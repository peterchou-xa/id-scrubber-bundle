CREATE TABLE IF NOT EXISTS scrub_metrics_hourly (
  hour      TIMESTAMPTZ NOT NULL,
  pii_type  TEXT        NOT NULL,
  count     BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, pii_type)
);

CREATE TABLE IF NOT EXISTS scrub_runs_hourly (
  hour  TIMESTAMPTZ NOT NULL PRIMARY KEY,
  runs  BIGINT      NOT NULL DEFAULT 0
);
