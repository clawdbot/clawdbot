import Foundation
import Security
import Testing
@testable import OpenClawKit

private actor GatewayTLSStoreFixtureLock {
    static let shared = GatewayTLSStoreFixtureLock()
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func withLock(_ operation: @Sendable () async throws -> Void) async rethrows {
        if self.locked {
            await withCheckedContinuation { self.waiters.append($0) }
        } else {
            self.locked = true
        }
        defer {
            if self.waiters.isEmpty {
                self.locked = false
            } else {
                self.waiters.removeFirst().resume()
            }
        }
        try await operation()
    }
}

final class GatewayTLSStoreFixture: @unchecked Sendable {
    @TaskLocal static var current: GatewayTLSStoreFixture?

    private let lock = NSLock()
    private var items: [String: [String: Any]] = [:]

    static func withStorage(_ operation: @Sendable () async throws -> Void) async throws {
        // Claims are process-global, so teardown must finish before another fixture starts.
        try await GatewayTLSStoreFixtureLock.shared.withLock {
            // The real profile boundary disables legacy UserDefaults reads and removal too.
            // Never restore the default namespace or proceed after an earlier live store access.
            try #require(GatewayTLSStore.configureKeychainServiceSuffix(".tests"))
            let fixture = GatewayTLSStoreFixture()
            try await Self.$current.withValue(fixture) {
                try await GatewayTLSStore.$keychainOperations.withValue(fixture.operations) {
                    defer { #expect(GatewayTLSStore.clearAllFingerprints()) }
                    try await operation()
                }
            }
        }
    }

    private var operations: GatewayTLSKeychainOperations {
        GatewayTLSKeychainOperations(
            copyMatching: { [self] query, result in self.copyMatching(query, result: result) },
            add: { [self] query in self.add(query) },
            update: { [self] query, updates in self.update(query, updates: updates) },
            delete: { [self] query in self.delete(query) })
    }

    func seed(account: String, data: Data) {
        self.lock.lock()
        self.items[account] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: GatewayTLSStore.resolvedKeychainService(suffix: ".tests"),
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
        ]
        self.lock.unlock()
    }

    private func copyMatching(
        _ query: CFDictionary,
        result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    {
        guard let query = query as NSDictionary as? [String: Any],
              let account = query[kSecAttrAccount as String] as? String
        else { return errSecParam }
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
        guard let query = query as NSDictionary as? [String: Any],
              let account = query[kSecAttrAccount as String] as? String
        else { return errSecParam }
        self.lock.lock()
        defer { self.lock.unlock() }
        guard self.items[account] == nil else { return errSecDuplicateItem }
        self.items[account] = query
        return errSecSuccess
    }

    private func update(_ query: CFDictionary, updates: CFDictionary) -> OSStatus {
        guard let query = query as NSDictionary as? [String: Any],
              let updates = updates as NSDictionary as? [String: Any],
              let account = query[kSecAttrAccount as String] as? String
        else { return errSecParam }
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
        guard let query = query as NSDictionary as? [String: Any] else { return errSecParam }
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

struct GatewayTLSStoreIsolationTrait: TestTrait, SuiteTrait, TestScoping {
    var isRecursive: Bool {
        true
    }

    func scopeProvider(for test: Test, testCase: Test.Case?) -> Self? {
        testCase == nil ? nil : self
    }

    func provideScope(
        for test: Test,
        testCase: Test.Case?,
        performing function: @Sendable () async throws -> Void) async throws
    {
        try await GatewayTLSStoreFixture.withStorage(function)
    }
}

extension Trait where Self == GatewayTLSStoreIsolationTrait {
    static var gatewayTLSStoreIsolated: Self {
        Self()
    }
}
