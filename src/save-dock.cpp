/*
Better Clips for OBS
Copyright (C) 2026

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.
*/

/* The "Better Clips" dock: a Save button, the replay length and the result
 * of the last save, next to OBS's own Controls. */

#include "replay-r2.hpp"
#include "youtube.hpp"

#include <obs-frontend-api.h>

#include <QApplication>
#include <QTime>
#include <QDockWidget>
#include <QHBoxLayout>
#include <QLabel>
#include <QMainWindow>
#include <QPointer>
#include <QPushButton>
#include <QScrollArea>
#include <QSignalBlocker>
#include <QSpinBox>
#include <QTimer>
#include <QVBoxLayout>

namespace {

QString last_success = "No upload or test yet this session";

const char *destination_name(Destination to)
{
	return to == Destination::S3 ? "S3" : to == Destination::YouTube ? "YouTube" : "Better Clips app";
}

const char *dock_id()
{
	return plugin_disabled() ? "BetterClipsRecoveryDock" : "ReplayR2Dock";
}

class SaveDock : public QWidget {
public:
	SaveDock()
	{
		if (plugin_disabled()) {
			setMinimumWidth(250);
			auto *notice = new QLabel(plugin_startup_notice());
			notice->setTextFormat(Qt::PlainText);
			notice->setTextInteractionFlags(Qt::TextSelectableByMouse);
			notice->setWordWrap(true);
			notice->setToolTip(plugin_startup_notice());
			auto *details = new QPushButton("Recovery instructions");
			connect(details, &QPushButton::clicked, this, show_settings_dialog);
			auto *layout = new QVBoxLayout(this);
			layout->addWidget(details);
			layout->addWidget(notice);
			layout->addStretch();
			return;
		}
		save = new QPushButton();
		save->setMinimumHeight(40);
		QFont bold = save->font();
		bold.setBold(true);
		save->setFont(bold);
		connect(save, &QPushButton::clicked, this, [this]() { on_click(); });

		length = new QSpinBox();
		length->setRange(5, 21600);
		length->setSuffix(" s");
		length->setKeyboardTracking(false); /* apply on Enter or focus out */
		length->setToolTip("How many seconds a saved clip goes back. Same as OBS's Maximum Replay Time.");
		connect(length, &QSpinBox::valueChanged, this, [](int seconds) { set_replay_seconds(seconds); });

		auto *settings = new QPushButton("Settings");
		connect(settings, &QPushButton::clicked, this, []() { show_settings_dialog(); });

		auto *row = new QHBoxLayout();
		row->addWidget(new QLabel("Length"));
		row->addWidget(length, 1);
		row->addWidget(settings);

		message = new QLabel();
		message->setWordWrap(true);
		message->setTextInteractionFlags(Qt::TextSelectableByMouse);
		message->setStyleSheet("color: palette(placeholder-text);");
		message->setText(plugin_startup_notice());
		message->setTextFormat(Qt::PlainText);
		readiness = new QLabel();
		readiness->setWordWrap(true);
		auto *body = new QWidget();
		auto *details = new QVBoxLayout(body);
		details->setContentsMargins(0, 0, 0, 0);
		details->addWidget(message);
		details->addWidget(readiness);
		details->addStretch();
		auto *scroll = new QScrollArea();
		scroll->setFrameShape(QFrame::NoFrame);
		scroll->setWidgetResizable(true);
		scroll->setWidget(body);

		auto *layout = new QVBoxLayout(this);
		layout->addWidget(save);
		layout->addLayout(row);
		layout->addWidget(scroll, 1);

		auto *timer = new QTimer(this);
		connect(timer, &QTimer::timeout, this, [this]() { refresh(); });
		timer->start(1000);
		refresh();
	}

	void refresh()
	{
		bool host = obs_frontend_replay_buffer_active();
		bool running = replay_r2_running();
		auto yt = get_youtube_settings();
		bool youtube = yt.destination == Destination::YouTube;
		bool s3 = yt.destination == Destination::S3;
		/* The Better Clips app keeps clips in R2; an S3 bucket may be anywhere. */
		const auto setup = destination_setup_action();
		save->setText(!host              ? "Start Replay Buffer"
			      : !running         ? "Retry Better Clips Buffer"
			      : !setup.isEmpty() ? setup
			      : youtube          ? "Save Replay to YouTube"
			      : s3               ? "Save Replay to S3"
						 : "Save Replay to R2");
		readiness->setText(QString("OBS buffer: %1 · Better Clips: %2\n%3: %4\n%5")
					   .arg(host ? "running" : "off", running ? "running" : "off",
						destination_name(yt.destination),
						!setup.isEmpty() ? "not configured"
						: youtube        ? "paired"
								 : "configured",
						last_success));
		message->setVisible(!message->text().isEmpty());
		message->setMinimumHeight(message->heightForWidth(message->width()));
		readiness->setMinimumHeight(readiness->heightForWidth(readiness->width()));

		int seconds = get_replay_seconds();
		if (seconds > 0 && !length->hasFocus() && length->value() != seconds) {
			QSignalBlocker block(length);
			length->setValue(seconds);
		}
		/* Picks up a length changed in OBS's Settings while running. */
		sync_replay_seconds();
	}

	void show_message(const QString &text)
	{
		QString shown = text;
		shown.remove("Better Clips: ");
		shown.remove("Replay to R2: "); /* before the rename */
		if (!shown.isEmpty())
			shown[0] = shown[0].toUpper();
		message->setText(shown);
	}

private:
	QPushButton *save;
	QSpinBox *length;
	QLabel *message, *readiness;

	void on_click()
	{
		if (obs_frontend_replay_buffer_active()) {
			if (!replay_r2_running())
				retry_plugin_buffer();
			else if (!destination_setup_action().isEmpty())
				show_settings_dialog();
			else
				save_replay_to_r2();
			return;
		}
		obs_output_t *output = obs_frontend_get_replay_buffer_output();
		if (!output) {
			show_message("Turn on the Replay Buffer in Settings > Output first.");
			return;
		}
		obs_output_release(output);
		obs_frontend_replay_buffer_start();
	}
};

QPointer<SaveDock> dock;

} // namespace

void create_save_dock()
{
	dock = new SaveDock();
	if (!obs_frontend_add_dock_by_id(dock_id(), "Better Clips", dock))
		delete dock;
}

void update_save_dock()
{
	if (dock)
		dock->refresh();
}

void record_destination_success(Destination to, bool upload)
{
	QMetaObject::invokeMethod(
		qApp,
		[to, upload] {
			last_success = QString("Last success: %1 %2 at %3")
					       .arg(destination_name(to), upload ? "upload" : "test",
						    QTime::currentTime().toString("HH:mm"));
			update_save_dock();
		},
		Qt::QueuedConnection);
}

void place_save_dock()
{
	auto *window = static_cast<QMainWindow *>(obs_frontend_get_main_window());
	if (!window || !dock)
		return;
	auto *ours = window->findChild<QDockWidget *>(dock_id());
	auto *controls = window->findChild<QDockWidget *>("controlsDock");
	if (!ours || !controls || !controls->isVisible())
		return;
	ours->setFloating(false);
	window->splitDockWidget(controls, ours, Qt::Horizontal);
	ours->setVisible(true);
}

void show_dock_message(const QString &message)
{
	if (dock)
		dock->show_message(message);
}
