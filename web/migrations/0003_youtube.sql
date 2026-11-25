CREATE TABLE youtube_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL UNIQUE,
  channel_title TEXT NOT NULL,
  refresh_enc TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  scopes TEXT NOT NULL,
  obs_hash TEXT UNIQUE,
  checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE youtube_codes (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES youtube_accounts(user_id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE youtube_clips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES youtube_accounts(user_id) ON DELETE CASCADE,
  videoId TEXT UNIQUE,
  session_enc TEXT, session_key_version INTEGER, size INTEGER NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL, privacy TEXT NOT NULL,
  category TEXT NOT NULL, recordedAt TEXT NOT NULL, uploaded TEXT NOT NULL,
  durationSeconds REAL, thumbnail TEXT, status TEXT NOT NULL DEFAULT 'uploading',
  start INTEGER, end INTEGER
);
CREATE INDEX youtube_clips_owner ON youtube_clips(user_id);
