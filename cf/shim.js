// Cloudflare Pages adapter: runs the Vercel-style api/*.js handlers ((req, res) with req.query and
// res.status().json()/send()) unchanged. Also stands in for Vercel's edge cache: answers that send
// Cache-Control s-maxage are kept in Cloudflare's cache for that long.
export function wrap(handler) {
  return async function onRequest({ request, waitUntil }) {
    const url = new URL(request.url);
    const get = request.method === "GET";
    const key = new Request(url.toString(), { method: "GET" });
    if (get) {
      const hit = await caches.default.match(key);
      if (hit) return hit;
    }
    let status = 200, body = null;
    const headers = new Headers();
    const res = {
      setHeader(k, v) { headers.set(k, v); return res; },
      status(c) { status = c; return res; },
      json(o) { headers.set("Content-Type", "application/json"); body = JSON.stringify(o); return res; },
      send(b) { body = b; return res; },
      end(b) { if (b != null) body = b; return res; }
    };
    const req = { method: request.method, headers: Object.fromEntries(request.headers), query: Object.fromEntries(url.searchParams) };
    try {
      await handler(req, res);
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    // When every upstream feed fails, answer with the last good copy (up to 5 min old) instead of an error
    const staleKey = new Request(url.toString() + (url.search ? "&" : "?") + "__stale=1", { method: "GET" });
    if (get && status >= 500) {
      const old = await caches.default.match(staleKey);
      if (old) return old;
    }
    const out = new Response(body, { status, headers });
    if (get && status === 200 && /s-maxage=\d+/.test(headers.get("Cache-Control") || "")) {
      waitUntil(caches.default.put(key, out.clone()));
      const keep = new Response(out.clone().body, { status, headers: new Headers(headers) });
      keep.headers.set("Cache-Control", "public, max-age=300");
      waitUntil(caches.default.put(staleKey, keep));
    }
    return out;
  };
}
