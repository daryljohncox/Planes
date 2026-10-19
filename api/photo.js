// Vercel serverless relay: a real photo of one aircraft from hexdb.io, which the Hub's browser can't ask directly.
// (Planespotters and Airport-Data refuse Vercel's servers with a 403, so the map asks those itself.)
// Answers are edge-cached for a day.
//   GET /api/photo?hex=c81d9e  ->  { photo: { src: "https://...jpg", credit: "Photo via hexdb.io" } }  or  { photo: null }
module.exports = async (req, res) => {
  const hex = String(req.query.hex || "").trim().toLowerCase();
  res.setHeader("Access-Control-Allow-Origin", "*");
  let photo = null, failed = false;
  if (/^[0-9a-f]{6}$/.test(hex)) {
    try {
      const up = await fetch("https://hexdb.io/hex-image?hex=" + hex, { headers: { "User-Agent": "nest-hub-planes" }, signal: AbortSignal.timeout(6000) });
      const src = up.ok ? (await up.text()).trim() : "";
      if (!up.ok) failed = true;
      if (/^https?:\/\/\S+\.(jpe?g|png|webp)(\?\S*)?$/i.test(src)) photo = { src: src, credit: "Photo via hexdb.io" };
    } catch (e) { failed = true; }
  }
  // A miss is kept for 6 hours unless the site was down, then it's asked again next time
  res.setHeader("Cache-Control", photo ? "s-maxage=86400, stale-while-revalidate=86400" : failed ? "no-store" : "s-maxage=21600");
  return res.status(200).json({ photo });
};
