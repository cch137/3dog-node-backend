SELECT
  mime_type,
  blob_content,
  error
FROM object_generation_results
WHERE task_id = @task_id AND version = @version
LIMIT 1;