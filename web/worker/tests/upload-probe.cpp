/* Linux integration driver. The network code is the plugin's real translation
 * unit; this just supplies the clip normally handed over by the muxer. */
#include "replay-r2.hpp"
#include <QCoreApplication>
#include <QFile>
#include <QNetworkAccessManager>
#include <iostream>
#include <thread>

void notify_user(const std::string &message, const std::string &link)
{
	if (!link.empty())
		std::abort(); /* A ready toast must not replace the clipboard again. */
	std::cerr << message << std::endl;
	QCoreApplication::quit();
}

int main(int argc, char **argv)
{
	QCoreApplication app(argc, argv);
	QNetworkAccessManager monitor;
	if (argc != 3)
		return 2;
	Clip clip;
	clip.youtube.app_url = argv[1];
	std::getline(std::cin, clip.youtube.upload_token);
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
		}
		if (result)
			QMetaObject::invokeMethod(&app, "quit", Qt::QueuedConnection);
	});
	app.exec();
	uploader.join();
	return result;
}
