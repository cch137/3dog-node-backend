import fs from "fs";
import path from "path";
import { stringifyError } from "../../lib/utils/error-handle";
export * from "./core";
import { Database } from "./core";

type QueryMap = {
  initialize: () => Promise<void>;

  add_result: (params: {
    task: {
      id: string;
      name: string;
      description: string;
    };
    result: {
      version: string;
      code?: string | null;
      error?: string | null;
      mime_type?: string | null;
      blob_content?: Buffer | Uint8Array | null;
      started_at: number;
      ended_at: number;
    };
  }) => Promise<{ id: number }>;

  get_result: (params: { task_id: string; version: string }) => Promise<{
    id: number;
    task_id: string;
    version: string;
    code: string | null;
    error: string | null;
    mime_type: string | null;
    blob_content: Buffer | null;
    started_at: number;
    ended_at: number;
  } | null>;

  get_latest_version: (params: { task_id: string }) => Promise<{
    id: number;
    task_id: string;
    version: string;
    started_at: number;
    ended_at: number;
  } | null>;

  get_task: (params: { task_id: string }) => Promise<{
    id: string;
    name: string;
    description: string;
    created_at: number;
    modified_at: number;
    results: Array<{
      version: string;
      success: boolean;
      error: string | null;
      started_at: number;
      ended_at: number;
    }>;
  } | null>;

  get_result_code: (params: { task_id: string; version?: string }) => Promise<{
    code: string | null;
    error: string | null;
  } | null>;

  get_result_content: (params: {
    task_id: string;
    version?: string;
  }) => Promise<{
    mime_type: string | null;
    blob_content: Buffer | null;
    error: string | null;
  } | null>;

  delete_task: (params: { task_id: string }) => Promise<boolean>;

  delete_result: (params: {
    task_id: string;
    version: string;
  }) => Promise<boolean>;

  get_result_snapshot: (params: {
    task_id: string;
    version?: string;
  }) => Promise<{
    id: number;
    type: string;
    mime_type: string;
    blob_content: Buffer;
    created_at: number;
  } | null>;

  set_result_snapshot: (params: {
    task_id: string;
    version?: string;
    type: string;
    mime_type: string;
    blob_content: Buffer | Uint8Array;
  }) => Promise<{ id: number } | null>;
};

async function sha256(data: string | Uint8Array) {
  const array = Uint8Array.from(
    typeof data === "string" ? new TextEncoder().encode(data) : data,
  );
  const buf = await crypto.subtle.digest("SHA-256", array);
  const hex = [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hex;
}

export function createDatabase(name: string) {
  return new Database<QueryMap>(name, {
    initialize: {
      file: "0001_initialization",
      migration: true,
      build:
        ({ db, sql }) =>
        async () => {
          db.pragma("journal_mode = WAL");
          db.pragma("foreign_keys = ON");
          db.pragma("busy_timeout = 5000");

          // We need to strictly verify the initialization SQL because schema differences can cause major issues;
          // other queries don’t need this level of checking.
          const checksum = await sha256(sql);
          const checksumFilepath = path.join(db.dirname, "checksum.sha256");

          if (fs.existsSync(checksumFilepath)) {
            const hash = await fs.promises.readFile(checksumFilepath, "utf8");
            if (hash === checksum) {
              db.log("database schema already initialized");
              return;
            }
            throw new Error("database schema checksum mismatch");
          }

          db.exec(sql);
          await fs.promises.writeFile(checksumFilepath, checksum);
          db.log("database schema initialized");
        },
    },

    add_result:
      ({ db, sql }) =>
      async ({ task, result }) => {
        // Enforce the table CHECK constraint expectations
        const mime = result.mime_type ?? null;
        const blob = result.blob_content ?? null;
        if ((mime === null) !== (blob === null)) {
          throw new Error(
            "mime_type and blob_content must both be null or both be non-null",
          );
        }

        // The SQL file contains 2 statements:
        // 1) upsert task
        // 2) upsert result + RETURNING id
        const parts = sql
          .split(/;\s*\n+/)
          .map((s) => s.trim())
          .filter(Boolean);

        if (parts.length !== 2) {
          throw new Error(
            `add_result.sql must contain exactly 2 statements, got ${parts.length}`,
          );
        }

        const upsertTaskSql = parts[0] + ";";
        const upsertResultSql = parts[1] + ";";

        const upsertTaskStmt = db.prepare(upsertTaskSql);
        const upsertResultStmt = db.prepare(upsertResultSql);

        const run = db.transaction(() => {
          upsertTaskStmt.run({
            task_id: task.id,
            task_name: task.name ?? "",
            task_description: task.description ?? "",
            modified_at: Date.now(),
          });

          const row = upsertResultStmt.get({
            task_id: task.id,
            version: result.version,
            code: result.code ?? null,
            error: result.error ?? null,
            mime_type: mime,
            blob_content: blob,
            started_at: result.started_at ?? null,
            ended_at: result.ended_at ?? null,
          }) as { id: number } | undefined;

          if (!row) throw new Error("add_result: missing RETURNING id");
          return row;
        });

        return run();
      },

    get_result:
      ({ db, sql }) =>
      async ({ task_id, version }) => {
        const stmt = db.prepare(sql);
        const row = stmt.get({ task_id, version }) as
          | {
              id: number;
              task_id: string;
              version: string;
              code: string | null;
              error: string | null;
              mime_type: string | null;
              blob_content: Buffer | null;
              started_at: number;
              ended_at: number;
            }
          | undefined;

        return row ?? null;
      },

    get_latest_version:
      ({ db, sql }) =>
      async ({ task_id }) => {
        const stmt = db.prepare(sql);
        const row = stmt.get({ task_id }) as
          | {
              id: number;
              task_id: string;
              version: string;
              started_at: number;
              ended_at: number;
            }
          | undefined;

        return row ?? null;
      },

    get_task:
      ({ db, sql }) =>
      async ({ task_id }) => {
        const stmt = db.prepare(sql);

        const row = stmt.get({ task_id }) as
          | {
              id: string;
              name: string;
              description: string;
              created_at: number;
              modified_at: number;
              results: string;
            }
          | undefined;

        if (!row) return null;

        const resultsRaw = JSON.parse(row.results) as Array<{
          version: string;
          success: 0 | 1 | boolean;
          error: string | null;
          started_at: number;
          ended_at: number;
        }>;

        return {
          id: row.id,
          name: row.name,
          description: row.description,
          created_at: row.created_at,
          modified_at: row.modified_at,
          results: resultsRaw.map((r) => ({
            version: r.version,
            success: Boolean(r.success),
            error: r.error ?? null,
            started_at: r.started_at ?? null,
            ended_at: r.ended_at ?? null,
          })),
        };
      },

    get_result_code:
      ({ db, sql }) =>
      async ({ task_id, version }) => {
        version ??= (await db.queries.get_latest_version({ task_id }))?.version;
        if (!version) return null;
        const stmt = db.prepare(sql);
        const row = stmt.get({ task_id, version }) as
          | { code: string | null; error: string | null }
          | undefined;

        return row ?? null;
      },

    get_result_content:
      ({ db, sql }) =>
      async ({ task_id, version }) => {
        version ??= (await db.queries.get_latest_version({ task_id }))?.version;
        if (!version) return null;
        const stmt = db.prepare(sql);
        const row = stmt.get({ task_id, version }) as
          | {
              mime_type: string | null;
              blob_content: Buffer | null;
              error: string | null;
            }
          | undefined;

        return row ?? null;
      },

    delete_task:
      ({ db, sql }) =>
      async ({ task_id }) => {
        const stmt = db.prepare(sql);
        const row = stmt.get({ task_id }) as { id: string } | undefined;
        return Boolean(row);
      },

    delete_result:
      ({ db, sql }) =>
      async ({ task_id, version }) => {
        const stmt = db.prepare(sql);
        const row = stmt.get({ task_id, version }) as
          | { id: number }
          | undefined;
        return Boolean(row);
      },

    get_result_snapshot:
      ({ db, sql }) =>
      async ({ task_id, version }) => {
        version ??= (await db.queries.get_latest_version({ task_id }))?.version;
        if (!version) return null;

        const stmt = db.prepare(sql);
        const row = stmt.get({ task_id, version }) as
          | {
              id: number;
              type: string;
              mime_type: string;
              blob_content: Buffer;
              created_at: number;
            }
          | undefined;

        return row ?? null;
      },

    set_result_snapshot:
      ({ db, sql }) =>
      async ({ task_id, version, type, mime_type, blob_content }) => {
        version ??= (await db.queries.get_latest_version({ task_id }))?.version;
        if (!version) return null;

        const stmt = db.prepare(sql);
        const info = stmt.run({
          task_id,
          version,
          type,
          mime_type,
          blob_content,
        });

        if (info.changes === 0) return null;
        return { id: Number(info.lastInsertRowid) };
      },
  });
}

export const connect = (() => {
  let _db: ReturnType<typeof createDatabase> | null = null;
  let connectionPending: Promise<void> | null = null;

  return async () => {
    const db = _db ?? createDatabase("main");

    if (!_db) _db = db;

    connectionPending ??= db.queries
      .initialize()
      .then(() => {
        const close = () => {
          try {
            db.close();
          } catch (err) {
            db.log("closing error:", stringifyError(err));
          }
        };

        process.on("SIGINT", close);
        process.on("SIGTERM", close);
      })
      .catch((err) => {
        db.log("initialization error:", stringifyError(err));
        process.exit(1);
      });

    await connectionPending;

    // Avoid calling `close` on the DB instance obtained via `connect`.
    return db as Omit<typeof db, "close">;
  };
})();
