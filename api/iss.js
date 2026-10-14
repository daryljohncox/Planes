// Vercel serverless relay: the International Space Station's orbit (two-line elements, TLE).
// The page works out the station's position and passes over home from this with satellite.js.
//   GET /api/iss  ->  { name, tle1, tle2, src }
// CelesTrak first, then wheretheiss.at and tle.ivanstanojevic.me as backups. Cached for 6 hours.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const ua = { "User-Agent": "nest-hub-planes" };
  const sources = [
    ["celestrak", async () => {
      const up = await fetch("https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE", { headers: ua });
      if (!up.ok) throw new Error("HTTP " + up.status);
      const l = (await up.text()).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return { tle1: l.find((s) => s.startsWith("1 ")), tle2: l.find((s) => s.startsWith("2 ")) };
    }],
    ["wheretheiss", async () => {
      const up = await fetch("https://api.wheretheiss.at/v1/satellites/25544/tles", { headers: ua });
      if (!up.ok) throw new Error("HTTP " + up.status);
      const j = await up.json();
      return { tle1: j.line1, tle2: j.line2 };
    }],
    ["ivanstanojevic", async () => {
      const up = await fetch("https://tle.ivanstanojevic.me/api/tle/25544", { headers: ua });
      if (!up.ok) throw new Error("HTTP " + up.status);
      const j = await up.json();
      return { tle1: j.line1, tle2: j.line2 };
    }]
  ];
  for (const [src, get] of sources) {
    try {
      const t = await get();
      if (/^1 25544/.test(t.tle1 || "") && /^2 25544/.test(t.tle2 || "")) {
        res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
        return res.status(200).json({ name: "ISS", tle1: t.tle1, tle2: t.tle2, src });
      }
    } catch (e) { /* next source */ }
  }
  res.setHeader("Cache-Control", "s-maxage=300");
  return res.status(502).json({ error: "no orbit data" });
};
