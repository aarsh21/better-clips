ALTER TABLE youtube_accounts ADD COLUMN grant_id TEXT;
UPDATE youtube_accounts SET grant_id=lower(hex(randomblob(16)));
CREATE TRIGGER legacy_youtube_grant AFTER INSERT ON youtube_accounts WHEN NEW.grant_id IS NULL BEGIN
  UPDATE youtube_accounts SET grant_id=lower(hex(randomblob(16))) WHERE user_id=NEW.user_id;
END;
