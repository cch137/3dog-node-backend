INSERT INTO object_generation_tasks (id, name, description, created_at, modified_at)
VALUES (@task_id, @task_name, @task_description, @modified_at, @modified_at)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  modified_at = excluded.modified_at
;

INSERT INTO object_generation_results (
  task_id,
  version,
  code,
  error,
  mime_type,
  blob_content,
  started_at,
  ended_at
)
VALUES (
  @task_id,
  @version,
  @code,
  @error,
  @mime_type,
  @blob_content,
  COALESCE(@started_at, (unixepoch('now') * 1000)),
  COALESCE(@ended_at,   (unixepoch('now') * 1000))
)
ON CONFLICT(task_id, version) DO UPDATE SET
  code = excluded.code,
  error = excluded.error,
  mime_type = excluded.mime_type,
  blob_content = excluded.blob_content,
  started_at = excluded.started_at,
  ended_at = excluded.ended_at
RETURNING id;