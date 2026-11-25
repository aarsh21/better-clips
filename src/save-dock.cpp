/*
Replay to R2 for OBS
Copyright (C) 2026

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.
*/

/* The "Replay to R2" dock: a Save button, the replay length and the result
 * of the last save, next to OBS's own Controls. */

#include "replay-r2.hpp"
#include "youtube.hpp"

#include <obs-frontend-api.h>

#include <QDockWidget>
#include <QHBoxLayout>
#include <QLabel>
#include <QMainWindow>
#include <QPointer>
#include <QPushButton>
#include <QSignalBlocker>
#include <QSpinBox>
#include <QTimer>
#include <QVBoxLayout>

namespace {

constexpr const char *DOCK_ID = "ReplayR2Dock";

class SaveDock : public QWidget {
public:
	SaveDock()
	{
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

		auto *layout = new QVBoxLayout(this);
		layout->addWidget(save);
		layout->addLayout(row);
		layout->addWidget(message);
		layout->addStretch(1);

		auto *timer = new QTimer(this);
		connect(timer, &QTimer::timeout, this, [this]() { refresh(); });
		timer->start(1000);
		refresh();
	}

	void refresh()
	{
		bool running = obs_frontend_replay_buffer_active();
		bool youtube = get_youtube_settings().destination == Destination::YouTube;
		save->setText(!running  ? "Start Replay Buffer"
			      : youtube ? "Save Replay to YouTube"
					: "Save Replay to R2");
		save->setToolTip(!running  ? "Starts OBS's Replay Buffer so you can save clips"
				 : youtube ? "Uploads the last few seconds to your YouTube channel"
					   : "Uploads the last few seconds to your clips app");

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
		shown.remove("Replay to R2: ");
		if (!shown.isEmpty())
			shown[0] = shown[0].toUpper();
		message->setText(shown);
	}

private:
	QPushButton *save;
	QSpinBox *length;
	QLabel *message;

	void on_click()
	{
		if (obs_frontend_replay_buffer_active()) {
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
	if (!obs_frontend_add_dock_by_id(DOCK_ID, "Replay to R2", dock))
		delete dock;
}

void update_save_dock()
{
	if (dock)
		dock->refresh();
}

void place_save_dock()
{
	auto *window = static_cast<QMainWindow *>(obs_frontend_get_main_window());
	if (!window || !dock)
		return;
	auto *ours = window->findChild<QDockWidget *>(DOCK_ID);
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
