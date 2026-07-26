import CryptoKit
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

private let gatewayTLSTestCertificateDER =
    Data(
        base64Encoded: "MIIDMTCCAhmgAwIBAgIUY2qs5gTY9AYGcm5Ba8TG3ooCnyowDQYJKoZIhvcNAQELBQAwGjEYMBYGA1UEAwwPZ2F0ZXdheS5leGFtcGxlMB4XDTI2MDcyNTIxNDkxM1oXDTM2MDcyMjIxNDkxM1owGjEYMBYGA1UEAwwPZ2F0ZXdheS5leGFtcGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtT4Nw7/K1v8hp5+rrtbfhgB3pnLGnjCi53n95Yisv1WH4osvd5oxjoS3OocLzdX5L8Czz66Caq3zX+Bd6FTtWiaAPek7Gc5hJ6lDf+UR2TBhJGgLcIZbrJz2GQGItqJl0XlkShqnhhAXw/8wScG0QdEeEq3OGm2z2IQYagtbYWB2ugb65GuTxjgIHryDISrY1pKAw3UhwhsftqpUQ5e+gVj1qTMUkj8o6+qEBqzKRWAah1mBbjBuv1/dn6dLXSJDM/XFxqQGOStpywQGHIi0EPZBNiPAE2QL9gRQg4YtgbX2gFcIdrrGUVmbDMEY+FVC4q6zsRyVmnxndDlTx791UwIDAQABo28wbTAdBgNVHQ4EFgQUjd+huKP5/FHbm0h2Tgmnjb8c2dowHwYDVR0jBBgwFoAUjd+huKP5/FHbm0h2Tgmnjb8c2dowDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgg9nYXRld2F5LmV4YW1wbGUwDQYJKoZIhvcNAQELBQADggEBAASZeHqh26eec0U30QJmI2I8+60HAGDd1Cd9XpA/13eFXqCGfev8Rk1gfZ+m0NvBDlBlary4jKGYnVA4QNzP23jL4mBEEAqlmO0QMFg4ucKiKtOLmzdnk2utCY7oMw3/Nt1tD0+qBhayL+d2e5t33fYUwEm5s832xONGJUkpJ1MIldXqMovKomlMUgzSNnkGiTv8yY/J1b2W2/LWjL/ZDLd7E/pyLwvfKY5QXlfEKFp2K+brfkkk1tFLRPir6VNm9wXz3HTZTnj2CAHchitY87MXgDVliYpsQD4AIiycrsHOcRkBF/CBX9XH1LL3iolkk8WaLHeDk2jd6+vd3FRrlsU=")!

private func gatewayTLSTestTrust(systemTrusted: Bool) throws -> SecTrust {
    let certificate = try #require(SecCertificateCreateWithData(nil, gatewayTLSTestCertificateDER as CFData))
    let policy = systemTrusted
        ? SecPolicyCreateBasicX509()
        : SecPolicyCreateSSL(true, "gateway.example" as CFString)
    var trust: SecTrust?
    try #require(SecTrustCreateWithCertificates(certificate, policy, &trust) == errSecSuccess)
    let trustValue = try #require(trust)
    if systemTrusted {
        try #require(SecTrustSetAnchorCertificates(trustValue, [certificate] as CFArray) == errSecSuccess)
        try #require(SecTrustSetAnchorCertificatesOnly(trustValue, true) == errSecSuccess)
    }
    return trustValue
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

    @Test func `server trust evaluator accepts matching pin and rejects mismatch`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: false)
        let fingerprint = SHA256.hash(data: gatewayTLSTestCertificateDER)
            .map { String(format: "%02x", $0) }.joined()
        let matching = GatewayTLSParams(
            required: true,
            expectedFingerprint: fingerprint,
            allowTOFU: false,
            storeKey: "profile:matching")
        let mismatch = GatewayTLSParams(
            required: true,
            expectedFingerprint: String(repeating: "0", count: 64),
            allowTOFU: false,
            storeKey: "profile:mismatch")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: matching) == .accept)
        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: mismatch) == .reject)
    }

    @Test func `server trust evaluator claims trusted first use`() throws {
        try self.withFakeKeychain { _ in
            let trust = try gatewayTLSTestTrust(systemTrusted: true)
            let fingerprint = SHA256.hash(data: gatewayTLSTestCertificateDER)
                .map { String(format: "%02x", $0) }.joined()
            let params = GatewayTLSParams(
                required: true,
                expectedFingerprint: nil,
                allowTOFU: true,
                storeKey: "profile:first-use")

            #expect(GatewayTLSServerTrust.evaluate(
                trust: trust,
                host: "gateway.example",
                port: 443,
                params: params) == .accept)
            #expect(GatewayTLSStore.loadFingerprint(stableID: "profile:first-use") == fingerprint)
        }
    }

    @Test func `server trust evaluator reuses persisted first use pin`() throws {
        try self.withFakeKeychain { _ in
            let trust = try gatewayTLSTestTrust(systemTrusted: false)
            let fingerprint = SHA256.hash(data: gatewayTLSTestCertificateDER)
                .map { String(format: "%02x", $0) }.joined()
            let storeKey = "profile:reconnect"
            let params = GatewayTLSParams(
                required: true,
                expectedFingerprint: nil,
                allowTOFU: true,
                storeKey: storeKey)
            let claimed = GatewayTLSStore.claimFirstUseFingerprint(fingerprint, stableID: storeKey)
            #expect(claimed == fingerprint)

            #expect(GatewayTLSServerTrust.evaluate(
                trust: trust,
                host: "gateway.example",
                port: 443,
                params: params) == .accept)
        }
    }

    @Test func `server trust evaluator rejects required untrusted first use`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: false)
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: nil,
            allowTOFU: true,
            storeKey: "profile:untrusted")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .reject)
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
