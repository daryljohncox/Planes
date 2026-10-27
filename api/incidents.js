// Vercel serverless relay: NZ aviation emergencies and incidents reported in the last 30 days, for the
// Emergencies tab. News stories (Google News NZ, which carries 1News / RNZ / Herald / Stuff, plus those
// outlets' own feeds as backups) whose headline is about an aircraft in trouble, and the Aviation Safety
// Network's NZ list. ?debug=1 adds what each source answered. Edge-cached for 15 minutes.
const DAY = 86400000, KEEP = 30 * DAY;
const UA = { "User-Agent": "Mozilla/5.0 (nest-hub-planes)" };

// A headline has to name an aircraft and some kind of trouble
const AIR = /\b(planes?|aircraft|airliners?|helicopters?|choppers?|microlights?|gyrocopters?|gliders?|pilots?|flights?|jets?|cessna|seaplanes?|float ?planes?|air new zealand|jetstar|air nz|skydiv\w*|paraglid\w*|hot air balloons?|aero club)\b/i;
const TROUBLE = /\b(crash\w*|emergenc\w*|forced landing|force-landed|mayday|ditch\w*|engine (failure|fail\w*|trouble)|propeller|prop broke|turned back|turns back|diverted|incident|bird ?strike|smoke|on fire|caught fire|missing|search for|rescued?|wreckage|crash-land\w*|hard landing|skid\w*|overran|went down|came down|plunged|taic|investigat\w*|safety scare|scare|mid-air|near miss|collid\w*)\b/i;
// Not about an actual aircraft in trouble
const NOT = /\b(arrest\w*|police (helicopter|eagle)|eagle helicopter|fleeing|offenders?|drones?|flight (prices|deals|sale)|fares?|airfares?|strike action|price|share price|profit|loss|results|game|esports|video game|simulator|movie|film|review)\b/i;

const NZ_NEWS = [
  { src: "Google News", url: "https://news.google.com/rss/search?q=" + encodeURIComponent('(plane OR aircraft OR helicopter OR pilot OR microlight OR glider) (crash OR "emergency landing" OR "forced landing" OR mayday OR "engine failure" OR emergency OR incident) when:30d') + "&hl=en-NZ&gl=NZ&ceid=NZ:en", google: true },
  { src: "RNZ", url: "https://www.rnz.co.nz/rss/national.xml" },
  { src: "1News", url: "https://www.1news.co.nz/arc/outboundfeeds/rss/?outputType=xml" },
  { src: "NZ Herald", url: "https://www.nzherald.co.nz/arc/outboundfeeds/rss/curated/78/?outputType=xml&_website=nzh" },
  { src: "Stuff", url: "https://www.stuff.co.nz/rss" }
];

function decode(s) {
  return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function tag(xml, name) {
  const m = new RegExp("<" + name + "(\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i").exec(xml);
  return m ? m[2] : "";
}
function idOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function news(feed, out, tried) {
  const host = new URL(feed.url).host;
  try {
    const up = await fetch(feed.url, { headers: UA, signal: AbortSignal.timeout(8000) });
    const ti = tried.push(feed.src + " " + up.status) - 1;
    if (!up.ok) return;
    const xml = await up.text(), items = xml.split(/<item[\s>]/i).slice(1);
    let n = 0;
    items.forEach((it) => {
      let title = decode(tag(it, "title"));
      const desc = decode(tag(it, "description")).slice(0, 300);
      const t = Date.parse(decode(tag(it, "pubDate"))) || 0;
      let src = feed.src;
      if (feed.google) {
        // Google News: only New Zealand outlets (the source's web address ends .nz), headline ends " - Outlet"
        const sm = /<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i.exec(it);
        if (!sm || !/\.nz(\/|$)/i.test(sm[1])) return;
        src = decode(sm[2]);
        title = title.replace(new RegExp("\\s+-\\s+" + src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), "");
      }
      if (!title || !t || Date.now() - t > KEEP) return;
      const text = title + " " + (feed.google ? "" : desc);
      if (!AIR.test(title) || !TROUBLE.test(text) || NOT.test(title)) return;
      out.push({ id: "n" + idOf(title.toLowerCase().replace(/[^a-z0-9]/g, "")), t, title, src, text: feed.google ? "" : desc, url: decode(tag(it, "link")) });
      n++;
    });
    tried[ti] += " · " + items.length + " stories, " + n + " kept";
  } catch (e) {
    tried.push(feed.src + " error " + host);
  }
}

// Aviation Safety Network: NZ-registered (ZK-) occurrences, newest first
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
async function asn(out, tried) {
  const url = "https://aviation-safety.net/wikibase/dblist.php?Country=ZK&sorteer=datekey_desc";
  try {
    const up = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
    const ti = tried.push("ASN " + up.status) - 1;
    if (!up.ok) return;
    const html = await up.text();
    let n = 0;
    html.split(/<tr[\s>]/i).slice(1).forEach((row) => {
      const cells = row.split(/<td[\s>]/i).slice(1).map((c) => c.replace(/<\/td>[\s\S]*$/i, ""));
      if (cells.length < 6) return;
      const dm = /(\d{1,2})-([A-Z]{3})-(\d{4})/.exec(decode(cells[0]));
      if (!dm || MON[dm[2]] == null) return;
      const t = Date.UTC(+dm[3], MON[dm[2]], +dm[1], 0, 0);
      if (Date.now() - t > KEEP) return;
      const link = /href="([^"]*wikibase\/(\d+))"/i.exec(row);
      const c = cells.map(decode);
      // date | type | reg | operator | fatalities | location | (country flag) | damage
      const type = c[1], reg = c[2], op = c[3], fat = c[4], where = c.slice(5).filter(Boolean).filter((x) => !/^(w\/o|sub|min|non|unk)$/i.test(x))[0] || "";
      const dmg = { "w/o": "destroyed", sub: "substantial damage", min: "minor damage", non: "no damage" }[c[c.length - 1]] || "";
      out.push({ id: "a" + (link ? link[2] : idOf(c.join("|"))), t, day: true, src: "Aviation Safety Network",
        title: [type, reg].filter(Boolean).join(" ") + (where ? ", " + where : ""),
        text: [op, dmg, fat && fat !== "0" ? "fatalities/occupants " + fat : ""].filter(Boolean).join(" · "),
        url: link ? (link[1].startsWith("http") ? link[1] : "https://aviation-safety.net" + (link[1].startsWith("/") ? "" : "/") + link[1]) : url });
      n++;
    });
    tried[ti] += " · " + n + " in 30 days";
  } catch (e) {
    tried.push("ASN error");
  }
}

module.exports = async (req, res) => {
  const out = [], tried = [];
  await Promise.all(NZ_NEWS.map((f) => news(f, out, tried)).concat([asn(out, tried)]));
  // The same story from several outlets: keep the earliest, one per headline
  const seen = {}, list = [];
  out.sort((a, b) => a.t - b.t).forEach((x) => { if (!seen[x.id]) { seen[x.id] = 1; list.push(x); } });
  list.reverse();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", req.query.debug ? "no-store" : "s-maxage=900, stale-while-revalidate=900");
  return res.status(200).json(req.query.debug ? { items: list, tried } : { items: list });
};
