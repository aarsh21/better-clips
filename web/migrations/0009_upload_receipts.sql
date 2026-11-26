ALTER TABLE uploads ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
DROP INDEX uploads_by_key;
CREATE UNIQUE INDEX uploads_by_key ON uploads(tenant_id,key) WHERE completed=0;
