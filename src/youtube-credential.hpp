#pragma once
#include <string>

// Only this opaque, per-sign-in id belongs in OBS settings.
namespace youtube_credential {
std::string read(const std::string &id);
bool store(const std::string &id, const std::string &token);
void remove(const std::string &id);
} // namespace youtube_credential
