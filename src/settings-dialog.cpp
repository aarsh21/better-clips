/* Tools > Replay to R2 Settings */

#include "replay-r2.hpp"

#include <obs-frontend-api.h>

#include <QApplication>
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

#include <thread>

namespace {

class SettingsDialog : public QDialog {
public:
	explicit SettingsDialog(QWidget *parent) : QDialog(parent)
	{
		setWindowTitle("Replay to R2 Settings");
		setMinimumWidth(560);

		R2Config config = get_config();
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

		auto *form = new QFormLayout();
		form->addRow("S3 API URL", s3_url);
		form->addRow("Access Key ID", access_key);
		form->addRow("Secret Access Key", secret_key);
		form->addRow("Folder", folder);
		form->addRow("Public URL", public_url);

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
	QLineEdit *s3_url, *access_key, *secret_key, *folder, *public_url;
	QLabel *status;

	R2Config current() const
	{
		R2Config config;
		config.s3_url = s3_url->text().trimmed().toStdString();
		config.access_key = access_key->text().trimmed().toStdString();
		config.secret_key = secret_key->text().trimmed().toStdString();
		config.folder = folder->text().trimmed().toStdString();
		config.public_url = public_url->text().trimmed().toStdString();
		return config;
	}

	/* The clips app's setup code: "r2obs1:" + base64 of
	 * {"u": S3 API URL, "k": access key, "s": secret key, "f": folder}. */
	void paste_setup_code()
	{
		QString text = QApplication::clipboard()->text().trimmed();
		const QString prefix = "r2obs1:";
		QJsonObject code;
		if (text.startsWith(prefix)) {
			QByteArray json = QByteArray::fromBase64(text.mid(prefix.size()).toUtf8());
			code = QJsonDocument::fromJson(json).object();
		}
		if (code.value("u").toString().isEmpty() || code.value("k").toString().isEmpty() ||
		    code.value("s").toString().isEmpty()) {
			status->setText("No setup code on the clipboard. Copy it from Connect OBS in your clips app.");
			return;
		}
		s3_url->setText(code.value("u").toString());
		access_key->setText(code.value("k").toString());
		secret_key->setText(code.value("s").toString());
		folder->setText(code.value("f").toString("replays"));
		public_url->clear();
		status->setText("Setup code pasted. Click Test Upload, then Save.");
	}

	/* Uploads a small text file so a typo shows up now, not after a clip is lost. */
	void run_test(QPushButton *button)
	{
		R2Config config = current();
		std::string key = object_key(config, "replay-r2-test.txt");
		button->setEnabled(false);
		status->setText("Uploading test file...");

		QPointer<SettingsDialog> self(this);
		QPointer<QPushButton> button_ptr(button);
		std::thread([config, key, self, button_ptr]() {
			const std::string text = "Replay to R2 for OBS can upload to this bucket.\n";
			std::vector<uint8_t> body(text.begin(), text.end());
			std::string error;
			bool ok = s3_put_object(config, key, body, "text/plain", error);
			QString message = ok ? QString("Test upload worked: %1").arg(QString::fromStdString(key))
					     : QString("Test upload failed: %1").arg(QString::fromStdString(error));
			QMetaObject::invokeMethod(
				qApp,
				[self, button_ptr, message]() {
					if (self)
						self->status->setText(message);
					if (button_ptr)
						button_ptr->setEnabled(true);
				},
				Qt::QueuedConnection);
		}).detach();
	}
};

} // namespace

void show_settings_dialog()
{
	auto *parent = static_cast<QWidget *>(obs_frontend_get_main_window());
	auto *dialog = new SettingsDialog(parent);
	dialog->setAttribute(Qt::WA_DeleteOnClose);
	dialog->show();
}
