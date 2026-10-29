// Deno Deploy relay: runs the Vercel-style api/feed.js unchanged, for when the feeds refuse Cloudflare's addresses.
// Entry point for the Deno Deploy app. Answers are cached in memory for at least MIN_TTL seconds (this is only the fallback, so a little stale is fine
// and it keeps the free Deno allowance (memory time) from running out).
import { createRequire } from "node:module";
const handler = createRequire(import.meta.url)("../api/feed.js");
const cache = new Map();
const MIN_TTL = 25;

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
  if (url.pathname !== "/api/feed" && url.pathname !== "/") return new Response("not found", { status: 404 });
  const key = url.search;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return new Response(hit.body, { status: 200, headers: hit.headers });
  let status = 200, body = "";
  const headers = new Headers(cors);
  const res = {
    setHeader(k, v) { headers.set(k, v); return res; },
    status(c) { status = c; return res; },
    json(o) { headers.set("Content-Type", "application/json"); body = JSON.stringify(o); return res; }
  };
  try {
    await handler({ method: "GET", headers: {}, query: Object.fromEntries(url.searchParams) }, res);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
  }
  const m = /s-maxage=(\d+)/.exec(headers.get("Cache-Control") || "");
  if (status === 200 && m) {
    if (cache.size > 200) cache.clear();
    cache.set(key, { body, headers, until: Date.now() + Math.max(m[1], MIN_TTL) * 1000 });
  }
  return new Response(body, { status, headers });
});
