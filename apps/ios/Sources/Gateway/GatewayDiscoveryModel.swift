import Foundation
import Network
import Observation
import OpenClawKit

@MainActor
@Observable
final class GatewayDiscoveryModel {
    struct DebugLogEntry: Identifiable, Equatable {
        var id = UUID()
        var ts: Date
        var message: String
    }

    struct DiscoveredGateway: Identifiable, Equatable {
        var id: GatewayStableIdentifier.Key {
            GatewayStableIdentifier.Key(self.stableID)
        }

        var name: String
        var endpoint: NWEndpoint
        var stableID: String
        var debugID: String
        var lanHost: String?
        var tailnetDns: String?
        var gatewayPort: Int?
        var tlsEnabled: Bool
        var tlsFingerprintSha256: String?
        var cliPath: String?

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.name == rhs.name &&
                lhs.endpoint == rhs.endpoint &&
                GatewayStableIdentifier.matches(lhs.stableID, rhs.stableID) &&
                lhs.debugID == rhs.debugID &&
                lhs.lanHost == rhs.lanHost &&
                lhs.tailnetDns == rhs.tailnetDns &&
                lhs.gatewayPort == rhs.gatewayPort &&
                lhs.tlsEnabled == rhs.tlsEnabled &&
                lhs.tlsFingerprintSha256 == rhs.tlsFingerprintSha256 &&
                lhs.cliPath == rhs.cliPath
        }
    }

    var gateways: [DiscoveredGateway] = []
    var statusText: String = GatewayDiscoveryStatusText.idle
    private(set) var debugLog: [DebugLogEntry] = []

    private let browserSession = GatewayDiscoveryBrowserSession()
    private var gatewaysByDomain: [String: [DiscoveredGateway]] = [:]
    private var debugLoggingEnabled = false
    private var lastStableIDs = Set<GatewayStableIdentifier.Key>()

    func setDebugLoggingEnabled(_ enabled: Bool) {
        let wasEnabled = self.debugLoggingEnabled
        self.debugLoggingEnabled = enabled
        if !enabled {
            self.debugLog = []
        } else if !wasEnabled {
            self.appendDebugLog("debug logging enabled")
            self.appendDebugLog("snapshot: status=\(self.statusText) gateways=\(self.gateways.count)")
        }
    }

    func start() {
        if self.browserSession.isRunning { return }
        self.appendDebugLog("start()")

        self.browserSession.start(
            queueLabelPrefix: "ai.openclawfoundation.app.gateway-discovery",
            onState: { [weak self] domain, state, status in
                guard let self else { return }
                self.statusText = status
                self.appendDebugLog("state[\(domain)]: \(Self.prettyState(state))")
            },
            onResults: { [weak self] domain, results in
                guard let self else { return }
                self.gatewaysByDomain[domain] = results.compactMap { result -> DiscoveredGateway? in
                    switch result.endpoint {
                    case let .service(name, _, _, _):
                        let decodedName = BonjourEscapes.decode(name)
                        let txt = result.endpoint.txtRecord?.dictionary ?? [:]
                        let advertisedName = txt["displayName"]
                        let prettyAdvertised = advertisedName
                            .map(GatewayDiscoveryText.prettifyInstanceName)
                            .flatMap { $0.isEmpty ? nil : $0 }
                        let prettyName = prettyAdvertised ?? GatewayDiscoveryText.prettifyInstanceName(decodedName)
                        return DiscoveredGateway(
                            name: prettyName,
                            endpoint: result.endpoint,
                            stableID: GatewayEndpointID.stableID(result.endpoint),
                            debugID: GatewayEndpointID.prettyDescription(result.endpoint),
                            lanHost: GatewayDiscoveryText.txtValue(txt, key: "lanHost"),
                            tailnetDns: GatewayDiscoveryText.txtValue(txt, key: "tailnetDns"),
                            gatewayPort: GatewayDiscoveryText.txtValue(txt, key: "gatewayPort").flatMap { Int($0) },
                            tlsEnabled: GatewayDiscoveryText.txtBoolValue(txt, key: "gatewayTls"),
                            tlsFingerprintSha256: GatewayDiscoveryText.txtValue(txt, key: "gatewayTlsSha256"),
                            cliPath: GatewayDiscoveryText.txtValue(txt, key: "cliPath"))
                    default:
                        return nil
                    }
                }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                self.recomputeGateways()
            })
    }

    func stop() {
        self.appendDebugLog("stop()")
        self.browserSession.stop()
        self.gatewaysByDomain = [:]
        self.gateways = []
        self.statusText = GatewayDiscoveryStatusText.stopped
    }

    private func recomputeGateways() {
        let next = self.gatewaysByDomain.values
            .flatMap(\.self)
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

        let nextIDs = Set(next.map { GatewayStableIdentifier.Key($0.stableID) })
        let added = nextIDs.subtracting(self.lastStableIDs)
        let removed = self.lastStableIDs.subtracting(nextIDs)
        if !added.isEmpty || !removed.isEmpty {
            self.appendDebugLog("results: total=\(next.count) added=\(added.count) removed=\(removed.count)")
        }
        self.lastStableIDs = nextIDs
        self.gateways = next
    }

    private static func prettyState(_ state: NWBrowser.State) -> String {
        switch state {
        case .setup:
            "setup"
        case .ready:
            "ready"
        case let .failed(err):
            "failed (\(err))"
        case .cancelled:
            "cancelled"
        case let .waiting(err):
            "waiting (\(err))"
        @unknown default:
            "unknown"
        }
    }

    private func appendDebugLog(_ message: String) {
        guard self.debugLoggingEnabled else { return }
        self.debugLog.append(DebugLogEntry(ts: Date(), message: message))
        if self.debugLog.count > 200 {
            self.debugLog.removeFirst(self.debugLog.count - 200)
        }
    }
}
