/* The name of the window you're using when you save, usually the game, so a
 * clip is called "Counter-Strike 2" instead of the OBS scene's "Scene".
 * Returns "" when OBS itself is focused or the system can't say, and the
 * clip falls back to the scene name. */

#include "replay-r2.hpp"

#include <string>

#if defined(_WIN32)

#include <windows.h>

std::string focused_window_name()
{
	HWND window = GetForegroundWindow();
	DWORD pid = 0;
	if (!window || !GetWindowThreadProcessId(window, &pid) || pid == GetCurrentProcessId())
		return "";

	wchar_t title[256];
	int length = GetWindowTextW(window, title, 256);
	if (length <= 0)
		return "";

	char utf8[1024];
	int bytes = WideCharToMultiByte(CP_UTF8, 0, title, length, utf8, sizeof(utf8), nullptr, nullptr);
	return bytes > 0 ? std::string(utf8, bytes) : "";
}

#elif defined(__APPLE__)

#include <CoreGraphics/CoreGraphics.h>
#include <unistd.h>

/* The owner of the frontmost normal window. Owner names, unlike window
 * titles, don't need the Screen Recording permission. */
std::string focused_window_name()
{
	CFArrayRef windows = CGWindowListCopyWindowInfo(
		kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
	if (!windows)
		return "";

	std::string name;
	for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
		auto info = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, i);
		int layer = -1, pid = 0;
		auto layer_ref = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowLayer);
		auto pid_ref = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowOwnerPID);
		if (!layer_ref || !CFNumberGetValue(layer_ref, kCFNumberIntType, &layer) || layer != 0)
			continue;
		if (pid_ref && CFNumberGetValue(pid_ref, kCFNumberIntType, &pid) && pid == getpid())
			break; /* OBS is in front */

		auto owner = (CFStringRef)CFDictionaryGetValue(info, kCGWindowOwnerName);
		char buffer[256];
		if (owner && CFStringGetCString(owner, buffer, sizeof(buffer), kCFStringEncodingUTF8))
			name = buffer;
		break;
	}
	CFRelease(windows);
	return name;
}

#else

#include <obs-data.h>

#include <cstdlib>
#include <cstring>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

/* Hyprland answers "j/activewindow" on its IPC socket with the focused
 * window as JSON. Other Linux desktops don't offer this to apps. */
std::string focused_window_name()
{
	const char *signature = getenv("HYPRLAND_INSTANCE_SIGNATURE");
	const char *runtime = getenv("XDG_RUNTIME_DIR");
	if (!signature || !*signature || !runtime)
		return "";

	sockaddr_un address = {};
	address.sun_family = AF_UNIX;
	std::string path = std::string(runtime) + "/hypr/" + signature + "/.socket.sock";
	if (path.size() >= sizeof(address.sun_path))
		return "";
	memcpy(address.sun_path, path.c_str(), path.size() + 1);

	int fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0)
		return "";
	timeval timeout = {0, 300000}; /* never hold up a save */
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
	setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));

	std::string reply;
	const char request[] = "j/activewindow";
	if (connect(fd, (sockaddr *)&address, sizeof(address)) == 0 &&
	    write(fd, request, sizeof(request) - 1) == (ssize_t)(sizeof(request) - 1)) {
		char buffer[4096];
		ssize_t n;
		while (reply.size() < 65536 && (n = read(fd, buffer, sizeof(buffer))) > 0)
			reply.append(buffer, (size_t)n);
	}
	close(fd);
	if (reply.empty())
		return "";

	obs_data_t *window = obs_data_create_from_json(reply.c_str());
	if (!window)
		return "";
	std::string name;
	if (obs_data_get_int(window, "pid") != getpid()) {
		name = obs_data_get_string(window, "title");
		if (name.empty())
			name = obs_data_get_string(window, "class");
	}
	obs_data_release(window);
	return name;
}

#endif
