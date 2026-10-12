// Vercel serverless relay: the track a plane has flown on its current flight.
// Uses adsb.lol's tar1090 trace files (full history plus the most recent points),
// then keeps only the current leg: after the last takeoff / new-leg marker or long signal gap.
//   GET /api/trace?hex=c81e2c  ->  { pts: [[lat, lon, alt_ft|"ground"|null, unix_s], ...] }
const GAP_S = 20 * 60;   // a signal gap this long starts a new flight

module.exports = async (req, res) => {
  const hex = String(req.query.hex || "").trim().toLowerCase();
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    res.setHeader("Cache-Control", "s-maxage=86400");
    return res.status(200).json({ pts: [] });
  }
  const base = "https://globe.adsb.lol/data/traces/" + hex.slice(-2) + "/";
  const get = async (name) => {
    try {
      const up = await fetch(base + name + "_" + hex + ".json", {
        headers: { "User-Agent": "nest-hub-planes", "Referer": "https://globe.adsb.lol/" }
      });
      return up.ok ? await up.json() : null;
    } catch (e) { return null; }
  };
  const [full, recent] = await Promise.all([get("trace_full"), get("trace_recent")]);

  // Trace rows: [seconds after file timestamp, lat, lon, alt ("ground" | ft | null), gs, track, flags, ...]
  // flags & 2 marks the start of a new leg.
  const rows = [];
  let lastT = -Infinity;
  [full, recent].forEach((f) => {
    if (!f || !Array.isArray(f.trace)) return;
    f.trace.forEach((p) => {
      const t = f.timestamp + p[0];
      if (t <= lastT || p[1] == null || p[2] == null) return;
      rows.push({ t, lat: p[1], lon: p[2], alt: p[3], leg: (p[6] & 2) === 2 });
      lastT = t;
    });
  });

  // Walk back from the newest point to where this flight began
  let start = 0;
  for (let i = rows.length - 1; i > 0; i--) {
    if (rows[i].leg || rows[i].t - rows[i - 1].t > GAP_S) { start = i; break; }
    if (rows[i - 1].alt === "ground") { start = i - 1; break; }   // include the takeoff roll's last ground point
  }
  const pts = rows.slice(start).map((r) => [
    +r.lat.toFixed(5), +r.lon.toFixed(5),
    r.alt === "ground" ? "ground" : typeof r.alt === "number" ? r.alt : null, Math.round(r.t)
  ]);

  res.setHeader("Cache-Control", pts.length ? "s-maxage=30, stale-while-revalidate=30" : "s-maxage=60");
  return res.status(200).json({ pts, src: full || recent ? "adsb.lol" : null });
};
