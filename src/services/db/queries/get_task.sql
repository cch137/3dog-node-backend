SELECT
  t.id,
  t.name,
  t.description,
  t.created_at,
  t.modified_at,
  COALESCE(
    (
      SELECT json_group_array(
        json_object(
          'version', x.version,
          'success', x.success,
          'error', x.error,
          'started_at', x.started_at,
          'ended_at', x.ended_at
        )
      )
      FROM (
        SELECT
          r.version AS version,
          (r.error IS NULL) AS success,
          r.error AS error,
          r.started_at AS started_at,
          r.ended_at AS ended_at
        FROM object_generation_results r
        WHERE r.task_id = t.id
        ORDER BY r.started_at DESC, r.id DESC
      ) x
    ),
    '[]'
  ) AS results
FROM object_generation_tasks t
WHERE t.id = @task_id
LIMIT 1;