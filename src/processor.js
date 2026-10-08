import { DurableObject } from "cloudflare:workers";
import { processBatch } from "./process.js";

// A Durable Object alarm chain stands in for a cron trigger: the Workers Free
// plan allows only 5 cron triggers per account. SQLite-backed Durable Objects
// are available on the free plan. Each alarm consumes the next archived
// snapshots, then re-arms itself; any request to /api/health (or /admin/kick)
// restarts the chain if it ever stops.
export class Processor extends DurableObject {
  async kick() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 1000);
    return true;
  }

  async alarm() {
    const every = parseInt(this.env.INTERVAL_SEC ?? "30", 10) * 1000;
    try {
      const stat = await processBatch(this.env, { limit: parseInt(this.env.BATCH_SNAPSHOTS ?? "10", 10) });
      console.log(JSON.stringify({ evt: "batch", ...stat }));
      await this.#maybePrune();
    } catch (err) {
      console.error(JSON.stringify({ evt: "batch_error", message: String(err?.message ?? err) }));
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + every);
    }
  }

  // Once a day shortly after 01:20 UTC drop old per-departure rows (aggregates stay).
  async #maybePrune() {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() < 1 || (await this.ctx.storage.get("pruned")) === today) return;
    const keep = parseInt(this.env.KEEP_DEPARTURE_DAYS ?? "45", 10);
    await this.env.DB.prepare("DELETE FROM departures WHERE planned_ts < ?").bind(Math.floor(Date.now() / 1000) - keep * 86400).run();
    await this.ctx.storage.put("pruned", today);
  }
}
