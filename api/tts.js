// Vercel serverless relay: text to speech for the spoken plane announcements.
//   GET /api/tts?text=Air%20New%20Zealand%20A320...  ->  audio/mpeg
// 1) Microsoft Edge "Read aloud" voice en-NZ Molly (free, natural female NZ voice; same service the
//    edge-tts project uses). 2) Google Translate's voice (Australian English) if that fails.
// Same text gives the same audio, so answers are edge-cached.
const crypto = require("crypto");
const WebSocket = require("ws");

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM = process.env.EDGE_TTS_VERSION || "130.0.2849.68";
const VOICE = "Microsoft Server Speech Text to Speech Voice (en-NZ, MollyNeural)";
const WSS = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=" + TOKEN;
const MAX_CHARS = 400;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const text = String(req.query.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  if (!text) return res.status(400).json({ error: "text missing" });
  let audio = null, src = "";
  try { audio = await edge(text, 0); src = "edge"; } catch (e) { audio = null; }
  if (!audio) { try { audio = await google(text); src = "google"; } catch (e) { audio = null; } }
  if (!audio || !audio.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "no voice available" });
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("X-Voice", src);
  res.setHeader("Cache-Control", "public, s-maxage=86400, max-age=3600");
  return res.status(200).send(audio);
};

// The service wants a token from the clock, rounded to 5 minutes (Windows file-time ticks).
function secMsGec(skewS) {
  let s = BigInt(Math.floor(Date.now() / 1000 + skewS)) + 11644473600n;
  s -= s % 300n;
  return crypto.createHash("sha256").update((s * 10000000n).toString() + TOKEN).digest("hex").toUpperCase();
}
const uuid = () => crypto.randomUUID().replace(/-/g, "");
const stamp = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) /, "$1 $3 $2 $4 ").replace("GMT", "GMT+0000 (Coordinated Universal Time)");
const xml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function edge(text, skewS, retried) {
  return new Promise((resolve, reject) => {
    const url = WSS + "&ConnectionId=" + uuid() + "&Sec-MS-GEC=" + secMsGec(skewS) + "&Sec-MS-GEC-Version=1-" + CHROMIUM;
    const major = CHROMIUM.split(".")[0];
    const ws = new WebSocket(url, {
      headers: {
        "Pragma": "no-cache", "Cache-Control": "no-cache",
        "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Safari/537.36 Edg/" + major + ".0.0.0",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": "muid=" + crypto.randomBytes(16).toString("hex").toUpperCase() + ";"
      }
    });
    const chunks = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { ws.close(); } catch (e) { /* already closed */ }
      if (err) reject(err); else if (chunks.length) resolve(Buffer.concat(chunks)); else reject(new Error("no audio"));
    };
    const timer = setTimeout(() => finish(new Error("timeout")), 8000);
    // A 403 usually means our clock is off from theirs: retry once with their time
    ws.on("unexpected-response", (rq, rs) => {
      const theirs = Date.parse(rs.headers.date || "");
      if (rs.statusCode === 403 && !retried && !isNaN(theirs)) {
        done = true; clearTimeout(timer);
        edge(text, (theirs - Date.now()) / 1000, true).then(resolve, reject);
        return;
      }
      finish(new Error("HTTP " + rs.statusCode));
    });
    ws.on("error", (e) => finish(e));
    ws.on("close", () => finish(chunks.length ? null : new Error("closed")));
    ws.on("open", () => {
      ws.send("X-Timestamp:" + stamp() + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
      ws.send("X-RequestId:" + uuid() + "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + stamp() + "Z\r\nPath:ssml\r\n\r\n" +
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='" + VOICE + "'>" +
        "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" + xml(text) + "</prosody></voice></speak>");
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // [2-byte header length][headers][mp3 bytes]
        const n = data.readUInt16BE(0), head = data.slice(2, 2 + n).toString();
        if (head.indexOf("Path:audio") >= 0) chunks.push(data.slice(2 + n));
      } else if (String(data).indexOf("Path:turn.end") >= 0) finish(null);
    });
  });
}

// Backup voice. Google's endpoint takes up to ~200 characters, so long text is sent in pieces.
async function google(text) {
  const parts = [], words = text.split(" ");
  let cur = "";
  words.forEach((w) => { if ((cur + " " + w).length > 190) { parts.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; });
  if (cur) parts.push(cur);
  const out = [];
  for (const p of parts) {
    const up = await fetch("https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en-AU&q=" + encodeURIComponent(p),
      { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://translate.google.com/" } });
    if (!up.ok) throw new Error("HTTP " + up.status);
    out.push(Buffer.from(await up.arrayBuffer()));
  }
  return Buffer.concat(out);
}
