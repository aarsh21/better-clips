#include "youtube-credential.hpp"

#if defined(_WIN32)
#include <windows.h>
#include <wincred.h>
#elif defined(__APPLE__)
#include <Security/Security.h>
#else
#include <libsecret/secret.h>
#endif

namespace youtube_credential {
#if defined(_WIN32)
static std::string target(const std::string &id)
{
	return "Better Clips/YouTube/" + id;
}

std::string read(const std::string &id)
{
	PCREDENTIALA item = nullptr;
	if (!CredReadA(target(id).c_str(), CRED_TYPE_GENERIC, 0, &item))
		return {};
	std::string token(reinterpret_cast<const char *>(item->CredentialBlob), item->CredentialBlobSize);
	CredFree(item);
	return token;
}

bool store(const std::string &id, const std::string &token)
{
	if (token.size() > CRED_MAX_CREDENTIAL_BLOB_SIZE)
		return false;
	auto name = target(id);
	CREDENTIALA item{};
	item.Type = CRED_TYPE_GENERIC;
	item.TargetName = name.data();
	item.Persist = CRED_PERSIST_LOCAL_MACHINE;
	item.CredentialBlob = reinterpret_cast<BYTE *>(const_cast<char *>(token.data()));
	item.CredentialBlobSize = static_cast<DWORD>(token.size());
	return CredWriteA(&item, 0) != FALSE;
}

void remove(const std::string &id)
{
	CredDeleteA(target(id).c_str(), CRED_TYPE_GENERIC, 0);
}
#elif defined(__APPLE__)
static CFMutableDictionaryRef query(const std::string &id)
{
	auto dict =
		CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	auto account = CFStringCreateWithCString(nullptr, id.c_str(), kCFStringEncodingUTF8);
	CFDictionarySetValue(dict, kSecClass, kSecClassGenericPassword);
	CFDictionarySetValue(dict, kSecAttrService, CFSTR("Better Clips YouTube"));
	CFDictionarySetValue(dict, kSecAttrAccount, account);
	CFRelease(account);
	return dict;
}

std::string read(const std::string &id)
{
	auto dict = query(id);
	CFDictionarySetValue(dict, kSecReturnData, kCFBooleanTrue);
	CFTypeRef result = nullptr;
	auto status = SecItemCopyMatching(dict, &result);
	CFRelease(dict);
	if (status != errSecSuccess)
		return {};
	auto data = static_cast<CFDataRef>(result);
	std::string token(reinterpret_cast<const char *>(CFDataGetBytePtr(data)),
			  static_cast<size_t>(CFDataGetLength(data)));
	CFRelease(data);
	return token;
}

bool store(const std::string &id, const std::string &token)
{
	auto dict = query(id);
	auto data = CFDataCreate(nullptr, reinterpret_cast<const UInt8 *>(token.data()),
				 static_cast<CFIndex>(token.size()));
	CFDictionarySetValue(dict, kSecValueData, data);
	CFRelease(data);
	auto status = SecItemAdd(dict, nullptr);
	CFRelease(dict);
	return status == errSecSuccess;
}

void remove(const std::string &id)
{
	auto dict = query(id);
	SecItemDelete(dict);
	CFRelease(dict);
}
#else
static const SecretSchema schema = [] {
	SecretSchema s{};
	s.name = "me.zabimaru.BetterClips.YouTube";
	s.attributes[0] = {"grant", SECRET_SCHEMA_ATTRIBUTE_STRING};
	return s;
}();

std::string read(const std::string &id)
{
	auto *value = secret_password_lookup_sync(&schema, nullptr, nullptr, "grant", id.c_str(), nullptr);
	std::string token = value ? value : "";
	secret_password_free(value);
	return token;
}

bool store(const std::string &id, const std::string &token)
{
	return secret_password_store_sync(&schema, SECRET_COLLECTION_DEFAULT, "Better Clips YouTube", token.c_str(),
					  nullptr, nullptr, "grant", id.c_str(), nullptr);
}

void remove(const std::string &id)
{
	secret_password_clear_sync(&schema, nullptr, nullptr, "grant", id.c_str(), nullptr);
}
#endif
} // namespace youtube_credential
