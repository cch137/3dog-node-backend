SELECT
  id,
  task_id,
  version,
  started_at,
  ended_at
FROM object_generation_results
WHERE task_id = @task_id
ORDER BY started_at DESC, id DESC
LIMIT 1;