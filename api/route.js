// Vercel serverless relay: looks up a flight's origin and destination by callsign.
// ADS-B itself doesn't carry the route, so this uses community route databases:
// adsbdb.com first, then adsb.lol's routeset as a backup. Answers are edge-cached.
//   GET /api/route?cs=ANZ123&lat=-40.1&lon=175.4
//   -> { route: { airline, from: {iata, icao, city, name}, to: {...} } }  or  { route: null }
module.exports = async (req, res) => {
  const cs = String(req.query.cs || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!/^[A-Z0-9]{3,8}$/.test(cs)) {
    res.setHeader("Cache-Control", "s-maxage=86400");
    return res.status(200).json({ route: null });
  }
  const ua = { "User-Agent": "nest-hub-planes" };

  // 1) adsbdb.com
  // A route with only one end known is kept as a fallback while we look for a complete one.
  let partial = null;
  try {
    const up = await fetch("https://api.adsbdb.com/v0/callsign/" + cs, { headers: ua });
    if (up.ok) {
      const j = await up.json();
      const fr = j && j.response && j.response.flightroute;
      if (fr && (fr.origin || fr.destination)) {
        const ap = (a) => a ? ({ iata: a.iata_code || "", icao: a.icao_code || "", city: a.municipality || "", name: a.name || "" }) : null;
        const route = { airline: (fr.airline && fr.airline.name) || "", from: ap(fr.origin), to: ap(fr.destination), src: "adsbdb" };
        if (route.from && route.to) return send(res, route);
        partial = route;
      }
    }
  } catch (e) { /* try the backup */ }

  // 2) adsb.lol routeset (uses position to check the route is plausible)
  try {
    const up = await fetch("https://api.adsb.lol/api/0/routeset", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, ua),
      body: JSON.stringify({ planes: [{ callsign: cs, lat: isNaN(lat) ? 0 : lat, lng: isNaN(lon) ? 0 : lon }] })
    });
    if (up.ok) {
      const list = await up.json();
      const r = Array.isArray(list) ? list[0] : null;
      const aps = r && r._airports;
      if (aps && aps.length && r.plausible !== false) {
        const ap = (a) => ({ iata: a.iata || "", icao: a.icao || "", city: a.location || "", name: a.name || "" });
        if (aps.length >= 2) return send(res, { airline: "", from: ap(aps[0]), to: ap(aps[aps.length - 1]), src: "adsb.lol" });
        if (!partial) partial = { airline: "", from: ap(aps[0]), to: null, src: "adsb.lol" };
      }
    }
  } catch (e) { /* no route */ }

  if (partial) return send(res, partial);

  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=600");
  return res.status(200).json({ route: null });
};

function send(res, route) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=3600");
  return res.status(200).json({ route });
}
