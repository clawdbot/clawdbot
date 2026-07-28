import CryptoKit
import Foundation
import Security

struct GatewayRouteChangedAfterDispatchError: LocalizedError, Sendable {
    let method: String

    var errorDescription: String? {
        "The Gateway route changed after \(self.method) was sent. Its result is unknown; refresh before retrying."
    }
}

enum GatewayActivationBindingKeyStore {
    private static let service = "ai.openclaw.onboarding-route-binding"
    private static let account = "credential-binding-v1"
    private static let byteCount = 32

    static func loadOrCreate() -> SymmetricKey? {
        if let data = load() {
            return SymmetricKey(data: data)
        }

        var data = Data(count: byteCount)
        let randomStatus = data.withUnsafeMutableBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(kSecRandomDefault, self.byteCount, baseAddress)
        }
        guard randomStatus == errSecSuccess else { return nil }

        var query = self.baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return SymmetricKey(data: data)
        }
        // Another process can win the first-launch create race. Only accept the
        // secret after reading the Keychain item back through normal ACL checks.
        if addStatus == errSecDuplicateItem, let existing = load() {
            return SymmetricKey(data: existing)
        }
        return nil
    }

    private static func load() -> Data? {
        var query = self.baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              data.count == byteCount
        else { return nil }
        return data
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }
}
