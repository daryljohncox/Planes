// Vercel serverless relay: a plane's last few flights (where it came from before reaching NZ coverage).
// Uses Flightradar24's flight list by registration. That isn't an official public API, so it may
// stop answering at any time; the map then falls back to a guess from the direction the plane came in.
//   GET /api/history?reg=ZK-JCJ
//   -> { flights: [{ from: {iata, icao, name, city, country}, to: {...} | null, dep: unix_s | null, arr: unix_s | null, live: bool }] }
module.exports = async (req, res) => {
  const reg = String(req.query.reg || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!/^[A-Z0-9]{1,3}-?[A-Z0-9]{2,6}$/.test(reg)) {
    res.setHeader("Cache-Control", "s-maxage=86400");
    return res.status(200).json({ flights: [] });
  }
  let flights = null;
  try {
    const up = await fetch("https://api.flightradar24.com/common/v1/flight/list.json?query=" + encodeURIComponent(reg.toLowerCase()) +
      "&fetchBy=reg&page=1&limit=5", {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://www.flightradar24.com/"
      }
    });
    if (up.ok) {
      const j = await up.json();
      const data = j && j.result && j.result.response && j.result.response.data;
      if (Array.isArray(data)) flights = data.map(flight).filter(Boolean).slice(0, 4);
    }
  } catch (e) { /* treated as no answer */ }

  // A failed lookup is retried soon; a real answer is kept for 10 minutes
  res.setHeader("Cache-Control", flights ? "s-maxage=600, stale-while-revalidate=600" : "no-store");
  return res.status(200).json({ flights: flights || [], ok: !!flights });
};

function airport(a) {
  if (!a || typeof a !== "object" || !a.code) return null;
  const pos = a.position || {};
  return {
    iata: a.code.iata || "", icao: a.code.icao || "", name: a.name || "",
    city: (pos.region && pos.region.city) || "", country: (pos.country && pos.country.name) || ""
  };
}
function flight(f) {
  const ap = (f && f.airport) || {}, real = (f && f.time && f.time.real) || {}, est = (f && f.time && f.time.estimated) || {};
  const from = airport(ap.origin);
  if (!from) return null;
  return {
    from, to: airport(ap.destination),
    dep: real.departure || null, arr: real.arrival || est.arrival || null,
    live: !!(f.status && f.status.live)
  };
}
