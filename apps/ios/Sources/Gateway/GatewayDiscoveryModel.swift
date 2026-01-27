import MoltbotKit
import Foundation
import Network
import Observation

@MainActor
@Observable
final class GatewayDiscoveryModel {
    struct DebugLogEntry: Identifiable, Equatable {
        var id = UUID()
        var ts: Date
        var message: String
    }

    struct DiscoveredGateway: Identifiable, Equatable {
        var id: String { self.stableID }
        var name: String
        var endpoint: NWEndpoint
        var stableID: String
        var debugID: String
        var lanHost: String?
        var tailnetDns: String?
        var gatewayPort: Int?
        var canvasPort: Int?
        var tlsEnabled: Bool
        var tlsFingerprintSha256: String?
        var cliPath: String?
    }

    var gateways: [DiscoveredGateway] = []
    var statusText: String = "Idle"
    private(set) var debugLog: [DebugLogEntry] = []

    private var browsers: [String: NWBrowser] = [:]
    private var gatewaysByDomain: [String: [DiscoveredGateway]] = [:]
    private var statesByDomain: [String: NWBrowser.State] = [:]
    private var debugLoggingEnabled = false
    private var lastStableIDs = Set<String>()

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
        if !self.browsers.isEmpty { return }
        self.appendDebugLog("start()")

        for domain in MoltbotBonjour.gatewayServiceDomains {
            let params = NWParameters.tcp
            params.includePeerToPeer = true
            let browser = NWBrowser(
                for: .bonjour(type: MoltbotBonjour.gatewayServiceType, domain: domain),
                using: params)

            browser.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self else { return }
                    self.statesByDomain[domain] = state
                    self.updateStatusText()
                    self.appendDebugLog("state[\(domain)]: \(Self.prettyState(state))")
                }
            }

            browser.browseResultsChangedHandler = { [weak self] results, _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.gatewaysByDomain[domain] = results.compactMap { result -> DiscoveredGateway? in
                        switch result.endpoint {
                        case let .service(name, _, _, _):
                            let decodedName = BonjourEscapes.decode(name)
                            let txt = result.endpoint.txtRecord?.dictionary ?? [:]
                            let advertisedName = txt["displayName"]
                            let prettyAdvertised = advertisedName
                                .map(Self.prettifyInstanceName)
                                .flatMap { $0.isEmpty ? nil : $0 }
                            let prettyName = prettyAdvertised ?? Self.prettifyInstanceName(decodedName)
                            return DiscoveredGateway(
                                name: prettyName,
                                endpoint: result.endpoint,
                                stableID: GatewayEndpointID.stableID(result.endpoint),
                                debugID: GatewayEndpointID.prettyDescription(result.endpoint),
                                lanHost: Self.txtValue(txt, key: "lanHost"),
                                tailnetDns: Self.txtValue(txt, key: "tailnetDns"),
                                gatewayPort: Self.txtIntValue(txt, key: "gatewayPort"),
                                canvasPort: Self.txtIntValue(txt, key: "canvasPort"),
                                tlsEnabled: Self.txtBoolValue(txt, key: "gatewayTls"),
                                tlsFingerprintSha256: Self.txtValue(txt, key: "gatewayTlsSha256"),
                                cliPath: Self.txtValue(txt, key: "cliPath"))
                        default:
                            return nil
                        }
                    }
                    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

                    self.recomputeGateways()
                }
            }

            self.browsers[domain] = browser
            browser.start(queue: DispatchQueue(label: "com.clawdbot.ios.gateway-discovery.\(domain)"))
        }
    }

    func stop() {
        self.appendDebugLog("stop()")
        for browser in self.browsers.values {
            browser.cancel()
        }
        self.browsers = [:]
        self.gatewaysByDomain = [:]
        self.statesByDomain = [:]
        self.gateways = []
        self.statusText = "Stopped"
    }

    private func recomputeGateways() {
        let next = self.gatewaysByDomain.values
            .flatMap(\.self)
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

        let nextIDs = Set(next.map(\.stableID))
        let added = nextIDs.subtracting(self.lastStableIDs)
        let removed = self.lastStableIDs.subtracting(nextIDs)
        if !added.isEmpty || !removed.isEmpty {
            self.appendDebugLog("results: total=\(next.count) added=\(added.count) removed=\(removed.count)")
        }
        self.lastStableIDs = nextIDs
        self.gateways = next
    }

    private func updateStatusText() {
        let states = Array(self.statesByDomain.values)
        if states.isEmpty {
            self.statusText = self.browsers.isEmpty ? "Idle" : "Setup"
            return
        }

        if let failed = states.first(where: { state in
            if case .failed = state { return true }
            return false
        }) {
            if case let .failed(err) = failed {
                self.statusText = "Failed: \(err)"
                return
            }
        }

        if let waiting = states.first(where: { state in
            if case .waiting = state { return true }
            return false
        }) {
            if case let .waiting(err) = waiting {
                self.statusText = "Waiting: \(err)"
                return
            }
        }

        if states.contains(where: { if case .ready = $0 { true } else { false } }) {
            self.statusText = "Searching…"
            return
        }

        if states.contains(where: { if case .setup = $0 { true } else { false } }) {
            self.statusText = "Setup"
            return
        }

        self.statusText = "Searching…"
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

    private static func prettifyInstanceName(_ decodedName: String) -> String {
        let normalized = decodedName.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let stripped = normalized.replacingOccurrences(of: " (Moltbot)", with: "")
            .replacingOccurrences(of: #"\s+\(\d+\)$"#, with: "", options: .regularExpression)
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func txtValue(_ dict: [String: String], key: String) -> String? {
        let raw = dict[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    private static func txtIntValue(_ dict: [String: String], key: String) -> Int? {
        guard let raw = self.txtValue(dict, key: key) else { return nil }
        return Int(raw)
    }

    private static func txtBoolValue(_ dict: [String: String], key: String) -> Bool {
        guard let raw = self.txtValue(dict, key: key)?.lowercased() else { return false }
        return raw == "1" || raw == "true" || raw == "yes"
    }
}
