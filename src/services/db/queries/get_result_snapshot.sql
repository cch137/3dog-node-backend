SELECT
  s.id,
  s.type,
  s.mime_type,
  s.blob_content,
  s.created_at
FROM object_generation_snapshots s
JOIN object_generation_results r ON r.id = s.result_id
WHERE r.task_id = @task_id AND r.version = @version
ORDER BY s.created_at DESC
LIMIT 1;