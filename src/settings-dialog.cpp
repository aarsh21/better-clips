/* Tools > Better Clips Settings, and the dialog that reviews a clip before
 * it goes to YouTube. */

#include "replay-r2.hpp"
#include "youtube.hpp"

#include <obs-frontend-api.h>

#include <QApplication>
#include <QCheckBox>
#include <QClipboard>
#include <QComboBox>
#include <QDesktopServices>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QHBoxLayout>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
#include <QMessageBox>
#include <QPlainTextEdit>
#include <QPointer>
#include <QPushButton>
#include <QRadioButton>
#include <QScreen>
#include <QScrollArea>
#include <QUrl>
#include <QUuid>
#include <QVBoxLayout>
#include <QWindow>

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

/* YouTube clips go through the hosted app, which keeps the Google tokens,
 * unless OBS uploads to YouTube directly. */
constexpr const char *HOSTED_APP = "https://clips.zabimaru.me";
constexpr const char *YOUTUBE_TERMS = "https://www.youtube.com/t/terms";
constexpr const char *GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";
constexpr int AUDIO_TRACKS = 6; /* OBS's audio tracks */

/* Whether OBS can upload on the route it signed in with. */
bool youtube_connected(const YouTubeSettings &settings)
{
	return settings.route == YouTubeRoute::Direct ? !settings.refresh_token.empty()
						      : !settings.upload_token.empty();
}

/* The Better Clips app's FAQ, which opens without signing in. */
void open_faq(std::string app_url)
{
	while (!app_url.empty() && app_url.back() == '/')
		app_url.pop_back();
	if (!secure_url(app_url))
		app_url = HOSTED_APP;
	QDesktopServices::openUrl(QUrl(QString::fromStdString(app_url + "/faq")));
}

bool test_connection(Destination to, const R2Config &config, std::string &error)
{
	if (to == Destination::ClipsApp) {
		if (config.app_url.empty()) {
			error = "Enter your Better Clips app URL or paste a setup code.";
			return false;
		}
		return app_check(config, error);
	}
	const auto key = object_key(config, "better-clips-test-" +
						    QUuid::createUuid().toString(QUuid::Id128).toStdString() + ".txt");
	if (!s3_put_object(config, key, {'O', 'B', 'S'}, "text/plain", error))
		return false;
	if (!s3_delete_object(config, key, error)) {
		error = "Wrote the test object but couldn't remove " + key + ": " + error;
		return false;
	}
	return true;
}

QString test_success(Destination to)
{
	return to == Destination::ClipsApp ? "Better Clips app: storage check passed."
					   : "S3: wrote and deleted a test object.";
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

/* Settings can be closed and reopened while the server is revoking access. */
class DisconnectState : public QObject {
	Q_OBJECT
public:
	bool pending = false;
	void start(bool remove_channel = false)
	{
		if (pending)
			return;
		pending = true;
		emit started();
		youtube_disconnect(
			[this](DisconnectResult result) {
				pending = false;
				emit finished(result);
			},
			remove_channel);
	}

signals:
	void started();
	void finished(DisconnectResult result);
};

/* The YouTube page of the settings: how clips get there, the channel, and
 * the upload defaults YouTube asks that people control. */
class YouTubePage : public QWidget {
public:
	explicit YouTubePage(const YouTubeSettings &settings)
	{
		via_app = new QRadioButton("Through the Better Clips app");
		direct = new QRadioButton("Directly to YouTube");
		auto *routes = new QHBoxLayout();
		routes->addWidget(via_app);
		routes->addWidget(direct);
		routes->addStretch(1);
		route_hint = hint_label();
		/* Without a Google client ID in this build, only the app can upload. */
		const bool can_direct = youtube_direct_available();
		(can_direct && settings.route == YouTubeRoute::Direct ? direct : via_app)->setChecked(true);
		connect(direct, &QRadioButton::toggled, this, [this]() {
			show_route(get_youtube_settings());
			show_status("");
		});

		app_url = new QLineEdit();
		app_url->setPlaceholderText(HOSTED_APP);

		channel = new QLabel();
		channel->setTextInteractionFlags(Qt::TextSelectableByMouse);
		sign_in = new QPushButton("Sign in with YouTube");
		cancel_sign_in = new QPushButton("Cancel sign-in");
		connect(cancel_sign_in, &QPushButton::clicked, this, [this] {
			cancel_youtube_sign_in();
			show_account(get_youtube_settings());
			show_status("Sign-in cancelled. You can close the browser tab.");
		});
		disconnect_button = new QPushButton("Disconnect");
		remove_channel = new QPushButton("Remove channel from app…");
		connect(sign_in, &QPushButton::clicked, this, [this]() { start_sign_in(); });
		static DisconnectState disconnect;
		connect(disconnect_button, &QPushButton::clicked, this, [] { disconnect.start(); });
		connect(remove_channel, &QPushButton::clicked, this, [this] {
			const auto before = get_youtube_settings();
			QMessageBox confirm(
				QMessageBox::Warning, "Remove channel everywhere?",
				"This removes the channel from Better Clips on every device. All of its app library entries and cut points disappear. The videos stay on YouTube.",
				QMessageBox::Cancel, this);
			auto *remove = confirm.addButton("Remove channel everywhere", QMessageBox::DestructiveRole);
			confirm.setDefaultButton(QMessageBox::Cancel);
			confirm.exec();
			if (confirm.clickedButton() == remove && !before.upload_token.empty() &&
			    get_youtube_settings().upload_token == before.upload_token)
				disconnect.start(true);
		});
		disconnect_button->setDisabled(disconnect.pending);
		remove_channel->setDisabled(disconnect.pending);
		connect(&disconnect, &DisconnectState::started, this, [this] {
			disconnect_button->setEnabled(false);
			remove_channel->setEnabled(false);
			show_status("Disconnecting...");
		});
		connect(&disconnect, &DisconnectState::finished, this,
			[this](DisconnectResult result) { show_disconnected(result); });
		auto *account = new QHBoxLayout();
		account->addWidget(channel, 1);
		account->addWidget(sign_in);
		account->addWidget(cancel_sign_in);
		account->addWidget(disconnect_button);

		status = hint_label();
		status->setTextFormat(Qt::PlainText);
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
		description->setMaximumHeight(64);

		audio_track = new QComboBox();
		for (int track = 1; track <= AUDIO_TRACKS; track++)
			audio_track->addItem(QString("Track %1").arg(track), track);
		audio_track->setCurrentIndex(std::clamp(settings.audio_track, 1, AUDIO_TRACKS) - 1);

		review = new QCheckBox("Review each clip before uploading");
		review->setChecked(settings.review_before_upload);
		review->setToolTip("Shows the title, description and visibility for every clip, so you can "
				   "change them or keep the clip off YouTube");

		access = new QLabel();
		access->setOpenExternalLinks(true);
		access->setWordWrap(true);

		form = new QFormLayout();
		form->addRow("Upload", routes);
		form->addRow(QString(), route_hint);
		form->addRow("Better Clips app", app_url);
		form->addRow("Channel", account);
		form->addRow(QString(), remove_channel);
		form->setRowVisible(routes, can_direct);
		form->setRowVisible(route_hint, can_direct);

		defaults = new QFormLayout();
		defaults->addRow("Visibility", privacy);
		defaults->addRow("Title", title_template);
		defaults->addRow(QString(), title_preview);
		defaults->addRow("Description", description);
		defaults->addRow("Audio track", audio_track);
		defaults->addRow(QString(),
				 hint_label("Only this track goes to YouTube. Pick one without voice chat."));
		defaults->addRow(review);
		defaults->addRow(terms_label());
		defaults->addRow(access);

		auto *layout = new QVBoxLayout(this);
		layout->setContentsMargins(0, 0, 0, 0);
		layout->addLayout(form);
		layout->addWidget(status);
		layout->addLayout(defaults);

		show_account(settings);
		update_preview();
	}

	void refresh_credentials()
	{
		const auto settings = get_youtube_settings();
		if (!disconnect_button->isHidden() && !youtube_connected(settings)) {
			show_account(settings);
			show_status("This OBS is no longer connected. Reconnect to upload to YouTube.", true);
		}
	}

	~YouTubePage() override
	{
		if (!cancel_sign_in->isHidden())
			cancel_youtube_sign_in();
	}

	/* The settings with this page's route and upload defaults. The
	 * connection itself is saved by youtube_connect_async and
	 * youtube_disconnect. */
	YouTubeSettings current() const
	{
		YouTubeSettings settings = get_youtube_settings();
		settings.route = route();
		settings.privacy = privacy->currentData().toString().toStdString();
		settings.title_template = title_template->text().trimmed().toStdString();
		if (settings.title_template.empty())
			settings.title_template = YouTubeSettings().title_template;
		settings.description = description->toPlainText().trimmed().toStdString();
		settings.review_before_upload = review->isChecked();
		settings.audio_track = audio_track->currentData().toInt();
		return settings;
	}

	/* The address the FAQ opens at: this page's Better Clips app. */
	std::string faq_app() const { return app_url->text().trimmed().toStdString(); }

	QFormLayout *form, *defaults;

private:
	QRadioButton *via_app, *direct;
	QLineEdit *app_url, *title_template;
	QLabel *route_hint, *channel, *status, *title_preview, *access;
	QPushButton *sign_in, *disconnect_button, *remove_channel, *cancel_sign_in;
	QComboBox *privacy, *audio_track;
	QPlainTextEdit *description;
	QCheckBox *review;

	YouTubeRoute route() const { return direct->isChecked() ? YouTubeRoute::Direct : YouTubeRoute::ClipsApp; }

	/* The trade-off of the chosen route, and the fields it needs. */
	void show_route(const YouTubeSettings &settings)
	{
		const bool app = route() == YouTubeRoute::ClipsApp;
		const bool reconnect = app ? settings.previously_paired : settings.previously_direct;
		sign_in->setText(reconnect ? "Reconnect YouTube" : "Sign in with YouTube");
		route_hint->setText(app ? "Clips show up in the Better Clips app, to rename, cut and delete them."
					: "No Better Clips app needed, but clips won't show up in its library.");
		form->setRowVisible(app_url, app);
		access->setText(QString("You can remove %1 access to your channel any time in "
					"<a href=\"%2\">your Google Account</a>.")
					.arg(app ? "the Better Clips app's" : "OBS's", GOOGLE_PERMISSIONS));
	}

	void show_account(const YouTubeSettings &settings)
	{
		bool connected = youtube_connected(settings);
		channel->setText(connected
					 ? QString("<b>%1</b>")
						   .arg(QString::fromStdString(settings.channel_title).toHtmlEscaped())
					 : "Not connected");
		channel->setEnabled(connected);
		/* A connection belongs to one route, and through the app to one
		 * app, so they're fixed until you disconnect. */
		if (connected)
			(settings.route == YouTubeRoute::Direct ? direct : via_app)->setChecked(true);
		via_app->setEnabled(!connected);
		direct->setEnabled(!connected);
		if (!settings.app_url.empty() && settings.route == YouTubeRoute::ClipsApp)
			app_url->setText(QString::fromStdString(settings.app_url));
		else if (app_url->text().isEmpty())
			app_url->setText(HOSTED_APP);
		app_url->setReadOnly(connected);
		sign_in->setVisible(!connected);
		cancel_sign_in->hide();
		sign_in->setEnabled(true);
		disconnect_button->setVisible(connected);
		disconnect_button->setText(settings.route == YouTubeRoute::ClipsApp ? "Unpair this OBS" : "Disconnect");
		form->setRowVisible(remove_channel, connected && settings.route == YouTubeRoute::ClipsApp);
		show_route(settings);
	}

	/* Progress in grey, errors in the normal text color so they stand out. */
	void show_status(const QString &text, bool error = false)
	{
		status->setText(text);
		status->setStyleSheet(error ? "" : "color: palette(placeholder-text);");
		status->setVisible(!text.isEmpty());
	}

	void show_disconnected(DisconnectResult result)
	{
		/* The route that was disconnected: the radio buttons stay on it
		 * until show_account unlocks them. */
		const bool app = route() == YouTubeRoute::ClipsApp;
		disconnect_button->setEnabled(true);
		remove_channel->setEnabled(true);
		auto current = get_youtube_settings();
		show_account(current);
		if (result == DisconnectResult::Failed)
			show_status("Could not disconnect YouTube. Try again.", true);
		/* You signed in again while it ran: that new connection stands. */
		else if (youtube_connected(current))
			show_status("");
		else if (result == DisconnectResult::Revoked)
			show_status(app ? "Disconnected. The app no longer has access to your channel, and its "
					  "YouTube clips are gone from your library. Your videos stay on YouTube."
					: "Disconnected. OBS no longer has access to your channel. Your videos stay "
					  "on YouTube.");
		else if (app)
			show_status("This OBS is no longer paired with the Better Clips app.");
		else
			show_status("OBS is signed out. Google had already ended its access, so there's nothing "
				    "left to remove. Your videos stay on YouTube.");
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
		const YouTubeRoute chosen = route();
		std::string url;
		if (chosen == YouTubeRoute::ClipsApp) {
			url = app_url->text().trimmed().toStdString();
			while (!url.empty() && url.back() == '/')
				url.pop_back();
			if (!secure_url(url)) {
				show_status("Enter your Better Clips app's address, starting with https://", true);
				return;
			}
		}

		sign_in->setText("Retry sign-in");
		cancel_sign_in->show();
		app_url->setReadOnly(true);
		via_app->setEnabled(false);
		direct->setEnabled(false);
		show_status("Finish signing in to Google in your browser. This updates when you're done.");

		QPointer<YouTubePage> self(this);
		youtube_connect_async(chosen, url, [self](bool ok, const std::string &error) {
			auto settings = get_youtube_settings();
			if (!self)
				return;
			self->show_account(settings);
			self->show_status(ok ? "Connected. Click Save to upload clips to this channel."
					     : QString("Couldn't sign in: %1").arg(QString::fromStdString(error)),
					  !ok);
		});
	}
};

QPointer<YouTubePage> open_account;

class SettingsDialog : public QDialog {
public:
	explicit SettingsDialog(QWidget *parent) : QDialog(parent)
	{
		setWindowTitle("Better Clips Settings");
		setMinimumWidth(560);
		if (plugin_disabled()) {
			auto *notice = new QLabel(plugin_startup_notice());
			notice->setTextFormat(Qt::PlainText);
			notice->setWordWrap(true);
			notice->setTextInteractionFlags(Qt::TextSelectableByMouse);
			auto *layout = new QVBoxLayout(this);
			layout->addWidget(notice);
			auto *close = new QDialogButtonBox(QDialogButtonBox::Close);
			connect(close, &QDialogButtonBox::rejected, this, &QDialog::reject);
			layout->addWidget(close);
			return;
		}

		R2Config config = get_config();
		YouTubeSettings youtube = get_youtube_settings();

		destination = new QComboBox();
		destination->addItem("Better Clips app (R2)", int(Destination::ClipsApp));
		destination->addItem("S3 bucket", int(Destination::S3));
		destination->addItem("YouTube", int(Destination::YouTube));
		destination->setCurrentIndex(destination->findData(int(youtube.destination)));

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

		app_page = new QWidget();
		auto *app_form = new QFormLayout(app_page);
		app_form->setContentsMargins(0, 0, 0, 0);
		app_form->addRow("Better Clips app", app_url);
		app_form->addRow("Upload token", upload_token);

		s3_page = new QWidget();
		auto *s3_form = new QFormLayout(s3_page);
		s3_form->setContentsMargins(0, 0, 0, 0);
		s3_form->addRow("S3 API URL", s3_url);
		s3_form->addRow("Access Key ID", access_key);
		s3_form->addRow("Secret Access Key", secret_key);
		s3_form->addRow("Folder", folder);
		s3_form->addRow("Public URL", public_url);

		youtube_page = new YouTubePage(youtube);
		open_account = youtube_page;

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
			YouTubeSettings settings = youtube_page->current();
			settings.destination = chosen();
			if (!save_settings(current(), settings)) {
				status->setText(
					"Settings weren't saved. Check the permissions on the Better Clips settings folder, then try again.");
				return;
			}
			accept();
		});
		connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
		connect(test, &QPushButton::clicked, this, [this]() { run_test(); });
		connect(destination, &QComboBox::currentIndexChanged, this, [this]() {
			invalidate_test();
			show_destination();
		});
		for (auto *field : {app_url, upload_token, s3_url, access_key, secret_key, folder, public_url})
			connect(field, &QLineEdit::textChanged, this, [this] { invalidate_test(); });

		auto *faq = new QLabel("<a href=\"faq\">Questions? Read the FAQ</a>");
		connect(faq, &QLabel::linkActivated, this, [this]() { open_faq(faq_app()); });
		auto *bottom = new QHBoxLayout();
		bottom->addWidget(faq);
		bottom->addWidget(buttons, 1);

		auto *content = new QWidget();
		auto *fields = new QVBoxLayout(content);
		fields->setContentsMargins(0, 0, 0, 0);
		fields->setSizeConstraint(QLayout::SetMinAndMaxSize);
		fields->addWidget(help);
		fields->addLayout(top);
		fields->addWidget(app_page);
		fields->addWidget(s3_page);
		fields->addWidget(youtube_page);
		fields->addWidget(start_replay);
		fields->addWidget(status);
		fields->addStretch();
		scroll = new QScrollArea();
		scroll->setFrameShape(QFrame::NoFrame);
		scroll->setWidgetResizable(true);
		scroll->setWidget(content);
		auto *layout = new QVBoxLayout(this);
		layout->addWidget(scroll);
		layout->addLayout(bottom);

		align_labels({top, app_form, s3_form, youtube_page->form, youtube_page->defaults});
		show_destination();
		status->setText(plugin_startup_notice());
	}

	void showEvent(QShowEvent *event) override
	{
		QDialog::showEvent(event);
		if (!scroll || !windowHandle())
			return;
		connect(windowHandle(), &QWindow::screenChanged, this, &SettingsDialog::watch_screen,
			Qt::UniqueConnection);
		watch_screen(screen());
	}

private:
	QScrollArea *scroll = nullptr;
	QMetaObject::Connection work_area_changed;
	void watch_screen(QScreen *screen)
	{
		disconnect(work_area_changed);
		if (screen) {
			work_area_changed =
				connect(screen, &QScreen::availableGeometryChanged, this, [this] { fit_page(); });
			fit_page();
		}
	}

	void fit_page()
	{
		const QRect area = screen()->availableGeometry();
		// Leave space for the window frame even before the window manager adds it.
		setMaximumHeight(area.height() * 9 / 10);
		const int w = std::max(minimumSizeHint().width(), 640);
		const auto margins = layout()->contentsMargins();
		const int body = scroll->widget()->heightForWidth(w - margins.left() - margins.right());
		resize(w, body + margins.top() + margins.bottom() + layout()->spacing() +
				  layout()->itemAt(1)->sizeHint().height());
		const int bottom = area.bottom() - margins.bottom();
		if (isVisible() && frameGeometry().bottom() > bottom)
			move(x(), std::max(area.top(), bottom - frameGeometry().height() + 1));
	}

	QComboBox *destination;
	QWidget *app_page, *s3_page;
	YouTubePage *youtube_page;
	QLineEdit *app_url, *upload_token, *s3_url, *access_key, *secret_key, *folder, *public_url;
	QCheckBox *start_replay;
	QLabel *help, *status;
	QPushButton *paste, *test;
	unsigned test_generation = 0;
	void invalidate_test()
	{
		++test_generation;
		status->clear();
		test->setEnabled(true);
	}

	Destination chosen() const { return Destination(destination->currentData().toInt()); }

	/* The FAQ is in every Better Clips app, so it opens in the one you use. */
	std::string faq_app() const
	{
		if (chosen() == Destination::YouTube)
			return youtube_page->faq_app();
		return chosen() == Destination::ClipsApp ? app_url->text().trimmed().toStdString() : HOSTED_APP;
	}

	/* Shows the chosen destination's fields, and sizes the dialog to them. */
	void show_destination()
	{
		Destination to = chosen();
		app_page->setVisible(to == Destination::ClipsApp);
		s3_page->setVisible(to == Destination::S3);
		youtube_page->setVisible(to == Destination::YouTube);

		const char *hotkey = "Then bind <b>Save Replay and Upload</b> in Settings &gt; Hotkeys.";
		if (to == Destination::ClipsApp)
			help->setText(QString("Saved replays upload from memory to your Better Clips app and are "
					      "never written to disk.<br>Easiest: click <b>Connect OBS</b> in your "
					      "Better Clips app, copy the setup code, then click <b>Paste setup "
					      "code</b>.<br>%1")
					      .arg(hotkey));
		else if (to == Destination::S3)
			help->setText(QString("Saved replays upload from memory straight to your own S3-compatible "
					      "bucket, such as Cloudflare R2.<br>%1")
					      .arg(hotkey));
		else
			help->setText(
				QString("Saved replays upload from memory to your YouTube channel.<br>%1").arg(hotkey));

		/* YouTube has no setup code, and signing in is its test. */
		paste->setVisible(to != Destination::YouTube);
		test->setVisible(to != Destination::YouTube);
		status->clear();
		// Let Qt recompute the newly visible form's size hints before measuring it.
		QMetaObject::invokeMethod(this, &SettingsDialog::fit_page, Qt::QueuedConnection);
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
		const auto code = QApplication::clipboard()->text().trimmed();
		if (!apply_setup_code(code.toStdString(), config)) {
			status->setText(
				"No setup code on the clipboard. Copy it from Connect OBS in your Better Clips app.");
			return;
		}
		app_url->setText(QString::fromStdString(config.app_url));
		upload_token->setText(QString::fromStdString(config.upload_token));
		s3_url->setText(QString::fromStdString(config.s3_url));
		access_key->setText(QString::fromStdString(config.access_key));
		secret_key->setText(QString::fromStdString(config.secret_key));
		folder->setText(QString::fromStdString(config.folder));
		public_url->setText(QString::fromStdString(config.public_url));
		destination->setCurrentIndex(destination->findData(
			int(code.startsWith("r2obs2:") ? Destination::ClipsApp : Destination::S3)));
		status->setText("Setup code pasted. Click Test Upload, then Save.");
	}

	/* Checks the settings now, so a typo shows up before a clip is lost. */
	void run_test()
	{
		R2Config config = current();
		const auto to = chosen();
		const auto generation = ++test_generation;
		test->setEnabled(false);
		status->setText("Testing...");

		QPointer<SettingsDialog> self(this);
		tests_running++;
		std::thread([config, self, to, generation]() {
			std::string error;
			bool ok = test_connection(to, config, error);
			QString message = ok ? test_success(to)
					     : QString("Test failed: %1").arg(QString::fromStdString(error));
			QMetaObject::invokeMethod(
				qApp,
				[self, message, generation, ok, to]() {
					if (!self || self->test_generation != generation)
						return;
					if (ok)
						record_destination_success(to, false);
					self->status->setText(message);
					self->test->setEnabled(true);
				},
				Qt::QueuedConnection);
			tests_running--;
		}).detach();
	}
};

/* ---- Reviewing a clip before it goes to YouTube ---- */

/* Review dialogs hold metadata only. All accesses run on the UI thread. */
bool reviewing = false;
QSet<QDialog *> open_reviews;

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

} // namespace

/* "r2obs2:" + base64 of {"a": app URL, "t": upload token}. Older apps gave
 * "r2obs1:" + base64 of {"u": S3 API URL, "k": access key, "s": secret key,
 * "f": folder}. */
bool apply_setup_code(const std::string &text, R2Config &config)
{
	QString code = QString::fromStdString(text).trimmed();
	if (!code.startsWith("r2obs1:") && !code.startsWith("r2obs2:"))
		return false;
	auto payload = QByteArray::fromBase64Encoding(code.mid(7).toUtf8(), QByteArray::AbortOnBase64DecodingErrors);
	if (!payload)
		return false;
	QJsonObject fields = QJsonDocument::fromJson(payload.decoded).object();
	auto field = [&](const char *name) {
		return fields.value(name).toString().trimmed().toStdString();
	};
	const bool app = code.startsWith("r2obs2:");
	const QUrl url(QString::fromStdString(field(app ? "a" : "u")), QUrl::StrictMode);
	if (!url.isValid() || url.host().isEmpty() || !url.userInfo().isEmpty() || url.hasQuery() ||
	    url.hasFragment() || !secure_url(url.toString().toStdString()) ||
	    (!app && url.path().split('/', Qt::SkipEmptyParts).isEmpty()))
		return false;
	if (app && !field("t").empty()) {
		config.app_url = field("a");
		config.upload_token = field("t");
	} else if (!app && !field("k").empty() && !field("s").empty()) {
		if (config.s3_url != field("u"))
			config.public_url.clear();
		config.s3_url = field("u");
		config.access_key = field("k");
		config.secret_key = field("s");
		config.folder = fields.value("f").toString("replays").toStdString();
	} else {
		return false;
	}
	return true;
}

void check_connection_async(const R2Config &config)
{
	const auto to = get_youtube_settings().destination;
	tests_running++;
	std::thread([config, to]() {
		std::string error;
		bool ok = test_connection(to, config, error);
		const auto now = get_config();
		if (get_youtube_settings().destination == to && now.app_url == config.app_url &&
		    now.upload_token == config.upload_token && now.s3_url == config.s3_url &&
		    now.access_key == config.access_key && now.secret_key == config.secret_key &&
		    now.folder == config.folder) {
			if (ok)
				record_destination_success(to, false);
			notify_user(ok ? test_success(to).toStdString()
				       : "Better Clips: storage check failed (" + error + ")");
		}
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
	static QPointer<SettingsDialog> current;
	if (current) {
		current->showNormal();
		current->raise();
		current->activateWindow();
		return;
	}
	auto *parent = static_cast<QWidget *>(obs_frontend_get_main_window());
	auto *dialog = new SettingsDialog(parent);
	current = dialog;
	dialog->setAttribute(Qt::WA_DeleteOnClose);
	dialog->show();
}

void refresh_youtube_account()
{
	if (open_account)
		open_account->refresh_credentials();
}

void start_youtube_reviews()
{
	reviewing = true;
}

void stop_youtube_reviews()
{
	reviewing = false;
	while (!open_reviews.empty())
		delete *open_reviews.begin();
}

void youtube_review(const YouTubeUpload &upload, const std::string &channel_title, const std::string &path,
		    std::function<void(YouTubeUpload)> approved)
{
	if (!reviewing || open_reviews.size() >= 16) {
		notify_user("Better Clips: can't open another review. Local copy: " + path);
		return;
	}
	auto *parent = static_cast<QWidget *>(obs_frontend_get_main_window());
	auto *dialog = new ReviewDialog(parent, upload, channel_title);
	dialog->setAttribute(Qt::WA_DeleteOnClose);
	dialog->setAttribute(Qt::WA_ShowWithoutActivating);
	open_reviews.insert(dialog);
	QObject::connect(dialog, &QDialog::finished, [approved = std::move(approved), path, dialog](int result) {
		if (result == QDialog::Accepted)
			approved(dialog->edited());
		else
			notify_user("Better Clips: YouTube upload cancelled. Local copy: " + path);
	});
	QObject::connect(dialog, &QObject::destroyed, [dialog]() { open_reviews.remove(dialog); });
	dialog->show();
	QApplication::alert(dialog);
}

#include "settings-dialog.moc"
