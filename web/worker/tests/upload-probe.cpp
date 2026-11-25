/* Linux integration driver. The network code is the plugin's real translation
 * unit; this just supplies the clip normally handed over by the muxer. */
#include "replay-r2.hpp"
#include <QDesktopServices>
#include <QGuiApplication>
#include <QFile>
#include <QNetworkAccessManager>
#include <iostream>
#include <thread>

static YouTubeSettings settings;
YouTubeSettings get_youtube_settings()
{
	return settings;
}
void set_youtube_settings(const YouTubeSettings &s)
{
	settings = s;
}

class Browser : public QObject {
	Q_OBJECT
	QNetworkAccessManager net;
public slots:
	void open(QUrl url) { net.get(QNetworkRequest(url)); }
};
#include "upload-probe.moc"

void notify_user(const std::string &message, const std::string &link)
{
	if (!link.empty())
		std::abort(); /* A ready toast must not replace the clipboard again. */
	std::cerr << message << std::endl;
	QCoreApplication::quit();
}

int main(int argc, char **argv)
{
	// Keep stdout reserved for the upload link, like the OBS clipboard.
	base_set_log_handler(
		[](int, const char *fmt, va_list args, void *) {
			vfprintf(stderr, fmt, args);
			fputc('\n', stderr);
		},
		nullptr);
	QGuiApplication app(argc, argv);
	QObject monitor;
	if (argc == 2) {
		std::string action(argv[1]);
		Browser browser;
		QDesktopServices::setUrlHandler("http", &browser, "open");
		if (action == "connect") {
			youtube_connect_async(YouTubeRoute::Direct, "must be ignored",
					      [&](bool ok, const std::string &error) {
						      if (!ok || settings.route != YouTubeRoute::Direct ||
							  settings.channel_id != "UC-local-testing" ||
							  settings.channel_title != "Local channel" ||
							  !settings.upload_token.empty() ||
							  settings.refresh_token != "testing-refresh") {
							      std::cerr << error;
							      std::abort();
						      }
						      app.quit();
					      });
		} else {
			settings.route = YouTubeRoute::Direct;
			settings.refresh_token = "testing-refresh";
			youtube_disconnect([&](DisconnectResult result) {
				bool failed = result == DisconnectResult::Failed;
				if (failed != (settings.refresh_token == "testing-refresh") ||
				    action != (failed                                ? "failed"
					       : result == DisconnectResult::Revoked ? "revoked"
										     : "unpaired"))
					std::abort();
				app.quit();
			});
		}
		app.exec();
		stop_youtube_disconnect();
		return 0;
	}
	if (argc != 3)
		return 2;
	Clip clip;
	if (std::string(argv[1]) == "direct") {
		clip.youtube.route = YouTubeRoute::Direct;
		std::getline(std::cin, clip.youtube.refresh_token);
	} else {
		clip.youtube.app_url = argv[1];
		std::getline(std::cin, clip.youtube.upload_token);
	}
	clip.game = "Game α";
	clip.recorded_at = 1722111031;
	YouTubeUpload details{youtube_title("<{game}>", clip.game, clip.recorded_at), "Two audio devices", "unlisted"};
	QFile file(argv[2]);
	if (!file.open(QIODevice::ReadOnly))
		return 2;
	auto bytes = file.readAll();
	std::vector<uint8_t> mp4(bytes.begin(), bytes.end());
	int result = 1;
	std::thread uploader([&] {
		YouTubeSession session;
		std::string link, error;
		for (int i = 0; i < 4; ++i) {
			if (youtube_upload(clip, details, mp4, session, link, error)) {
				std::cout << link << std::endl;
				youtube_watch(&monitor, clip.youtube, session.clip_id, details.title);
				std::cerr << "Uploader released" << std::endl;
				result = 0;
				break;
			}
			std::cerr << error << std::endl;
			if (session.permanent_failure) {
				result = 3;
				break;
			}
		}
		if (result)
			QMetaObject::invokeMethod(&app, "quit", Qt::QueuedConnection);
	});
	app.exec();
	uploader.join();
	return result;
}
