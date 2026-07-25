import Foundation
import Security
import Testing
@testable import OpenClawKit

private final class GatewayTLSFakeKeychain: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: [String: Any]] = [:]

    var operations: GatewayTLSKeychainOperations {
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
            kSecAttrService as String: "ai.openclaw.tls-pinning",
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
        ]
        self.lock.unlock()
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

struct GatewayTLSPinningTests {
    private func withFakeKeychain<T>(_ operation: (GatewayTLSFakeKeychain) throws -> T) rethrows -> T {
        let keychain = GatewayTLSFakeKeychain()
        return try GatewayTLSStore.$keychainOperations.withValue(keychain.operations) {
            try operation(keychain)
        }
    }

    private func withFakeKeychain<T>(
        _ operation: (GatewayTLSFakeKeychain) async throws -> T) async rethrows -> T
    {
        let keychain = GatewayTLSFakeKeychain()
        return try await GatewayTLSStore.$keychainOperations.withValue(keychain.operations) {
            try await operation(keychain)
        }
    }

    @Test func `first use pinning requires system trust`() {
        #expect(GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: true))
        #expect(!GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: false))
    }

    @Test func `TLS authority includes normalized host and effective port`() throws {
        let url = try #require(URL(string: "wss://Gateway.Example.com/path"))
        let route = try #require(GatewayTLSAuthority(url: url))

        #expect(route == GatewayTLSAuthority(host: "gateway.example.com", port: 443))
        #expect(route != GatewayTLSAuthority(host: "redirect.example.com", port: 443))
        #expect(route != GatewayTLSAuthority(host: "gateway.example.com", port: 8443))
    }

    @Test func `matching explicit pin overrides system trust`() {
        let decision = GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: "expected",
            allowTOFU: false,
            required: true,
            systemTrustOk: false)

        #expect(decision == .accept(
            fingerprint: "expected",
            enforcePin: true,
            saveFirstUse: false))
    }

    @Test func `explicit pin mismatch and unavailable certificate fail closed`() {
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: "different",
            allowTOFU: false,
            required: true,
            systemTrustOk: true) == .reject(.pinMismatch))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: nil,
            allowTOFU: false,
            required: true,
            systemTrustOk: true) == .reject(.certificateUnavailable))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: nil,
            allowTOFU: true,
            required: true,
            systemTrustOk: true) == .reject(.certificateUnavailable))
    }

    @Test func `trusted first use is saved and enforced`() {
        let decision = GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: "observed",
            allowTOFU: true,
            required: true,
            systemTrustOk: true)

        #expect(decision == .accept(
            fingerprint: "observed",
            enforcePin: true,
            saveFirstUse: true))
    }

    @Test func `concurrent first use sessions share one durable fingerprint`() async {
        await self.withFakeKeychain { _ in
            let stableID = "test-first-use-claim"
            let results = await withTaskGroup(of: String?.self, returning: [String?].self) { group in
                for fingerprint in ["first", "second"] {
                    group.addTask {
                        GatewayTLSStore.claimFirstUseFingerprint(fingerprint, stableID: stableID)
                    }
                }
                var results: [String?] = []
                for await result in group {
                    results.append(result)
                }
                return results
            }
            let claimed = results.compactMap(\.self)

            #expect(claimed.count == 2)
            #expect(Set(claimed).count == 1)
            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == claimed.first)
        }
    }

    @Test func `first use claim fails closed without a storage owner`() {
        #expect(GatewayTLSStore.claimFirstUseFingerprint("observed", stableID: "") == nil)
    }

    @Test func `losing first use session adopts the shared winner`() {
        var state = GatewayTLSPinningState(expectedFingerprint: nil)

        state.enforceFingerprint("winner")

        #expect(state.enforcedFingerprint == "winner")
        #expect(state.acceptedFingerprint == nil)
    }

    @Test func `pin replacement compares the stored value atomically`() {
        self.withFakeKeychain { _ in
            let stableID = "test-pin-cas"
            GatewayTLSStore.saveFingerprint("old", stableID: stableID)

            #expect(!GatewayTLSStore.replaceFingerprint("wrong", ifCurrent: "missing", stableID: stableID))
            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
            #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
        }
    }

    @Test func `pin storage canonicalizes accepted fingerprint spelling`() {
        self.withFakeKeychain { _ in
            let stableID = "test-pin-canonical-spelling"
            let uppercase = String(repeating: "AB", count: 32)
            let lowercase = uppercase.lowercased()

            GatewayTLSStore.saveFingerprint("SHA256: \(uppercase)", stableID: stableID)

            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == lowercase)
            #expect(GatewayTLSStore.replaceFingerprint(
                String(repeating: "c", count: 64),
                ifCurrent: uppercase,
                stableID: stableID))
        }
    }

    @Test func `canonical pin without comparison metadata is upgraded for replacement`() {
        self.withFakeKeychain { keychain in
            let stableID = "测试-pin-canonical-migration"
            let component = Data(stableID.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            keychain.seed(account: "fingerprint.v2.\(component)", data: Data("old".utf8))

            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
            #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
        }
    }

    @Test func `unreadable v2 pin blocks a new first use claim`() {
        self.withFakeKeychain { keychain in
            let stableID = "test-pin-unreadable-v2"
            let component = Data(stableID.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            keychain.seed(account: "fingerprint.v2.\(component)", data: Data([0xFF]))

            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == nil)
            #expect(GatewayTLSStore.claimFirstUseFingerprint("new", stableID: stableID) == nil)
        }
    }

    @Test func `legacy raw pin is migrated before conditional replacement`() {
        self.withFakeKeychain { keychain in
            let stableID = "test-pin-legacy-migration"
            keychain.seed(account: stableID, data: Data("old".utf8))

            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
            #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
        }
    }

    @Test func `first use fingerprint remains enforced for reconnects`() {
        var state = GatewayTLSPinningState(expectedFingerprint: nil)

        state.recordAcceptance("first", enforcePin: true)

        #expect(state.acceptedFingerprint == "first")
        #expect(state.enforcedFingerprint == "first")
    }

    @Test func `untrusted first use is rejected`() {
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: "observed",
            allowTOFU: true,
            required: true,
            systemTrustOk: false) == .reject(.untrustedCertificate))
    }
}
