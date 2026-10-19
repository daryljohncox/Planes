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
  const get = async (url, text) => {
    try {
      const up = await fetch(url, { headers: ua, signal: AbortSignal.timeout(5000) });
      return up.ok ? (text ? await up.text() : await up.json()) : null;
    } catch (e) { return null; }
  };

  let photo = null, failed = 0;
  if (okReg) {
    const j = await get("https://api.planespotters.net/pub/photos/reg/" + encodeURIComponent(reg));
    if (!j) failed++;
    const p = j && j.photos && j.photos[0];
    if (p) photo = { src: (p.thumbnail_large || p.thumbnail).src, credit: "© " + (p.photographer || "unknown") + " · Planespotters.net" };
  }
  for (const q of [okHex && "m=" + hex, okReg && "r=" + encodeURIComponent(reg)]) {
    if (photo || !q) continue;
    const j = await get("https://www.airport-data.com/api/ac_thumb.json?n=1&" + q);
    if (!j) failed++;
    const p = j && Array.isArray(j.data) && j.data[0];
    if (p && p.image) photo = { src: p.image.replace("/thumbnails/", "/"), thumb: p.image, credit: "© " + (p.photographer || "unknown") + " · Airport-Data.com" };
  }
  if (!photo && okHex) {
    const t = await get("https://hexdb.io/hex-image?hex=" + hex, true);
    if (t == null) failed++;
    const src = String(t || "").trim();
    if (/^https?:\/\/\S+\.(jpe?g|png|webp)(\?\S*)?$/i.test(src)) photo = { src: src, credit: "Photo via hexdb.io" };
  }

  // A miss is kept for 6 hours unless a site was down, then it's asked again next time
  res.setHeader("Cache-Control", photo ? "s-maxage=86400, stale-while-revalidate=86400" : failed ? "no-store" : "s-maxage=21600");
  return res.status(200).json({ photo });
};
