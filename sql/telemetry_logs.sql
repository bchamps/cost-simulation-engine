-- Table to store telemetry events (clicks, AI prompts, session time)
CREATE TABLE IF NOT EXISTS analytics_telemetry (
  event_id STRING,
  event_name STRING,
  tab_name STRING,
  user_role STRING,
  metadata JSON,
  timestamp TIMESTAMP
) PARTITION BY DATE(timestamp);
