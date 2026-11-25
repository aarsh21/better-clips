/* The name of the app you're using when you save, usually the game, so a
 * clip's category is "Counter-Strike 2" or "Google Chrome" instead of the OBS
 * scene's "Scene". It's the app, not the window title, so every browser tab
 * or document lands in the same category. Returns "" when OBS itself is
 * focused or the system can't say, and the clip falls back to the scene. */

#include "replay-r2.hpp"

#include <string>

#if defined(_WIN32)

#include <windows.h>
#include <winver.h>

#include <cwchar>
#include <vector>

static std::string utf8(const wchar_t *text, int length = -1)
{
	int bytes = WideCharToMultiByte(CP_UTF8, 0, text, length, nullptr, 0, nullptr, nullptr);
	if (bytes <= 0)
		return "";
	std::string out((size_t)bytes, '\0');
	WideCharToMultiByte(CP_UTF8, 0, text, length, out.data(), bytes, nullptr, nullptr);
	if (length == -1)
		out.pop_back(); /* the terminator */
	return out;
}

/* The app's name from its version info, such as "Google Chrome". */
static std::string version_name(const wchar_t *path)
{
	DWORD size = GetFileVersionInfoSizeW(path, nullptr);
	if (!size)
		return "";
	std::vector<BYTE> info(size);
	if (!GetFileVersionInfoW(path, 0, size, info.data()))
		return "";

	struct Translation {
		WORD language, codepage;
	} *translations = nullptr;
	UINT bytes = 0;
	if (!VerQueryValueW(info.data(), L"\\VarFileInfo\\Translation", (void **)&translations, &bytes) ||
	    bytes < sizeof(Translation))
		return "";

	for (const wchar_t *field : {L"FileDescription", L"ProductName"}) {
		wchar_t query[64];
		swprintf(query, 64, L"\\StringFileInfo\\%04x%04x\\%ls", translations[0].language,
			 translations[0].codepage, field);
		wchar_t *value = nullptr;
		UINT length = 0;
		if (VerQueryValueW(info.data(), query, (void **)&value, &length) && length > 1)
			return utf8(value);
	}
	return "";
}

std::string focused_app_name()
{
	HWND window = GetForegroundWindow();
	DWORD pid = 0;
	if (!window || !GetWindowThreadProcessId(window, &pid) || pid == GetCurrentProcessId())
		return "";

	HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
	if (!process) {
		/* Some anti-cheat protected games refuse even this; their window
		 * title is usually just the game's name. */
		wchar_t title[256];
		int length = GetWindowTextW(window, title, 256);
		return length > 0 ? utf8(title, length) : "";
	}
	wchar_t path[1024];
	DWORD length = 1024;
	BOOL ok = QueryFullProcessImageNameW(process, 0, path, &length);
	CloseHandle(process);
	if (!ok)
		return "";

	std::string name = version_name(path);
	if (!name.empty())
		return name;

	/* No version info: the file name without ".exe". */
	const wchar_t *file = wcsrchr(path, L'\\');
	name = utf8(file ? file + 1 : path);
	if (name.size() > 4 && _stricmp(name.c_str() + name.size() - 4, ".exe") == 0)
		name.resize(name.size() - 4);
	return name;
}

#elif defined(__APPLE__)

#include <CoreGraphics/CoreGraphics.h>
#include <unistd.h>

/* The owner of the frontmost normal window. Owner names, unlike window
 * titles, don't need the Screen Recording permission. */
std::string focused_app_name()
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
#include <filesystem>
#include <fstream>
#include <vector>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

/* The Name= of an installed app's .desktop file: the one called
 * <app id>.desktop, or else one whose StartupWMClass is the app id. So
 * "google-chrome" is "Google Chrome". */
static std::string desktop_name(const std::string &app_id)
{
	if (app_id.empty() || app_id.find('/') != std::string::npos)
		return "";

	std::vector<std::string> dirs;
	const char *data_home = getenv("XDG_DATA_HOME");
	const char *home = getenv("HOME");
	if (data_home && *data_home)
		dirs.push_back(data_home);
	else if (home)
		dirs.push_back(std::string(home) + "/.local/share");
	const char *data_dirs = getenv("XDG_DATA_DIRS");
	std::string list = data_dirs && *data_dirs ? data_dirs : "/usr/local/share:/usr/share";
	for (size_t start = 0, end; start <= list.size(); start = end + 1) {
		end = list.find(':', start);
		if (end == std::string::npos)
			end = list.size();
		if (end > start)
			dirs.push_back(list.substr(start, end - start));
	}

	/* The [Desktop Entry] keys of one file. */
	auto read = [](const std::filesystem::path &path, std::string &name, std::string &wm_class) {
		std::ifstream file(path);
		std::string line;
		bool entry = false;
		while (std::getline(file, line)) {
			if (!line.empty() && line.back() == '\r')
				line.pop_back();
			if (!line.empty() && line[0] == '[')
				entry = line == "[Desktop Entry]";
			else if (entry && line.rfind("Name=", 0) == 0 && name.empty())
				name = line.substr(5);
			else if (entry && line.rfind("StartupWMClass=", 0) == 0)
				wm_class = line.substr(15);
		}
	};

	std::error_code error;
	for (const std::string &dir : dirs) {
		std::string name, wm_class;
		read(dir + "/applications/" + app_id + ".desktop", name, wm_class);
		if (!name.empty())
			return name;
	}
	for (const std::string &dir : dirs) {
		for (const auto &file : std::filesystem::directory_iterator(dir + "/applications", error)) {
			if (file.path().extension() != ".desktop")
				continue;
			std::string name, wm_class;
			read(file.path(), name, wm_class);
			if (!name.empty() && wm_class == app_id)
				return name;
		}
	}
	return "";
}

/* Hyprland answers "j/activewindow" on its IPC socket with the focused
 * window as JSON; its class is the app. Other Linux desktops don't offer
 * this to apps. */
std::string focused_app_name()
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
		std::string app = obs_data_get_string(window, "class");
		if (app.empty())
			app = obs_data_get_string(window, "initialClass");
		name = desktop_name(app);
		if (name.empty())
			name = app.empty() ? obs_data_get_string(window, "title") : app;
	}
	obs_data_release(window);
	return name;
}

#endif
