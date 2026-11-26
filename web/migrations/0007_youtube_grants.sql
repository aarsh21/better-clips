ALTER TABLE youtube_accounts ADD COLUMN grant_id TEXT;
UPDATE youtube_accounts SET grant_id=lower(hex(randomblob(16)));
