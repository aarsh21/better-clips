CREATE TABLE bucket_moves (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  move TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,source)
);
