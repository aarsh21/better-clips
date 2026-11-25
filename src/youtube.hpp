#pragma once

#include <ctime>
#include <functional>
#include <string>

/* Where saved replays go. ClipsApp and S3 use R2Config as before. */
enum class Destination { ClipsApp, S3, YouTube };
enum class YouTubeRoute { ClipsApp, Direct };

struct YouTubeSettings {
	Destination destination = Destination::ClipsApp;
	YouTubeRoute route = YouTubeRoute::ClipsApp;
	std::string refresh_token; /* Direct only; never sent to the Clips app */
	/* Set by youtube_connect_async; empty when not connected. */
	std::string app_url;      /* the hosted Clips app that keeps the Google tokens */
	std::string upload_token; /* OBS's token for that app */
	std::string channel_id;
	std::string channel_title;
	/* Upload defaults the user controls, as YouTube's policies require. */
	std::string privacy = "unlisted"; /* "private", "unlisted" or "public" */
	std::string title_template = "{game} - {date} {time}";
	std::string description;
	bool review_before_upload = false;
	int audio_track = 1; /* 1-based OBS audio track sent to YouTube */
};

YouTubeSettings get_youtube_settings();
void set_youtube_settings(const YouTubeSettings &settings);

bool youtube_direct_available(); /* false when the build has no Google client ID */
/* Opens the Clips app or Google (Direct ignores app_url), then waits on a
 * loopback port. done runs on the UI thread with a user-facing error when !ok. */
void youtube_connect_async(YouTubeRoute route, const std::string &app_url,
			   std::function<void(bool ok, const std::string &error)> done);

/* Revokes access through the current route. done runs on the UI thread after the settings update,
 * unless OBS shuts down first. */
enum class DisconnectResult { Revoked, Unpaired, Failed };
void youtube_disconnect(std::function<void(DisconnectResult result)> done);
void stop_youtube_disconnect();

/* {game}, {date} (YYYY-MM-DD) and {time} (HH:MM), at most 100 characters,
 * without < or >. */
std::string youtube_title(const std::string &title_template, const std::string &game, time_t when);

struct YouTubeUpload {
	std::string title, description, privacy;
};

/* Implemented by the UI (settings-dialog.cpp). Called on the uploader thread
 * when review_before_upload is on; blocks until the user answers. false means
 * cancel: the clip is saved to the recording folder instead. */
bool youtube_review(YouTubeUpload &upload, const std::string &channel_title);
void start_youtube_reviews();
void stop_youtube_reviews();
