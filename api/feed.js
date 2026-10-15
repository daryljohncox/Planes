// Vercel serverless relay: fetches nearby aircraft for the Nest Hub page.
// Tries adsb.lol first, then adsb.fi. With ?hex= it looks up one aircraft instead. Answers are edge-cached for 5 s.
module.exports = async (req, res) => {
  const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  const lat = num(req.query.lat, -40.07);
  const lon = num(req.query.lon, 175.38);
  const r = Math.min(num(req.query.r, 60), 250);

  // ?hex=c81234 finds one aircraft anywhere (used to jump to a plane from the rare plane list)
  const hex = /^[0-9a-f]{6}$/i.test(req.query.hex || "") ? req.query.hex.toLowerCase() : null;
  const sources = hex ? [
    { url: `https://api.adsb.lol/v2/hex/${hex}`, list: "ac" },
    { url: `https://opendata.adsb.fi/api/v2/hex/${hex}`, list: "aircraft" }
  ] : [
    { url: `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`, list: "ac" },
    { url: `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`, list: "aircraft" }
  ];
  const tried = [];

  for (const s of sources) {
    try {
      const up = await fetch(s.url, { headers: { "User-Agent": "nest-hub-planes" } });
      tried.push(new URL(s.url).host + " " + up.status);
      if (!up.ok) continue;
      const data = await up.json();
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=5");
      return res.status(200).json({ ac: data[s.list] || [], src: new URL(s.url).host });
    } catch (e) {
      tried.push(new URL(s.url).host + " error");
    }
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  return res.status(503).json({ ac: [], error: "all feeds busy", tried });
};
