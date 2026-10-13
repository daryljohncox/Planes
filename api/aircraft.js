// Vercel serverless relay: backup aircraft details for planes the feed doesn't recognise
// (no type code). Tries adsbdb.com by Mode S hex, then hexdb.io, then adsbdb by registration.
// Answers are edge-cached for a day.
//   GET /api/aircraft?hex=c81e2c&reg=ZK-HBC
//   -> { ac: { t: "AS50", desc: "Airbus Helicopters AS 350 B2", r: "ZK-HBC", owner: "..." } }  or  { ac: null }
module.exports = async (req, res) => {
  const hex = String(req.query.hex || "").trim().toLowerCase();
  const reg = String(req.query.reg || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const ua = { "User-Agent": "nest-hub-planes" };
  const get = async (url) => {
    try {
      const up = await fetch(url, { headers: ua });
      return up.ok ? await up.json() : null;
    } catch (e) { return null; }
  };
  const fromAdsbdb = (j) => {
    const a = j && j.response && j.response.aircraft;
    if (!a || typeof a !== "object") return null;
    return clean({ t: a.icao_type, desc: [a.manufacturer, a.type].filter(Boolean).join(" "), r: a.registration, owner: a.registered_owner });
  };

  let ac = null;
  if (/^[0-9a-f]{6}$/.test(hex)) {
    ac = fromAdsbdb(await get("https://api.adsbdb.com/v0/aircraft/" + hex));
    if (!ac) {
      const h = await get("https://hexdb.io/api/v1/aircraft/" + hex);
      if (h && typeof h === "object") ac = clean({ t: h.ICAOTypeCode, desc: [h.Manufacturer, h.Type].filter(Boolean).join(" "), r: h.Registration, owner: h.RegisteredOwners });
    }
  }
  if (!ac && /^[A-Z0-9]{1,3}-?[A-Z0-9]{2,6}$/.test(reg)) ac = fromAdsbdb(await get("https://api.adsbdb.com/v0/aircraft/" + reg));

  res.setHeader("Cache-Control", ac ? "s-maxage=86400, stale-while-revalidate=86400" : "s-maxage=21600");
  return res.status(200).json({ ac });
};

// keep only useful text fields; null if nothing tells us what the aircraft is
function clean(o) {
  const out = {};
  for (const k in o) {
    const v = typeof o[k] === "string" ? o[k].trim() : "";
    if (v && !/^(unknown|n\/?a|none|-)$/i.test(v)) out[k] = v;
  }
  out.t = (out.t || "").toUpperCase();
  if (!/^[A-Z0-9]{2,4}$/.test(out.t)) delete out.t;
  return out.t || out.desc ? out : null;
}
