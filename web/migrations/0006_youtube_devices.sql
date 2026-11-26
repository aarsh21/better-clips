CREATE TABLE youtube_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES youtube_accounts(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  last_seen INTEGER
);
CREATE INDEX youtube_devices_owner ON youtube_devices(user_id);
INSERT INTO youtube_devices(id,user_id,token_hash)
  SELECT lower(hex(randomblob(16))),user_id,obs_hash FROM youtube_accounts WHERE obs_hash IS NOT NULL;
-- Migrations precede the Worker deploy. Let the previous Worker authenticate
-- existing devices and capture exchanges it finishes during the rollout.
CREATE TRIGGER legacy_obs_exchange AFTER UPDATE OF obs_hash ON youtube_accounts
WHEN NEW.obs_hash IS NOT NULL AND NEW.obs_hash IS NOT OLD.obs_hash
BEGIN
  INSERT INTO youtube_devices(id,user_id,token_hash)
    VALUES(lower(hex(randomblob(16))),NEW.user_id,NEW.obs_hash);
END;
CREATE TRIGGER clear_legacy_obs AFTER DELETE ON youtube_devices BEGIN
  UPDATE youtube_accounts SET obs_hash=NULL WHERE obs_hash=OLD.token_hash;
END;
