import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

@MainActor
struct IOSDeviceSettingsBridgeTests {
    @Test func `retained documents reject coalesced authority changes and accept fresh requests`() throws {
        let original = try Self.controlUIConfig()
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        model.activeGatewayConnectConfig = original
        model.setOperatorConnected(true)
        defer { model.setOperatorConnected(false) }

        var document = IOSDeviceSettingsDocument()
        document.commitNavigation()
        let beforeReconnect = document.requestIdentity(authorityGeneration: model.operatorAuthorityGeneration)
        #expect(document.accepts(beforeReconnect, authorityGeneration: model.operatorAuthorityGeneration))

        model.setOperatorConnected(false)
        model.setOperatorConnected(true)
        #expect(model.isOperatorGatewayConnected)
        #expect(document.isAvailable)
        #expect(!document.accepts(beforeReconnect, authorityGeneration: model.operatorAuthorityGeneration))
        document.invalidateRequests()
        let afterReconnect = document.requestIdentity(authorityGeneration: model.operatorAuthorityGeneration)
        #expect(document.accepts(afterReconnect, authorityGeneration: model.operatorAuthorityGeneration))

        var registration = original.nodeOptions
        registration.caps = ["camera"]
        registration.permissions = ["camera": true]
        model.activeGatewayConnectConfig = try Self.controlUIConfig(options: registration)
        #expect(document.accepts(afterReconnect, authorityGeneration: model.operatorAuthorityGeneration))

        model.activeGatewayConnectConfig = try Self.controlUIConfig(token: "replacement-token")
        model.activeGatewayConnectConfig = original
        #expect(!document.accepts(afterReconnect, authorityGeneration: model.operatorAuthorityGeneration))
        document.invalidateRequests()
        let afterCredentialChange = document.requestIdentity(authorityGeneration: model.operatorAuthorityGeneration)
        #expect(document.accepts(afterCredentialChange, authorityGeneration: model.operatorAuthorityGeneration))

        document.startNavigation()
        model.setOperatorConnected(false)
        model.setOperatorConnected(true)
        document.invalidateRequests()
        let provisional = document.requestIdentity(authorityGeneration: model.operatorAuthorityGeneration)
        #expect(!document.accepts(provisional, authorityGeneration: model.operatorAuthorityGeneration))
        document.failProvisionalNavigation()
        let retained = document.requestIdentity(authorityGeneration: model.operatorAuthorityGeneration)
        #expect(document.accepts(retained, authorityGeneration: model.operatorAuthorityGeneration))
    }

    @Test func `node registration changes preserve control UI authority and browser identity`() throws {
        let original = try Self.controlUIConfig()
        var registration = original.nodeOptions
        registration.role = "node"
        registration.scopes = ["node.changed"]
        registration.scopesAreExplicit = true
        registration.caps = ["camera", "location"]
        registration.commands = ["camera.snap", "location.get"]
        registration.permissions = ["camera": true, "location": true]
        registration.clientMode = "background"
        registration.clientDisplayName = "Renamed device"
        registration.pathEnv = "/synthetic/bin"
        let refreshed = try Self.controlUIConfig(bootstrapToken: "new-bootstrap-token", options: registration)

        #expect(!original.hasSameConnectionInputs(as: refreshed))
        #expect(original.hasSameControlUIInputs(as: refreshed))
        #expect(
            AuthenticatedControlUI.webContentIdentity(config: original, storedOperatorToken: "paired-token") ==
                AuthenticatedControlUI.webContentIdentity(config: refreshed, storedOperatorToken: "paired-token"))
    }

    @Test func `changed control UI authentication rejects ownership and recreates the browser`() throws {
        let original = try Self.controlUIConfig()
        var replacements = try [
            Self.controlUIConfig(url: "wss://replacement.example/openclaw"),
            Self.controlUIConfig(stableID: "gateway-e\u{301}"),
            Self.controlUIConfig(tls: nil),
            Self.controlUIConfig(tls: GatewayTLSParams(
                required: false, expectedFingerprint: "pin-a", allowTOFU: false, storeKey: "gateway")),
            Self.controlUIConfig(tls: GatewayTLSParams(
                required: true, expectedFingerprint: "pin-b", allowTOFU: false, storeKey: "gateway")),
            Self.controlUIConfig(tls: GatewayTLSParams(
                required: true, expectedFingerprint: "pin-a", allowTOFU: true, storeKey: "gateway")),
            Self.controlUIConfig(tls: GatewayTLSParams(
                required: true, expectedFingerprint: "pin-a", allowTOFU: false, storeKey: "replacement")),
            Self.controlUIConfig(token: "replacement-shared-token"),
            Self.controlUIConfig(password: "replacement-password"),
        ]
        let changeOptions: [(inout GatewayConnectOptions) -> Void] = [
            { $0.clientId = "replacement-client" },
            { $0.includeDeviceIdentity = false },
            { $0.allowStoredDeviceAuth = false },
            { $0.deviceIdentityProfile = .node },
            { $0.deviceAuthGatewayID = "replacement-auth-owner" },
        ]
        for change in changeOptions {
            var options = original.nodeOptions
            change(&options)
            try replacements.append(Self.controlUIConfig(options: options))
        }

        for replacement in replacements {
            #expect(!original.hasSameControlUIInputs(as: replacement))
            #expect(
                AuthenticatedControlUI.webContentIdentity(config: original, storedOperatorToken: "paired-token") !=
                    AuthenticatedControlUI.webContentIdentity(
                        config: replacement, storedOperatorToken: "paired-token"))
        }
    }

    @Test func `explicit device auth owner matches the same effective gateway`() throws {
        let original = try Self.controlUIConfig()
        var options = original.nodeOptions
        options.deviceAuthGatewayID = original.effectiveStableID
        let explicit = try Self.controlUIConfig(options: options)

        #expect(original.hasSameControlUIInputs(as: explicit))
        #expect(
            AuthenticatedControlUI.webContentIdentity(config: original, storedOperatorToken: nil) ==
                AuthenticatedControlUI.webContentIdentity(config: explicit, storedOperatorToken: nil))
    }

    private static func controlUIConfig(
        url: String = "wss://gateway.example/openclaw",
        stableID: String = "gateway-\u{e9}",
        tls: GatewayTLSParams? = GatewayTLSParams(
            required: true, expectedFingerprint: "pin-a", allowTOFU: false, storeKey: "gateway"),
        token: String? = "shared-token",
        bootstrapToken: String? = nil,
        password: String? = nil,
        options: GatewayConnectOptions? = nil) throws -> GatewayConnectConfig
    {
        try GatewayConnectConfig(
            url: #require(URL(string: url)),
            stableID: stableID,
            tls: tls,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            nodeOptions: options ?? GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: "Synthetic device"))
    }

    @Test func `device settings trust requires the hosting main frame and gateway authority`() throws {
        let gateway = try #require(URL(string: "https://gateway.example:8443/openclaw/"))
        let settings = try #require(URL(string: "https://gateway.example:8443/openclaw/settings/device"))
        func trusted(_ source: URL?, mainFrame: Bool = true, hostingView: Bool = true) -> Bool {
            IOSDeviceSettingsBridge.isTrustedSource(
                source, webViewURL: settings, gatewayURL: gateway,
                isMainFrame: mainFrame, isHostingWebView: hostingView)
        }
        #expect(trusted(settings))
        #expect(!trusted(settings, mainFrame: false))
        #expect(!trusted(settings, hostingView: false))
        #expect(!trusted(nil))
        for value in [
            "https://other.example:8443/openclaw/settings",
            "http://gateway.example:8443/openclaw/settings",
            "https://gateway.example/openclaw/settings",
            "https://gateway.example:8443/openclaw-other/settings",
            "https://gateway.example:8443/openclaw%2Fsettings",
            "about:blank",
        ] {
            #expect(!trusted(URL(string: value)))
        }
        #expect(!IOSDeviceSettingsBridge.isTrustedSource(
            settings, webViewURL: URL(string: "https://other.example/"), gatewayURL: gateway,
            isMainFrame: true, isHostingWebView: true))
    }

    @Test func `failed provisional navigation restores only the retained document with fresh authority`() {
        var document = IOSDeviceSettingsDocument()
        document.startNavigation()
        document.failProvisionalNavigation()
        #expect(!document.isAvailable)

        document.commitNavigation()
        let original = document.id
        #expect(document.isAvailable)
        document.startNavigation()
        let provisional = document.id
        #expect(!document.isAvailable)
        #expect(provisional != original)

        document.failProvisionalNavigation()
        #expect(document.isAvailable)
        #expect(document.id != original)
        #expect(document.id != provisional)

        document.startNavigation()
        document.retire()
        document.failProvisionalNavigation()
        #expect(!document.isAvailable)
    }

    @Test func `embed script is opt in and seeds the platform idiom at document start`() throws {
        let url = try #require(URL(string: "https://gateway.example/settings"))
        let plain = AuthenticatedControlUIWebViewCoordinator(url: url, tls: nil)
        let plainController = WKUserContentController()
        plain.installUserScripts(in: plainController)
        #expect(plainController.userScripts.isEmpty)
        let embedded = AuthenticatedControlUIWebViewCoordinator(url: url, tls: nil, usesNativeEmbed: true)
        let controller = WKUserContentController()
        embedded.installUserScripts(in: controller)
        let script = try #require(controller.userScripts.first)
        #expect(script.injectionTime == .atDocumentStart)
        #expect(script.isForMainFrameOnly)
        #expect(script.source.contains("__OPENCLAW_NATIVE_EMBED__"))
        #expect(script.source.contains("location.origin"))
        #expect(AuthenticatedControlUIWebViewCoordinator.embedScript(url: url, isPad: false)?
            .contains("'phone'") == true)
        #expect(AuthenticatedControlUIWebViewCoordinator.embedScript(url: url, isPad: true)?.contains("'pad'") == true)
    }

    @Test func `native consent covers capability enables and only always location escalation`() {
        for key in [DeviceSettingKey.wakeEnabled, .cameraEnabled, .healthSummaryEnabled] {
            #expect(IOSDeviceSettingsConsent.required(for: key, value: .boolean(true), locationMode: .off) != nil)
            #expect(IOSDeviceSettingsConsent.required(for: key, value: .boolean(false), locationMode: .off) == nil)
        }
        #expect(IOSDeviceSettingsConsent.required(
            for: .locationMode, value: .string("always"), locationMode: .whileUsing) == .locationAlways)
        #expect(IOSDeviceSettingsConsent.required(
            for: .locationMode, value: .string("always"), locationMode: .always) == nil)
        #expect(IOSDeviceSettingsConsent.required(
            for: .locationMode, value: .string("whileUsing"), locationMode: .off) == nil)
        #expect(IOSDeviceSettingsConsent.required(
            for: .locationPrecise, value: .boolean(true), locationMode: .always) == nil)
    }

    @Test func `request retirement rejects active and queued replies once and allows a replacement document`() async {
        let queue = IOSDeviceSettingsRequestQueue()
        var completed: [String] = []
        var errors: [String] = []
        var releaseRetiredOperation: CheckedContinuation<Void, Never>?
        let activeReply = IOSDeviceSettingsReply { _, error in
            if let error { errors.append(error) }
            completed.append("active")
        }
        let pendingReply = IOSDeviceSettingsReply { _, error in
            if let error { errors.append(error) }
            completed.append("pending")
        }
        await withCheckedContinuation { started in
            queue.enqueue(operation: {
                await withCheckedContinuation { release in
                    releaseRetiredOperation = release
                    started.resume()
                }
                activeReply.finish(NSNull())
            }, onCancel: { activeReply.retire() })
        }
        queue.enqueue(operation: {
            completed.append("stale write")
            pendingReply.finish(NSNull())
        }, onCancel: { pendingReply.retire() })
        queue.cancel()
        #expect(completed == ["active", "pending"])
        #expect(errors.count == 2)
        await withCheckedContinuation { replacementFinished in
            queue.enqueue(operation: {
                completed.append("replacement")
                replacementFinished.resume()
            }, onCancel: { Issue.record("Replacement document was unexpectedly retired") })
        }
        releaseRetiredOperation?.resume()
        await Task.yield()
        #expect(completed == ["active", "pending", "replacement"])
        #expect(errors.count == 2)
    }

    @Test func `queued writes settle in submission order`() async {
        let queue = IOSDeviceSettingsRequestQueue()
        var values: [Int] = []
        await withCheckedContinuation { finished in
            for value in 1...3 {
                queue.enqueue(operation: {
                    await Task.yield()
                    values.append(value)
                    if value == 3 { finished.resume() }
                }, onCancel: { Issue.record("Current document unexpectedly retired") })
            }
        }
        #expect(values == [1, 2, 3])
    }
}
