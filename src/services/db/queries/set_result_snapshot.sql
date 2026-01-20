INSERT INTO object_generation_snapshots (result_id, type, mime_type, blob_content)
SELECT r.id, @type, @mime_type, @blob_content
FROM object_generation_results r
WHERE r.task_id = @task_id AND r.version = @version
LIMIT 1;