#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

using Sha256Digest = std::array<uint8_t, 32>;

Sha256Digest sha256(const void *data, size_t size);
Sha256Digest hmac_sha256(const void *key, size_t key_size, const std::string &message);
std::string to_hex(const uint8_t *data, size_t size);

inline std::string to_hex(const Sha256Digest &digest)
{
	return to_hex(digest.data(), digest.size());
}
