SELECT
  code,
  error
FROM object_generation_results
WHERE task_id = @task_id AND version = @version
LIMIT 1;