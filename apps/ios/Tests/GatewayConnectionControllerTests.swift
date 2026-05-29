import Foundation
import OpenClawKit
import Testing
import UIKit
@testable import OpenClaw

@Suite(.serialized) struct GatewayConnectionControllerTests {
    @Test @MainActor func resolvedDisplayNameSetsDefaultWhenMissing() {
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

    @Test @MainActor func currentCapsReflectToggles() {
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
            #expect(caps.contains(OpenClawCapability.camera.rawValue))
            #expect(caps.contains(OpenClawCapability.location.rawValue))
            #expect(caps.contains(OpenClawCapability.voiceWake.rawValue))
            #expect(caps.contains(OpenClawCapability.talk.rawValue))
        }
    }

    @Test @MainActor func currentCommandsIncludeLocationWhenEnabled() {
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

    @Test @MainActor func locationPermissionRequiresGlobalServicesAndAppAuthorization() {
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

    @Test @MainActor func currentCommandsExcludeDangerousSystemExecCommands() {
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

    @Test @MainActor func operatorConnectOptionsOnlyRequestApprovalScopeWhenEnabled() {
        let appModel = NodeAppModel()
        let withoutApprovalScope = appModel._test_makeOperatorConnectOptions(
            clientId: "openclaw-ios",
            displayName: "OpenClaw iOS",
            includeApprovalScope: false)
        let withApprovalScope = appModel._test_makeOperatorConnectOptions(
            clientId: "openclaw-ios",
            displayName: "OpenClaw iOS",
            includeApprovalScope: true)

        #expect(withoutApprovalScope.role == "operator")
        #expect(withoutApprovalScope.scopes.contains("operator.read"))
        #expect(withoutApprovalScope.scopes.contains("operator.write"))
        #expect(!withoutApprovalScope.scopes.contains("operator.approvals"))
        #expect(withoutApprovalScope.scopes.contains("operator.talk.secrets"))
        #expect(!withoutApprovalScope.scopesAreExplicit)

        #expect(withApprovalScope.scopes.contains("operator.approvals"))
    }

    @Test @MainActor func operatorTalkPermissionUpgradeUsesExplicitScopes() {
        let appModel = NodeAppModel()
        let options = appModel._test_makeOperatorConnectOptions(
            clientId: "openclaw-ios",
            displayName: "OpenClaw iOS",
            includeApprovalScope: false,
            forceExplicitScopes: true)

        #expect(options.scopesAreExplicit)
        #expect(options.scopes.contains("operator.read"))
        #expect(options.scopes.contains("operator.write"))
        #expect(options.scopes.contains("operator.talk.secrets"))
    }

    @Test func operatorApprovalScopeRequestsStayBackwardCompatible() {
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
    }

    @Test @MainActor func savedManualEndpointFallbackUsesOnboardingHostWhenAutoConnectIsEnabled() {
        withUserDefaults([
            "gateway.autoconnect": true,
            "gateway.manual.enabled": true,
            "gateway.manual.host": "forges-mac-mini.taila96df5.ts.net",
            "gateway.manual.port": 0,
            "gateway.manual.tls": false,
            "node.instanceId": "ios-test",
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let endpoint = controller._test_savedManualEndpointFallback()

            #expect(endpoint?.host == "forges-mac-mini.taila96df5.ts.net")
            #expect(endpoint?.port == 443)
            #expect(endpoint?.useTLS == true)
        }
    }

    @Test @MainActor func savedManualEndpointFallbackRequiresManualGatewayEnabled() {
        withUserDefaults([
            "gateway.autoconnect": true,
            "gateway.manual.enabled": false,
            "gateway.manual.host": "forges-mac-mini.taila96df5.ts.net",
            "gateway.manual.port": 443,
            "gateway.manual.tls": true,
            "node.instanceId": "ios-test",
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            #expect(controller._test_savedManualEndpointFallback() == nil)
        }
    }

    @Test @MainActor func savedManualEndpointFallbackRequiresAutoConnect() {
        withUserDefaults([
            "gateway.autoconnect": false,
            "gateway.manual.enabled": true,
            "gateway.manual.host": "forges-mac-mini.taila96df5.ts.net",
            "gateway.manual.port": 443,
            "gateway.manual.tls": true,
            "node.instanceId": "ios-test",
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            #expect(controller._test_savedManualEndpointFallback() == nil)
        }
    }

    @Test func gatewayConnectConfigMatchesEquivalentInputs() {
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

    @Test @MainActor func applyingDifferentGatewayConfigReconnectsActiveTasks() {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let first = Self.makeGatewayConnectConfig(
            url: URL(string: "wss://first.gateway.example.com")!,
            stableID: "manual|first.gateway.example.com|443")
        let second = Self.makeGatewayConnectConfig(
            url: URL(string: "wss://second.gateway.example.com")!,
            stableID: "manual|second.gateway.example.com|443")

        appModel.applyGatewayConnectConfig(first)
        appModel.applyGatewayConnectConfig(second)

        #expect(appModel.connectedGatewayID == second.stableID)
    }

    @Test @MainActor func loadLastConnectionReadsSavedValues() {
        let prior = KeychainStore.loadString(service: "ai.openclaw.gateway", account: "lastConnection")
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: "ai.openclaw.gateway", account: "lastConnection")
            } else {
                _ = KeychainStore.delete(service: "ai.openclaw.gateway", account: "lastConnection")
            }
        }
        _ = KeychainStore.delete(service: "ai.openclaw.gateway", account: "lastConnection")

        GatewaySettingsStore.saveLastGatewayConnectionManual(
            host: "gateway.example.com",
            port: 443,
            useTLS: true,
            stableID: "manual|gateway.example.com|443")
        let loaded = GatewaySettingsStore.loadLastGatewayConnection()
        #expect(loaded == .manual(
            host: "gateway.example.com",
            port: 443,
            useTLS: true,
            stableID: "manual|gateway.example.com|443"))
    }

    @Test @MainActor func loadLastConnectionReturnsNilForInvalidData() {
        let prior = KeychainStore.loadString(service: "ai.openclaw.gateway", account: "lastConnection")
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: "ai.openclaw.gateway", account: "lastConnection")
            } else {
                _ = KeychainStore.delete(service: "ai.openclaw.gateway", account: "lastConnection")
            }
        }
        _ = KeychainStore.delete(service: "ai.openclaw.gateway", account: "lastConnection")

        // Plant legacy UserDefaults with invalid host/port to exercise migration + validation.
        withUserDefaults([
            "gateway.last.kind": "manual",
            "gateway.last.host": "",
            "gateway.last.port": 0,
            "gateway.last.tls": false,
            "gateway.last.stableID": "manual|invalid|0",
        ]) {
            let loaded = GatewaySettingsStore.loadLastGatewayConnection()
            #expect(loaded == nil)
        }
    }

    private static func makeGatewayConnectConfig(
        url: URL = URL(string: "wss://gateway.example.com")!,
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
