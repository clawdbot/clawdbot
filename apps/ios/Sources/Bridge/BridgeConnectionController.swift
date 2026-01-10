import ClawdbotKit
import Darwin
import Foundation
import Network
import Observation
import SwiftUI
import UIKit

protocol BridgePairingClient: Sendable {
    func pairAndHello(
        endpoint: NWEndpoint,
        hello: BridgeHello,
        onStatus: (@Sendable (String) -> Void)?) async throws -> String
}

extension BridgeClient: BridgePairingClient {}

@MainActor
@Observable
final class BridgeConnectionController {
    private(set) var bridges: [BridgeDiscoveryModel.DiscoveredBridge] = []
    private(set) var discoveryStatusText: String = "Idle"
    private(set) var discoveryDebugLog: [BridgeDiscoveryModel.DebugLogEntry] = []

    private let discovery = BridgeDiscoveryModel()
    private weak var appModel: NodeAppModel?
    private var didAutoConnect = false

    private let bridgeClientFactory: @Sendable () -> any BridgePairingClient

    init(
        appModel: NodeAppModel,
        startDiscovery: Bool = true,
        bridgeClientFactory: @escaping @Sendable () -> any BridgePairingClient = { BridgeClient() })
    {
        self.appModel = appModel
        self.bridgeClientFactory = bridgeClientFactory

        BridgeSettingsStore.bootstrapPersistence()
        let defaults = UserDefaults.standard
        self.discovery.setDebugLoggingEnabled(defaults.bool(forKey: "bridge.discovery.debugLogs"))

        self.updateFromDiscovery()
        self.observeDiscovery()

        if startDiscovery {
            self.discovery.start()
        }
    }

    func setDiscoveryDebugLoggingEnabled(_ enabled: Bool) {
        self.discovery.setDebugLoggingEnabled(enabled)
    }

    func setScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background:
            self.discovery.stop()
        case .active, .inactive:
            self.discovery.start()
        @unknown default:
            self.discovery.start()
        }
    }

    private func updateFromDiscovery() {
        let newBridges = self.discovery.bridges
        self.bridges = newBridges
        self.discoveryStatusText = self.discovery.statusText
        self.discoveryDebugLog = self.discovery.debugLog
        self.updateLastDiscoveredBridge(from: newBridges)
        self.maybeAutoConnect()
    }

    private func observeDiscovery() {
        withObservationTracking {
            _ = self.discovery.bridges
            _ = self.discovery.statusText
            _ = self.discovery.debugLog
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.updateFromDiscovery()
                self.observeDiscovery()
            }
        }
    }

    private func maybeAutoConnect() {
        guard !self.didAutoConnect else { return }
        guard let appModel = self.appModel else { return }
        guard appModel.bridgeServerName == nil else { return }

        let defaults = UserDefaults.standard
        let manualEnabled = defaults.bool(forKey: "bridge.manual.enabled")

        let instanceId = defaults.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !instanceId.isEmpty else { return }

        let token = KeychainStore.loadString(
            service: "com.clawdbot.bridge",
            account: self.keychainAccount(instanceId: instanceId))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !token.isEmpty else { return }

        if manualEnabled {
            let manualHost = defaults.string(forKey: "bridge.manual.host")?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !manualHost.isEmpty else { return }

            let manualPort = defaults.integer(forKey: "bridge.manual.port")
            let resolvedPort = manualPort > 0 ? manualPort : 18790
            guard let port = NWEndpoint.Port(rawValue: UInt16(resolvedPort)) else { return }

            self.didAutoConnect = true
            let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(manualHost), port: port)
            self.startAutoConnect(
                endpoint: endpoint,
                bridgeStableID: BridgeEndpointID.stableID(endpoint),
                token: token,
                instanceId: instanceId)
            return
        }

        let preferredStableID = defaults.string(forKey: "bridge.preferredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lastDiscoveredStableID = defaults.string(forKey: "bridge.lastDiscoveredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        let candidates = [preferredStableID, lastDiscoveredStableID].filter { !$0.isEmpty }
        guard let targetStableID = candidates.first(where: { id in
            self.bridges.contains(where: { $0.stableID == id })
        }) else { return }

        guard let target = self.bridges.first(where: { $0.stableID == targetStableID }) else { return }

        self.didAutoConnect = true
        self.startAutoConnect(
            endpoint: target.endpoint,
            bridgeStableID: target.stableID,
            token: token,
            instanceId: instanceId)
    }

    private func updateLastDiscoveredBridge(from bridges: [BridgeDiscoveryModel.DiscoveredBridge]) {
        let defaults = UserDefaults.standard
        let preferred = defaults.string(forKey: "bridge.preferredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let existingLast = defaults.string(forKey: "bridge.lastDiscoveredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        // Avoid overriding user intent (preferred/lastDiscovered are also set on manual Connect).
        guard preferred.isEmpty, existingLast.isEmpty else { return }
        guard let first = bridges.first else { return }

        defaults.set(first.stableID, forKey: "bridge.lastDiscoveredStableID")
        BridgeSettingsStore.saveLastDiscoveredBridgeStableID(first.stableID)
    }

    private func makeHello(token: String) -> BridgeHello {
        let defaults = UserDefaults.standard
        let nodeId = defaults.string(forKey: "node.instanceId") ?? "ios-node"
        let displayName = self.resolvedDisplayName(defaults: defaults)

        return BridgeHello(
            nodeId: nodeId,
            displayName: displayName,
            token: token,
            platform: self.platformString(),
            version: self.appVersion(),
            deviceFamily: self.deviceFamily(),
            modelIdentifier: self.modelIdentifier(),
            caps: self.currentCaps(),
            commands: self.currentCommands())
    }

    private func keychainAccount(instanceId: String) -> String {
        "bridge-token.\(instanceId)"
    }

    private func startAutoConnect(
        endpoint: NWEndpoint,
        bridgeStableID: String,
        token: String,
        instanceId: String)
    {
        guard let appModel else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let hello = self.makeHello(token: token)
                let refreshed = try await self.bridgeClientFactory().pairAndHello(
                    endpoint: endpoint,
                    hello: hello,
                    onStatus: { status in
                        Task { @MainActor in
                            appModel.bridgeStatusText = status
                        }
                    })
                let resolvedToken = refreshed.isEmpty ? token : refreshed
                if !refreshed.isEmpty, refreshed != token {
                    _ = KeychainStore.saveString(
                        refreshed,
                        service: "com.clawdbot.bridge",
                        account: self.keychainAccount(instanceId: instanceId))
                }
                appModel.connectToBridge(
                    endpoint: endpoint,
                    bridgeStableID: bridgeStableID,
                    hello: self.makeHello(token: resolvedToken))
            } catch {
                await MainActor.run {
                    appModel.bridgeStatusText = "Bridge error: \(error.localizedDescription)"
                }
            }
        }
    }

    private func resolvedDisplayName(defaults: UserDefaults) -> String {
        let key = "node.displayName"
        let existing = defaults.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !existing.isEmpty, existing != "iOS Node" { return existing }

        let deviceName = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = deviceName.isEmpty ? "iOS Node" : deviceName

        if existing.isEmpty || existing == "iOS Node" {
            defaults.set(candidate, forKey: key)
        }

        return candidate
    }

    private func currentCaps() -> [String] {
        var caps = [ClawdbotCapability.canvas.rawValue, ClawdbotCapability.screen.rawValue]

        // Default-on: if the key doesn't exist yet, treat it as enabled.
        let cameraEnabled =
            UserDefaults.standard.object(forKey: "camera.enabled") == nil
                ? true
                : UserDefaults.standard.bool(forKey: "camera.enabled")
        if cameraEnabled { caps.append(ClawdbotCapability.camera.rawValue) }

        let voiceWakeEnabled = UserDefaults.standard.bool(forKey: VoiceWakePreferences.enabledKey)
        if voiceWakeEnabled { caps.append(ClawdbotCapability.voiceWake.rawValue) }

        let locationModeRaw = UserDefaults.standard.string(forKey: "location.enabledMode") ?? "off"
        let locationMode = ClawdbotLocationMode(rawValue: locationModeRaw) ?? .off
        if locationMode != .off { caps.append(ClawdbotCapability.location.rawValue) }

        return caps
    }

    private func currentCommands() -> [String] {
        var commands: [String] = [
            ClawdbotCanvasCommand.present.rawValue,
            ClawdbotCanvasCommand.hide.rawValue,
            ClawdbotCanvasCommand.navigate.rawValue,
            ClawdbotCanvasCommand.evalJS.rawValue,
            ClawdbotCanvasCommand.snapshot.rawValue,
            ClawdbotCanvasA2UICommand.push.rawValue,
            ClawdbotCanvasA2UICommand.pushJSONL.rawValue,
            ClawdbotCanvasA2UICommand.reset.rawValue,
            ClawdbotScreenCommand.record.rawValue,
        ]

        let caps = Set(self.currentCaps())
        if caps.contains(ClawdbotCapability.camera.rawValue) {
            commands.append(ClawdbotCameraCommand.list.rawValue)
            commands.append(ClawdbotCameraCommand.snap.rawValue)
            commands.append(ClawdbotCameraCommand.clip.rawValue)
        }
        if caps.contains(ClawdbotCapability.location.rawValue) {
            commands.append(ClawdbotLocationCommand.get.rawValue)
        }

        return commands
    }

    private func platformString() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let name = switch UIDevice.current.userInterfaceIdiom {
        case .pad:
            "iPadOS"
        case .phone:
            "iOS"
        default:
            "iOS"
        }
        return "\(name) \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    private func deviceFamily() -> String {
        switch UIDevice.current.userInterfaceIdiom {
        case .pad:
            "iPad"
        case .phone:
            "iPhone"
        default:
            "iOS"
        }
    }

    private func modelIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafeBytes(of: &systemInfo.machine) { ptr in
            String(bytes: ptr.prefix { $0 != 0 }, encoding: .utf8)
        }
        let trimmed = machine?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "unknown" : trimmed
    }

    private func appVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }
}

#if DEBUG
extension BridgeConnectionController {
    func _test_makeHello(token: String) -> BridgeHello {
        self.makeHello(token: token)
    }

    func _test_resolvedDisplayName(defaults: UserDefaults) -> String {
        self.resolvedDisplayName(defaults: defaults)
    }

    func _test_currentCaps() -> [String] {
        self.currentCaps()
    }

    func _test_currentCommands() -> [String] {
        self.currentCommands()
    }

    func _test_platformString() -> String {
        self.platformString()
    }

    func _test_deviceFamily() -> String {
        self.deviceFamily()
    }

    func _test_modelIdentifier() -> String {
        self.modelIdentifier()
    }

    func _test_appVersion() -> String {
        self.appVersion()
    }

    func _test_setBridges(_ bridges: [BridgeDiscoveryModel.DiscoveredBridge]) {
        self.bridges = bridges
    }

    func _test_triggerAutoConnect() {
        self.maybeAutoConnect()
    }
}
#endif
