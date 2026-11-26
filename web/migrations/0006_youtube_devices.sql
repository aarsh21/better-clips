CREATE TABLE youtube_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES youtube_accounts(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  last_seen INTEGER
);
CREATE INDEX youtube_devices_owner ON youtube_devices(user_id);
INSERT INTO youtube_devices(id,user_id,token_hash)
  SELECT lower(hex(randomblob(16))),user_id,obs_hash FROM youtube_accounts WHERE obs_hash IS NOT NULL;
UPDATE youtube_accounts SET obs_hash=NULL WHERE obs_hash IS NOT NULL;
