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

describe("dss (json relay)", () => {
  afterAll(() => {
    store.destroy();
  });

  it("GET /data/:id -> 404 when no data", async () => {
    const res = await dss.request("/data/test-id-001", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("POST /data/:id -> 400 when invalid JSON", async () => {
    const res = await dss.request("/data/test-id-002", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-json",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON" });
  });

  it("POST /data/:id -> 413 when payload too large (by content-length)", async () => {
    const res = await dss.request("/data/test-id-003", {
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

  it("POST then GET -> returns same JSON", async () => {
    const id = "test-id-004";
    const payload = { type: "offer", data: "sdp", dataSeparator: "|" };

    const post = await dss.request(`/data/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(post.status).toBe(200);

    const get = await dss.request(`/data/${id}`, { method: "GET" });
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toEqual(payload);

    const get2 = await dss.request(`/data/${id}`, { method: "GET" });
    expect(get2.status).toBe(404);
  });

  it("FIFO queue: POST x2 then GET x2 in order", async () => {
    const id = "test-id-005";
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

    const get3 = await dss.request(`/data/${id}`, { method: "GET" });
    expect(get3.status).toBe(404);
  });

  it("GET deletes queue when payload.once === true", async () => {
    const id = "test-id-006";
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

    // queue should be deleted, so pLater is gone
    const get2 = await dss.request(`/data/${id}`, { method: "GET" });
    expect(get2.status).toBe(404);
  });

  it("DELETE /data/:id -> existed true then false", async () => {
    const id = "test-id-007";
    const payload = { hello: "world" };

    expect(
      (
        await dss.request(`/data/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).status,
    ).toBe(200);

    const del1 = await dss.request(`/data/${id}`, { method: "DELETE" });
    expect(del1.status).toBe(200);
    await expect(del1.json()).resolves.toEqual({ existed: true });

    const del2 = await dss.request(`/data/${id}`, { method: "DELETE" });
    expect(del2.status).toBe(200);
    await expect(del2.json()).resolves.toEqual({ existed: false });

    const get = await dss.request(`/data/${id}`, { method: "GET" });
    expect(get.status).toBe(404);
  });

  it("POST /data/:id -> 500 when queue is full", async () => {
    const id = "test-id-008";

    for (let i = 0; i < 256; i++) {
      const res = await dss.request(`/data/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ i }),
      });
      expect(res.status).toBe(200);
    }

    const overflow = await dss.request(`/data/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ i: 256 }),
    });
    expect(overflow.status).toBe(500);
    const json = await overflow.json();
    expect(json).toHaveProperty("error");
  });
});
