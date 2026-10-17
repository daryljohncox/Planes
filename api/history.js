// Vercel serverless relay: a plane's last few flights (where it came from before reaching NZ coverage).
// Passes on Flightradar24's flight list by registration as-is; the map reads it. That isn't an official
// public API and it may refuse Vercel's servers, so the map asks Flightradar24 directly first, then
// this relay, then falls back to a guess from the direction the plane came in.
//   GET /api/history?reg=ZK-JCJ  ->  Flightradar24's JSON ({ result: { response: { data: [...] } } }), or {} on failure
module.exports = async (req, res) => {
  const reg = String(req.query.reg || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!/^[A-Z0-9]{1,3}-?[A-Z0-9]{2,6}$/.test(reg)) {
    res.setHeader("Cache-Control", "s-maxage=86400");
    return res.status(200).json({});
  }
  let j = null;
  try {
    const up = await fetch("https://api.flightradar24.com/common/v1/flight/list.json?query=" + encodeURIComponent(reg.toLowerCase()) +
      "&fetchBy=reg&page=1&limit=5", {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://www.flightradar24.com/"
      },
      signal: AbortSignal.timeout(5000)   // a blocked request can hang until Vercel kills the function
    });
    if (up.ok) j = await up.json();
  } catch (e) { /* treated as no answer */ }

  const ok = !!(j && j.result && j.result.response && Array.isArray(j.result.response.data));
  // A failed lookup is retried soon; a real answer is kept for 10 minutes
  res.setHeader("Cache-Control", ok ? "s-maxage=600, stale-while-revalidate=600" : "no-store");
  return res.status(200).json(ok ? j : {});
};
