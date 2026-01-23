import { getConnInfo } from "@hono/node-server/conninfo";
import type { Debugger } from "debug";
import type { Context, Next } from "hono";

export function createRouterLogger(log: Debugger) {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    await next();

    const ms = Date.now() - start;
    const info = getConnInfo(c);
    const ip = info.remote.address;
    const method = c.req.method;
    const url = c.req.url;
    const status = c.res.status;
    const contentLength = c.res.headers.get("content-length") ?? "0";

    log(`${method} ${status} ${url} (${contentLength}b) (${ms}ms) ${ip}`);
  };
}
