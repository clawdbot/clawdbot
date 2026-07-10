import Foundation
import OpenClawKit
import Security

enum KeychainStore {
    static func loadString(service: String, account: String) -> String? {
        GenericPasswordKeychainStore.loadString(service: service, account: account)
    }

    static func saveString(_ value: String, service: String, account: String) -> Bool {
        GenericPasswordKeychainStore.saveString(value, service: service, account: account)
    }

    static func delete(service: String, account: String) -> Bool {
        GenericPasswordKeychainStore.delete(service: service, account: account)
    }

    static func deleteAll(service: String) -> Bool {
        GenericPasswordKeychainStore.deleteAll(service: service)
    }

    static func deleteAccounts(service: String, accountPrefix: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return true
        }
        guard status == errSecSuccess else { return false }
        let matches = item as? [[String: Any]] ?? []
        let accounts = matches
            .compactMap { $0[kSecAttrAccount as String] as? String }
            .filter { $0.hasPrefix(accountPrefix) }
        var deletedAll = true
        for account in accounts where !self.delete(service: service, account: account) {
            deletedAll = false
        }
        return deletedAll
    }
}
