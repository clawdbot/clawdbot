import Foundation
import Network
import OpenClawChatUI
import os
import Testing
import UIKit
@testable import OpenClaw
@testable import OpenClawKit

@discardableResult
private func saveActiveManualGateway(
    host: String,
    port: Int,
    useTLS: Bool,
    stableID: String) -> Bool
{
    let entry = GatewaySettingsStore.GatewayRegistryEntry(
        stableID: stableID,
        kind: .manual,
        name: "\(host):\(port)",
        host: host,
        port: port,
        useTLS: useTLS,
        lastConnectedAtMs: nil)
    return GatewaySettingsStore.upsertGatewayRegistryEntry(entry, activate: true)
}

private struct GatewayRegistryTestIsolation {
    private static let service = GatewaySettingsStore._testGatewayService
    private static let registryAccount = "gateway-registry"
    private static let legacyAccount = "lastConnection"
    private static let legacyDefaultsKeys = [
        "gateway.last.kind",
        "gateway.last.host",
        "gateway.last.port",
        "gateway.last.tls",
        "gateway.last.stableID",
    ]

    private let previousRegistry: String?
    private let previousLegacyConnection: String?
    private let previousDefaults: [String: Any?]

    init() {
        gatewayPersistenceTestSemaphore.wait()
        self.previousRegistry = KeychainStore.loadString(
            service: Self.service,
            account: Self.registryAccount)
        self.previousLegacyConnection = KeychainStore.loadString(
            service: Self.service,
            account: Self.legacyAccount)
        self.previousDefaults = Dictionary(uniqueKeysWithValues: Self.legacyDefaultsKeys.map { key in
            (key, UserDefaults.standard.object(forKey: key))
        })
        _ = KeychainStore.delete(service: Self.service, account: Self.registryAccount)
        _ = KeychainStore.delete(service: Self.service, account: Self.legacyAccount)
        for key in Self.legacyDefaultsKeys {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    func restore() {
        if let previousRegistry {
            _ = KeychainStore.saveString(
                previousRegistry,
                service: Self.service,
                account: Self.registryAccount)
        } else {
            _ = KeychainStore.delete(service: Self.service, account: Self.registryAccount)
        }
        if let previousLegacyConnection {
            _ = KeychainStore.saveString(
                previousLegacyConnection,
                service: Self.service,
                account: Self.legacyAccount)
        } else {
            _ = KeychainStore.delete(service: Self.service, account: Self.legacyAccount)
        }
        for (key, value) in self.previousDefaults {
            if let value {
                UserDefaults.standard.set(value, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
        gatewayPersistenceTestSemaphore.signal()
    }
}

@MainActor
private func waitForActiveGateway(stableID: String, appModel: NodeAppModel) async {
    let deadline = ContinuousClock().now.advanced(by: .seconds(3))
    while appModel.activeGatewayConnectConfig?.effectiveStableID != stableID,
          ContinuousClock().now < deadline
    {
        await Task.yield()
    }
}

@Suite(.serialized) struct GatewayReconnectErrorRetentionTests {
    @Test @MainActor func `retained display problem does not control next retry`() {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let problem = GatewayConnectionProblem(
            kind: .pairingScopeUpgradeRequired,
            owner: .gateway,
            title: "Additional permissions required",
            message: "Approve the requested permissions on the gateway.",
            requestId: "req-admin",
            retryable: false,
            pauseReconnect: true)
        appModel._test_applyOperatorGatewayConnectionProblem(problem)

        appModel._test_prepareForGatewayConnect(
            stableID: "manual|gateway.example.com|443",
            preservingGatewayProblem: true)

        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.gatewayDisplayStatusText == problem.localizedStatusText)
        #expect(!appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == nil)

        let cancelled = NSError(
            domain: URLError.errorDomain,
            code: URLError.cancelled.rawValue,
            userInfo: [NSLocalizedDescriptionKey: "gateway receive: cancelled"])
        let mapped = appModel._test_mapNodeGatewayConnectionError(cancelled)
        #expect(mapped?.kind == .websocketCancelled)
        #expect(mapped?.requestId == nil)
        #expect(mapped?.pauseReconnect == false)
    }

    @Test @MainActor func `active operator problem survives node cancellation`() {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let problem = GatewayConnectionProblem(
            kind: .pairingScopeUpgradeRequired,
            owner: .gateway,
            title: "Additional permissions required",
            message: "Approve the requested permissions on the gateway.",
            requestId: "req-admin",
            retryable: false,
            pauseReconnect: true)
        appModel._test_applyOperatorGatewayConnectionProblem(problem)

        let cancelled = NSError(
            domain: URLError.errorDomain,
            code: URLError.cancelled.rawValue,
            userInfo: [NSLocalizedDescriptionKey: "gateway receive: cancelled"])
        let applied = appModel._test_applyNodeGatewayConnectionError(cancelled)

        #expect(applied == problem)
        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == "req-admin")

        appModel._test_clearOperatorGatewayConnectionProblemIfCurrent()
        #expect(appModel.lastGatewayProblem == nil)
        #expect(!appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == nil)
    }
}

@Suite(.serialized) struct GatewayConnectionControllerTests {
    @Test @MainActor func `chat owner survives reconnect while session refresh identity changes`() {
        let appModel = NodeAppModel()
        let disconnectedOwner = appModel.chatViewModelOwnerID
        let disconnectedRefreshIdentity = appModel.chatViewModelIdentityID

        appModel._test_setOperatorConnected(true)
        #expect(appModel.chatViewModelOwnerID == disconnectedOwner)
        #expect(appModel.chatViewModelIdentityID != disconnectedRefreshIdentity)

        appModel._test_setOperatorConnected(false)
        #expect(appModel.chatViewModelOwnerID == disconnectedOwner)
        #expect(appModel.chatViewModelIdentityID == disconnectedRefreshIdentity)
    }

    @Test func `direct push registration dedupe includes gateway identity`() {
        #expect(!NodeAppModel.shouldPublishDirectAPNsRegistration(
            token: "device-token",
            gatewayStableID: "gateway-a",
            lastToken: "device-token",
            lastGatewayStableID: "gateway-a"))
        #expect(NodeAppModel.shouldPublishDirectAPNsRegistration(
            token: "device-token",
            gatewayStableID: "gateway-b",
            lastToken: "device-token",
            lastGatewayStableID: "gateway-a"))
        #expect(NodeAppModel.shouldPublishDirectAPNsRegistration(
            token: "device-token",
            gatewayStableID: "gateway-\u{00E9}",
            lastToken: "device-token",
            lastGatewayStableID: "gateway-e\u{0301}"))
    }

    @Test func `push relay identity preserves exact opaque gateway bytes`() throws {
        for deviceID in ["\u{0085}gateway-\u{00E9}", " gateway", "gateway\u{FEFF}"] {
            let identity = try NodeAppModel._test_decodePushRelayGatewayIdentity(
                #"{"deviceId":"\#(deviceID)","publicKey":"public-key"}"#)

            #expect(Array(identity.deviceId.utf8) == Array(deviceID.utf8))
        }
    }

    @Test @MainActor func `resolved display name sets default when missing`() {
        let defaults = UserDefaults.standard
        let displayKey = "node.displayName"

        withUserDefaults([displayKey: nil, "node.instanceId": "ios-test"]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let resolved = controller._test_resolvedDisplayName(defaults: defaults)
            #expect(!resolved.isEmpty)
            #expect(defaults.string(forKey: displayKey) == resolved)
        }
    }

    @Test @MainActor func `current caps reflect toggles`() {
        withUserDefaults([
            "node.instanceId": "ios-test",
            "node.displayName": "Test Node",
            "camera.enabled": true,
            "location.enabledMode": OpenClawLocationMode.always.rawValue,
            VoiceWakePreferences.enabledKey: true,
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let caps = Set(controller._test_currentCaps())

            #expect(caps.contains(OpenClawCapability.canvas.rawValue))
            #expect(caps.contains(OpenClawCapability.screen.rawValue))
            #expect(!caps.contains(OpenClawGatewayClientCapability.inlineWidgets))
            #expect(caps.contains(OpenClawCapability.camera.rawValue))
            #expect(caps.contains(OpenClawCapability.location.rawValue))
            #expect(caps.contains(OpenClawCapability.voiceWake.rawValue))
            #expect(caps.contains(OpenClawCapability.talk.rawValue))
        }
    }

    @Test @MainActor func `current commands include location when enabled`() {
        withUserDefaults([
            "node.instanceId": "ios-test",
            "location.enabledMode": OpenClawLocationMode.whileUsing.rawValue,
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let commands = Set(controller._test_currentCommands())

            #expect(commands.contains(OpenClawLocationCommand.get.rawValue))
        }
    }

    @Test @MainActor func `location permission requires global services and app authorization`() {
        #expect(GatewayConnectionController._test_isLocationAvailable(
            servicesEnabled: true,
            status: .authorizedWhenInUse))
        #expect(GatewayConnectionController._test_isLocationAvailable(
            servicesEnabled: true,
            status: .authorizedAlways))
        #expect(!GatewayConnectionController._test_isLocationAvailable(
            servicesEnabled: false,
            status: .authorizedAlways))
        #expect(!GatewayConnectionController._test_isLocationAvailable(
            servicesEnabled: true,
            status: .denied))
    }

    @Test @MainActor func `registration permissions exclude watch availability`() async {
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let permissions = await controller._test_currentPermissions()

        #expect(!permissions.keys.contains(where: { $0.hasPrefix("watch") }))
    }

    @Test @MainActor func `legacy EventKit permission means readable access`() {
        #expect(GatewayConnectionController._test_hasEventKitReadAccess(.fullAccess))
        #expect(!GatewayConnectionController._test_hasEventKitReadAccess(.writeOnly))
        #expect(!GatewayConnectionController._test_hasEventKitReadAccess(.denied))
    }

    @Test @MainActor func `current commands exclude dangerous system exec commands`() {
        withUserDefaults([
            "node.instanceId": "ios-test",
            "camera.enabled": true,
            "location.enabledMode": OpenClawLocationMode.whileUsing.rawValue,
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let commands = Set(controller._test_currentCommands())

            // iOS should expose notify, but not host shell/exec-approval commands.
            #expect(commands.contains(OpenClawSystemCommand.notify.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.run.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.which.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.execApprovalsGet.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.execApprovalsSet.rawValue))
        }
    }

    @Test @MainActor func `operator connect options only request approval scope when enabled`() {
        let appModel = NodeAppModel()
        let withoutApprovalScope = appModel._test_makeOperatorConnectOptions(
            clientId: "openclaw-ios",
            displayName: "OpenClaw iOS",
            includeApprovalScope: false)
        let withApprovalScope = appModel._test_makeOperatorConnectOptions(
            clientId: "openclaw-ios",
            displayName: "OpenClaw iOS",
            includeApprovalScope: true)
        let withAdminScope = appModel._test_makeOperatorConnectOptions(
            clientId: "openclaw-ios",
            displayName: "OpenClaw iOS",
            includeAdminScope: true,
            includeApprovalScope: false)

        #expect(withoutApprovalScope.role == "operator")
        #expect(!withoutApprovalScope.scopes.contains("operator.admin"))
        #expect(withoutApprovalScope.scopes.contains("operator.read"))
        #expect(withoutApprovalScope.scopes.contains("operator.write"))
        #expect(!withoutApprovalScope.scopes.contains("operator.approvals"))
        #expect(!withoutApprovalScope.scopes.contains("operator.questions"))
        #expect(withoutApprovalScope.scopes.contains("operator.talk.secrets"))
        #expect(!withoutApprovalScope.scopesAreExplicit)
        #expect(withoutApprovalScope.caps == [OpenClawGatewayClientCapability.inlineWidgets])

        #expect(withApprovalScope.scopes.contains("operator.approvals"))
        #expect(withApprovalScope.scopes.contains("operator.questions"))
        #expect(withAdminScope.scopes.contains("operator.admin"))
    }

    @Test @MainActor func `operator talk permission upgrade uses explicit least privilege scopes`() {
        let appModel = NodeAppModel()
        let options = appModel._test_makeOperatorConnectOptions(
            clientId: "openclaw-ios",
            displayName: "OpenClaw iOS",
            includeApprovalScope: false,
            forceExplicitScopes: true)

        #expect(options.scopesAreExplicit)
        #expect(!options.scopes.contains("operator.admin"))
        #expect(!options.scopes.contains("operator.approvals"))
        #expect(options.scopes.contains("operator.read"))
        #expect(options.scopes.contains("operator.write"))
        #expect(options.scopes.contains("operator.talk.secrets"))
    }

    @Test func `permission upgrade polling preserves active connection attempts`() {
        #expect(NodeAppModel.shouldRestartTalkPermissionUpgradePoll(
            hasOperatorGatewayTask: false,
            hasReconnectTask: false))
        #expect(!NodeAppModel.shouldRestartTalkPermissionUpgradePoll(
            hasOperatorGatewayTask: true,
            hasReconnectTask: false))
        #expect(!NodeAppModel.shouldRestartTalkPermissionUpgradePoll(
            hasOperatorGatewayTask: false,
            hasReconnectTask: true))
    }

    @Test func `automatic talk permission upgrade retries recoverable failures`() {
        #expect(NodeAppModel.shouldRequestTalkPermissionUpgrade(
            isTalkEnabled: true,
            state: .missingScope("operator.talk.secrets")))
        #expect(NodeAppModel.shouldRequestTalkPermissionUpgrade(
            isTalkEnabled: true,
            state: .requestFailed("Gateway is not connected")))
        #expect(!NodeAppModel.shouldRequestTalkPermissionUpgrade(
            isTalkEnabled: false,
            state: .requestFailed("Gateway is not connected")))
        #expect(!NodeAppModel.shouldRequestTalkPermissionUpgrade(
            isTalkEnabled: true,
            state: .upgradeRequested))
    }

    @Test func `operator admin scope requests only when shared auth or already granted`() {
        #expect(
            !NodeAppModel._test_shouldRequestOperatorAdminScope(
                token: nil,
                password: nil,
                storedOperatorScopes: ["operator.read", "operator.write", "operator.talk.secrets"]))
        #expect(
            NodeAppModel._test_shouldRequestOperatorAdminScope(
                token: nil,
                password: nil,
                storedOperatorScopes: ["operator.admin"]))
        #expect(
            NodeAppModel._test_shouldRequestOperatorAdminScope(
                token: "shared-token",
                password: nil,
                storedOperatorScopes: []))
        #expect(
            NodeAppModel._test_shouldRequestOperatorAdminScope(
                token: nil,
                password: "shared-password",
                storedOperatorScopes: []))
        #expect(
            !NodeAppModel._test_shouldRequestOperatorAdminScope(
                token: "shared-token",
                password: nil,
                storedOperatorScopes: [],
                forceTalkPermissionUpgradeRequest: true))
    }

    @Test func `stored device token scope gap uses gateway scope compatibility`() {
        #expect(!GatewayChannelActor._test_requestedScopesExceedStoredToken(
            role: "operator",
            requestedScopes: ["operator.read", "operator.write", "operator.talk.secrets"],
            storedToken: "stored-device-token",
            storedScopes: ["operator.admin"]))
        #expect(!GatewayChannelActor._test_requestedScopesExceedStoredToken(
            role: "operator",
            requestedScopes: ["operator.read"],
            storedToken: "stored-device-token",
            storedScopes: []))
        #expect(GatewayChannelActor._test_requestedScopesExceedStoredToken(
            role: "operator",
            requestedScopes: ["operator.admin"],
            storedToken: "stored-device-token",
            storedScopes: ["operator.read"]))
    }

    @Test func `operator approval scope requests stay backward compatible`() {
        #expect(
            !NodeAppModel._test_shouldRequestOperatorApprovalScope(
                token: nil,
                password: nil,
                storedOperatorScopes: ["operator.read", "operator.write", "operator.talk.secrets"]))
        #expect(
            NodeAppModel._test_shouldRequestOperatorApprovalScope(
                token: nil,
                password: nil,
                storedOperatorScopes: [
                    "operator.approvals",
                    "operator.read",
                    "operator.write",
                    "operator.talk.secrets",
                ]))
        #expect(
            NodeAppModel._test_shouldRequestOperatorApprovalScope(
                token: "shared-token",
                password: nil,
                storedOperatorScopes: []))
        #expect(
            !NodeAppModel._test_shouldRequestOperatorApprovalScope(
                token: "shared-token",
                password: nil,
                storedOperatorScopes: [],
                forceTalkPermissionUpgradeRequest: true))
        #expect(
            NodeAppModel._test_shouldRequestOperatorApprovalScope(
                token: nil,
                password: nil,
                storedOperatorScopes: ["operator.approvals"],
                forceTalkPermissionUpgradeRequest: true))
    }

    @Test @MainActor func `operator pairing problem preserves primary gateway connection state`() {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
        appModel.gatewayServerName = "gateway.example.com"
        appModel.gatewayRemoteAddress = "127.0.0.1:53380"
        let problem = GatewayConnectionProblem(
            kind: .pairingScopeUpgradeRequired,
            owner: .gateway,
            title: "Additional permissions required",
            message: "Approve the requested permissions on the gateway.",
            requestId: "req-admin",
            retryable: false,
            pauseReconnect: true)

        appModel._test_applyOperatorGatewayConnectionProblem(problem)

        #expect(appModel._test_isGatewayConnected())
        #expect(appModel.gatewayServerName == "gateway.example.com")
        #expect(appModel.gatewayRemoteAddress == "127.0.0.1:53380")
        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == "req-admin")

        appModel._test_clearGatewayConnectionProblem()

        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == "req-admin")

        appModel._test_clearOperatorGatewayConnectionProblemIfCurrent()

        #expect(appModel._test_isGatewayConnected())
        #expect(appModel.gatewayServerName == "gateway.example.com")
        #expect(appModel.lastGatewayProblem == nil)
        #expect(!appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == nil)
        #expect(appModel.gatewayStatusText == "Connected")
    }

    @Test @MainActor func `retained gateway problem clears only when explicit target changes`() throws {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let currentConfig = Self.makeGatewayConnectConfig()
        appModel.applyGatewayConnectConfig(currentConfig)
        let problem = GatewayConnectionProblem(
            kind: .connectionRefused,
            owner: .network,
            title: "Connection refused",
            message: "The gateway refused the connection.",
            retryable: true,
            pauseReconnect: false)
        appModel._test_applyOperatorGatewayConnectionProblem(problem)

        #expect(appModel.lastGatewayProblem == problem)

        appModel.applyGatewayConnectConfig(currentConfig, forceReconnect: true)
        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.gatewayDisplayStatusText == problem.localizedStatusText)

        let replacementURL = try #require(URL(string: "wss://replacement.example.com:443"))
        let replacementConfig = Self.makeGatewayConnectConfig(
            url: replacementURL,
            stableID: "manual|replacement.example.com|443")
        appModel.beginGatewayPreconnectVerification(statusText: "Verifying gateway TLS fingerprint…")
        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.gatewayDisplayStatusText == problem.localizedStatusText)

        appModel.applyGatewayConnectConfig(replacementConfig, forceReconnect: true)
        #expect(appModel.lastGatewayProblem == nil)
        #expect(appModel.gatewayStatusText == "Connecting…")
        #expect(appModel.gatewayDisplayStatusText == "Connecting…")
        #expect(!appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == nil)
    }

    @Test @MainActor func `stable gateway owner preserves focused chat across route changes`() throws {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let currentConfig = Self.makeGatewayConnectConfig()
        let focusedSessionKey = "agent:main:ios-focused"
        appModel.applyGatewayConnectConfig(currentConfig)
        appModel.focusChatSession(focusedSessionKey)

        let replacementURL = try #require(URL(string: "wss://127.0.0.1:2"))
        let refreshedRoute = Self.makeGatewayConnectConfig(
            url: replacementURL,
            stableID: currentConfig.stableID)
        appModel.applyGatewayConnectConfig(refreshedRoute, forceReconnect: true)
        #expect(appModel.chatSessionKey == focusedSessionKey)

        let replacementConfig = Self.makeGatewayConnectConfig(
            url: replacementURL,
            stableID: "manual|replacement.example.com|443")
        appModel.applyGatewayConnectConfig(replacementConfig, forceReconnect: true)

        #expect(appModel.chatSessionKey != focusedSessionKey)
    }

    @Test func `gateway connect config matches equivalent inputs`() {
        let lhs = Self.makeGatewayConnectConfig()
        let rhs = GatewayConnectConfig(
            url: lhs.url,
            stableID: lhs.stableID,
            tls: lhs.tls,
            token: lhs.token,
            bootstrapToken: lhs.bootstrapToken,
            password: lhs.password,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: ["canvas", "screen"],
                commands: ["location.get", "notify"],
                permissions: ["screen": true],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone"))

        #expect(lhs.hasSameConnectionInputs(as: rhs))
    }

    @Test @MainActor func `same target retry unpauses retained pairing problem`() {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let config = Self.makeGatewayConnectConfig()
        appModel.applyGatewayConnectConfig(config)
        let problem = GatewayConnectionProblem(
            kind: .pairingScopeUpgradeRequired,
            owner: .gateway,
            title: "Additional permissions required",
            message: "Approve the requested permissions on the gateway.",
            requestId: "req-admin",
            retryable: false,
            pauseReconnect: true)
        appModel._test_applyOperatorGatewayConnectionProblem(problem)
        #expect(appModel.gatewayPairingPaused)

        appModel.applyGatewayConnectConfig(config, forceReconnect: true)

        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.gatewayDisplayStatusText == problem.localizedStatusText)
        #expect(!appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == nil)

        appModel._test_clearGatewayConnectionProblem()

        #expect(appModel.lastGatewayProblem == nil)
        #expect(!appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == nil)
    }

    @Test @MainActor func `gateway preflight retains only the readable problem snapshot`() {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let config = Self.makeGatewayConnectConfig()
        appModel.applyGatewayConnectConfig(config)
        let problem = GatewayConnectionProblem(
            kind: .pairingScopeUpgradeRequired,
            owner: .gateway,
            title: "Additional permissions required",
            message: "Approve the requested permissions on the gateway.",
            requestId: "req-admin",
            retryable: false,
            pauseReconnect: true)
        appModel._test_applyOperatorGatewayConnectionProblem(problem)

        appModel.beginGatewayPreconnectVerification(statusText: "Verifying gateway TLS fingerprint…")

        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.gatewayDisplayStatusText == problem.localizedStatusText)
        #expect(appModel.gatewayStatusText == "Verifying gateway TLS fingerprint…")
        #expect(!appModel.gatewayPairingPaused)
        #expect(appModel.gatewayPairingRequestId == nil)

        appModel._test_clearGatewayConnectionProblem()
        #expect(appModel.lastGatewayProblem == nil)
    }

    @Test func `gateway connect config keeps stable owner bytes exact`() {
        let composedID = "gateway-\u{00E9}"
        let decomposedID = "gateway-e\u{0301}"
        let boundaryID = "\u{0085}gateway"
        let composed = Self.makeGatewayConnectConfig(stableID: composedID)
        let decomposed = Self.makeGatewayConnectConfig(stableID: decomposedID)
        let boundary = Self.makeGatewayConnectConfig(stableID: boundaryID)

        #expect(composedID == decomposedID)
        #expect(Array(composed.effectiveStableID.utf8) == Array(composedID.utf8))
        #expect(Array(boundary.effectiveStableID.utf8) == Array(boundaryID.utf8))
        #expect(!composed.hasSameConnectionInputs(as: decomposed))

        var composedOptions = composed.nodeOptions
        composedOptions.deviceAuthGatewayID = composedID
        var decomposedOptions = composed.nodeOptions
        decomposedOptions.deviceAuthGatewayID = decomposedID
        let composedAuthOwner = GatewayConnectConfig(
            url: composed.url,
            stableID: "shared-route",
            tls: composed.tls,
            token: composed.token,
            bootstrapToken: composed.bootstrapToken,
            password: composed.password,
            nodeOptions: composedOptions)
        let decomposedAuthOwner = GatewayConnectConfig(
            url: composed.url,
            stableID: "shared-route",
            tls: composed.tls,
            token: composed.token,
            bootstrapToken: composed.bootstrapToken,
            password: composed.password,
            nodeOptions: decomposedOptions)
        #expect(!composedAuthOwner.hasSameConnectionInputs(as: decomposedAuthOwner))
    }

    @Test @MainActor func `gateway reconnect options stay scoped to exact owner bytes`() {
        let composedID = "gateway-\u{00E9}"
        let decomposedID = "gateway-e\u{0301}"
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let config = Self.makeGatewayConnectConfig(stableID: composedID)
        appModel.applyGatewayConnectConfig(config)
        var fallback = config.nodeOptions
        fallback.clientId = "fallback-client"

        let selected = appModel._test_currentGatewayReconnectOptions(
            stableID: decomposedID,
            fallback: fallback)

        #expect(selected.clientId == "fallback-client")
    }

    @Test func `setup auth override is scoped to scanned endpoint`() {
        let link = GatewayConnectDeepLink(
            host: "first.gateway.example.com",
            port: 443,
            tls: true,
            bootstrapToken: "bootstrap-token",
            token: "source-token",
            password: "source-password")
        let pending = GatewayConnectionController.ManualAuthOverride.setupAuth(from: link).manualAuthOverride
        let firstStableID = GatewayConnectionController.ManualAuthOverride.manualStableID(
            host: link.host,
            port: link.port)
        let secondStableID = GatewayConnectionController.ManualAuthOverride.manualStableID(
            host: "second.gateway.example.com",
            port: 443)

        let first = GatewayConnectionController.ManualAuthOverride.currentManualInput(
            token: "source-token",
            pendingOverride: pending,
            password: "source-password",
            targetStableID: firstStableID)
        let second = GatewayConnectionController.ManualAuthOverride.currentManualInput(
            token: "source-token",
            pendingOverride: pending,
            password: "source-password",
            targetStableID: secondStableID)
        let edited = GatewayConnectionController.ManualAuthOverride.currentManualInput(
            token: "replacement-token",
            pendingOverride: pending,
            password: "source-password",
            targetStableID: secondStableID)
        let ordinary = GatewayConnectionController.ManualAuthOverride.currentManualInput(
            token: "manual-token",
            pendingOverride: nil,
            password: nil,
            targetStableID: secondStableID)

        #expect(first?.token == "source-token")
        #expect(first?.bootstrapToken == "bootstrap-token")
        #expect(first?.password == "source-password")
        #expect(first?.targetStableID == firstStableID)
        #expect(first?.suppressStoredDeviceAuth == true)
        #expect(second?.token == nil)
        #expect(second?.bootstrapToken == nil)
        #expect(second?.password == nil)
        #expect(second?.targetStableID == secondStableID)
        #expect(second?.suppressStoredDeviceAuth == true)
        #expect(edited?.token == "replacement-token")
        #expect(edited?.password == nil)
        #expect(ordinary?.suppressStoredDeviceAuth == false)
    }

    @Test func `persisted setup auth stays scoped after view recreation`() throws {
        let instanceID = "setup-auth-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let firstStableID = "manual|first.gateway.example.com|443"
        let secondStableID = "manual|second.gateway.example.com|443"
        GatewaySettingsStore.saveGatewayCredentials(
            token: "source-token",
            bootstrapToken: "source-bootstrap-token",
            password: "source-password",
            gatewayStableID: firstStableID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)

        let relaunchedOverride = try #require(
            GatewayConnectionController.ManualAuthOverride.persisted(
                instanceId: instanceID,
                targetStableID: firstStableID))
        let sameTargetRetryOverride = try #require(
            GatewayConnectionController.ManualAuthOverride.persisted(
                instanceId: instanceID,
                targetStableID: firstStableID))
        #expect(sameTargetRetryOverride.bootstrapToken == "source-bootstrap-token")
        #expect(GatewayConnectionController.ManualAuthOverride.persisted(
            instanceId: instanceID,
            targetStableID: secondStableID) == nil)
        let secondGatewayAuth = try #require(
            GatewayConnectionController.ManualAuthOverride.currentManualInput(
                token: "source-token",
                pendingOverride: relaunchedOverride,
                password: "source-password",
                targetStableID: secondStableID))
        GatewaySettingsStore.saveGatewayCredentials(
            token: secondGatewayAuth.token,
            bootstrapToken: secondGatewayAuth.bootstrapToken,
            password: secondGatewayAuth.password,
            gatewayStableID: secondStableID,
            suppressStoredDeviceAuth: secondGatewayAuth.suppressStoredDeviceAuth,
            instanceId: instanceID)

        #expect(secondGatewayAuth.token == nil)
        #expect(secondGatewayAuth.bootstrapToken == nil)
        #expect(secondGatewayAuth.password == nil)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: firstStableID).bootstrapToken == "source-bootstrap-token")
        let persistedCredentiallessHandoff = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondStableID)
        #expect(!persistedCredentiallessHandoff.hasCredentials)
        #expect(persistedCredentiallessHandoff.suppressStoredDeviceAuth)
        let nextRelaunchOverride = try #require(
            GatewayConnectionController.ManualAuthOverride.persisted(
                instanceId: instanceID,
                targetStableID: secondStableID))
        #expect(nextRelaunchOverride.targetStableID == secondStableID)
        #expect(nextRelaunchOverride.suppressStoredDeviceAuth)
    }

    @Test @MainActor func `empty setup auth does not reuse stored gateway credentials`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        let defaults = UserDefaults.standard
        let previousInstanceID = defaults.object(forKey: "node.instanceId")
        let instanceID = "ios-test-\(UUID().uuidString)"
        defaults.set(instanceID, forKey: "node.instanceId")
        GatewaySettingsStore.saveGatewayCredentials(
            token: "stored-token",
            bootstrapToken: nil,
            password: "stored-password",
            gatewayStableID: "manual|stored.example.com|443",
            suppressStoredDeviceAuth: false,
            instanceId: instanceID)
        defer {
            GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID)
            if let previousInstanceID {
                defaults.set(previousInstanceID, forKey: "node.instanceId")
            } else {
                defaults.removeObject(forKey: "node.instanceId")
            }
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let link = GatewayConnectDeepLink(
            host: "192.168.1.41",
            port: 18789,
            tls: false,
            bootstrapToken: nil,
            token: nil,
            password: nil)
        let setupAuth = GatewayConnectionController.ManualAuthOverride.setupAuth(from: link)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        await controller.connectManual(
            host: link.host,
            port: link.port,
            useTLS: link.tls,
            authOverride: setupAuth.manualAuthOverride)
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while appModel.activeGatewayConnectConfig == nil, ContinuousClock().now < deadline {
            await Task.yield()
        }

        #expect(appModel.activeGatewayConnectConfig != nil)
        #expect(appModel.activeGatewayConnectConfig?.token == nil)
        #expect(appModel.activeGatewayConnectConfig?.bootstrapToken == nil)
        #expect(appModel.activeGatewayConnectConfig?.password == nil)
        #expect(appModel.activeGatewayConnectConfig?.nodeOptions.allowStoredDeviceAuth == false)
        #expect(appModel.activeGatewayConnectConfig?.nodeOptions.deviceAuthGatewayID == setupAuth.targetStableID)
    }

    @Test @MainActor func `legacy auth preserves proven relay credentials and otherwise requires full re-pair`() throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        let defaults = UserDefaults.standard
        let previousInstanceID = defaults.string(forKey: "node.instanceId")
        let instanceID = "legacy-relay-\(UUID().uuidString)"
        let gatewayService = GatewaySettingsStore._testGatewayService
        let lastConnectionAccount = "gateway-registry"
        let previousLastConnection = KeychainStore.loadString(
            service: gatewayService,
            account: lastConnectionAccount)
        let previousRelay = ShareGatewayRelaySettings.loadConfig()
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defaults.set(instanceID, forKey: "node.instanceId")
        defer {
            GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID)
            if let previousInstanceID {
                defaults.set(previousInstanceID, forKey: "node.instanceId")
            } else {
                defaults.removeObject(forKey: "node.instanceId")
            }
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            if let previousLastConnection {
                _ = KeychainStore.saveString(
                    previousLastConnection,
                    service: gatewayService,
                    account: lastConnectionAccount)
            } else {
                _ = KeychainStore.delete(service: gatewayService, account: lastConnectionAccount)
            }
            if let previousRelay {
                ShareGatewayRelaySettings.saveConfig(previousRelay)
            } else {
                ShareGatewayRelaySettings.clearConfig()
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let stableID = "manual|gateway.example.com|443"
        let primaryIdentity = DeviceIdentityStore.loadOrCreate()
        let shareIdentity = DeviceIdentityStore.loadOrCreate(profile: .shareExtension)
        _ = DeviceAuthStore.storeToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            token: "legacy-primary-token")
        _ = DeviceAuthStore.storeToken(
            deviceId: primaryIdentity.deviceId,
            role: "operator",
            token: "legacy-operator-token")
        _ = DeviceAuthStore.storeToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            token: "legacy-share-token",
            profile: .shareExtension)
        GatewaySettingsStore.saveLegacyGatewayTokenForMigrationTest(
            "unproven-field-token",
            instanceId: instanceID)
        saveActiveManualGateway(
            host: "gateway.example.com",
            port: 443,
            useTLS: true,
            stableID: stableID)
        ShareGatewayRelaySettings.saveConfig(ShareGatewayRelayConfig(
            gatewayURLString: "wss://gateway.example.com",
            token: "proven-relay-token",
            password: "proven-relay-password",
            sessionKey: "main"))

        let extensionConfig = try #require(ShareGatewayRelaySettings.loadConfigDiscardingUnscopedDeviceAuth())
        #expect(extensionConfig.gatewayStableID == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            profile: .shareExtension) == nil)

        _ = DeviceAuthStore.storeToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            token: "ambiguous-share-token",
            profile: .shareExtension)
        _ = GatewayConnectionController(appModel: NodeAppModel(), startDiscovery: false)

        #expect(DeviceAuthStore.loadToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            gatewayID: stableID)?.token == "legacy-primary-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: primaryIdentity.deviceId,
            role: "operator",
            gatewayID: stableID) == nil)
        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "operator") == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            gatewayID: stableID,
            profile: .shareExtension) == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            profile: .shareExtension) == nil)
        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "node") == nil)
        #expect(ShareGatewayRelaySettings.loadConfig()?.gatewayStableID == stableID)
        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: stableID)
        #expect(credentials.token == "proven-relay-token")
        #expect(credentials.password == "proven-relay-password")
        #expect(!credentials.suppressStoredDeviceAuth)
        #expect(KeychainStore.loadString(
            service: gatewayService,
            account: "gateway-token.\(instanceID)") == nil)

        let rePairStableID = "manual|pair-again.example.com|443"
        _ = DeviceAuthStore.storeToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            token: "legacy-node-without-shared-auth")
        _ = DeviceAuthStore.storeToken(
            deviceId: primaryIdentity.deviceId,
            role: "operator",
            token: "legacy-operator-without-shared-auth")
        GatewaySettingsStore.saveLegacyGatewayTokenForMigrationTest(
            "unproven-field-token",
            instanceId: instanceID)
        saveActiveManualGateway(
            host: "pair-again.example.com",
            port: 443,
            useTLS: true,
            stableID: rePairStableID)
        ShareGatewayRelaySettings.saveConfig(ShareGatewayRelayConfig(
            gatewayURLString: "wss://pair-again.example.com",
            token: nil,
            password: nil,
            sessionKey: "main"))

        _ = GatewayConnectionController(appModel: NodeAppModel(), startDiscovery: false)

        #expect(DeviceAuthStore.loadToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            gatewayID: rePairStableID) == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: primaryIdentity.deviceId,
            role: "operator",
            gatewayID: rePairStableID) == nil)
        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "node") == nil)
        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "operator") == nil)
    }

    @Test @MainActor func `successful setup handoff enables target scoped auth`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        let previousStableID = "manual|previous.gateway.example.com|443"
        let stableID = "manual|new.gateway.example.com|443"
        let instanceID = "bootstrap-handoff-\(UUID().uuidString)"
        let previousInstanceID = UserDefaults.standard.string(forKey: "node.instanceId")
        UserDefaults.standard.set(instanceID, forKey: "node.instanceId")
        defer {
            GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID)
            if let previousInstanceID {
                UserDefaults.standard.set(previousInstanceID, forKey: "node.instanceId")
            } else {
                UserDefaults.standard.removeObject(forKey: "node.instanceId")
            }
        }
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: "previous-node-token",
            gatewayID: previousStableID)
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "previous-operator-token",
            gatewayID: previousStableID)
        var nodeOptions = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "ios",
            clientMode: "node",
            clientDisplayName: "Phone",
            allowStoredDeviceAuth: false,
            deviceAuthGatewayID: stableID)
        let config = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: stableID,
            tls: nil,
            token: nil,
            bootstrapToken: "one-time-bootstrap",
            password: nil,
            nodeOptions: nodeOptions)
        GatewaySettingsStore.saveGatewayCredentials(
            token: nil,
            bootstrapToken: "one-time-bootstrap",
            password: nil,
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        appModel.applyGatewayConnectConfig(config)

        let emptyIssuanceOptions = try appModel._test_completeSuccessfulGatewayAuthHandoff(
            issuedRoles: [],
            nodeOptions: nodeOptions)
        let operatorOnlyOptions = try appModel._test_completeSuccessfulGatewayAuthHandoff(
            issuedRoles: ["operator"],
            nodeOptions: nodeOptions)
        let nodeOnlyOptions = try appModel._test_completeSuccessfulGatewayAuthHandoff(
            issuedRoles: ["node"],
            nodeOptions: nodeOptions)
        #expect(emptyIssuanceOptions == nil)
        #expect(operatorOnlyOptions == nil)
        #expect(nodeOnlyOptions == nil)
        #expect(appModel.activeGatewayConnectConfig?.bootstrapToken == "one-time-bootstrap")
        #expect(GatewaySettingsStore.loadGatewayCredentialMetadata(
            instanceId: instanceID,
            gatewayStableID: stableID) != nil)

        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: "new-node-token",
            gatewayID: stableID)
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "new-operator-token",
            gatewayID: stableID)
        let bootstrapOptions = nodeOptions
        appModel._test_setGatewayLoopTasks(node: nil, operator: Task {})
        let completedOptions = try appModel._test_completeSuccessfulGatewayAuthHandoff(
            issuedRoles: ["node", "operator"],
            nodeOptions: nodeOptions)
        nodeOptions = try #require(completedOptions)

        #expect(nodeOptions.allowStoredDeviceAuth)
        #expect(appModel.activeGatewayConnectConfig?.nodeOptions.allowStoredDeviceAuth == true)
        #expect(appModel.activeGatewayConnectConfig?.bootstrapToken == nil)
        #expect(GatewaySettingsStore.loadGatewayCredentialMetadata(
            instanceId: instanceID,
            gatewayStableID: stableID) == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: stableID)?.token == "new-node-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "operator",
            gatewayID: stableID)?.token == "new-operator-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: previousStableID)?.token == "previous-node-token")
        #expect(appModel._test_hasGatewayLoopTasks().operator)
        #expect(appModel._test_currentGatewayReconnectOptions(
            stableID: stableID,
            fallback: bootstrapOptions).allowStoredDeviceAuth)
    }

    @Test @MainActor func `bootstrap pairing clears only the target gateway`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        let gatewayA = "manual|gateway-a-\(UUID().uuidString)|443"
        let gatewayB = "manual|gateway-b-\(UUID().uuidString)|443"
        defer {
            GatewayTLSStore.clearFingerprint(stableID: gatewayA)
            GatewayTLSStore.clearFingerprint(stableID: gatewayB)
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let primaryIdentity = DeviceIdentityStore.loadOrCreate()
        let shareIdentity = DeviceIdentityStore.loadOrCreate(profile: .shareExtension)
        GatewayTLSStore.saveFingerprint("fingerprint-a", stableID: gatewayA)
        GatewayTLSStore.saveFingerprint("fingerprint-b", stableID: gatewayB)
        let gatewayAOwner = GatewaySettingsStore.authenticationOwnerID(routeStableID: gatewayA)
        let gatewayBOwner = GatewaySettingsStore.authenticationOwnerID(routeStableID: gatewayB)
        for (routeID, ownerID) in [(gatewayA, gatewayAOwner), (gatewayB, gatewayBOwner)] {
            _ = DeviceAuthStore.storeToken(
                deviceId: primaryIdentity.deviceId,
                role: "node",
                token: "primary-\(routeID)",
                gatewayID: ownerID)
            _ = DeviceAuthStore.storeToken(
                deviceId: shareIdentity.deviceId,
                role: "node",
                token: "share-\(routeID)",
                gatewayID: ownerID,
                profile: .shareExtension)
        }

        let appModel = NodeAppModel()
        await GatewayOnboardingReset.prepareForBootstrapPairing(
            appModel: appModel,
            instanceId: "",
            gatewayStableID: gatewayB,
            disconnectGateway: false)

        #expect(DeviceAuthStore.loadToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            gatewayID: gatewayAOwner) != nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            gatewayID: gatewayBOwner) == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            gatewayID: gatewayAOwner,
            profile: .shareExtension) != nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            gatewayID: gatewayBOwner,
            profile: .shareExtension) == nil)
        #expect(GatewayTLSStore.loadFingerprint(stableID: gatewayA) == "fingerprint-a")
        #expect(GatewayTLSStore.loadFingerprint(stableID: gatewayB) == nil)
    }

    @Test @MainActor func `explicit auth starts operator loop while stored auth is disabled`() throws {
        let stableID = "manual|gateway.example.com|443"
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let config = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: stableID,
            tls: nil,
            token: "shared-token",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone",
                allowStoredDeviceAuth: false,
                deviceAuthGatewayID: stableID))

        appModel.applyGatewayConnectConfig(config)

        #expect(appModel._test_hasGatewayLoopTasks().node)
        #expect(appModel._test_hasGatewayLoopTasks().operator)
    }

    @Test @MainActor func `applying different gateway config reconnects active tasks`() throws {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let first = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: "manual|first.gateway.example.com|443")
        let second = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:2")),
            stableID: "manual|second.gateway.example.com|443")

        appModel.applyGatewayConnectConfig(first)
        appModel.talkMode.updateGatewayConnected(true)
        appModel.applyGatewayConnectConfig(second)

        #expect(appModel.connectedGatewayID == second.stableID)
        #expect(!appModel.talkMode.isGatewayConnected)
    }

    @Test @MainActor func `forced reconnect reset clears active gateway loop tasks`() async {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }

        appModel.applyGatewayConnectConfig(Self.makeGatewayConnectConfig())
        #expect(appModel._test_hasGatewayLoopTasks().node)
        #expect(appModel._test_hasGatewayLoopTasks().operator)

        await appModel.resetGatewaySessionsForForcedReconnect()

        #expect(!appModel._test_hasGatewayLoopTasks().node)
        #expect(!appModel._test_hasGatewayLoopTasks().operator)
    }

    @Test @MainActor func `forced reconnect reset waits for canceled loop cleanup`() async {
        var cleanupStarted = false
        var releaseCleanup: CheckedContinuation<Void, Never>?
        var resetFinished = false
        let appModel = NodeAppModel()
        let loopTask = Task { @MainActor in
            while !Task.isCancelled {
                await Task.yield()
            }
            cleanupStarted = true
            await withCheckedContinuation { continuation in
                releaseCleanup = continuation
            }
        }
        appModel._test_setGatewayLoopTasks(node: loopTask)
        defer {
            releaseCleanup?.resume()
            appModel.disconnectGateway()
        }

        let resetTask = Task { @MainActor in
            await appModel.resetGatewaySessionsForForcedReconnect()
            resetFinished = true
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while !cleanupStarted, ContinuousClock().now < deadline {
            await Task.yield()
        }

        #expect(cleanupStarted)
        #expect(appModel.hasGatewaySessionResetInFlight)
        #expect(!resetFinished)

        releaseCleanup?.resume()
        releaseCleanup = nil
        await resetTask.value

        #expect(resetFinished)
        #expect(!appModel.hasGatewaySessionResetInFlight)
    }

    @Test @MainActor func `manual disconnect chains after existing reset to own new loops`() async {
        let resetRelease = AsyncStream<Void>.makeStream()
        let appModel = NodeAppModel()
        defer {
            resetRelease.continuation.finish()
            appModel._test_setGatewaySessionResetTask(nil)
            appModel.disconnectGateway()
        }
        let existingReset = Task {
            for await _ in resetRelease.stream {
                return
            }
        }
        appModel._test_setGatewaySessionResetTask(existingReset)
        appModel.applyGatewayConnectConfig(Self.makeGatewayConnectConfig())
        #expect(appModel._test_hasGatewayLoopTasks().node)
        #expect(appModel._test_hasGatewayLoopTasks().operator)

        appModel.disconnectGateway()
        resetRelease.continuation.yield()
        resetRelease.continuation.finish()
        await appModel.waitForGatewaySessionResetIfNeeded()

        #expect(appModel.activeGatewayConnectConfig == nil)
        #expect(!appModel._test_hasGatewayLoopTasks().node)
        #expect(!appModel._test_hasGatewayLoopTasks().operator)
    }

    @Test @MainActor func `target switch reset clears previous reconnect route`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let defaults = UserDefaults.standard
        let reconnectDefaults: [String: Any?] = [
            "gateway.autoconnect": true,
            "gateway.manual.enabled": true,
            "gateway.manual.host": "previous.gateway.invalid",
            "gateway.manual.port": 443,
            "gateway.manual.tls": true,
        ]
        var reconnectDefaultsSnapshot: [String: Any?] = [:]
        for key in reconnectDefaults.keys {
            reconnectDefaultsSnapshot[key] = defaults.object(forKey: key)
        }
        let gatewayService = GatewaySettingsStore._testGatewayService
        let lastConnectionAccount = "gateway-registry"
        let priorLastConnection = KeychainStore.loadString(
            service: gatewayService,
            account: lastConnectionAccount)
        let priorRelayConfig = ShareGatewayRelaySettings.loadConfig()
        defer {
            if let priorRelayConfig {
                ShareGatewayRelaySettings.saveConfig(priorRelayConfig)
            } else {
                ShareGatewayRelaySettings.clearConfig()
            }
        }
        defer {
            for (key, value) in reconnectDefaultsSnapshot {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
            if let priorLastConnection {
                _ = KeychainStore.saveString(
                    priorLastConnection,
                    service: gatewayService,
                    account: lastConnectionAccount)
            } else {
                _ = KeychainStore.delete(service: gatewayService, account: lastConnectionAccount)
            }
        }
        for (key, value) in reconnectDefaults {
            defaults.set(value, forKey: key)
        }
        saveActiveManualGateway(
            host: "previous.gateway.invalid",
            port: 443,
            useTLS: true,
            stableID: "manual|previous.gateway.invalid|443")
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }

        ShareGatewayRelaySettings.saveConfig(ShareGatewayRelayConfig(
            gatewayURLString: "wss://previous.gateway.invalid",
            token: "previous-token",
            password: nil,
            sessionKey: "main"))
        appModel.applyGatewayConnectConfig(Self.makeGatewayConnectConfig())
        await appModel.resetGatewaySessionsForTargetSwitch()

        #expect(!appModel.gatewayAutoReconnectEnabled)
        #expect(!defaults.bool(forKey: "gateway.autoconnect"))
        #expect(appModel.activeGatewayConnectConfig == nil)
        #expect(appModel.gatewayServerName == nil)
        #expect(!appModel._test_hasGatewayLoopTasks().node)
        #expect(!appModel._test_hasGatewayLoopTasks().operator)
        #expect(!appModel._test_hasChatSessionRoutingRestoreTask())
        #expect(ShareGatewayRelaySettings.loadConfig() == nil)

        let relaunchedModel = NodeAppModel()
        defer { relaunchedModel.disconnectGateway() }
        let relaunchedController = GatewayConnectionController(
            appModel: relaunchedModel,
            startDiscovery: false)
        relaunchedController._test_triggerAutoConnect()

        #expect(!relaunchedController._test_didAutoConnect())
        #expect(relaunchedModel.activeGatewayConnectConfig == nil)
    }

    @Test @MainActor func `target switch reset reasserts persisted reconnect pause after teardown`() async {
        let defaults = UserDefaults.standard
        let priorAutoConnect = defaults.object(forKey: "gateway.autoconnect")
        defer {
            if let priorAutoConnect {
                defaults.set(priorAutoConnect, forKey: "gateway.autoconnect")
            } else {
                defaults.removeObject(forKey: "gateway.autoconnect")
            }
        }
        defaults.set(true, forKey: "gateway.autoconnect")

        let teardownRelease = AsyncStream<Void>.makeStream()
        let appModel = NodeAppModel()
        defer {
            appModel._test_setGatewaySessionResetTask(nil)
            appModel.disconnectGateway()
        }
        let staleTeardownTask = Task {
            for await _ in teardownRelease.stream {
                defaults.set(true, forKey: "gateway.autoconnect")
                return
            }
        }
        appModel._test_setGatewaySessionResetTask(staleTeardownTask)

        let targetResetTask = Task {
            await appModel.resetGatewaySessionsForTargetSwitch()
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while defaults.bool(forKey: "gateway.autoconnect"), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(!defaults.bool(forKey: "gateway.autoconnect"))

        teardownRelease.continuation.yield()
        teardownRelease.continuation.finish()
        await targetResetTask.value

        #expect(!defaults.bool(forKey: "gateway.autoconnect"))
    }

    @Test @MainActor func `newer gateway connect generation rejects queued config`() throws {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let staleGeneration = appModel.beginGatewayConnectAttempt()
        let currentGeneration = appModel.beginGatewayConnectAttempt()
        let staleConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://stale.gateway.invalid")),
            stableID: "manual|stale.gateway.invalid|443")
        let currentConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: "manual|current.gateway.invalid|443")

        appModel.applyGatewayConnectConfig(staleConfig, expectedGeneration: staleGeneration)
        #expect(appModel.activeGatewayConnectConfig == nil)

        appModel.applyGatewayConnectConfig(currentConfig, expectedGeneration: currentGeneration)
        #expect(appModel.activeGatewayConnectConfig?.stableID == currentConfig.stableID)
    }

    @Test @MainActor func `direct gateway apply invalidates older queued config`() throws {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let staleGeneration = appModel.beginGatewayConnectAttempt()
        let staleConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://stale.gateway.invalid")),
            stableID: "manual|stale.gateway.invalid|443")
        let currentConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: "manual|current.gateway.invalid|443")

        appModel.applyGatewayConnectConfig(currentConfig)
        appModel.applyGatewayConnectConfig(staleConfig, expectedGeneration: staleGeneration)

        #expect(appModel.activeGatewayConnectConfig?.stableID == currentConfig.stableID)
    }

    @Test @MainActor func `newer explicit connect immediately invalidates queued config`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let host = "new-target.gateway.invalid"
        let stableID = "manual|\(host.lowercased())|443"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.clearFingerprint(stableID: stableID)

        let probeStarted = AsyncStream<Void>.makeStream()
        let probeResults = AsyncStream<GatewayTLSFingerprintProbeResult>.makeStream()
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in
                probeStarted.continuation.yield()
                for await result in probeResults.stream {
                    return result
                }
                return .failure(.certificateUnavailable)
            })
        let staleGeneration = appModel.beginGatewayConnectAttempt()
        let staleConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://old-target.gateway.invalid")),
            stableID: "manual|old-target.gateway.invalid|443")
        let duringResolutionConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://resolution-window.gateway.invalid")),
            stableID: "manual|resolution-window.gateway.invalid|443")
        var startedIterator = probeStarted.stream.makeAsyncIterator()

        let connectTask = Task {
            await controller.connectManual(host: host, port: 443, useTLS: true)
        }
        _ = await startedIterator.next()
        appModel.applyGatewayConnectConfig(staleConfig, expectedGeneration: staleGeneration)

        #expect(appModel.activeGatewayConnectConfig == nil)

        let duringResolutionGeneration = appModel.gatewayConnectGeneration
        probeResults.continuation.yield(.fingerprint("new-target-fingerprint"))
        probeResults.continuation.finish()
        await connectTask.value
        await controller.acceptPendingTrustPrompt()
        appModel.applyGatewayConnectConfig(
            duringResolutionConfig,
            expectedGeneration: duringResolutionGeneration)

        #expect(appModel.activeGatewayConnectConfig?.stableID != duringResolutionConfig.stableID)
    }

    @Test @MainActor func `trusted certificate keeps device auth route scoped`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let host = "127.0.0.1"
        let stableID = "manual|\(host)|1"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.clearFingerprint(stableID: stableID)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("route-independent-fingerprint") })

        await controller.connectManual(host: host, port: 1, useTLS: true)
        await controller.acceptPendingTrustPrompt()
        for _ in 0..<100 where appModel.activeGatewayConnectConfig == nil {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(appModel.activeGatewayConnectConfig?.stableID == stableID)
        #expect(appModel.activeGatewayConnectConfig?.nodeOptions.deviceAuthGatewayID == stableID)
    }

    @Test @MainActor func `discovered connect preserves exact device auth owner bytes`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let stableID = "\u{0085}gateway-e\u{0301}"
        let endpoint: NWEndpoint = .service(
            name: "Exact Owner",
            type: "_openclaw-gw._tcp",
            domain: "local.",
            interface: nil)
        let gateway = GatewayDiscoveryModel.DiscoveredGateway(
            name: "Exact Owner",
            endpoint: endpoint,
            stableID: stableID,
            debugID: "exact-owner",
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            canvasPort: nil,
            tlsEnabled: true,
            tlsFingerprintSha256: nil,
            cliPath: nil)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let persistedOwnerBytes = OSAllocatedUnfairLock<[UInt8]?>(initialState: nil)
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("exact-owner-fingerprint") },
            serviceEndpointResolver: { _ in (host: "127.0.0.1", port: 1) },
            persistTLSFingerprint: { _, owner in
                persistedOwnerBytes.withLock { $0 = Array(owner.utf8) }
                return true
            })

        #expect(await controller.connectWithDiagnostics(gateway) == nil)
        await controller.acceptPendingTrustPrompt()
        for _ in 0..<100 where appModel.activeGatewayConnectConfig == nil {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(persistedOwnerBytes.withLock { $0 } == Array(stableID.utf8))
        #expect(appModel.activeGatewayConnectConfig.map { Array($0.stableID.utf8) } == Array(stableID.utf8))
        #expect(appModel.activeGatewayConnectConfig
            .flatMap(\.nodeOptions.deviceAuthGatewayID)
            .map { Array($0.utf8) } == Array(stableID.utf8))
    }

    @Test @MainActor func `first trust aborts when certificate pin is not durable`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let host = "127.0.0.1"
        let stableID = "manual|\(host)|2"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.clearFingerprint(stableID: stableID)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("unpersisted-fingerprint") },
            persistTLSFingerprint: { _, _ in false })

        await controller.connectManual(host: host, port: 2, useTLS: true)
        await controller.acceptPendingTrustPrompt()

        #expect(controller.pendingTrustPrompt != nil)
        #expect(appModel.activeGatewayConnectConfig == nil)
        #expect(appModel.gatewayStatusText == "Could not save gateway certificate")
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == nil)
    }

    @Test @MainActor func `certificate rotation preserves route scoped device auth`() async throws {
        let stableID = "manual|rotation-\(UUID().uuidString)|443"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        #expect(GatewayTLSStore.replaceFingerprint("old-certificate", stableID: stableID))
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        var options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "node",
            clientDisplayName: nil,
            deviceAuthGatewayID: stableID)
        options.allowStoredDeviceAuth = true
        let config = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: stableID,
            tls: GatewayTLSParams(
                required: true,
                expectedFingerprint: "old-certificate",
                allowTOFU: false,
                storeKey: stableID),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options)
        appModel.applyGatewayConnectConfig(config)
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let error = GatewayTLSValidationError(
            failure: GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "127.0.0.1",
                storeKey: stableID,
                expectedFingerprint: "old-certificate",
                observedFingerprint: "new-certificate",
                systemTrustOk: true),
            context: "connect to gateway")
        let problem = try #require(GatewayConnectionProblemMapper.map(error: error))

        let didTrust = await controller.trustRotatedGatewayCertificate(from: problem)
        #expect(didTrust)
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new-certificate")
        #expect(appModel.activeGatewayConnectConfig?.nodeOptions.deviceAuthGatewayID == stableID)
        #expect(appModel.activeGatewayConnectConfig?.tls?.expectedFingerprint == "new-certificate")
    }

    @Test @MainActor func `cancel during forced reset restores current gateway`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let host = "replacement.gateway.invalid"
        let stableID = "manual|\(host)|443"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.saveFingerprint("replacement-fingerprint", stableID: stableID)

        let resetFinished = AsyncStream<Void>.makeStream()
        let resetRelease = AsyncStream<Void>.makeStream()
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let currentConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: "manual|current.gateway.invalid|443")
        appModel.applyGatewayConnectConfig(currentConfig)
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            forceReconnectReset: { appModel in
                await appModel.resetGatewaySessionsForForcedReconnect()
                resetFinished.continuation.yield()
                for await _ in resetRelease.stream {
                    return
                }
            })
        var finishedIterator = resetFinished.stream.makeAsyncIterator()

        await controller.connectManual(host: host, port: 443, useTLS: true, forceReconnect: true)
        _ = await finishedIterator.next()
        #expect(!appModel._test_hasGatewayLoopTasks().node)

        controller.cancelPendingConnectionAttempts()
        resetRelease.continuation.yield()
        resetRelease.continuation.finish()
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while !appModel._test_hasGatewayLoopTasks().node, ContinuousClock().now < deadline {
            await Task.yield()
        }

        #expect(appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: currentConfig) == true)
        #expect(appModel._test_hasGatewayLoopTasks().node)
    }

    @Test @MainActor func `cancel without pending task preserves reconnect pause`() async {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let currentConfig = Self.makeGatewayConnectConfig()
        appModel.applyGatewayConnectConfig(currentConfig)
        await appModel.resetGatewaySessionsForForcedReconnect()
        let problem = GatewayConnectionProblem(
            kind: .protocolMismatch,
            owner: .gateway,
            title: "Protocol mismatch",
            message: "Upgrade the gateway before reconnecting.",
            retryable: false,
            pauseReconnect: true)
        appModel._test_applyOperatorGatewayConnectionProblem(problem)
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        controller.cancelPendingConnectionAttempts()
        for _ in 0..<10 {
            await Task.yield()
        }

        #expect(!appModel.gatewayPairingPaused)
        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: currentConfig) == true)
        #expect(!appModel._test_hasGatewayLoopTasks().node)
    }

    @Test @MainActor func `new connect waits for superseded forced reset`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let forceHost = "192.168.1.39"

        let resetRelease = AsyncStream<Void>.makeStream()
        var resetStarted = false
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let currentConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: "manual|current.gateway.invalid|443")
        appModel.applyGatewayConnectConfig(currentConfig)
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            forceReconnectReset: { appModel in
                await appModel.resetGatewaySessionsForForcedReconnect()
                resetStarted = true
                for await _ in resetRelease.stream {
                    return
                }
            })

        await controller.connectManual(host: forceHost, port: 18789, useTLS: false, forceReconnect: true)
        // Simulator WebSocket teardown can take several seconds under the aggregate iOS suite.
        // Keep this bounded while allowing the real session barrier to finish before superseding it.
        let resetStartDeadline = ContinuousClock().now.advanced(by: .seconds(10))
        while !resetStarted, ContinuousClock().now < resetStartDeadline {
            await Task.yield()
        }
        #expect(resetStarted)
        await controller.connectManual(host: "192.168.1.40", port: 18789, useTLS: false)

        #expect(appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: currentConfig) == true)
        #expect(!appModel._test_hasGatewayLoopTasks().node)

        resetRelease.continuation.yield()
        resetRelease.continuation.finish()
        let replacementStableID = "manual|192.168.1.40|18789"
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while appModel.activeGatewayConnectConfig?.stableID != replacementStableID,
              ContinuousClock().now < deadline
        {
            await Task.yield()
        }

        #expect(appModel.activeGatewayConnectConfig?.stableID == replacementStableID)
        #expect(appModel._test_hasGatewayLoopTasks().node)
    }

    @Test @MainActor func `new connect waits for model owned reset barrier`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let resetRelease = AsyncStream<Void>.makeStream()
        let appModel = NodeAppModel()
        defer {
            appModel._test_setGatewaySessionResetTask(nil)
            appModel.disconnectGateway()
        }
        let currentConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: "manual|current.gateway.invalid|443")
        appModel.applyGatewayConnectConfig(currentConfig)
        let modelResetTask = Task {
            for await _ in resetRelease.stream {
                return
            }
        }
        appModel._test_setGatewaySessionResetTask(modelResetTask)
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        await controller.connectManual(host: "192.168.1.41", port: 18789, useTLS: false)
        await Task.yield()

        #expect(appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: currentConfig) == true)

        resetRelease.continuation.yield()
        resetRelease.continuation.finish()
        let replacementStableID = "manual|192.168.1.41|18789"
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while appModel.activeGatewayConnectConfig?.stableID != replacementStableID,
              ContinuousClock().now < deadline
        {
            await Task.yield()
        }

        #expect(appModel.activeGatewayConnectConfig?.stableID == replacementStableID)
    }

    @Test @MainActor func `trust decline releases suppression without reconnecting unpinned target`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let defaults = UserDefaults.standard
        let updates: [String: Any?] = [
            "gateway.autoconnect": false,
            "gateway.manual.enabled": true,
            "gateway.manual.host": "persisted.gateway.invalid",
            "gateway.manual.port": 443,
            "gateway.manual.tls": true,
            "node.instanceId": "ios-test",
        ]
        var snapshot: [String: Any?] = [:]
        for key in updates.keys {
            snapshot[key] = defaults.object(forKey: key)
        }
        for (key, value) in updates {
            defaults.set(value, forKey: key)
        }
        defer {
            for (key, value) in snapshot {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }

        let explicitHost = "explicit.gateway.invalid"
        let explicitStableID = "manual|\(explicitHost)|443"
        defer { GatewayTLSStore.clearFingerprint(stableID: explicitStableID) }
        GatewayTLSStore.clearFingerprint(stableID: explicitStableID)
        let probeStarted = AsyncStream<Void>.makeStream()
        let probeResults = AsyncStream<GatewayTLSFingerprintProbeResult>.makeStream()
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in
                probeStarted.continuation.yield()
                for await result in probeResults.stream {
                    return result
                }
                return .failure(.certificateUnavailable)
            })
        defaults.set(true, forKey: "gateway.autoconnect")
        var startedIterator = probeStarted.stream.makeAsyncIterator()

        let connectTask = Task {
            await controller.connectManual(host: explicitHost, port: 443, useTLS: true)
        }
        _ = await startedIterator.next()
        controller._test_triggerAutoConnect()

        #expect(!controller._test_didAutoConnect())
        #expect(appModel.activeGatewayConnectConfig == nil)

        probeResults.continuation.yield(.fingerprint("explicit-fingerprint"))
        probeResults.continuation.finish()
        await connectTask.value
        #expect(controller.pendingTrustPrompt?.fingerprintSha256 == "explicit-fingerprint")

        controller.declinePendingTrustPrompt()

        #expect(!controller._test_didAutoConnect())
        #expect(!controller._test_isAutoConnectSuppressed())
        #expect(appModel.activeGatewayConnectConfig == nil)
    }

    @Test @MainActor func `active manual TLS auto connect wins over legacy manual defaults`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let host = "manual-autoconnect-\(UUID().uuidString).example.com"
        let stableID = "manual|\(host.lowercased())|443"
        let previousStableID = "manual|previous-gateway.example.com|443"
        let priorPreviousFingerprint = GatewayTLSStore.loadFingerprint(stableID: previousStableID)
        defer {
            GatewayTLSStore.clearFingerprint(stableID: stableID)
            if let priorPreviousFingerprint {
                GatewayTLSStore.saveFingerprint(priorPreviousFingerprint, stableID: previousStableID)
            } else {
                GatewayTLSStore.clearFingerprint(stableID: previousStableID)
            }
        }
        GatewayTLSStore.saveFingerprint("previous-certificate", stableID: previousStableID)
        saveActiveManualGateway(
            host: host,
            port: 443,
            useTLS: true,
            stableID: stableID)

        await withUserDefaults([
            "gateway.autoconnect": true,
            "gateway.manual.enabled": true,
            "gateway.manual.host": "previous-gateway.example.com",
            "gateway.manual.port": 443,
            "gateway.manual.tls": true,
            "node.instanceId": "ios-test",
            "gateway.last.host": nil,
            "gateway.last.port": nil,
            "gateway.last.tls": nil,
            "gateway.last.stableID": nil,
            "gateway.last.kind": nil,
            "gateway.preferredStableID": nil,
            "gateway.lastDiscoveredStableID": nil,
        ]) {
            let appModel = NodeAppModel()
            defer { appModel.disconnectGateway() }
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            controller._test_triggerAutoConnect()
            #expect(!controller._test_didAutoConnect())

            GatewayTLSStore.saveFingerprint("trusted-certificate", stableID: stableID)
            controller._test_triggerAutoConnect()
            #expect(controller._test_didAutoConnect())
            await waitForActiveGateway(stableID: stableID, appModel: appModel)
            #expect(appModel.activeGatewayConnectConfig?.effectiveStableID == stableID)
        }
    }

    @Test @MainActor func `active local manual gateway auto connects without TLS pin`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let stableID = "manual|127.0.0.1|1"
        defer {
            GatewayTLSStore.clearFingerprint(stableID: stableID)
        }
        GatewayTLSStore.clearFingerprint(stableID: stableID)
        saveActiveManualGateway(host: "127.0.0.1", port: 1, useTLS: false, stableID: stableID)

        await withUserDefaults([
            "gateway.autoconnect": true,
            "gateway.manual.enabled": false,
            "node.instanceId": "ios-test",
        ]) {
            let appModel = NodeAppModel()
            defer { appModel.disconnectGateway() }
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            controller._test_triggerAutoConnect()

            #expect(controller._test_didAutoConnect())
            await waitForActiveGateway(stableID: stableID, appModel: appModel)
            #expect(appModel.activeGatewayConnectConfig?.effectiveStableID == stableID)
            #expect(appModel.activeGatewayConnectConfig?.url == URL(string: "ws://127.0.0.1:1"))
        }
    }

    @Test @MainActor func `missing active discovered gateway auto connects to latest manual gateway`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let manualID = "manual|127.0.0.1|1"
        saveActiveManualGateway(host: "127.0.0.1", port: 1, useTLS: false, stableID: manualID)
        _ = GatewaySettingsStore.markGatewayConnected(stableID: manualID, atMs: 42)
        let discoveredID = "bonjour|missing"
        _ = GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
            stableID: discoveredID,
            kind: .discovered,
            name: "Missing Gateway",
            host: nil,
            port: nil,
            useTLS: true,
            lastConnectedAtMs: 84))
        _ = GatewaySettingsStore.setActiveGateway(stableID: discoveredID)

        await withUserDefaults([
            "gateway.autoconnect": true,
            "gateway.manual.enabled": false,
            "node.instanceId": "ios-test",
        ]) {
            let appModel = NodeAppModel()
            defer { appModel.disconnectGateway() }
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            controller._test_triggerAutoConnect()

            #expect(controller._test_didAutoConnect())
            await waitForActiveGateway(stableID: manualID, appModel: appModel)
            #expect(appModel.activeGatewayConnectConfig?.effectiveStableID == manualID)
            #expect(GatewaySettingsStore.activeGatewayEntry()?.stableID == manualID)
        }
    }

    @Test @MainActor func `forget gateway clears matching share relay only`() {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let priorRelay = ShareGatewayRelaySettings.loadConfig()
        defer {
            if let priorRelay {
                ShareGatewayRelaySettings.saveConfig(priorRelay)
            } else {
                ShareGatewayRelaySettings.clearConfig()
            }
        }
        let stableID = "manual|forgotten.example.com|443"
        ShareGatewayRelaySettings.saveConfig(.init(
            gatewayURLString: "wss://forgotten.example.com",
            gatewayStableID: stableID,
            token: "relay-token",
            password: nil,
            sessionKey: "main"))
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        controller.forgetGateway(stableID: stableID)

        #expect(ShareGatewayRelaySettings.loadConfig() == nil)
    }

    @Test @MainActor func `forget manual gateway clears matching legacy auto connect defaults`() {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let host = "forgotten.example.com"
        let port = 443
        let stableID = GatewayConnectionController.ManualAuthOverride.manualStableID(host: host, port: port)
        withUserDefaults([
            "gateway.manual.enabled": true,
            "gateway.manual.host": host,
            "gateway.manual.port": port,
            "gateway.manual.tls": true,
        ]) {
            let appModel = NodeAppModel()
            defer { appModel.disconnectGateway() }
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            controller.forgetGateway(stableID: stableID)

            let defaults = UserDefaults.standard
            #expect(!defaults.bool(forKey: "gateway.manual.enabled"))
            #expect(defaults.object(forKey: "gateway.manual.host") == nil)
            #expect(defaults.object(forKey: "gateway.manual.port") == nil)
            #expect(defaults.object(forKey: "gateway.manual.tls") == nil)
        }
    }

    @Test @MainActor func `forget gateway preserves legacy defaults for another manual gateway`() {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        withUserDefaults([
            "gateway.manual.enabled": true,
            "gateway.manual.host": "kept.example.com",
            "gateway.manual.port": 443,
            "gateway.manual.tls": true,
        ]) {
            let appModel = NodeAppModel()
            defer { appModel.disconnectGateway() }
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            controller.forgetGateway(stableID: "manual|forgotten.example.com|443")

            let defaults = UserDefaults.standard
            #expect(defaults.bool(forKey: "gateway.manual.enabled"))
            #expect(defaults.string(forKey: "gateway.manual.host") == "kept.example.com")
            #expect(defaults.integer(forKey: "gateway.manual.port") == 443)
            #expect(defaults.bool(forKey: "gateway.manual.tls"))
        }
    }

    @Test @MainActor func `forget connected gateway disconnects and repeats device auth cleanup`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let service = GatewaySettingsStore._testGatewayService
        let account = "gateway-registry"
        let prior = KeychainStore.loadString(service: service, account: account)
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: service, account: account)
            } else {
                _ = KeychainStore.delete(service: service, account: account)
            }
        }
        _ = KeychainStore.delete(service: service, account: account)
        let connectedID = "manual|connected.example.com|443"
        let selectedID = "manual|selected.example.com|443"
        saveActiveManualGateway(host: "selected.example.com", port: 443, useTLS: true, stableID: selectedID)
        let appModel = NodeAppModel()
        try appModel.applyGatewayConnectConfig(Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://connected.example.com")),
            stableID: connectedID))
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let identity = DeviceIdentityStore.loadOrCreate()
        defer { DeviceAuthStore.clearToken(deviceId: identity.deviceId, role: "node", gatewayID: connectedID) }

        controller.forgetGateway(stableID: connectedID)
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: "late-handshake-token",
            gatewayID: connectedID)
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: connectedID) != nil,
            ContinuousClock().now < deadline
        {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(appModel.activeGatewayConnectConfig == nil)
        #expect(GatewaySettingsStore.activeGatewayEntry()?.stableID == selectedID)
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: connectedID) == nil)
    }

    @Test @MainActor func `forget selected gateway preserves a different live route`() throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let service = GatewaySettingsStore._testGatewayService
        let account = "gateway-registry"
        let prior = KeychainStore.loadString(service: service, account: account)
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: service, account: account)
            } else {
                _ = KeychainStore.delete(service: service, account: account)
            }
        }
        _ = KeychainStore.delete(service: service, account: account)
        let selectedID = "manual|selected.example.com|443"
        let connectedID = "manual|connected.example.com|443"
        saveActiveManualGateway(host: "selected.example.com", port: 443, useTLS: true, stableID: selectedID)
        _ = GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
            stableID: connectedID,
            kind: .manual,
            name: "connected.example.com:443",
            host: "connected.example.com",
            port: 443,
            useTLS: true,
            lastConnectedAtMs: nil))
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let connectedConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://connected.example.com")),
            stableID: connectedID)
        appModel.applyGatewayConnectConfig(connectedConfig)
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        controller.forgetGateway(stableID: selectedID)

        #expect(appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: connectedConfig) == true)
        #expect(GatewaySettingsStore.activeGatewayEntry() == nil)
        #expect(GatewaySettingsStore.loadGatewayRegistry().entries.map(\.stableID) == [connectedID])
    }

    @Test @MainActor func `forget gateway clears only matching legacy discovery selectors`() {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let service = GatewaySettingsStore._testGatewayService
        let preferredAccount = "preferredStableID"
        let lastAccount = "lastDiscoveredStableID"
        let priorPreferred = KeychainStore.loadString(service: service, account: preferredAccount)
        let priorLast = KeychainStore.loadString(service: service, account: lastAccount)
        defer {
            if let priorPreferred {
                _ = KeychainStore.saveString(priorPreferred, service: service, account: preferredAccount)
            } else {
                _ = KeychainStore.delete(service: service, account: preferredAccount)
            }
            if let priorLast {
                _ = KeychainStore.saveString(priorLast, service: service, account: lastAccount)
            } else {
                _ = KeychainStore.delete(service: service, account: lastAccount)
            }
        }
        let forgottenID = "bonjour|forgotten"
        let keptID = "bonjour|kept"
        _ = KeychainStore.saveString(forgottenID, service: service, account: preferredAccount)
        _ = KeychainStore.saveString(keptID, service: service, account: lastAccount)

        withUserDefaults([
            "gateway.preferredStableID": forgottenID,
            "gateway.lastDiscoveredStableID": keptID,
        ]) {
            let appModel = NodeAppModel()
            defer { appModel.disconnectGateway() }
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            controller.forgetGateway(stableID: forgottenID)

            let defaults = UserDefaults.standard
            #expect(defaults.object(forKey: "gateway.preferredStableID") == nil)
            #expect(defaults.string(forKey: "gateway.lastDiscoveredStableID") == keptID)
            #expect(KeychainStore.loadString(service: service, account: preferredAccount) == nil)
            #expect(KeychainStore.loadString(service: service, account: lastAccount) == keptID)
        }
    }

    @Test @MainActor func `forget gateway cancels its pending trust handoff`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let service = GatewaySettingsStore._testGatewayService
        let account = "gateway-registry"
        let prior = KeychainStore.loadString(service: service, account: account)
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: service, account: account)
            } else {
                _ = KeychainStore.delete(service: service, account: account)
            }
        }
        _ = KeychainStore.delete(service: service, account: account)
        let host = "pending-trust.example.com"
        let port = 443
        let stableID = GatewayConnectionController.ManualAuthOverride.manualStableID(host: host, port: port)
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.clearFingerprint(stableID: stableID)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("forgotten-fingerprint") })

        await controller.connectManual(host: host, port: port, useTLS: true)
        #expect(controller.pendingTrustPrompt?.stableID == stableID)
        controller.forgetGateway(stableID: stableID)
        await controller.acceptPendingTrustPrompt()

        #expect(controller.pendingTrustPrompt == nil)
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == nil)
        #expect(!GatewaySettingsStore.loadGatewayRegistry().entries.contains { $0.stableID == stableID })
    }

    @Test @MainActor func `forget gateway preserves another gateway pending trust handoff`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let pendingHost = "pending-kept.example.com"
        let pendingID = GatewayConnectionController.ManualAuthOverride.manualStableID(
            host: pendingHost,
            port: 443)
        defer { GatewayTLSStore.clearFingerprint(stableID: pendingID) }
        GatewayTLSStore.clearFingerprint(stableID: pendingID)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("kept-fingerprint") })

        await controller.connectManual(host: pendingHost, port: 443, useTLS: true)
        #expect(controller.pendingTrustPrompt?.stableID == pendingID)
        controller.forgetGateway(stableID: "bonjour|unrelated-forgotten")

        #expect(controller.pendingTrustPrompt?.stableID == pendingID)
    }

    @Test @MainActor func `forget live gateway preserves replacement pending trust generation`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let connectedID = "manual|connected-before-forget.example.com|443"
        let replacementHost = "replacement-after-forget.example.com"
        let replacementID = GatewayConnectionController.ManualAuthOverride.manualStableID(
            host: replacementHost,
            port: 443)
        defer { GatewayTLSStore.clearFingerprint(stableID: replacementID) }
        GatewayTLSStore.clearFingerprint(stableID: replacementID)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        try appModel.applyGatewayConnectConfig(Self.makeGatewayConnectConfig(
            url: #require(URL(string: "wss://connected-before-forget.example.com")),
            stableID: connectedID))
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("replacement-fingerprint") })

        await controller.connectManual(host: replacementHost, port: 443, useTLS: true)
        #expect(controller.pendingTrustPrompt?.stableID == replacementID)
        controller.forgetGateway(stableID: connectedID)
        await controller.acceptPendingTrustPrompt()
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while appModel.activeGatewayConnectConfig?.effectiveStableID != replacementID,
              ContinuousClock().now < deadline
        {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(appModel.activeGatewayConnectConfig?.effectiveStableID == replacementID)
    }

    @Test @MainActor func `stale cancellation lease cannot release newer suppression`() {
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        let staleLease = controller.cancelPendingConnectionAttempts()
        let currentLease = controller.cancelPendingConnectionAttempts()

        controller.resumeAutoConnect(after: staleLease)
        #expect(controller._test_isAutoConnectSuppressed())

        controller.resumeAutoConnect(after: currentLease)
        #expect(!controller._test_isAutoConnectSuppressed())
    }

    @Test @MainActor func `cancellation lease restores previous auto connect state`() {
        withUserDefaults([
            "gateway.autoconnect": true,
            "gateway.manual.enabled": false,
            "gateway.preferredStableID": nil,
            "gateway.lastDiscoveredStableID": nil,
        ]) {
            let appModel = NodeAppModel()
            appModel.gatewayAutoReconnectEnabled = true
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let scannerLease = controller.cancelPendingConnectionAttempts(suspendCurrentGateway: true)

            #expect(!appModel.gatewayAutoReconnectEnabled)
            #expect(UserDefaults.standard.bool(forKey: "gateway.autoconnect"))

            let replacementLease = controller.cancelPendingConnectionAttempts()
            controller.resumeAutoConnect(after: scannerLease)
            #expect(!appModel.gatewayAutoReconnectEnabled)

            controller.resumeAutoConnect(after: replacementLease)
            #expect(appModel.gatewayAutoReconnectEnabled)
            #expect(UserDefaults.standard.bool(forKey: "gateway.autoconnect"))
        }
    }

    @Test @MainActor func `completed target switch does not restore auto connect state`() {
        withUserDefaults(["gateway.autoconnect": true]) {
            let appModel = NodeAppModel()
            appModel.gatewayAutoReconnectEnabled = true
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let lease = controller.cancelPendingConnectionAttempts(suspendCurrentGateway: true)

            controller.releaseAutoConnectSuppression(after: lease)

            #expect(!controller._test_isAutoConnectSuppressed())
            #expect(!appModel.gatewayAutoReconnectEnabled)
            #expect(UserDefaults.standard.bool(forKey: "gateway.autoconnect"))
        }
    }

    @Test @MainActor func `auto connect choice made during target review wins`() throws {
        try withUserDefaults(["gateway.autoconnect": true]) {
            let appModel = NodeAppModel()
            defer { appModel.disconnectGateway() }
            let suspendedConfig = try Self.makeGatewayConnectConfig(
                url: #require(URL(string: "wss://127.0.0.1:1")),
                stableID: "manual|127.0.0.1|1")
            appModel.applyGatewayConnectConfig(suspendedConfig)
            appModel.gatewayAutoReconnectEnabled = true
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let lease = controller.cancelPendingConnectionAttempts(suspendCurrentGateway: true)

            UserDefaults.standard.set(false, forKey: "gateway.autoconnect")
            controller.resumeAutoConnect(after: lease)

            #expect(!appModel.gatewayAutoReconnectEnabled)
            #expect(appModel.activeGatewayConnectConfig == nil)
            #expect(!UserDefaults.standard.bool(forKey: "gateway.autoconnect"))
        }
    }

    @Test @MainActor func `failed replacement restores inherited scanner reconnect state`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let defaults = UserDefaults.standard
        let updates: [String: Any?] = [
            "gateway.autoconnect": true,
            "gateway.manual.enabled": false,
            "node.instanceId": "ios-test",
            "gateway.preferredStableID": nil,
            "gateway.lastDiscoveredStableID": nil,
        ]
        var snapshot: [String: Any?] = [:]
        for key in updates.keys {
            snapshot[key] = defaults.object(forKey: key)
        }
        for (key, value) in updates {
            if let value {
                defaults.set(value, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
        defer {
            for (key, value) in snapshot {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let suspendedConfig = try Self.makeGatewayConnectConfig(
            url: #require(URL(string: "ws://127.0.0.1:1")),
            stableID: "manual|127.0.0.1|1")
        appModel.applyGatewayConnectConfig(suspendedConfig)
        appModel.gatewayAutoReconnectEnabled = true
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        _ = controller.cancelPendingConnectionAttempts(suspendCurrentGateway: true)

        await controller.connectManual(host: "invalid.example.com", port: 70000, useTLS: true)

        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: suspendedConfig) != true,
              ContinuousClock().now < deadline
        {
            await Task.yield()
        }
        #expect(!controller._test_isAutoConnectSuppressed())
        #expect(appModel.gatewayAutoReconnectEnabled)
        #expect(appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: suspendedConfig) == true)
        #expect(defaults.bool(forKey: "gateway.autoconnect"))
    }

    @Test @MainActor func `foreground reconnect cannot replace queued explicit handoff`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let defaults = UserDefaults.standard
        let updates: [String: Any?] = [
            "gateway.autoconnect": false,
            "gateway.manual.enabled": true,
            "gateway.manual.host": "192.168.1.20",
            "gateway.manual.port": 18789,
            "gateway.manual.tls": false,
            "node.instanceId": "ios-test",
        ]
        var snapshot: [String: Any?] = [:]
        for key in updates.keys {
            snapshot[key] = defaults.object(forKey: key)
        }
        for (key, value) in updates {
            defaults.set(value, forKey: key)
        }
        defer {
            for (key, value) in snapshot {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }

        let resetRelease = AsyncStream<Void>.makeStream()
        let appModel = NodeAppModel()
        defer {
            resetRelease.continuation.finish()
            appModel._test_setGatewaySessionResetTask(nil)
            appModel.disconnectGateway()
        }
        let modelResetTask = Task {
            for await _ in resetRelease.stream {
                return
            }
        }
        appModel._test_setGatewaySessionResetTask(modelResetTask)
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        defaults.set(true, forKey: "gateway.autoconnect")

        let explicitStableID = "manual|192.168.1.41|18789"
        await controller.connectManual(host: "192.168.1.41", port: 18789, useTLS: false)
        #expect(appModel.activeGatewayConnectConfig == nil)

        controller._test_triggerAutoReconnect()
        for _ in 0..<10 {
            await Task.yield()
        }
        #expect(controller._test_didAutoConnect())
        #expect(appModel.activeGatewayConnectConfig == nil)

        resetRelease.continuation.yield()
        resetRelease.continuation.finish()
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while appModel.activeGatewayConnectConfig?.stableID != explicitStableID,
              ContinuousClock().now < deadline
        {
            await Task.yield()
        }

        #expect(appModel.activeGatewayConnectConfig?.stableID == explicitStableID)
        controller._test_triggerAutoConnect()
        #expect(controller._test_didAutoConnect())
        #expect(appModel.activeGatewayConnectConfig?.stableID == explicitStableID)
    }

    @Test @MainActor func `clearing trust prompt invalidates in flight probe`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let probeStarted = AsyncStream<Void>.makeStream()
        let probeResults = AsyncStream<GatewayTLSFingerprintProbeResult>.makeStream()
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in
                probeStarted.continuation.yield()
                for await result in probeResults.stream {
                    return result
                }
                return .failure(.certificateUnavailable)
            })
        var startedIterator = probeStarted.stream.makeAsyncIterator()

        let connectTask = Task {
            await controller.connectManual(host: "trust-probe-cancel.invalid", port: 443, useTLS: true)
        }
        _ = await startedIterator.next()
        controller.clearPendingTrustPrompt()
        probeResults.continuation.yield(.fingerprint("stale-fingerprint"))
        probeResults.continuation.finish()
        await connectTask.value

        #expect(controller.pendingTrustPrompt == nil)
    }

    @Test @MainActor func `foreground stale connection restart reapplies active gateway config`() async {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }

        let config = Self.makeGatewayConnectConfig()
        let focusedSessionKey = "agent:main:ios-foreground-focused"
        appModel.applyGatewayConnectConfig(config)
        appModel.focusChatSession(focusedSessionKey)
        await appModel._test_restartGatewaySessionsAfterForegroundStaleConnection()

        #expect(appModel.gatewayStatusText == "Reconnecting…")
        #expect(appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: config) == true)
        #expect(appModel.chatSessionKey == focusedSessionKey)
        #expect(appModel._test_hasGatewayLoopTasks().node)
        #expect(appModel._test_hasGatewayLoopTasks().operator)
    }

    @Test @MainActor func `switch to manual gateway applies its stable I D and URL`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let service = GatewaySettingsStore._testGatewayService
        let account = "gateway-registry"
        let prior = KeychainStore.loadString(service: service, account: account)
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: service, account: account)
            } else {
                _ = KeychainStore.delete(service: service, account: account)
            }
        }
        _ = KeychainStore.delete(service: service, account: account)
        let stableID = "manual|127.0.0.1|1"
        saveActiveManualGateway(host: "127.0.0.1", port: 1, useTLS: false, stableID: stableID)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            forceReconnectReset: { _ in })

        let failure = await controller.switchToGateway(stableID: stableID)
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while appModel.activeGatewayConnectConfig == nil, ContinuousClock().now < deadline {
            await Task.yield()
        }

        #expect(failure == nil)
        #expect(appModel.activeGatewayConnectConfig?.effectiveStableID == stableID)
        #expect(appModel.activeGatewayConnectConfig?.url == URL(string: "ws://127.0.0.1:1"))
        #expect(GatewaySettingsStore.activeGatewayEntry()?.stableID == stableID)
    }

    @Test @MainActor func `switch to undiscoverable gateway returns failure without changing active gateway`() async {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let service = GatewaySettingsStore._testGatewayService
        let account = "gateway-registry"
        let prior = KeychainStore.loadString(service: service, account: account)
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: service, account: account)
            } else {
                _ = KeychainStore.delete(service: service, account: account)
            }
        }
        _ = KeychainStore.delete(service: service, account: account)
        let activeID = "manual|127.0.0.1|1"
        let discoveredID = "bonjour|missing"
        saveActiveManualGateway(host: "127.0.0.1", port: 1, useTLS: false, stableID: activeID)
        _ = GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
            stableID: discoveredID,
            kind: .discovered,
            name: "Kitchen Gateway",
            host: nil,
            port: nil,
            useTLS: true,
            lastConnectedAtMs: nil))
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        let failure = await controller.switchToGateway(stableID: discoveredID)

        #expect(failure == "Kitchen Gateway is not currently discoverable on this network.")
        #expect(GatewaySettingsStore.activeGatewayEntry()?.stableID == activeID)
        #expect(appModel.activeGatewayConnectConfig == nil)
    }

    @Test @MainActor func `chat cache remains isolated when active gateway switches`() async throws {
        let registryIsolation = GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let service = GatewaySettingsStore._testGatewayService
        let account = "gateway-registry"
        let prior = KeychainStore.loadString(service: service, account: account)
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: service, account: account)
            } else {
                _ = KeychainStore.delete(service: service, account: account)
            }
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }
        _ = KeychainStore.delete(service: service, account: account)
        let gatewayA = "manual|gateway-a|18789"
        let gatewayB = "manual|gateway-b|18789"
        saveActiveManualGateway(host: "gateway-a", port: 18789, useTLS: false, stableID: gatewayA)
        _ = GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
            stableID: gatewayB,
            kind: .manual,
            name: "Gateway B",
            host: "gateway-b",
            port: 18789,
            useTLS: false,
            lastConnectedAtMs: nil))
        let appModel = NodeAppModel()
        let session = OpenClawChatSessionEntry(
            key: "agent:main:a",
            kind: nil,
            displayName: "Gateway A session",
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: 1,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil)

        await appModel.storeCachedChatSessions([session])
        _ = GatewaySettingsStore.setActiveGateway(stableID: gatewayB)
        #expect(await appModel.loadCachedChatSessions().isEmpty)
        _ = GatewaySettingsStore.setActiveGateway(stableID: gatewayA)
        #expect(await appModel.loadCachedChatSessions() == [session])
    }

    private static func makeGatewayConnectConfig(
        // Fail locally instead of making lifecycle tests depend on DNS or external network timing.
        url: URL = URL(string: "wss://127.0.0.1:1")!,
        stableID: String = "manual|gateway.example.com|443") -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url,
            stableID: stableID,
            tls: GatewayTLSParams(
                required: true,
                expectedFingerprint: "abc",
                allowTOFU: false,
                storeKey: stableID),
            token: "token",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: ["screen", "canvas"],
                commands: ["notify", "location.get"],
                permissions: ["screen": true],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone"))
    }
}
