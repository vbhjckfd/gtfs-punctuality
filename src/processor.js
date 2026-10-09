import { DurableObject } from "cloudflare:workers";
import { processBatch, newContext, dumpContext, loadContext } from "./process.js";

// The Processor owns all detection work.
//
// * A Durable Object alarm chain stands in for a cron trigger (the Workers
//   Free plan allows 5 per account). Each alarm consumes the next archived
//   snapshots, then re-arms; /api/health (or /admin/kick) restarts the chain.
// * Pending departures (buses waiting at the terminus) are kept in this
//   object's storage as one blob per stream, written once per batch. The
//   object is evicted between alarms, so in-memory state alone is lost every
//   time (the first write-once version relied on it and confirmed nothing).
// * Live processing and replays (backfill) go through one queue.
const STREAMS = ["live", "replay"];

export class Processor extends DurableObject {
  #cx = {};
  #queue = Promise.resolve();
  #diag = { bornAt: new Date().toISOString(), liveBatches: 0, liveConfirmed: 0 };

  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #context(name) {
    if (!this.#cx[name]) this.#cx[name] = loadContext(await this.ctx.storage.get(name));
    return this.#cx[name];
  }

  // Process one batch on a stream; persist its context only if D1 accepted the writes.
  async #batch(name, opts) {
    const cx = await this.#context(name);
    try {
      const stat = await processBatch(this.env, cx, opts);
      const blob = dumpContext(cx);
      await this.ctx.storage.put(name, blob);
      stat.stateBytes = JSON.stringify(blob).length;
      return stat;
    } catch (err) {
      delete this.#cx[name]; // reload the last stored state next time
      // stored, not just in memory: the object is evicted between alarms
      await this.ctx.storage.put("lastError", { stream: name, message: String(err?.message ?? err), at: new Date().toISOString() });
      throw err;
    }
  }

  async kick() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 1000);
    return true;
  }

  async state() {
    const out = { ...this.#diag, lastError: (await this.ctx.storage.get("lastError")) ?? null };
    for (const n of STREAMS) {
      const cx = await this.#context(n);
      out[n] = { pending: cx.pending.size, done: cx.done.size, cursor: cx.cursor };
    }
    return out;
  }

  /** One replay batch starting after `after` (backfill). */
  run({ limit, after }) {
    return this.#serial(() => this.#batch("replay", { limit, startAfter: after }));
  }

  // Re-arm: right away while behind the archive (catch-up after an outage),
  // the normal interval when caught up, and slowly after an error (a D1 daily
  // quota block lasts until 00:00 UTC; retrying every 30 s only burns requests).
  async alarm() {
    const every = parseInt(this.env.INTERVAL_SEC ?? "30", 10) * 1000;
    let next = every;
    try {
      await this.#serial(async () => {
        const stat = await this.#batch("live", { limit: parseInt(this.env.BATCH_SNAPSHOTS ?? "10", 10) });
        this.#diag.liveBatches++;
        this.#diag.liveConfirmed += stat.confirmed;
        console.log(JSON.stringify({ evt: "batch", ...stat }));
        if (!stat.caughtUp) next = 2000;
        await this.#maybePrune();
      });
    } catch (err) {
      next = 5 * 60_000;
      console.error(JSON.stringify({ evt: "batch_error", message: String(err?.message ?? err) }));
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + next);
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
