import CryptoKit
import Foundation
import Security
import Testing
@testable import OpenClawKit

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
    // Both trust outcomes use explicit fixture anchors, without default roots or issuer downloads.
    let anchors = systemTrusted ? [certificate] : []
    try #require(SecTrustSetAnchorCertificates(trustValue, anchors as CFArray) == errSecSuccess)
    try #require(SecTrustSetAnchorCertificatesOnly(trustValue, true) == errSecSuccess)
    try #require(SecTrustSetNetworkFetchAllowed(trustValue, false) == errSecSuccess)
    return trustValue
}

@Suite(.gatewayTLSStoreIsolated)
struct GatewayTLSPinningTests {
    @Test(
        arguments: [true, false],
        ["https://other.example/", "http://gateway.example/", "https://gateway.example/login"])
    func `credential routes can refuse every transport redirect`(
        _ allowsRedirects: Bool,
        destination: String) async throws
    {
        let originalURL = try #require(URL(string: "https://gateway.example/artifact"))
        let targetURL = try #require(URL(string: destination))
        let policy = GatewayTLSPinningSession(
            params: .init(required: true, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
            allowsRedirects: allowsRedirects)
        let transport = URLSession(configuration: .ephemeral)
        let task = transport.dataTask(with: originalURL)
        defer {
            task.cancel()
            transport.invalidateAndCancel()
        }
        let response = try #require(HTTPURLResponse(
            url: originalURL, statusCode: 302, httpVersion: nil, headerFields: ["Location": destination]))
        var request = URLRequest(url: targetURL)
        request.setValue("synthetic-session", forHTTPHeaderField: "CF-Access-Token")
        let redirected = await withCheckedContinuation { continuation in
            policy.urlSession(
                transport,
                task: task,
                willPerformHTTPRedirection: response,
                newRequest: request,
                completionHandler: { continuation.resume(returning: $0) })
        }
        #expect(redirected?.url == (allowsRedirects ? targetURL : nil))
    }

    @Test func `keychain namespace configures once and fails closed after use`() {
        var state = GatewayTLSKeychainNamespaceState()
        let configuredWork = state.configure(suffix: ".profile.work")
        let reconfiguredWork = state.configure(suffix: ".profile.work")
        let configuredOther = state.configure(suffix: ".profile.other")
        let workService = state.service(base: "ai.openclaw.tls-pinning")
        let configuredWorkAfterUse = state.configure(suffix: ".profile.work")
        let configuredDefaultAfterUse = state.configure(suffix: "")
        #expect(configuredWork)
        #expect(reconfiguredWork)
        #expect(!configuredOther)
        #expect(workService == "ai.openclaw.tls-pinning.profile.work")
        #expect(configuredWorkAfterUse)
        #expect(!configuredDefaultAfterUse)

        var usedDefault = GatewayTLSKeychainNamespaceState()
        let defaultService = usedDefault.service(base: "ai.openclaw.tls-pinning")
        let configuredDefault = usedDefault.configure(suffix: "")
        let configuredProfileAfterDefaultUse = usedDefault.configure(suffix: ".profile.work")
        #expect(defaultService == "ai.openclaw.tls-pinning")
        #expect(configuredDefault)
        #expect(!configuredProfileAfterDefaultUse)
    }

    @Test func `first use pinning requires system trust`() {
        #expect(GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: true))
        #expect(!GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: false))
    }

    @Test func `TLS authority includes normalized host and effective port`() throws {
        let url = try #require(URL(string: "wss://Gateway.Example.com/path"))
        let route = try #require(GatewayTLSAuthority(url: url))
        let explicitPortURL = try #require(URL(string: "wss://gateway.example.com:8443/path"))
        let explicitPort = try #require(GatewayTLSAuthority(url: explicitPortURL))

        #expect(route.host == "gateway.example.com")
        #expect(route.port == 443)
        #expect(route.matches(host: "gateway.example.com", port: 0))
        #expect(route.matches(host: "gateway.example.com", port: 443))
        #expect(!route.matches(host: "redirect.example.com", port: 443))
        #expect(!route.matches(host: "gateway.example.com", port: 8443))
        #expect(!explicitPort.matches(host: "gateway.example.com", port: 0))
        #expect(explicitPort.matches(host: "gateway.example.com", port: 8443))
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

    @Test func `server trust evaluator rejects a different system-trusted certificate after pinning`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: true)
        let pinnedFingerprint = SHA256.hash(data: Data("previous certificate".utf8))
            .map { String(format: "%02x", $0) }.joined()
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: pinnedFingerprint,
            allowTOFU: false,
            storeKey: "profile:pinned")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .reject)
    }

    @Test func `server trust evaluator claims trusted first use`() throws {
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

    @Test func `server trust evaluator reuses persisted first use pin`() throws {
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
        let stableID = "test-pin-cas"
        GatewayTLSStore.saveFingerprint("old", stableID: stableID)

        #expect(!GatewayTLSStore.replaceFingerprint("wrong", ifCurrent: "missing", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `pin storage canonicalizes accepted fingerprint spelling`() {
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

    @Test func `canonical pin without comparison metadata is upgraded for replacement`() throws {
        let stableID = "测试-pin-canonical-migration"
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        try #require(GatewayTLSStoreFixture.current).seed(
            account: "fingerprint.v2.\(component)",
            data: Data("old".utf8))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `unreadable v2 pin blocks a new first use claim`() throws {
        let stableID = "test-pin-unreadable-v2"
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        try #require(GatewayTLSStoreFixture.current).seed(account: "fingerprint.v2.\(component)", data: Data([0xFF]))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == nil)
        #expect(GatewayTLSStore.claimFirstUseFingerprint("new", stableID: stableID) == nil)
    }

    @Test func `legacy raw pin is migrated before conditional replacement`() throws {
        let stableID = "test-pin-legacy-migration"
        try #require(GatewayTLSStoreFixture.current).seed(account: stableID, data: Data("old".utf8))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
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

    @Test func `clear all fingerprints removes every canonical pin without live storage`() {
        GatewayTLSStore.saveFingerprint("11", stableID: "gateway-1")
        GatewayTLSStore.saveFingerprint("22", stableID: "gateway-2")

        #expect(GatewayTLSStore.clearAllFingerprints())
        #expect(GatewayTLSStore.loadFingerprint(stableID: "gateway-1") == nil)
        #expect(GatewayTLSStore.loadFingerprint(stableID: "gateway-2") == nil)
    }
}
