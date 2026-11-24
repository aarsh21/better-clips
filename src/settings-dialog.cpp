/* Tools > Replay to R2 Settings */

#include "replay-r2.hpp"

#include <obs-frontend-api.h>

#include <QApplication>
#include <QCheckBox>
#include <QClipboard>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
#include <QPointer>
#include <QPushButton>
#include <QVBoxLayout>

#include <atomic>
#include <chrono>
#include <thread>

namespace {

/* Test uploads run on their own thread; OBS waits for them before it unloads
 * the plugin and shuts curl down. */
std::atomic<int> tests_running{0};

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

class SettingsDialog : public QDialog {
public:
	explicit SettingsDialog(QWidget *parent) : QDialog(parent)
	{
		setWindowTitle("Replay to R2 Settings");
		setMinimumWidth(560);

		R2Config config = get_config();
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

		auto *help = new QLabel("Saved replays are uploaded from memory and never written to disk.<br>"
					"Easiest: open your clips app, click <b>Connect OBS</b>, copy the setup code, "
					"then click <b>Paste setup code</b> here.<br>"
					"Then bind <b>Save Replay to Cloudflare R2</b> in Settings &gt; Hotkeys.");
		help->setWordWrap(true);

		start_replay = new QCheckBox("Start the Replay Buffer when OBS opens");
		start_replay->setChecked(config.start_replay_buffer);

		auto *form = new QFormLayout();
		form->addRow("Clips app", app_url);
		form->addRow("Upload token", upload_token);
		auto *s3_heading =
			new QLabel("Or upload straight to your own S3 bucket (used when Clips app is empty):");
		s3_heading->setWordWrap(true);
		form->addRow(s3_heading);
		form->addRow("S3 API URL", s3_url);
		form->addRow("Access Key ID", access_key);
		form->addRow("Secret Access Key", secret_key);
		form->addRow("Folder", folder);
		form->addRow("Public URL", public_url);
		form->addRow(start_replay);

		status = new QLabel();
		status->setWordWrap(true);
		status->setTextInteractionFlags(Qt::TextSelectableByMouse);

		auto *buttons = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel);
		QPushButton *paste = buttons->addButton("Paste setup code", QDialogButtonBox::ActionRole);
		QPushButton *test = buttons->addButton("Test Upload", QDialogButtonBox::ActionRole);
		connect(paste, &QPushButton::clicked, this, [this]() { paste_setup_code(); });
		connect(buttons, &QDialogButtonBox::accepted, this, [this]() {
			set_config(current());
			accept();
		});
		connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
		connect(test, &QPushButton::clicked, this, [this, test]() { run_test(test); });

		auto *layout = new QVBoxLayout(this);
		layout->addWidget(help);
		layout->addLayout(form);
		layout->addWidget(status);
		layout->addWidget(buttons);
	}

private:
	QLineEdit *app_url, *upload_token, *s3_url, *access_key, *secret_key, *folder, *public_url;
	QCheckBox *start_replay;
	QLabel *status;

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
		status->setText("Setup code pasted. Click Test Upload, then Save.");
	}

	/* Checks the settings now, so a typo shows up before a clip is lost. */
	void run_test(QPushButton *button)
	{
		R2Config config = current();
		button->setEnabled(false);
		status->setText("Testing...");

		QPointer<SettingsDialog> self(this);
		QPointer<QPushButton> button_ptr(button);
		tests_running++;
		std::thread([config, self, button_ptr]() {
			std::string where, error;
			bool ok = test_connection(config, where, error);
			QString message =
				ok ? QString("Test worked: clips will upload to %1").arg(QString::fromStdString(where))
				   : QString("Test failed: %1").arg(QString::fromStdString(error));
			QMetaObject::invokeMethod(
				qApp,
				[self, button_ptr, message]() {
					if (self)
						self->status->setText(message);
					if (button_ptr)
						button_ptr->setEnabled(true);
				},
				Qt::QueuedConnection);
			tests_running--;
		}).detach();
	}
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
