-- No default: an older OBS client may use only a choice the owner has made.
ALTER TABLE youtube_accounts ADD COLUMN default_made_for_kids INTEGER
  CHECK (default_made_for_kids IN (0, 1));
