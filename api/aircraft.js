// Vercel serverless relay: backup aircraft details for planes the feed doesn't recognise
// (no type code). Tries adsbdb.com by Mode S hex, then hexdb.io, then adsbdb by registration,
// then (for NZ aircraft) the CAA NZ aircraft register, which has new planes the others lack.
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
  let caaDown = false;
  if (/^ZK-?[A-Z0-9]{2,4}$/.test(reg) || /^c8/.test(hex)) {
    const zk = await caaRegister();
    if (!zk) caaDown = true;
    else {
      const row = zk.byReg.get(reg.replace("-", "")) || zk.byHex.get(hex);
      if (row) ac = ac ? Object.assign({}, row, ac, { t: ac.t || row.t, year: row.year, sn: row.sn, since: row.since }) : row;
      if (ac && !ac.t) delete ac.t;
    }
  }

  res.setHeader("Cache-Control", ac ? "s-maxage=86400, stale-while-revalidate=86400" : caaDown ? "no-store" : "s-maxage=21600");
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

// ---------- CAA NZ aircraft register (whole register as CSV, refreshed by the CAA every week or so) ----------
const CAA_CSV = "https://www.aviation.govt.nz/assets/aircraft/aircraft-register/Aircraft-Register-for-website.csv";
let caa = null, caaAt = 0;
async function caaRegister() {
  if (caa && Date.now() - caaAt < 12 * 3600e3) return caa;
  try {
    const up = await fetch(CAA_CSV, { headers: { "User-Agent": "nest-hub-planes" } });
    if (!up.ok) return caa;
    const rows = parseCsv((await up.text()).replace(/^\uFEFF/, ""));
    const head = rows.shift().map((h) => h.trim().toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const cReg = col(/^registration/), cMan = col(/^manufacturer/), cMod = col(/^model$/), cOwn = col(/^owner name/), cHex = col(/hex/);
    // year built, serial number and registration date: column names vary a little between CAA releases
    const cYear = col(/year.*manuf|manuf.*year|year of|year built/), cSn = col(/serial|c\/n|msn/), cSince = col(/registration date|date registered|registered date/);
    if (cReg < 0 || cMod < 0) return caa;
    const byReg = new Map(), byHex = new Map();
    for (const r of rows) {
      const reg = (r[cReg] || "").trim().toUpperCase();
      if (!/^ZK-[A-Z0-9]{2,4}$/.test(reg)) continue;
      const man = maker(r[cMan] || ""), model = (r[cMod] || "").trim();
      const ac = clean({ t: icaoType(man, model), desc: [man, model].filter(Boolean).join(" "), r: reg, owner: r[cOwn] });
      if (!ac) continue;
      const yr = cYear >= 0 ? (r[cYear] || "").match(/\b(19|20)\d\d\b/) : null;
      if (yr) ac.year = yr[0];
      if (cSn >= 0 && (r[cSn] || "").trim()) ac.sn = r[cSn].trim();
      if (cSince >= 0 && (r[cSince] || "").trim()) ac.since = r[cSince].trim();
      byReg.set(reg.replace("-", ""), ac);
      const hex = (r[cHex] || "").trim().toLowerCase();
      if (/^[0-9a-f]{6}$/.test(hex)) byHex.set(hex, ac);
    }
    if (byReg.size) { caa = { byReg, byHex }; caaAt = Date.now(); }
  } catch (e) { /* keep the last good copy */ }
  return caa;
}

// RFC 4180-ish: quoted fields may hold commas, newlines and "" escapes
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); f = ""; if (row.length > 1 || row[0]) rows.push(row); row = [];
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// "Cessna Aircraft Company" -> "Cessna", "Costruzioni Aeronautiche Tecnam" -> "Tecnam"
const MAKERS = ["Tecnam", "Cessna", "Piper", "Diamond", "Cirrus", "Robinson", "Beechcraft", "Pacific Aerospace", "Airbus",
  "Eurocopter", "Bell", "Hughes", "MD Helicopters", "Pilatus", "Socata", "Daher", "Textron", "Grob", "Pipistrel", "Vans",
  "Jabiru", "Schempp-Hirth", "Schleicher", "Airbus Helicopters", "Embraer", "ATR", "De Havilland", "Boeing", "Fletcher", "Kawasaki", "Leonardo", "Agusta"];
function maker(s) {
  s = s.trim();
  const m = MAKERS.find((k) => new RegExp("\\b" + k + "\\b", "i").test(s));
  if (m) return m;
  return s.replace(/[,.]?\s+(aircraft|aviation|flugzeugbau|aeronautical|aerospace|industries|company|corporation|corp|inc|incorporated|limited|ltd|llc|gmbh|s\.?p\.?a|s\.?r\.?l|co)\b\.?/gi, "").trim();
}

// Best-effort ICAO type designator from the register's maker and model, so colours and photos work
const TYPE_RULES = [
  [/^Tecnam P[- ]?2008|^Tecnam P[- ]?MENTOR/i, "P208"], [/^Tecnam P[- ]?92/i, "P92"],
  [/^Cessna (A|F|R)?150/i, "C150"], [/^Cessna (F|A)?152/i, "C152"], [/^Cessna 162/i, "C162"], [/^Cessna (F|R)?172/i, "C172"],
  [/^Cessna 177/i, "C177"], [/^Cessna 180/i, "C180"], [/^Cessna (F|R|T)?182/i, "C182"], [/^Cessna A?185/i, "C185"],
  [/^Cessna (U|T|TU|P)?206/i, "C206"], [/^Cessna (T)?207/i, "C207"], [/^Cessna 208/i, "C208"], [/^Cessna (T|P)?210/i, "C210"],
  [/^Piper PA[- ]?28R/i, "P28R"], [/^Piper PA[- ]?28/i, "P28A"], [/^Piper PA[- ]?18/i, "PA18"], [/^Piper PA[- ]?38/i, "PA38"],
  [/^Piper PA[- ]?44/i, "PA44"], [/^Piper PA[- ]?34/i, "PA34"], [/^Piper PA[- ]?32R/i, "P32R"], [/^Piper PA[- ]?32/i, "PA32"],
  [/^Diamond DA ?20/i, "DA20"], [/^Diamond DA ?40/i, "DA40"], [/^Diamond DA ?42/i, "DA42"], [/^Diamond DA ?62/i, "DA62"],
  [/^Cirrus SR ?20/i, "SR20"], [/^Cirrus SR ?22/i, "SR22"],
  [/^Robinson R ?22/i, "R22"], [/^Robinson R ?44/i, "R44"], [/^Robinson R ?66/i, "R66"],
  [/^(Airbus|Eurocopter|Airbus Helicopters) AS ?350/i, "AS50"], [/^(Airbus|Eurocopter|Airbus Helicopters) EC ?130/i, "EC30"],
  [/^Bell 206/i, "B06"], [/^Hughes 369|^MD Helicopters 369/i, "H500"],
  [/^Beechcraft 76/i, "BE76"], [/^Beechcraft 58/i, "BE58"], [/^Pacific Aerospace 750/i, "P750"]
];
function icaoType(man, model) {
  const s = man + " " + model;
  const r = TYPE_RULES.find((x) => x[0].test(s));
  return r ? r[1] : "";
}
