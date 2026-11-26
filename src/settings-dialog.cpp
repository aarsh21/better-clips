/* Tools > Better Clips Settings, and the dialog that reviews a clip before
 * it goes to YouTube. */

#include "replay.hpp"
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

bool secure_url(const std::string &text)
{
	const QUrl url(QString::fromStdString(text));
	return url.isValid() && !url.host().isEmpty() && url.userInfo().isEmpty() &&
	       (url.scheme() == "https" ||
		(url.scheme() == "http" && (url.host() == "localhost" || url.host() == "127.0.0.1")));
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
	auto *terms = new QLabel(
		QString("By clicking 'upload,' you certify that the content you are uploading complies with the YouTube Terms of Service (including the YouTube Community Guidelines) at <a href=\"%1\">%1</a>. Please be sure not to violate others' copyright or privacy rights.")
			.arg(YOUTUBE_TERMS));
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
				"This removes the channel from Better Clips on every device. All of its app library entries disappear. The videos stay on YouTube.",
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
		audience = new QComboBox();
		audience->addItem("Yes", true);
		audience->addItem("No", false);
		audience->setCurrentIndex(audience->findData(settings.made_for_kids));

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
		defaults->addRow("Made for kids?", audience);
		auto *audience_help = hint_label(
			"Choose Yes if your clips are directed at children. <a href=\"https://support.google.com/youtube/answer/9528076\">How to choose</a>");
		audience_help->setOpenExternalLinks(true);
		defaults->addRow(QString(), audience_help);
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
		if (disconnect_button->isHidden())
			return;
		const auto settings = get_youtube_settings();
		show_account(settings);
		if (!youtube_connected(settings))
			show_status("This OBS is no longer connected. Reconnect to upload to YouTube.", true);
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
		settings.made_for_kids = audience->currentData().toBool();
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
	QComboBox *privacy, *audience, *audio_track;
	QPlainTextEdit *description;
	QCheckBox *review;

	YouTubeRoute route() const { return direct->isChecked() ? YouTubeRoute::Direct : YouTubeRoute::ClipsApp; }

	/* The trade-off of the chosen route, and the fields it needs. */
	void show_route(const YouTubeSettings &settings)
	{
		const bool app = route() == YouTubeRoute::ClipsApp;
		const bool reconnect = app ? settings.previously_paired : settings.previously_direct;
		sign_in->setText(reconnect ? "Reconnect YouTube" : "Sign in with YouTube");
		route_hint->setText(app ? "Clips show up in the Better Clips app, to watch, rename and delete them."
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

		youtube_page = new YouTubePage(get_youtube_settings());
		open_account = youtube_page;

		start_replay = new QCheckBox("Start the Replay Buffer when OBS opens");
		start_replay->setChecked(get_youtube_settings().start_replay_buffer);

		status = new QLabel();
		status->setWordWrap(true);
		status->setTextInteractionFlags(Qt::TextSelectableByMouse);

		auto *buttons = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel);
		connect(buttons, &QDialogButtonBox::accepted, this, [this]() {
			YouTubeSettings settings = youtube_page->current();
			settings.start_replay_buffer = start_replay->isChecked();
			if (!save_settings(settings)) {
				status->setText(
					"Settings weren't saved. Check the permissions on the Better Clips settings folder, then try again.");
				return;
			}
			accept();
		});
		connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
		auto *faq = new QLabel("<a href=\"faq\">Questions? Read the FAQ</a>");
		connect(faq, &QLabel::linkActivated, this, [this]() { open_faq(youtube_page->faq_app()); });
		auto *bottom = new QHBoxLayout();
		bottom->addWidget(faq);
		bottom->addWidget(buttons, 1);

		auto *content = new QWidget();
		auto *fields = new QVBoxLayout(content);
		fields->setContentsMargins(0, 0, 0, 0);
		fields->setSizeConstraint(QLayout::SetMinAndMaxSize);
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

		align_labels({youtube_page->form, youtube_page->defaults});
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

	YouTubePage *youtube_page;
	QCheckBox *start_replay;
	QLabel *status;
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

void show_settings_dialog()
{
	if (!plugin_disabled())
		check_youtube_pairing();
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
