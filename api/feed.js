// Vercel serverless relay: fetches nearby aircraft for the Nest Hub page.
// Tries adsb.lol first, then adsb.fi, then airplanes.live (Cloudflare's shared addresses get 429/403 from the first two). With ?hex= it looks up one aircraft instead. Answers are edge-cached for 5 s.
module.exports = async (req, res) => {
  const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  const lat = num(req.query.lat, -40.07);
  const lon = num(req.query.lon, 175.38);
  const r = Math.min(num(req.query.r, 60), 250);

  // ?hex=c81234 finds one aircraft anywhere (used to jump to a plane from the rare plane list)
  const hex = /^[0-9a-f]{6}$/i.test(req.query.hex || "") ? req.query.hex.toLowerCase() : null;
  // ?reg=ZK-IPB finds one aircraft by registration (used to watch the police Eagles)
  const reg = /^[A-Z0-9]{1,3}-?[A-Z0-9]{2,6}$/i.test(req.query.reg || "") ? req.query.reg.toUpperCase() : null;
  const sources = reg ? [
    { url: `https://api.adsb.lol/v2/registration/${reg}`, list: "ac" },
    { url: `https://opendata.adsb.fi/api/v2/registration/${reg}`, list: "aircraft" },
    { url: `https://api.airplanes.live/v2/reg/${reg}`, list: "ac" }
  ] : hex ? [
    { url: `https://api.adsb.lol/v2/hex/${hex}`, list: "ac" },
    { url: `https://opendata.adsb.fi/api/v2/hex/${hex}`, list: "aircraft" },
    { url: `https://api.airplanes.live/v2/hex/${hex}`, list: "ac" }
  ] : [
    { url: `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`, list: "ac" },
    { url: `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`, list: "aircraft" },
    { url: `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`, list: "ac" }
  ];
  const tried = [];
  // A plane sending a blank callsign comes through as "@@@@@@@@" (character 0 in ADS-B): treat it as none
  const clean = (list) => list.map((x) => {
    if (typeof x.flight === "string" && x.flight.indexOf("@") >= 0) {
      const f = x.flight.replace(/@/g, "").trim();
      if (f) x.flight = f; else delete x.flight;
    }
    return x;
  });

  // ?types=A124,B2,...: every plane of those types anywhere in the world (the "Continents" scan for very rare aircraft).
  // adsb.lol first, airplanes.live as the backup for each type; the page asks for a handful of types at a time
  if (req.query.types) {
    const codes = String(req.query.types).toUpperCase().split(",").filter((c) => /^[A-Z0-9]{2,4}$/.test(c)).slice(0, 8);
    const seen = {}, ac = [];
    await Promise.all(codes.map(async (c) => {
      for (const s of [`https://api.adsb.lol/v2/type/${c}`, `https://api.airplanes.live/v2/type/${c}`]) {
        const host = new URL(s).host;
        try {
          const up = await fetch(s, { headers: { "User-Agent": "nest-hub-planes" }, signal: AbortSignal.timeout(3000) });
          tried.push(host + " " + c + " " + up.status);
          if (!up.ok) continue;
          const data = await up.json();
          (data.ac || data.aircraft || []).forEach((x) => { if (x.hex && typeof x.lat === "number" && !seen[x.hex]) { seen[x.hex] = 1; ac.push(x); } });
          return;
        } catch (e) {
          tried.push(host + " " + c + " error");
        }
      }
    }));
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json({ ac: clean(ac), tried });
  }

  // ?mil=1: every military plane over the South Pacific and Antarctica, from the military lists of all three
  // feeds put together (each one misses some), so an Antarctic flight one feed leaves out still gets caught
  if (req.query.mil) {
    const lists = [
      { url: "https://api.adsb.lol/v2/mil", list: "ac" },
      { url: "https://opendata.adsb.fi/api/v2/mil", list: "aircraft" },
      { url: "https://api.airplanes.live/v2/mil", list: "ac" }
    ];
    const seen = {}, ac = [];
    await Promise.all(lists.map(async (s) => {
      const host = new URL(s.url).host;
      try {
        const up = await fetch(s.url, { headers: { "User-Agent": "nest-hub-planes" }, signal: AbortSignal.timeout(6000) });
        tried.push(host + " " + up.status);
        if (!up.ok) return;
        const data = await up.json();
        (data[s.list] || []).forEach((x) => {
          if (typeof x.lat !== "number" || !x.hex) return;
          if (!req.query.all && (x.lat > -30 || (x.lon < 140 && x.lon > -150))) return;   // ?mil=1&all=1: the whole world (Continents scan)
          const old = seen[x.hex];
          if (old && (old.seen_pos == null || (x.seen_pos != null && x.seen_pos >= old.seen_pos))) return;   // keep the freshest
          if (old) ac.splice(ac.indexOf(old), 1);
          seen[x.hex] = x; ac.push(x);
        });
      } catch (e) {
        tried.push(host + " error");
      }
    }));
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=20");
    return res.status(200).json({ ac: clean(ac), tried });
  }

  // ?sqk=1: every plane squawking 7700 / 7600 / 7500 around New Zealand, from all three feeds put together,
  // so the emergency alarm goes off wherever the map is looking
  if (req.query.sqk) {
    const lists = [];
    ["7700", "7600", "7500"].forEach((c) => lists.push(
      { url: `https://api.adsb.lol/v2/sqk/${c}`, list: "ac" },
      { url: `https://opendata.adsb.fi/api/v2/sqk/${c}`, list: "aircraft" },
      { url: `https://api.airplanes.live/v2/squawk/${c}`, list: "ac" }
    ));
    const seen = {}, ac = [];
    await Promise.all(lists.map(async (s) => {
      const host = new URL(s.url).host;
      try {
        const up = await fetch(s.url, { headers: { "User-Agent": "nest-hub-planes" }, signal: AbortSignal.timeout(6000) });
        tried.push(host + " " + up.status);
        if (!up.ok) return;
        const data = await up.json();
        (data[s.list] || []).forEach((x) => {
          // NZ and the sea around it (Kermadecs down to the Auckland Islands, Tasman to the Chathams)
          if (typeof x.lat !== "number" || x.lat > -28 || x.lat < -53 || (x.lon < 160 && x.lon > -174) || !x.hex) return;
          const old = seen[x.hex];
          if (old && (old.seen_pos == null || (x.seen_pos != null && x.seen_pos >= old.seen_pos))) return;   // keep the freshest
          if (old) ac.splice(ac.indexOf(old), 1);
          seen[x.hex] = x; ac.push(x);
        });
      } catch (e) {
        tried.push(host + " error");
      }
    }));
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=10");
    return res.status(200).json({ ac: clean(ac), tried });
  }

  for (const s of sources) {
    try {
      const up = await fetch(s.url, { headers: { "User-Agent": "nest-hub-planes" }, signal: AbortSignal.timeout(5000) });
      tried.push(new URL(s.url).host + " " + up.status);
      if (!up.ok) continue;
      const data = await up.json();
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=5");
      return res.status(200).json({ ac: clean(data[s.list] || []), src: new URL(s.url).host });
    } catch (e) {
      tried.push(new URL(s.url).host + " error");
    }
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  return res.status(503).json({ ac: [], error: "all feeds busy", tried });
};
