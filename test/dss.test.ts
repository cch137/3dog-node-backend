import dss, { store } from "../routers/dss";

describe("dss", () => {
  it("GET /data/test-id-001 -> 404 when no data", async () => {
    const res = await dss.request("/data/test-id-001", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("POST /data/test-id-001 -> 200", async () => {
    const res = await dss.request("/data/test-id-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "offer", data: "sdp" }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /data/test-id-002 -> 200", async () => {
    const res = await dss.request("/data/test-id-002", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "offer",
        data: "sdp",
        dataSeparator: "|",
      }),
    });
    expect(res.status).toBe(200);
  });

  describe("queries", () => {
    it("inserts data (x1)", async () => {
      const res = await dss.request("/data/test-id-003", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "offer",
          data: "sdp",
          dataSeparator: "|",
        }),
      });
      expect(res.status).toBe(200);
    });

    it("inserts data (x2)", async () => {
      const res = await dss.request("/data/test-id-003", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "answer",
          data: "sdp2",
          dataSeparator: "|",
        }),
      });
      expect(res.status).toBe(200);
    });

    it("reads back data (x1)", async () => {
      const res = await dss.request("/data/test-id-003", { method: "GET" });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toEqual({
        type: "offer",
        data: "sdp",
        dataSeparator: "|",
      });
    });

    it("reads back data (x2)", async () => {
      const res = await dss.request("/data/test-id-003", { method: "GET" });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toEqual({
        type: "answer",
        data: "sdp2",
        dataSeparator: "|",
      });
    });

    it("gets 404 when there is no data", async () => {
      const res = await dss.request("/data/test-id-003", { method: "GET" });
      expect(res.status).toBe(404);
    });
  });

  afterAll(() => {
    store.destroy();
  });
});
