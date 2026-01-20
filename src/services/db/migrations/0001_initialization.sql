CREATE TABLE IF NOT EXISTS object_generation_tasks (
  id        TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  modified_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE TRIGGER IF NOT EXISTS trg_object_generation_tasks_modified_at
AFTER UPDATE ON object_generation_tasks
FOR EACH ROW
WHEN NEW.modified_at = OLD.modified_at
BEGIN
  UPDATE object_generation_tasks
  SET modified_at = (unixepoch('now') * 1000)
  WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS object_generation_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  version       TEXT NOT NULL, -- e.g. "1", "v2", "2026-01-08", "exp-a"
  code          TEXT,
  error         TEXT,

  mime_type     TEXT,          -- e.g. model/gltf+json, model/gltf-binary
  blob_content  BLOB,

  started_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  ended_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),

  FOREIGN KEY (task_id) REFERENCES object_generation_tasks(id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (task_id, version),

  CHECK (
    (mime_type IS NULL AND blob_content IS NULL) OR
    (mime_type IS NOT NULL AND blob_content IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_object_generation_results_task
ON object_generation_results(task_id);

CREATE TABLE IF NOT EXISTS object_generation_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  result_id    INTEGER NOT NULL,
  type         TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  blob_content BLOB NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  FOREIGN KEY (result_id) REFERENCES object_generation_results(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_object_generation_snapshots_result
ON object_generation_snapshots(result_id);
