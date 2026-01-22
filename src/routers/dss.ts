import { Hono } from "hono";
import debug from "debug";
import { EventEmitter } from "node:events";

import { stringifyError } from "../lib/utils/error-handle";
import { createRouterLogger } from "../lib/middlewares/route-logger";

const log = debug("dss");
const bodyLog = log.extend("body");

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const INACTIVITY_TTL_MS = 10 * 60 * 1000;
const MAX_QUEUE_SIZE = 256; // max records per queue
const MAX_POST_DATA_BYTES = 4 * 1024 * 1024;
const LONG_POLL_TIMEOUT_MS = 30_000;

export class RelayQueue<T = unknown> {
  private items: T[] = [];
  public readonly createdAtMs: number;
  private _lastUpdatedAtMs: number;

  get lastUpdatedAtMs() {
    return this._lastUpdatedAtMs;
  }

  constructor() {
    const now = Date.now();
    this.createdAtMs = now;
    this._lastUpdatedAtMs = now;
  }

  push(payload: T): void {
    if (this.items.length >= MAX_QUEUE_SIZE) {
      throw new Error("Queue is full");
    }
    this.items.push(payload);
    this.touch();
  }

  pop(): T | undefined {
    this.touch();
    return this.items.shift();
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  private touch() {
    this._lastUpdatedAtMs = Date.now();
  }
}

export class RelayStore<T = unknown> {
  private readonly queues = new Map<string, RelayQueue<T>>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private destroyed = false;

  // Emitter for long-polling notifications
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly inactivityTtlMs: number,
    cleanupIntervalMs: number,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  push(id: string, payload: T): void {
    if (this.destroyed) {
      throw new Error("Store is destroyed");
    }

    let queue = this.queues.get(id);
    if (!queue) {
      queue = new RelayQueue<T>();
      this.queues.set(id, queue);
    }
    queue.push(payload);

    // Notify waiters immediately
    this.emitter.emit(this.eventName(id));
  }

  pop(id: string): T | undefined {
    if (this.destroyed) {
      throw new Error("Store is destroyed");
    }

    const queue = this.queues.get(id);
    if (!queue) return undefined;

    const payload = queue.pop();
    if (queue.isEmpty()) {
      this.queues.delete(id);
    }
    return payload;
  }

  delete(id: string) {
    if (this.destroyed) {
      throw new Error("Store is destroyed");
    }

    return this.queues.delete(id);
  }

  /**
   * Long-polling: wait up to `timeoutMs` for any data pushed into `id` queue,
   * then pop and return it. Returns `undefined` on timeout.
   */
  async waitPop(id: string, timeoutMs: number): Promise<T | undefined> {
    if (this.destroyed) {
      throw new Error("Store is destroyed");
    }

    // Fast path
    const immediate = this.pop(id);
    if (immediate !== undefined) return immediate;

    const evt = this.eventName(id);

    return await new Promise<T | undefined>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        this.emitter.removeListener(evt, onData);
      };

      const settle = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onData = () => {
        try {
          // Pop after notification
          const payload = this.pop(id);
          if (payload !== undefined) settle(payload);
          // If somehow undefined (race), keep waiting until timeout.
        } catch (e) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(e);
        }
      };

      this.emitter.on(evt, onData);

      // Avoid missing pushes between "fast path" and listener registration
      try {
        const afterListen = this.pop(id);
        if (afterListen !== undefined) return settle(afterListen);
      } catch (e) {
        settled = true;
        cleanup();
        return reject(e);
      }

      const timer = setTimeout(() => settle(undefined), timeoutMs);
    });
  }

  private eventName(id: string) {
    return `data:${id}`;
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, queue] of this.queues.entries()) {
      if (now - queue.lastUpdatedAtMs >= this.inactivityTtlMs) {
        this.queues.delete(id);
      }
    }
  }

  get isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.queues.clear();
    clearInterval(this.cleanupTimer);
    this.emitter.removeAllListeners();
    this.destroyed = true;
  }
}

export const store = new RelayStore<unknown>(
  INACTIVITY_TTL_MS,
  CLEANUP_INTERVAL_MS,
);

const app = new Hono();
const dss = new Hono();

dss.use(createRouterLogger(log));

// POST /data/:id  (JSON only)
dss.post("/:id", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_POST_DATA_BYTES) {
    return c.json({ error: "Payload too large" }, 413);
  }

  let body: unknown;
  try {
    body = await c.req.json();
    bodyLog(body);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  try {
    const id = c.req.param("id");
    store.push(id, body);
    return c.body(null, 200);
  } catch (error) {
    return c.json({ error: stringifyError(error) }, 500);
  }
});

// GET /data/:id  (long polling)
dss.get("/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const payload = await store.waitPop(id, LONG_POLL_TIMEOUT_MS);

    if (
      payload &&
      typeof payload === "object" &&
      "once" in payload &&
      payload.once === true
    ) {
      store.delete(id);
    }

    if (payload === undefined) {
      return c.body(null, 404);
    }

    return c.json(payload, 200);
  } catch (error) {
    return c.json({ error: stringifyError(error) }, 500);
  }
});

// DELETE /data/:id
dss.delete("/:id", (c) => {
  const id = c.req.param("id");

  try {
    return c.json({ existed: store.delete(id) }, 200);
  } catch (error) {
    return c.json({ error: stringifyError(error) }, 500);
  }
});

app.route("/data/", dss);

export default app;
