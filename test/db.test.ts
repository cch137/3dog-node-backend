import fs from "node:fs";
import { webcrypto } from "node:crypto";
import { createDatabase } from "../src/services/db";

if (!globalThis.crypto?.subtle) {
  (globalThis as any).crypto = webcrypto;
}

async function rmDirWithRetry(dirname: string, retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      fs.rmSync(dirname, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

describe("services/db/index.ts", () => {
  const dbName = `test_${Date.now()}`;
  const db = createDatabase(dbName);

  const task = {
    id: "task-id-001",
    name: "Task 001",
    description: "Task 001 description",
  };

  const t0 = Date.now();
  const v1 = {
    version: "v1",
    code: "console.log('v1')",
    error: null as string | null,
    mime_type: null as string | null,
    blob_content: null as Buffer | null,
    started_at: t0,
    ended_at: t0 + 10,
  };

  const v2Blob = Buffer.from("hello");
  const v2 = {
    version: "v2",
    code: null as string | null,
    error: "runtime error",
    mime_type: "text/plain",
    blob_content: v2Blob,
    started_at: t0 + 20,
    ended_at: t0 + 30,
  };

  let v1Id = -1;
  let v2Id = -1;

  describe("queries", () => {
    it("initialize (idempotent)", async () => {
      await expect(db.queries.initialize()).resolves.toBeUndefined();
      await expect(db.queries.initialize()).resolves.toBeUndefined();
    });

    it("add_result (v1) -> returns id", async () => {
      const res = await db.queries.add_result({ task, result: v1 });
      expect(typeof res.id).toBe("number");
      expect(res.id).toBeGreaterThan(0);
      v1Id = res.id;
    });

    it("get_result/get_result_code/get_result_content (v1)", async () => {
      const row = await db.queries.get_result({
        task_id: task.id,
        version: v1.version,
      });
      expect(row).not.toBeNull();
      expect(row!.id).toBe(v1Id);
      expect(row!.task_id).toBe(task.id);
      expect(row!.version).toBe(v1.version);
      expect(row!.code).toBe(v1.code);
      expect(row!.error).toBeNull();
      expect(row!.mime_type).toBeNull();
      expect(row!.blob_content).toBeNull();
      expect(row!.started_at).toBe(v1.started_at);
      expect(row!.ended_at).toBe(v1.ended_at);

      const codeRow = await db.queries.get_result_code({
        task_id: task.id,
        version: v1.version,
      });
      expect(codeRow).toEqual({ code: v1.code, error: null });

      const contentRow = await db.queries.get_result_content({
        task_id: task.id,
        version: v1.version,
      });
      expect(contentRow).not.toBeNull();
      expect(contentRow!.mime_type).toBeNull();
      expect(contentRow!.blob_content).toBeNull();
      expect(contentRow!.error).toBeNull();
    });

    it("add_result (v2, with blob) -> returns id", async () => {
      const res = await db.queries.add_result({ task, result: v2 });
      expect(typeof res.id).toBe("number");
      expect(res.id).toBeGreaterThan(0);
      v2Id = res.id;
    });

    it("get_result_content (v2)", async () => {
      const contentRow = await db.queries.get_result_content({
        task_id: task.id,
        version: v2.version,
      });

      expect(contentRow).not.toBeNull();
      expect(contentRow!.mime_type).toBe(v2.mime_type);
      expect(contentRow!.blob_content).toEqual(v2Blob);
      expect(contentRow!.error).toBe(v2.error);
    });

    it("get_latest_version (should be v2)", async () => {
      const latest = await db.queries.get_latest_version({ task_id: task.id });
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(v2Id);
      expect(latest!.version).toBe(v2.version);
    });

    it("get_task (includes results summary)", async () => {
      const row = await db.queries.get_task({ task_id: task.id });
      expect(row).not.toBeNull();

      expect(row!.id).toBe(task.id);
      expect(row!.name).toBe(task.name);
      expect(row!.description).toBe(task.description);

      const byVersion = new Map(row!.results.map((r) => [r.version, r]));

      expect(byVersion.get(v1.version)).toEqual({
        version: v1.version,
        success: true,
        error: null,
        started_at: v1.started_at,
        ended_at: v1.ended_at,
      });

      expect(byVersion.get(v2.version)).toEqual({
        version: v2.version,
        success: false,
        error: v2.error,
        started_at: v2.started_at,
        ended_at: v2.ended_at,
      });
    });

    it("add_result rejects invalid mime/blob pairing", async () => {
      await expect(
        db.queries.add_result({
          task,
          result: {
            version: "bad",
            code: null,
            error: null,
            mime_type: "text/plain",
            blob_content: null,
            started_at: Date.now(),
            ended_at: Date.now() + 1,
          },
        })
      ).rejects.toThrow(/mime_type and blob_content/i);
    });

    it("delete_result (v1) -> true, then false; get_result -> null", async () => {
      const ok = await db.queries.delete_result({
        task_id: task.id,
        version: v1.version,
      });
      expect(ok).toBe(true);

      const after = await db.queries.get_result({
        task_id: task.id,
        version: v1.version,
      });
      expect(after).toBeNull();

      const ok2 = await db.queries.delete_result({
        task_id: task.id,
        version: v1.version,
      });
      expect(ok2).toBe(false);
    });

    it("delete_task -> true, then false; task/results gone", async () => {
      const ok = await db.queries.delete_task({ task_id: task.id });
      expect(ok).toBe(true);

      expect(await db.queries.get_task({ task_id: task.id })).toBeNull();
      expect(
        await db.queries.get_latest_version({ task_id: task.id })
      ).toBeNull();
      expect(
        await db.queries.get_result({ task_id: task.id, version: v2.version })
      ).toBeNull();

      expect(await db.queries.delete_task({ task_id: task.id })).toBe(false);
      expect(
        await db.queries.delete_result({
          task_id: task.id,
          version: v2.version,
        })
      ).toBe(false);
    });
  });

  afterAll(async () => {
    const dirname = db.dirname;

    db.close();

    // Verify closed: better-sqlite3 should throw on usage after close
    expect(() => db.prepare("select 1")).toThrow();

    await rmDirWithRetry(dirname);
    expect(fs.existsSync(dirname)).toBe(false);
  });
});
