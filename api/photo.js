// Vercel serverless relay: a real photo of one aircraft from the free photo sites the Hub's browser can't ask
// directly. Tries Planespotters by registration (the map already asks it by hex), then airport-data.com by
// hex and by registration, then hexdb.io. Answers are edge-cached for a day.
//   GET /api/photo?hex=c81d9e&reg=ZK-NZE
//   -> { photo: { src: "https://...jpg", credit: "© Name · Airport-Data.com" } }  or  { photo: null }
module.exports = async (req, res) => {
  const hex = String(req.query.hex || "").trim().toLowerCase();
  const reg = String(req.query.reg || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const okHex = /^[0-9a-f]{6}$/.test(hex), okReg = /^[A-Z0-9]{1,3}-?[A-Z0-9]{2,6}$/.test(reg);
  const ua = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" };
  const diag = [];   // ?debug=1 shows what each site answered
  const get = async (url, text) => {
    try {
      const up = await fetch(url, { headers: ua, signal: AbortSignal.timeout(6000) });
      const body = up.ok ? (text ? await up.text() : await up.json()) : null;
      diag.push([url, up.status, JSON.stringify(body).slice(0, 300)]);
      return body;
    } catch (e) { diag.push([url, String(e).slice(0, 100)]); return null; }
  };

  // All asked at once (one slow site mustn't run past Vercel's time limit); the first in this order wins
  let failed = 0;
  const ask = (url, text, pick) => url ? get(url, text).then((j) => { if (j == null) failed++; return j == null ? null : pick(j); }) : Promise.resolve(null);
  const answers = await Promise.all([
    ask(okReg && "https://api.planespotters.net/pub/photos/reg/" + encodeURIComponent(reg), false, (j) => {
      const p = j.photos && j.photos[0];
      return p ? { src: (p.thumbnail_large || p.thumbnail).src, credit: "© " + (p.photographer || "unknown") + " · Planespotters.net" } : null;
    }),
    ask(okHex && "https://www.airport-data.com/api/ac_thumb.json?n=1&m=" + hex, false, airportData),
    ask(okReg && "https://www.airport-data.com/api/ac_thumb.json?n=1&r=" + encodeURIComponent(reg), false, airportData),
    ask(okHex && "https://hexdb.io/hex-image?hex=" + hex, true, (t) => {
      const src = String(t).trim();
      return /^https?:\/\/\S+\.(jpe?g|png|webp)(\?\S*)?$/i.test(src) ? { src: src, credit: "Photo via hexdb.io" } : null;
    })
  ]);
  const photo = answers.find(Boolean) || null;

  // A miss is kept for 6 hours unless a site was down, then it's asked again next time
  res.setHeader("Cache-Control", photo ? "s-maxage=86400, stale-while-revalidate=86400" : failed ? "no-store" : "s-maxage=21600");
  return res.status(200).json(req.query.debug ? { photo, diag } : { photo });
};

function airportData(j) {
  const p = Array.isArray(j.data) && j.data[0];
  return p && p.image ? { src: p.image, credit: "© " + (p.photographer || "unknown") + " · Airport-Data.com" } : null;
}
