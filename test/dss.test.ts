// test/dss.test.ts
// IMPORTANT: mock must be declared before importing dss

jest.mock("../src/lib/middlewares/route-logger", () => {
  return {
    createRouterLogger:
      () => async (_c: unknown, next: () => Promise<unknown>) => {
        await next();
      },
  };
});

import dss, { store } from "../src/routers/dss";

const LONG_POLL_TIMEOUT_MS = 30_000;

async function expectGet404(id: string) {
  jest.useFakeTimers();

  const req = dss.request(`/data/${id}`, { method: "GET" });
  await jest.advanceTimersByTimeAsync(LONG_POLL_TIMEOUT_MS);

  const res = await req;
  expect(res.status).toBe(404);

  jest.useRealTimers();
}

describe("dss (json relay)", () => {
  afterAll(() => {
    store.destroy();
  });

  it("GET /data/:id -> 404 on long-poll timeout (no data)", async () => {
    await expectGet404("timeout-001");
  });

  it("POST /data/:id -> 400 when invalid JSON", async () => {
    const res = await dss.request("/data/invalid-json-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-json",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON" });
  });

  it("POST /data/:id -> 413 when payload too large (by content-length)", async () => {
    const res = await dss.request("/data/too-large-001", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "content-length": String(4 * 1024 * 1024 + 1),
      },
      body: JSON.stringify({ ok: true }),
    });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "Payload too large" });
  });

  it("Long-poll: GET waits, then returns immediately after POST", async () => {
    const id = "lp-001";
    const payload = { type: "offer", data: "sdp", dataSeparator: "|" };

    const pendingGet = dss.request(`/data/${id}`, { method: "GET" });
    await new Promise((r) => setTimeout(r, 0)); // allow GET handler to start waiting

    const post = await dss.request(`/data/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(post.status).toBe(200);

    const get = await pendingGet;
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toEqual(payload);

    await expectGet404(id);
  });

  it("FIFO queue: POST x2 then GET x2 in order", async () => {
    const id = "fifo-001";
    const p1 = { type: "offer", data: "sdp" };
    const p2 = { type: "answer", data: "sdp2" };

    expect(
      (
        await dss.request(`/data/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(p1),
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await dss.request(`/data/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(p2),
        })
      ).status,
    ).toBe(200);

    const get1 = await dss.request(`/data/${id}`, { method: "GET" });
    expect(get1.status).toBe(200);
    await expect(get1.json()).resolves.toEqual(p1);

    const get2 = await dss.request(`/data/${id}`, { method: "GET" });
    expect(get2.status).toBe(200);
    await expect(get2.json()).resolves.toEqual(p2);

    await expectGet404(id);
  });

  it("GET deletes queue when payload.once === true (drops subsequent items)", async () => {
    const id = "once-001";
    const pOnce = { once: true, value: 1 };
    const pLater = { value: 2 };

    expect(
      (
        await dss.request(`/data/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pOnce),
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await dss.request(`/data/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pLater),
        })
      ).status,
    ).toBe(200);

    const get1 = await dss.request(`/data/${id}`, { method: "GET" });
    expect(get1.status).toBe(200);
    await expect(get1.json()).resolves.toEqual(pOnce);

    // queue deleted -> pLater gone (will 404 after long-poll timeout)
    await expectGet404(id);
  });

  it("DELETE /data/:id -> existed true then false, GET after delete -> 404 (after long-poll timeout)", async () => {
    const id = "delete-001";

    expect(
      (
        await dss.request(`/data/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hello: "world" }),
        })
      ).status,
    ).toBe(200);

    const del1 = await dss.request(`/data/${id}`, { method: "DELETE" });
    expect(del1.status).toBe(200);
    await expect(del1.json()).resolves.toEqual({ existed: true });

    const del2 = await dss.request(`/data/${id}`, { method: "DELETE" });
    expect(del2.status).toBe(200);
    await expect(del2.json()).resolves.toEqual({ existed: false });

    await expectGet404(id);
  });

  it("POST /data/:id -> 500 when queue is full (robustness)", async () => {
    const id = "full-001";

    // fill quickly
    for (let i = 0; i < 1024; i++) store.push(id, { i });

    const overflow = await dss.request(`/data/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ i: 1024 }),
    });

    expect(overflow.status).toBe(500);
    const json = await overflow.json();
    expect(json).toHaveProperty("error");
  });
});
