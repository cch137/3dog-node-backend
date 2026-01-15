SELECT
  id,
  task_id,
  version,
  code,
  error,
  mime_type,
  blob_content,
  started_at,
  ended_at
FROM object_generation_results
WHERE task_id = @task_id AND version = @version
LIMIT 1;