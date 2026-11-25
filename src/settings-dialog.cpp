/* Tools > Replay to R2 Settings, and the dialog that reviews a clip before
 * it goes to YouTube. */

#include "replay-r2.hpp"
#include "youtube.hpp"

#include <obs-frontend-api.h>

#include <QApplication>
#include <QCheckBox>
#include <QClipboard>
#include <QComboBox>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QHBoxLayout>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QPointer>
#include <QPushButton>
#include <QStackedWidget>
#include <QVBoxLayout>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace {

/* Test uploads run on their own thread; OBS waits for them before it unloads
 * the plugin and shuts curl down. */
std::atomic<int> tests_running{0};

/* YouTube clips go through the hosted app, which keeps the Google tokens. */
constexpr const char *HOSTED_APP = "https://clips.zabimaru.me";
constexpr const char *YOUTUBE_TERMS = "https://www.youtube.com/t/terms";
constexpr const char *GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";
constexpr int AUDIO_TRACKS = 6; /* OBS's audio tracks */

/* The same check as Test Upload. With S3, uploads a small text file. */
bool test_connection(const R2Config &config, std::string &where, std::string &error)
{
	if (!config.app_url.empty()) {
		where = config.app_url;
		return app_check(config, error);
	}
	where = object_key(config, "replay-r2-test.txt");
	const std::string text = "Replay to R2 for OBS can upload to this bucket.\n";
	std::vector<uint8_t> body(text.begin(), text.end());
	return s3_put_object(config, where, body, "text/plain", error);
}

/* Visibility choices, in YouTube's words. */
QComboBox *privacy_box(const std::string &privacy)
{
	auto *box = new QComboBox();
	box->addItem("Unlisted: anyone with the link", "unlisted");
	box->addItem("Private: only you", "private");
	box->addItem("Public: everyone", "public");
	box->setCurrentIndex(std::max(0, box->findData(QString::fromStdString(privacy))));
	return box;
}

QLabel *terms_label()
{
	auto *terms =
		new QLabel(QString("Uploads follow <a href=\"%1\">YouTube's Terms of Service</a>.").arg(YOUTUBE_TERMS));
	terms->setOpenExternalLinks(true);
	terms->setWordWrap(true);
	return terms;
}

QLabel *hint_label(const QString &text = {})
{
	auto *hint = new QLabel(text);
	hint->setWordWrap(true);
	hint->setStyleSheet("color: palette(placeholder-text);");
	return hint;
}

/* Lines up the labels of forms shown one above the other. */
void align_labels(std::initializer_list<QFormLayout *> forms)
{
	std::vector<QWidget *> labels;
	int width = 0;
	for (QFormLayout *form : forms)
		for (int row = 0; row < form->rowCount(); row++) {
			QLayoutItem *item = form->itemAt(row, QFormLayout::LabelRole);
			if (item && item->widget()) {
				labels.push_back(item->widget());
				width = std::max(width, item->widget()->sizeHint().width());
			}
		}
	for (QWidget *label : labels)
		label->setMinimumWidth(width);
}

/* The YouTube page of the settings: the channel, and the upload defaults
 * YouTube asks that people control. */
class YouTubePage : public QWidget {
public:
	explicit YouTubePage(const YouTubeSettings &settings)
	{
		app_url = new QLineEdit();
		app_url->setPlaceholderText(HOSTED_APP);

		channel = new QLabel();
		channel->setTextInteractionFlags(Qt::TextSelectableByMouse);
		sign_in = new QPushButton("Sign in with YouTube");
		disconnect_button = new QPushButton("Disconnect");
		connect(sign_in, &QPushButton::clicked, this, [this]() { start_sign_in(); });
		connect(disconnect_button, &QPushButton::clicked, this, [this]() { disconnect_channel(); });
		auto *account = new QHBoxLayout();
		account->addWidget(channel, 1);
		account->addWidget(sign_in);
		account->addWidget(disconnect_button);

		status = hint_label();
		status->setTextInteractionFlags(Qt::TextSelectableByMouse);
		status->hide();

		privacy = privacy_box(settings.privacy);

		title_template = new QLineEdit(QString::fromStdString(settings.title_template));
		title_template->setPlaceholderText("{game} - {date} {time}");
		title_template->setToolTip(
			"{game} is the app you're playing, {date} is YYYY-MM-DD and {time} is HH:MM");
		title_preview = hint_label();
		title_preview->setWordWrap(false);
		title_preview->setTextFormat(Qt::PlainText);
		connect(title_template, &QLineEdit::textChanged, this, [this]() { update_preview(); });

		description = new QPlainTextEdit(QString::fromStdString(settings.description));
		description->setPlaceholderText("Optional");
		description->setTabChangesFocus(true);
		description->setFixedHeight(64);

		audio_track = new QComboBox();
		for (int track = 1; track <= AUDIO_TRACKS; track++)
			audio_track->addItem(QString("Track %1").arg(track), track);
		audio_track->setCurrentIndex(std::clamp(settings.audio_track, 1, AUDIO_TRACKS) - 1);

		review = new QCheckBox("Review each clip before uploading");
		review->setChecked(settings.review_before_upload);
		review->setToolTip("Shows the title, description and visibility for every clip, so you can "
				   "change them or keep the clip off YouTube");

		auto *access = new QLabel(QString("You can remove this app's access to your channel any time in "
						  "<a href=\"%1\">your Google Account</a>.")
						  .arg(GOOGLE_PERMISSIONS));
		access->setOpenExternalLinks(true);
		access->setWordWrap(true);

		form = new QFormLayout(this);
		form->setContentsMargins(0, 0, 0, 0);
		form->addRow("Clips app", app_url);
		form->addRow("Channel", account);
		form->addRow(status);
		form->addRow("Visibility", privacy);
		form->addRow("Title", title_template);
		form->addRow(QString(), title_preview);
		form->addRow("Description", description);
		form->addRow("Audio track", audio_track);
		form->addRow(QString(), hint_label("Only this track goes to YouTube. Pick one without voice chat."));
		form->addRow(review);
		form->addRow(terms_label());
		form->addRow(access);

		show_account(settings);
		update_preview();
	}

	/* The settings with this page's upload defaults. The connection itself
	 * is saved by youtube_connect_async and youtube_disconnect. */
	YouTubeSettings current() const
	{
		YouTubeSettings settings = get_youtube_settings();
		settings.privacy = privacy->currentData().toString().toStdString();
		settings.title_template = title_template->text().trimmed().toStdString();
		if (settings.title_template.empty())
			settings.title_template = YouTubeSettings().title_template;
		settings.description = description->toPlainText().trimmed().toStdString();
		settings.review_before_upload = review->isChecked();
		settings.audio_track = audio_track->currentData().toInt();
		return settings;
	}

	QFormLayout *form;

private:
	QLineEdit *app_url, *title_template;
	QLabel *channel, *status, *title_preview;
	QPushButton *sign_in, *disconnect_button;
	QComboBox *privacy, *audio_track;
	QPlainTextEdit *description;
	QCheckBox *review;

	void show_account(const YouTubeSettings &settings)
	{
		bool connected = !settings.upload_token.empty();
		channel->setText(connected
					 ? QString("<b>%1</b>")
						   .arg(QString::fromStdString(settings.channel_title).toHtmlEscaped())
					 : "Not connected");
		channel->setEnabled(connected);
		/* The token belongs to one app, so its address is fixed until you
		 * disconnect. */
		if (connected)
			app_url->setText(QString::fromStdString(settings.app_url));
		else if (app_url->text().isEmpty())
			app_url->setText(HOSTED_APP);
		app_url->setReadOnly(connected);
		sign_in->setVisible(!connected);
		sign_in->setEnabled(true);
		sign_in->setText("Sign in with YouTube");
		disconnect_button->setVisible(connected);
	}

	/* Progress in grey, errors in the normal text color so they stand out. */
	void show_status(const QString &text, bool error = false)
	{
		status->setText(text);
		status->setStyleSheet(error ? "" : "color: palette(placeholder-text);");
		status->setVisible(!text.isEmpty());
	}

	void update_preview()
	{
		std::string title =
			youtube_title(title_template->text().toStdString(), "Counter-Strike 2", time(nullptr));
		QString example = QString("For example: %1").arg(QString::fromStdString(title));
		title_preview->setText(title_preview->fontMetrics().elidedText(example, Qt::ElideRight, 400));
	}

	void start_sign_in()
	{
		std::string url = app_url->text().trimmed().toStdString();
		while (!url.empty() && url.back() == '/')
			url.pop_back();
		if (!secure_url(url)) {
			show_status("Enter your clips app's address, starting with https://", true);
			return;
		}

		sign_in->setEnabled(false);
		sign_in->setText("Waiting for your browser...");
		show_status("Finish signing in to Google in your browser. This updates when you're done.");

		QPointer<YouTubePage> self(this);
		youtube_connect_async(url, [self](bool ok, const std::string &error) {
			if (!self)
				return;
			self->show_account(get_youtube_settings());
			self->show_status(ok ? "Connected. Clips now upload to this channel."
					     : QString("Couldn't sign in: %1").arg(QString::fromStdString(error)),
					  !ok);
		});
	}

	void disconnect_channel()
	{
		disconnect_button->setEnabled(false);
		youtube_disconnect();
		disconnect_button->setEnabled(true);
		show_account(get_youtube_settings());
		show_status("Disconnected. The app no longer has access to your channel, and its YouTube "
			    "clips are gone from your library. Your videos stay on YouTube.");
	}
};

class SettingsDialog : public QDialog {
public:
	explicit SettingsDialog(QWidget *parent) : QDialog(parent)
	{
		setWindowTitle("Replay to R2 Settings");
		setMinimumWidth(560);

		R2Config config = get_config();
		YouTubeSettings youtube = get_youtube_settings();

		destination = new QComboBox();
		destination->addItem("Clips app (R2)", int(Destination::ClipsApp));
		destination->addItem("S3 bucket", int(Destination::S3));
		destination->addItem("YouTube", int(Destination::YouTube));
		/* Before there was a choice, an empty Clips app meant the S3 bucket. */
		Destination to = youtube.destination;
		if (to == Destination::ClipsApp && config.app_url.empty() && !config.s3_url.empty())
			to = Destination::S3;
		destination->setCurrentIndex(destination->findData(int(to)));

		app_url = new QLineEdit(QString::fromStdString(config.app_url));
		app_url->setPlaceholderText("https://clips.<you>.workers.dev");
		upload_token = new QLineEdit(QString::fromStdString(config.upload_token));
		upload_token->setEchoMode(QLineEdit::Password);
		s3_url = new QLineEdit(QString::fromStdString(config.s3_url));
		s3_url->setPlaceholderText("https://<account-id>.r2.cloudflarestorage.com/<bucket>");
		access_key = new QLineEdit(QString::fromStdString(config.access_key));
		secret_key = new QLineEdit(QString::fromStdString(config.secret_key));
		secret_key->setEchoMode(QLineEdit::Password);
		folder = new QLineEdit(QString::fromStdString(config.folder));
		public_url = new QLineEdit(QString::fromStdString(config.public_url));
		public_url->setPlaceholderText("Optional: https://pub-xxxx.r2.dev or your custom domain");

		auto *app_page = new QWidget();
		auto *app_form = new QFormLayout(app_page);
		app_form->setContentsMargins(0, 0, 0, 0);
		app_form->addRow("Clips app", app_url);
		app_form->addRow("Upload token", upload_token);

		auto *s3_page = new QWidget();
		auto *s3_form = new QFormLayout(s3_page);
		s3_form->setContentsMargins(0, 0, 0, 0);
		s3_form->addRow("S3 API URL", s3_url);
		s3_form->addRow("Access Key ID", access_key);
		s3_form->addRow("Secret Access Key", secret_key);
		s3_form->addRow("Folder", folder);
		s3_form->addRow("Public URL", public_url);

		youtube_page = new YouTubePage(youtube);

		pages = new QStackedWidget();
		pages->addWidget(app_page);
		pages->addWidget(s3_page);
		pages->addWidget(youtube_page);

		help = new QLabel();
		help->setWordWrap(true);

		start_replay = new QCheckBox("Start the Replay Buffer when OBS opens");
		start_replay->setChecked(config.start_replay_buffer);

		auto *top = new QFormLayout();
		top->addRow("Destination", destination);

		status = new QLabel();
		status->setWordWrap(true);
		status->setTextInteractionFlags(Qt::TextSelectableByMouse);

		auto *buttons = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel);
		paste = buttons->addButton("Paste setup code", QDialogButtonBox::ActionRole);
		test = buttons->addButton("Test Upload", QDialogButtonBox::ActionRole);
		connect(paste, &QPushButton::clicked, this, [this]() { paste_setup_code(); });
		connect(buttons, &QDialogButtonBox::accepted, this, [this]() {
			set_config(current());
			YouTubeSettings settings = youtube_page->current();
			settings.destination = chosen();
			set_youtube_settings(settings);
			accept();
		});
		connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
		connect(test, &QPushButton::clicked, this, [this]() { run_test(); });
		connect(destination, &QComboBox::currentIndexChanged, this, [this]() { show_destination(); });

		auto *layout = new QVBoxLayout(this);
		layout->addWidget(help);
		layout->addLayout(top);
		layout->addWidget(pages);
		layout->addWidget(start_replay);
		layout->addWidget(status);
		layout->addWidget(buttons);

		align_labels({top, app_form, s3_form, youtube_page->form});
		show_destination();
	}

private:
	QComboBox *destination;
	QStackedWidget *pages;
	YouTubePage *youtube_page;
	QLineEdit *app_url, *upload_token, *s3_url, *access_key, *secret_key, *folder, *public_url;
	QCheckBox *start_replay;
	QLabel *help, *status;
	QPushButton *paste, *test;

	Destination chosen() const { return Destination(destination->currentData().toInt()); }

	/* Shows the chosen destination's fields, and sizes the dialog to them. */
	void show_destination()
	{
		Destination to = chosen();
		pages->setCurrentIndex(int(to));
		for (int i = 0; i < pages->count(); i++)
			pages->widget(i)->setSizePolicy(QSizePolicy::Preferred,
							i == int(to) ? QSizePolicy::Preferred : QSizePolicy::Ignored);

		const char *hotkey = "Then bind <b>Save Replay to Cloudflare R2</b> in Settings &gt; Hotkeys.";
		if (to == Destination::ClipsApp)
			help->setText(QString("Saved replays upload from memory to your clips app and are never "
					      "written to disk.<br>Easiest: open your clips app, click <b>Connect "
					      "OBS</b>, copy the setup code, then click <b>Paste setup code</b> "
					      "here.<br>%1")
					      .arg(hotkey));
		else if (to == Destination::S3)
			help->setText(QString("Saved replays upload from memory straight to your own S3-compatible "
					      "bucket, such as Cloudflare R2.<br>%1")
					      .arg(hotkey));
		else
			help->setText(QString("Saved replays upload from memory to your YouTube channel, and show up "
					      "in your clips app next to your other clips.<br>%1")
					      .arg(hotkey));

		/* YouTube has no setup code, and signing in is its test. */
		paste->setVisible(to != Destination::YouTube);
		test->setVisible(to != Destination::YouTube);
		status->clear();
		adjustSize();
	}

	R2Config current() const
	{
		R2Config config;
		config.app_url = app_url->text().trimmed().toStdString();
		config.upload_token = upload_token->text().trimmed().toStdString();
		config.s3_url = s3_url->text().trimmed().toStdString();
		config.access_key = access_key->text().trimmed().toStdString();
		config.secret_key = secret_key->text().trimmed().toStdString();
		config.folder = folder->text().trimmed().toStdString();
		config.public_url = public_url->text().trimmed().toStdString();
		config.start_replay_buffer = start_replay->isChecked();
		return config;
	}

	void paste_setup_code()
	{
		R2Config config = current();
		if (!apply_setup_code(QApplication::clipboard()->text().toStdString(), config)) {
			status->setText("No setup code on the clipboard. Copy it from Connect OBS in your clips app.");
			return;
		}
		app_url->setText(QString::fromStdString(config.app_url));
		upload_token->setText(QString::fromStdString(config.upload_token));
		s3_url->setText(QString::fromStdString(config.s3_url));
		access_key->setText(QString::fromStdString(config.access_key));
		secret_key->setText(QString::fromStdString(config.secret_key));
		folder->setText(QString::fromStdString(config.folder));
		public_url->clear();
		destination->setCurrentIndex(
			destination->findData(int(config.app_url.empty() ? Destination::S3 : Destination::ClipsApp)));
		status->setText("Setup code pasted. Click Test Upload, then Save.");
	}

	/* Checks the settings now, so a typo shows up before a clip is lost. */
	void run_test()
	{
		R2Config config = current();
		/* Test the bucket that's chosen, even when a clips app is filled in. */
		if (chosen() == Destination::S3) {
			config.app_url.clear();
			config.upload_token.clear();
		}
		test->setEnabled(false);
		status->setText("Testing...");

		QPointer<SettingsDialog> self(this);
		tests_running++;
		std::thread([config, self]() {
			std::string where, error;
			bool ok = test_connection(config, where, error);
			QString message =
				ok ? QString("Test worked: clips will upload to %1").arg(QString::fromStdString(where))
				   : QString("Test failed: %1").arg(QString::fromStdString(error));
			QMetaObject::invokeMethod(
				qApp,
				[self, message]() {
					if (!self)
						return;
					self->status->setText(message);
					self->test->setEnabled(true);
				},
				Qt::QueuedConnection);
			tests_running--;
		}).detach();
	}
};

/* ---- Reviewing a clip before it goes to YouTube ---- */

/* One review, shared by the uploader thread that waits and the dialog that
 * answers. */
struct Review {
	std::mutex mutex;
	std::condition_variable done;
	bool answered = false;
	bool upload = false;
	YouTubeUpload fields;

	void answer(bool ok, const YouTubeUpload *edited = nullptr)
	{
		{
			std::lock_guard<std::mutex> lock(mutex);
			if (answered)
				return;
			answered = true;
			upload = ok;
			if (edited)
				fields = *edited;
		}
		done.notify_all();
	}
};

/* Cancels a review whose dialog never opened: Qt drops a queued call it
 * hasn't run when OBS closes first. */
struct CancelUnlessShown {
	std::shared_ptr<Review> review;
	~CancelUnlessShown()
	{
		if (review)
			review->answer(false);
	}
};

std::atomic<bool> exiting{false};
QPointer<QDialog> open_review; /* UI thread only */

/* OBS is closing: answer an open review with "save to disk", so the uploader
 * can finish before OBS unloads the plugin. */
void on_review_frontend_event(enum obs_frontend_event event, void *)
{
	if (event != OBS_FRONTEND_EVENT_EXIT)
		return;
	exiting = true;
	if (open_review)
		open_review->reject();
	/* OBS calls these from last to first, so this may remove itself. */
	obs_frontend_remove_event_callback(on_review_frontend_event, nullptr);
}

class ReviewDialog : public QDialog {
public:
	ReviewDialog(QWidget *parent, const YouTubeUpload &upload, const std::string &channel_title) : QDialog(parent)
	{
		setWindowTitle("Upload this clip to YouTube?");
		setMinimumWidth(460);

		auto *to = new QLabel(
			QString("Uploading to <b>%1</b>").arg(QString::fromStdString(channel_title).toHtmlEscaped()));
		title = new QLineEdit(QString::fromStdString(upload.title));
		title->setMaxLength(100);
		description = new QPlainTextEdit(QString::fromStdString(upload.description));
		description->setPlaceholderText("Optional");
		description->setTabChangesFocus(true);
		description->setFixedHeight(72);
		privacy = privacy_box(upload.privacy);

		auto *form = new QFormLayout();
		form->addRow("Title", title);
		form->addRow("Description", description);
		form->addRow("Visibility", privacy);

		auto *buttons = new QDialogButtonBox();
		QPushButton *upload_button = buttons->addButton("Upload", QDialogButtonBox::AcceptRole);
		buttons->addButton("Save to disk instead", QDialogButtonBox::RejectRole);
		upload_button->setDefault(true);
		connect(buttons, &QDialogButtonBox::accepted, this, &QDialog::accept);
		connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
		/* YouTube refuses an empty title and titles with < or >. */
		connect(title, &QLineEdit::textChanged, this, [this, upload_button]() {
			QString text = title->text();
			if (text.contains('<') || text.contains('>')) {
				int at = title->cursorPosition();
				text.remove('<').remove('>');
				title->setText(text);
				title->setCursorPosition(std::min(at, int(text.size())));
			}
			upload_button->setEnabled(!text.trimmed().isEmpty());
		});

		auto *layout = new QVBoxLayout(this);
		layout->addWidget(to);
		layout->addLayout(form);
		layout->addWidget(terms_label());
		layout->addWidget(buttons);
	}

	YouTubeUpload edited() const
	{
		YouTubeUpload upload;
		upload.title = title->text().trimmed().toStdString();
		upload.description = description->toPlainText().trimmed().toStdString();
		upload.privacy = privacy->currentData().toString().toStdString();
		return upload;
	}

private:
	QLineEdit *title;
	QPlainTextEdit *description;
	QComboBox *privacy;
};

/* Opens the review on the UI thread. It shows without taking focus, so a game
 * keeps it; the taskbar flashes until you look. */
void show_review(const std::shared_ptr<Review> &review, const std::string &channel_title)
{
	static bool hooked = false;
	if (!hooked) {
		obs_frontend_add_event_callback(on_review_frontend_event, nullptr);
		hooked = true;
	}
	if (exiting) {
		review->answer(false);
		return;
	}

	auto *parent = static_cast<QWidget *>(obs_frontend_get_main_window());
	auto *dialog = new ReviewDialog(parent, review->fields, channel_title);
	dialog->setAttribute(Qt::WA_DeleteOnClose);
	dialog->setAttribute(Qt::WA_ShowWithoutActivating);
	dialog->setWindowModality(Qt::WindowModal);
	QObject::connect(dialog, &QDialog::finished, [review, dialog](int result) {
		YouTubeUpload edited = dialog->edited();
		review->answer(result == QDialog::Accepted, &edited);
	});
	/* Closed with OBS's window, or by OBS closing. */
	QObject::connect(dialog, &QObject::destroyed, [review]() { review->answer(false); });
	open_review = dialog;
	dialog->show();
	QApplication::alert(dialog);
}

} // namespace

/* "r2obs2:" + base64 of {"a": app URL, "t": upload token}. Older apps gave
 * "r2obs1:" + base64 of {"u": S3 API URL, "k": access key, "s": secret key,
 * "f": folder}. */
bool apply_setup_code(const std::string &text, R2Config &config)
{
	QString code = QString::fromStdString(text).trimmed();
	if (!code.startsWith("r2obs1:") && !code.startsWith("r2obs2:"))
		return false;
	QJsonObject fields = QJsonDocument::fromJson(QByteArray::fromBase64(code.mid(7).toUtf8())).object();
	auto field = [&](const char *name) {
		return fields.value(name).toString().toStdString();
	};

	if (!field("a").empty() && !field("t").empty()) {
		config.app_url = field("a");
		config.upload_token = field("t");
	} else if (!field("u").empty() && !field("k").empty() && !field("s").empty()) {
		config.app_url.clear();
		config.upload_token.clear();
		config.s3_url = field("u");
		config.access_key = field("k");
		config.secret_key = field("s");
		config.folder = fields.value("f").toString("replays").toStdString();
	} else {
		return false;
	}
	config.public_url.clear();
	return true;
}

void check_connection_async(const R2Config &config)
{
	tests_running++;
	std::thread([config]() {
		std::string where, error;
		if (test_connection(config, where, error))
			notify_user("Replay to R2: connected to " + where +
				    ". Press your Save Replay to Cloudflare R2 hotkey to save a clip.");
		else
			notify_user("Replay to R2: could not connect (" + error + ")");
		tests_running--;
	}).detach();
}

void wait_for_tests()
{
	while (tests_running > 0)
		std::this_thread::sleep_for(std::chrono::milliseconds(50));
}

void show_settings_dialog()
{
	auto *parent = static_cast<QWidget *>(obs_frontend_get_main_window());
	auto *dialog = new SettingsDialog(parent);
	dialog->setAttribute(Qt::WA_DeleteOnClose);
	dialog->show();
}

bool youtube_review(YouTubeUpload &upload, const std::string &channel_title)
{
	if (exiting)
		return false;

	auto review = std::make_shared<Review>();
	review->fields = upload;
	auto guard = std::make_shared<CancelUnlessShown>();
	guard->review = review;
	notify_user("Replay to R2: review the clip in OBS to upload it to YouTube");
	QMetaObject::invokeMethod(
		qApp,
		[guard, channel_title]() {
			std::shared_ptr<Review> shown = std::move(guard->review);
			show_review(shown, channel_title);
		},
		Qt::QueuedConnection);
	guard.reset();

	std::unique_lock<std::mutex> lock(review->mutex);
	/* Also wakes when OBS starts closing before the dialog opened. */
	while (!review->done.wait_for(lock, std::chrono::milliseconds(250), [&] { return review->answered; }))
		if (exiting)
			return false;
	if (review->upload)
		upload = review->fields;
	return review->upload;
}
