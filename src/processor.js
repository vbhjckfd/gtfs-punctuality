import { DurableObject } from "cloudflare:workers";
import { processBatch, newContext } from "./process.js";

// The Processor owns all detection work.
//
// * A Durable Object alarm chain stands in for a cron trigger (the Workers
//   Free plan allows 5 per account). Each alarm consumes the next archived
//   snapshots, then re-arms; /api/health (or /admin/kick) restarts the chain.
// * Pending departures (buses waiting at the terminus) live in this object's
//   memory, so D1 is written only when a departure is confirmed.
// * Live processing and replays (backfill) go through one queue, so they never
//   race each other on D1.
export class Processor extends DurableObject {
  live = newContext();
  replay = newContext();
  #queue = Promise.resolve();

  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async kick() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 1000);
    return true;
  }

  /** One replay batch starting after `after` (backfill). */
  run({ limit, after }) {
    return this.#serial(async () => {
      try {
        return await processBatch(this.env, this.replay, { limit, startAfter: after });
      } catch (err) {
        this.replay = newContext();
        throw err;
      }
    });
  }

  async alarm() {
    const every = parseInt(this.env.INTERVAL_SEC ?? "30", 10) * 1000;
    try {
      await this.#serial(async () => {
        try {
          const stat = await processBatch(this.env, this.live, { limit: parseInt(this.env.BATCH_SNAPSHOTS ?? "10", 10) });
          console.log(JSON.stringify({ evt: "batch", ...stat }));
        } catch (err) {
          this.live = newContext(); // back to the persisted cursor
          throw err;
        }
        await this.#maybePrune();
      });
    } catch (err) {
      console.error(JSON.stringify({ evt: "batch_error", message: String(err?.message ?? err) }));
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + every);
    }
  }

  // Once a day after 01:00 UTC drop old per-departure rows (aggregates stay).
  async #maybePrune() {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() < 1 || (await this.ctx.storage.get("pruned")) === today) return;
    const keep = parseInt(this.env.KEEP_DEPARTURE_DAYS ?? "45", 10);
    // actual_ts has an index; planned_ts alone would scan the table
    await this.env.DB.prepare("DELETE FROM departures WHERE actual_ts < ?").bind(Math.floor(Date.now() / 1000) - keep * 86400).run();
    await this.ctx.storage.put("pruned", today);
  }
}
