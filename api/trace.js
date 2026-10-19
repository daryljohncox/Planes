// Vercel serverless relay: the track a plane has flown on its current flight.
// Uses tar1090 trace files (adsb.lol, else adsb.fi or airplanes.live) (full history plus the most recent points),
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
  // tar1090 trace files from several community networks: the first that answers wins.
  // adsb.lol started returning nothing to Vercel (Oct 2026), so adsb.fi and airplanes.live back it up.
  const SOURCES = [
    ["adsb.lol", "https://globe.adsb.lol"],
    ["adsb.fi", "https://globe.adsb.fi"],
    ["airplanes.live", "https://globe.airplanes.live"]
  ];
  const debug = [];
  const get = async (site, name) => {
    try {
      const up = await fetch(site[1] + "/data/traces/" + hex.slice(-2) + "/" + name + "_" + hex + ".json", {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 nest-hub-planes",
          "Referer": site[1] + "/", "Accept": "application/json"
        }
      });
      debug.push(site[0] + " " + name + " " + up.status);
      return up.ok ? await up.json() : null;
    } catch (e) { debug.push(site[0] + " " + name + " " + e.message); return null; }
  };
  let full = null, recent = null, src = null;
  for (const site of SOURCES) {
    [full, recent] = await Promise.all([get(site, "trace_full"), get(site, "trace_recent")]);
    if (full || recent) { src = site[0]; break; }
  }

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
  const out = { pts, src };
  if (req.query.debug) out.debug = debug;
  return res.status(200).json(out);
};
