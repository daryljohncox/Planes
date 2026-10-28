// Cloudflare Pages version of api/tts.js (same behaviour; Workers have no `ws` package, so the Edge
// "Read aloud" socket is opened with fetch + Upgrade, which lets us send the headers it wants).
//   GET /api/tts?text=...&v=sonia  ->  audio/mpeg
const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM = "130.0.2849.68";
const VOICES = {
  sonia: "en-GB, SoniaNeural", libby: "en-GB, LibbyNeural", hollie: "en-GB, HollieNeural",
  molly: "en-NZ, MollyNeural", natasha: "en-AU, NatashaNeural"
};
const GOOGLE_LANG = { "en-GB": "en-GB", "en-NZ": "en-AU", "en-AU": "en-AU" };
const WSS = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=" + TOKEN;
const MAX_CHARS = 400;

const json = (o, status, extra) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra } });

export async function onRequest({ request, waitUntil }) {
  const url = new URL(request.url);
  const key = new Request(url.toString(), { method: "GET" });
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const text = String(url.searchParams.get("text") || "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  if (!text) return json({ error: "text missing" }, 400);
  const voice = VOICES[String(url.searchParams.get("v") || "").toLowerCase()] || VOICES.sonia;
  const lang = voice.split(",")[0];
  let audio = null, src = "";
  try { audio = await edge(text, voice, 0); src = "edge " + voice; } catch (e) { audio = null; }
  if (!audio) { try { audio = await google(text, GOOGLE_LANG[lang] || "en-GB"); src = "google " + lang; } catch (e) { audio = null; } }
  if (!audio || !audio.length) return json({ error: "no voice available" }, 502, { "Cache-Control": "no-store" });
  const out = new Response(audio, { status: 200, headers: {
    "Content-Type": "audio/mpeg", "X-Voice": src, "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, s-maxage=86400, max-age=3600"
  } });
  waitUntil(caches.default.put(key, out.clone()));
  return out;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
// The service wants a token from the clock, rounded to 5 minutes (Windows file-time ticks).
async function secMsGec(skewS) {
  let s = BigInt(Math.floor(Date.now() / 1000 + skewS)) + 11644473600n;
  s -= s % 300n;
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode((s * 10000000n).toString() + TOKEN)));
}
const uuid = () => crypto.randomUUID().replace(/-/g, "");
const stamp = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) /, "$1 $3 $2 $4 ").replace("GMT", "GMT+0000 (Coordinated Universal Time)");
const xml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const concat = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; parts.forEach((p) => { out.set(p, o); o += p.length; }); return out; };

async function edge(text, voice, skewS, retried) {
  const major = CHROMIUM.split(".")[0];
  const muid = hex(crypto.getRandomValues(new Uint8Array(16)));
  const resp = await fetch(WSS + "&ConnectionId=" + uuid() + "&Sec-MS-GEC=" + await secMsGec(skewS) + "&Sec-MS-GEC-Version=1-" + CHROMIUM, {
    headers: {
      "Upgrade": "websocket",
      "Pragma": "no-cache", "Cache-Control": "no-cache",
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Safari/537.36 Edg/" + major + ".0.0.0",
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": "muid=" + muid + ";"
    }
  });
  const ws = resp.webSocket;
  if (!ws) {
    // A 403 usually means our clock is off from theirs: retry once with their time
    const theirs = Date.parse(resp.headers.get("date") || "");
    if (resp.status === 403 && !retried && !isNaN(theirs)) return edge(text, voice, (theirs - Date.now()) / 1000, true);
    throw new Error("HTTP " + resp.status);
  }
  ws.accept();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { ws.close(); } catch (e) { /* already closed */ }
      if (err) reject(err); else if (chunks.length) resolve(concat(chunks)); else reject(new Error("no audio"));
    };
    const timer = setTimeout(() => finish(new Error("timeout")), 8000);
    ws.addEventListener("error", () => finish(new Error("socket error")));
    ws.addEventListener("close", () => finish(chunks.length ? null : new Error("closed")));
    ws.addEventListener("message", (ev) => {
      const data = ev.data;
      if (typeof data === "string") { if (data.indexOf("Path:turn.end") >= 0) finish(null); return; }
      // [2-byte header length][headers][mp3 bytes]
      const b = new Uint8Array(data), n = (b[0] << 8) | b[1];
      if (new TextDecoder().decode(b.slice(2, 2 + n)).indexOf("Path:audio") >= 0) chunks.push(b.slice(2 + n));
    });
    ws.send("X-Timestamp:" + stamp() + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
      '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
    ws.send("X-RequestId:" + uuid() + "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + stamp() + "Z\r\nPath:ssml\r\n\r\n" +
      "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='Microsoft Server Speech Text to Speech Voice (" + voice + ")'>" +
      "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" + xml(text) + "</prosody></voice></speak>");
  });
}

// Backup voice. Google's endpoint takes up to ~200 characters, so long text is sent in pieces.
async function google(text, lang) {
  const parts = [], words = text.split(" ");
  let cur = "";
  words.forEach((w) => { if ((cur + " " + w).length > 190) { parts.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; });
  if (cur) parts.push(cur);
  const out = [];
  for (const p of parts) {
    const up = await fetch("https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=" + lang + "&q=" + encodeURIComponent(p),
      { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://translate.google.com/" } });
    if (!up.ok) throw new Error("HTTP " + up.status);
    out.push(new Uint8Array(await up.arrayBuffer()));
  }
  return concat(out);
}
