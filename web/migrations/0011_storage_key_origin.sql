-- An existing bucket could have used either setup route. Do not guess.
ALTER TABLE tenants ADD COLUMN app_key INTEGER;
UPDATE tenants SET app_key=1 WHERE created_by_app=1;
