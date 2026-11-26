-- Remember that a connected channel had library entries, even if the last
-- entry was removed from another browser or by scheduled reconciliation.
ALTER TABLE youtube_accounts ADD COLUMN had_clips INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER youtube_library_emptied AFTER DELETE ON youtube_clips
WHEN OLD.videoId IS NOT NULL BEGIN
  UPDATE youtube_accounts SET had_clips=1 WHERE user_id=OLD.user_id AND had_clips=0;
END;
