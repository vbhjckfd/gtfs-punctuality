import { handleApi } from "./api.js";
import { processBatch } from "./process.js";

export { Processor } from "./processor.js";

const kick = (env) => env.PROCESSOR.get(env.PROCESSOR.idFromName("main")).kick();

async function admin(request, env, url) {
  const auth = request.headers.get("authorization");
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return new Response("unauthorized", { status: 401 });
  if (url.pathname === "/admin/kick") return Response.json({ armed: await kick(env) });
  if (url.pathname === "/admin/run") {
    const limit = Math.min(40, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20);
    const after = url.searchParams.get("after") ?? undefined;
    try {
      return Response.json(await processBatch(env, { limit, startAfter: after }));
    } catch (err) {
      return Response.json({ error: String(err?.message ?? err), after }, { status: 500 });
    }
  }
  if (url.pathname === "/admin/cursor" && request.method === "POST") {
    const to = url.searchParams.get("to");
    if (!to) return new Response("missing ?to=", { status: 400 });
    await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('cursor', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(to).run();
    return Response.json({ cursor: to });
  }
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/health") ctx.waitUntil(kick(env)); // self-heal the alarm chain
      return handleApi(request, env, ctx);
    }
    if (url.pathname.startsWith("/admin/")) return admin(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
