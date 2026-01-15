DELETE FROM object_generation_tasks
WHERE id = @task_id
RETURNING id;