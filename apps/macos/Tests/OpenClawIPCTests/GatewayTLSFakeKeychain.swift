import Foundation
import Security
@testable import OpenClawKit

private final class MacGatewayTLSFakeKeychain: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: [String: Any]] = [:]

    var operations: GatewayTLSKeychainOperations {
        GatewayTLSKeychainOperations(
            copyMatching: { [self] query, result in self.copyMatching(query, result: result) },
            add: { [self] query in self.add(query) },
            update: { [self] query, updates in self.update(query, updates: updates) },
            delete: { [self] query in self.delete(query) })
    }

    private func copyMatching(
        _ query: CFDictionary,
        result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    {
        let query = query as NSDictionary as! [String: Any]
        guard let account = query[kSecAttrAccount as String] as? String else { return errSecParam }
        self.lock.lock()
        defer { self.lock.unlock() }
        guard let item = self.items[account] else { return errSecItemNotFound }
        if query[kSecReturnAttributes as String] as? Bool == true {
            result?.pointee = item as CFDictionary
        } else {
            guard let data = item[kSecValueData as String] as? Data else { return errSecDecode }
            result?.pointee = data as CFData
        }
        return errSecSuccess
    }

    private func add(_ query: CFDictionary) -> OSStatus {
        let query = query as NSDictionary as! [String: Any]
        guard let account = query[kSecAttrAccount as String] as? String else { return errSecParam }
        self.lock.lock()
        defer { self.lock.unlock() }
        guard self.items[account] == nil else { return errSecDuplicateItem }
        self.items[account] = query
        return errSecSuccess
    }

    private func update(_ query: CFDictionary, updates: CFDictionary) -> OSStatus {
        let query = query as NSDictionary as! [String: Any]
        let updates = updates as NSDictionary as! [String: Any]
        guard let account = query[kSecAttrAccount as String] as? String else { return errSecParam }
        self.lock.lock()
        defer { self.lock.unlock() }
        guard var item = self.items[account] else { return errSecItemNotFound }
        if let expected = query[kSecAttrGeneric as String] as? Data,
           item[kSecAttrGeneric as String] as? Data != expected
        {
            return errSecItemNotFound
        }
        item.merge(updates) { _, replacement in replacement }
        self.items[account] = item
        return errSecSuccess
    }

    private func delete(_ query: CFDictionary) -> OSStatus {
        let query = query as NSDictionary as! [String: Any]
        self.lock.lock()
        defer { self.lock.unlock() }
        guard let account = query[kSecAttrAccount as String] as? String else {
            self.items.removeAll()
            return errSecSuccess
        }
        self.items[account] = nil
        return errSecSuccess
    }
}

func withFakeGatewayTLSKeychain<T>(_ operation: () throws -> T) rethrows -> T {
    let keychain = MacGatewayTLSFakeKeychain()
    return try GatewayTLSStore.$keychainOperations.withValue(keychain.operations) {
        try operation()
    }
}

func withFakeGatewayTLSKeychain<T>(_ operation: () async throws -> T) async rethrows -> T {
    let keychain = MacGatewayTLSFakeKeychain()
    return try await GatewayTLSStore.$keychainOperations.withValue(keychain.operations) {
        try await operation()
    }
}
