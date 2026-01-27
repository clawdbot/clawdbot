import MoltbotKit
import Foundation
import Network
import Observation
import OSLog

@MainActor
@Observable
public final class GatewayDiscoveryModel {
    public struct LocalIdentity: Equatable, Sendable {
        public var hostTokens: Set<String>
        public var displayTokens: Set<String>

        public init(hostTokens: Set<String>, displayTokens: Set<String>) {
            self.hostTokens = hostTokens
            self.displayTokens = displayTokens
        }
    }

    public struct DiscoveredGateway: Identifiable, Equatable, Sendable {
        public var id: String { self.stableID }
        public var displayName: String
        public var lanHost: String?
        public var tailnetDns: String?
        public var sshPort: Int
        public var gatewayPort: Int?
        public var cliPath: String?
        public var stableID: String
        public var debugID: String
        public var isLocal: Bool

        public init(
            displayName: String,
            lanHost: String? = nil,
            tailnetDns: String? = nil,
            sshPort: Int,
            gatewayPort: Int? = nil,
            cliPath: String? = nil,
            stableID: String,
            debugID: String,
            isLocal: Bool)
        {
            self.displayName = displayName
            self.lanHost = lanHost
            self.tailnetDns = tailnetDns
            self.sshPort = sshPort
            self.gatewayPort = gatewayPort
            self.cliPath = cliPath
            self.stableID = stableID
            self.debugID = debugID
            self.isLocal = isLocal
        }
    }

    public var gateways: [DiscoveredGateway] = []
    public var statusText: String = "Idle"

    private var browsers: [String: NWBrowser] = [:]
    private var resultsByDomain: [String: Set<NWBrowser.Result>] = [:]
    private var gatewaysByDomain: [String: [DiscoveredGateway]] = [:]
    private var statesByDomain: [String: NWBrowser.State] = [:]
    private var localIdentity: LocalIdentity
    private let localDisplayName: String?
    private let filterLocalGateways: Bool
    private var resolvedTXTByID: [String: [String: String]] = [:]
    private var pendingTXTResolvers: [String: GatewayTXTResolver] = [:]
    private var wideAreaFallbackTask: Task<Void, Never>?
    private var wideAreaFallbackGateways: [DiscoveredGateway] = []
    private let logger = Logger(subsystem: "com.clawdbot", category: "gateway-discovery")

    public init(
        localDisplayName: String? = nil,
        filterLocalGateways: Bool = true)
    {
        self.localDisplayName = localDisplayName
        self.filterLocalGateways = filterLocalGateways
        self.localIdentity = Self.buildLocalIdentityFast(displayName: localDisplayName)
        self.refreshLocalIdentity()
    }

    public func start() {
        if !self.browsers.isEmpty { return }

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
                }
            }

            browser.browseResultsChangedHandler = { [weak self] results, _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.resultsByDomain[domain] = results
                    self.updateGateways(for: domain)
                    self.recomputeGateways()
                }
            }

            self.browsers[domain] = browser
            browser.start(queue: DispatchQueue(label: "com.clawdbot.macos.gateway-discovery.\(domain)"))
        }

        self.scheduleWideAreaFallback()
    }

    public func refreshWideAreaFallbackNow(timeoutSeconds: TimeInterval = 5.0) {
        let domain = MoltbotBonjour.wideAreaGatewayServiceDomain
        Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            let beacons = WideAreaGatewayDiscovery.discover(timeoutSeconds: timeoutSeconds)
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.wideAreaFallbackGateways = self.mapWideAreaBeacons(beacons, domain: domain)
                self.recomputeGateways()
            }
        }
    }

    public func stop() {
        for browser in self.browsers.values {
            browser.cancel()
        }
        self.browsers = [:]
        self.resultsByDomain = [:]
        self.gatewaysByDomain = [:]
        self.statesByDomain = [:]
        self.resolvedTXTByID = [:]
        self.pendingTXTResolvers.values.forEach { $0.cancel() }
        self.pendingTXTResolvers = [:]
        self.wideAreaFallbackTask?.cancel()
        self.wideAreaFallbackTask = nil
        self.wideAreaFallbackGateways = []
        self.gateways = []
        self.statusText = "Stopped"
    }

    private func mapWideAreaBeacons(_ beacons: [WideAreaGatewayBeacon], domain: String) -> [DiscoveredGateway] {
        beacons.map { beacon in
            let stableID = "wide-area|\(domain)|\(beacon.instanceName)"
            let isLocal = Self.isLocalGateway(
                lanHost: beacon.lanHost,
                tailnetDns: beacon.tailnetDns,
                displayName: beacon.displayName,
                serviceName: beacon.instanceName,
                local: self.localIdentity)
            return DiscoveredGateway(
                displayName: beacon.displayName,
                lanHost: beacon.lanHost,
                tailnetDns: beacon.tailnetDns,
                sshPort: beacon.sshPort ?? 22,
                gatewayPort: beacon.gatewayPort,
                cliPath: beacon.cliPath,
                stableID: stableID,
                debugID: "\(beacon.instanceName)@\(beacon.host):\(beacon.port)",
                isLocal: isLocal)
        }
    }

    private func recomputeGateways() {
        let primary = self.sortedDeduped(gateways: self.gatewaysByDomain.values.flatMap(\.self))
        let primaryFiltered = self.filterLocalGateways ? primary.filter { !$0.isLocal } : primary
        if !primaryFiltered.isEmpty {
            self.gateways = primaryFiltered
            return
        }

        // Bonjour can return only "local" results for the wide-area domain (or no results at all),
        // which makes onboarding look empty even though Tailscale DNS-SD can already see gateways.
        guard !self.wideAreaFallbackGateways.isEmpty else {
            self.gateways = primaryFiltered
            return
        }

        let combined = self.sortedDeduped(gateways: primary + self.wideAreaFallbackGateways)
        self.gateways = self.filterLocalGateways ? combined.filter { !$0.isLocal } : combined
    }

    private func updateGateways(for domain: String) {
        guard let results = self.resultsByDomain[domain] else {
            self.gatewaysByDomain[domain] = []
            return
        }

        self.gatewaysByDomain[domain] = results.compactMap { result -> DiscoveredGateway? in
            guard case let .service(name, type, resultDomain, _) = result.endpoint else { return nil }

            let decodedName = BonjourEscapes.decode(name)
            let stableID = GatewayEndpointID.stableID(result.endpoint)
            let resolvedTXT = self.resolvedTXTByID[stableID] ?? [:]
            let txt = Self.txtDictionary(from: result).merging(
                resolvedTXT,
                uniquingKeysWith: { _, new in new })

            let advertisedName = txt["displayName"]
                .map(Self.prettifyInstanceName)
                .flatMap { $0.isEmpty ? nil : $0 }
            let prettyName =
                advertisedName ?? Self.prettifyServiceName(decodedName)

            let parsedTXT = Self.parseGatewayTXT(txt)

            if parsedTXT.lanHost == nil || parsedTXT.tailnetDns == nil {
                self.ensureTXTResolution(
                    stableID: stableID,
                    serviceName: name,
                    type: type,
                    domain: resultDomain)
            }

            let isLocal = Self.isLocalGateway(
                lanHost: parsedTXT.lanHost,
                tailnetDns: parsedTXT.tailnetDns,
                displayName: prettyName,
                serviceName: decodedName,
                local: self.localIdentity)
            return DiscoveredGateway(
                displayName: prettyName,
                lanHost: parsedTXT.lanHost,
                tailnetDns: parsedTXT.tailnetDns,
                sshPort: parsedTXT.sshPort,
                gatewayPort: parsedTXT.gatewayPort,
                cliPath: parsedTXT.cliPath,
                stableID: stableID,
                debugID: GatewayEndpointID.prettyDescription(result.endpoint),
                isLocal: isLocal)
        }
        .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }

        if domain == MoltbotBonjour.wideAreaGatewayServiceDomain,
           self.hasUsableWideAreaResults
        {
            self.wideAreaFallbackGateways = []
        }
    }

    private func scheduleWideAreaFallback() {
        let domain = MoltbotBonjour.wideAreaGatewayServiceDomain
        if Self.isRunningTests { return }
        guard self.wideAreaFallbackTask == nil else { return }
        self.wideAreaFallbackTask = Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            var attempt = 0
            let startedAt = Date()
            while !Task.isCancelled, Date().timeIntervalSince(startedAt) < 35.0 {
                let hasResults = await MainActor.run {
                    self.hasUsableWideAreaResults
                }
                if hasResults { return }

                // Wide-area discovery can be racy (Tailscale not yet up, DNS zone not
                // published yet). Retry with a short backoff while onboarding is open.
                let beacons = WideAreaGatewayDiscovery.discover(timeoutSeconds: 2.0)
                if !beacons.isEmpty {
                    await MainActor.run { [weak self] in
                        guard let self else { return }
                        self.wideAreaFallbackGateways = self.mapWideAreaBeacons(beacons, domain: domain)
                        self.recomputeGateways()
                    }
                    return
                }

                attempt += 1
                let backoff = min(8.0, 0.6 + (Double(attempt) * 0.7))
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            }
        }
    }

    private var hasUsableWideAreaResults: Bool {
        let domain = MoltbotBonjour.wideAreaGatewayServiceDomain
        guard let gateways = self.gatewaysByDomain[domain], !gateways.isEmpty else { return false }
        if !self.filterLocalGateways { return true }
        return gateways.contains(where: { !$0.isLocal })
    }

    private func sortedDeduped(gateways: [DiscoveredGateway]) -> [DiscoveredGateway] {
        var seen = Set<String>()
        let deduped = gateways.filter { gateway in
            if seen.contains(gateway.stableID) { return false }
            seen.insert(gateway.stableID)
            return true
        }
        return deduped.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    private nonisolated static var isRunningTests: Bool {
        // Keep discovery background work from running forever during SwiftPM test runs.
        if Bundle.allBundles.contains(where: { $0.bundleURL.pathExtension == "xctest" }) { return true }

        let env = ProcessInfo.processInfo.environment
        return env["XCTestConfigurationFilePath"] != nil
            || env["XCTestBundlePath"] != nil
            || env["XCTestSessionIdentifier"] != nil
    }

    private func updateGatewaysForAllDomains() {
        for domain in self.resultsByDomain.keys {
            self.updateGateways(for: domain)
        }
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

    private static func txtDictionary(from result: NWBrowser.Result) -> [String: String] {
        var merged: [String: String] = [:]

        if case let .bonjour(txt) = result.metadata {
            merged.merge(txt.dictionary, uniquingKeysWith: { _, new in new })
        }

        if let endpointTxt = result.endpoint.txtRecord?.dictionary {
            merged.merge(endpointTxt, uniquingKeysWith: { _, new in new })
        }

        return merged
    }

    public struct GatewayTXT: Equatable {
        public var lanHost: String?
        public var tailnetDns: String?
        public var sshPort: Int
        public var gatewayPort: Int?
        public var cliPath: String?
    }

    public static func parseGatewayTXT(_ txt: [String: String]) -> GatewayTXT {
        var lanHost: String?
        var tailnetDns: String?
        var sshPort = 22
        var gatewayPort: Int?
        var cliPath: String?

        if let value = txt["lanHost"] {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            lanHost = trimmed.isEmpty ? nil : trimmed
        }
        if let value = txt["tailnetDns"] {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            tailnetDns = trimmed.isEmpty ? nil : trimmed
        }
        if let value = txt["sshPort"],
           let parsed = Int(value.trimmingCharacters(in: .whitespacesAndNewlines)),
           parsed > 0
        {
            sshPort = parsed
        }
        if let value = txt["gatewayPort"],
           let parsed = Int(value.trimmingCharacters(in: .whitespacesAndNewlines)),
           parsed > 0
        {
            gatewayPort = parsed
        }
        if let value = txt["cliPath"] {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            cliPath = trimmed.isEmpty ? nil : trimmed
        }

        return GatewayTXT(
            lanHost: lanHost,
            tailnetDns: tailnetDns,
            sshPort: sshPort,
            gatewayPort: gatewayPort,
            cliPath: cliPath)
    }

    public static func buildSSHTarget(user: String, host: String, port: Int) -> String {
        var target = "\(user)@\(host)"
        if port != 22 {
            target += ":\(port)"
        }
        return target
    }

    private func ensureTXTResolution(
        stableID: String,
        serviceName: String,
        type: String,
        domain: String)
    {
        guard self.resolvedTXTByID[stableID] == nil else { return }
        guard self.pendingTXTResolvers[stableID] == nil else { return }

        let resolver = GatewayTXTResolver(
            name: serviceName,
            type: type,
            domain: domain,
            logger: self.logger)
        { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                self.pendingTXTResolvers[stableID] = nil
                switch result {
                case let .success(txt):
                    self.resolvedTXTByID[stableID] = txt
                    self.updateGatewaysForAllDomains()
                    self.recomputeGateways()
                case .failure:
                    break
                }
            }
        }

        self.pendingTXTResolvers[stableID] = resolver
        resolver.start()
    }

    private nonisolated static func prettifyInstanceName(_ decodedName: String) -> String {
        let normalized = decodedName.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let stripped = normalized.replacingOccurrences(of: " (Moltbot)", with: "")
            .replacingOccurrences(of: #"\s+\(\d+\)$"#, with: "", options: .regularExpression)
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private nonisolated static func prettifyServiceName(_ decodedName: String) -> String {
        let normalized = Self.prettifyInstanceName(decodedName)
        var cleaned = normalized.replacingOccurrences(of: #"\s*-?gateway$"#, with: "", options: .regularExpression)
        cleaned = cleaned
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty {
            cleaned = normalized
        }
        let words = cleaned.split(separator: " ")
        let titled = words.map { word -> String in
            let lower = word.lowercased()
            guard let first = lower.first else { return "" }
            return String(first).uppercased() + lower.dropFirst()
        }.joined(separator: " ")
        return titled.isEmpty ? normalized : titled
    }

    public nonisolated static func isLocalGateway(
        lanHost: String?,
        tailnetDns: String?,
        displayName: String?,
        serviceName: String?,
        local: LocalIdentity) -> Bool
    {
        if let host = normalizeHostToken(lanHost),
           local.hostTokens.contains(host)
        {
            return true
        }
        if let host = normalizeHostToken(tailnetDns),
           local.hostTokens.contains(host)
        {
            return true
        }
        if let name = normalizeDisplayToken(displayName),
           local.displayTokens.contains(name)
        {
            return true
        }
        if let serviceHost = normalizeServiceHostToken(serviceName),
           local.hostTokens.contains(serviceHost)
        {
            return true
        }
        return false
    }

    private func refreshLocalIdentity() {
        let fastIdentity = self.localIdentity
        let displayName = self.localDisplayName
        Task.detached(priority: .utility) {
            let slowIdentity = Self.buildLocalIdentitySlow(displayName: displayName)
            let merged = Self.mergeLocalIdentity(fast: fastIdentity, slow: slowIdentity)
            await MainActor.run { [weak self] in
                guard let self else { return }
                guard self.localIdentity != merged else { return }
                self.localIdentity = merged
                self.recomputeGateways()
            }
        }
    }

    private nonisolated static func mergeLocalIdentity(
        fast: LocalIdentity,
        slow: LocalIdentity) -> LocalIdentity
    {
        LocalIdentity(
            hostTokens: fast.hostTokens.union(slow.hostTokens),
            displayTokens: fast.displayTokens.union(slow.displayTokens))
    }

    private nonisolated static func buildLocalIdentityFast(displayName: String?) -> LocalIdentity {
        var hostTokens: Set<String> = []
        var displayTokens: Set<String> = []

        let hostName = ProcessInfo.processInfo.hostName
        if let token = normalizeHostToken(hostName) {
            hostTokens.insert(token)
        }

        if let token = normalizeDisplayToken(displayName) {
            displayTokens.insert(token)
        }

        return LocalIdentity(hostTokens: hostTokens, displayTokens: displayTokens)
    }

    private nonisolated static func buildLocalIdentitySlow(displayName: String?) -> LocalIdentity {
        var hostTokens: Set<String> = []
        var displayTokens: Set<String> = []

        if let host = Host.current().name,
           let token = normalizeHostToken(host)
        {
            hostTokens.insert(token)
        }

        if let token = normalizeDisplayToken(displayName) {
            displayTokens.insert(token)
        }

        if let token = normalizeDisplayToken(Host.current().localizedName) {
            displayTokens.insert(token)
        }

        return LocalIdentity(hostTokens: hostTokens, displayTokens: displayTokens)
    }

    private nonisolated static func normalizeHostToken(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let lower = trimmed.lowercased()
        let strippedTrailingDot = lower.hasSuffix(".")
            ? String(lower.dropLast())
            : lower
        let withoutLocal = strippedTrailingDot.hasSuffix(".local")
            ? String(strippedTrailingDot.dropLast(6))
            : strippedTrailingDot
        let firstLabel = withoutLocal.split(separator: ".").first.map(String.init)
        let token = (firstLabel ?? withoutLocal).trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    private nonisolated static func normalizeDisplayToken(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let prettified = Self.prettifyInstanceName(raw)
        let trimmed = prettified.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        return trimmed.lowercased()
    }

    private nonisolated static func normalizeServiceHostToken(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let prettified = Self.prettifyInstanceName(raw)
        let strippedGateway = prettified.replacingOccurrences(
            of: #"\s*-?\s*gateway$"#,
            with: "",
            options: .regularExpression)
        return self.normalizeHostToken(strippedGateway)
    }
}

final class GatewayTXTResolver: NSObject, NetServiceDelegate {
    private let service: NetService
    private let completion: (Result<[String: String], Error>) -> Void
    private let logger: Logger
    private var didFinish = false

    init(
        name: String,
        type: String,
        domain: String,
        logger: Logger,
        completion: @escaping (Result<[String: String], Error>) -> Void)
    {
        self.service = NetService(domain: domain, type: type, name: name)
        self.completion = completion
        self.logger = logger
        super.init()
        self.service.delegate = self
    }

    func start(timeout: TimeInterval = 2.0) {
        self.service.schedule(in: .main, forMode: .common)
        self.service.resolve(withTimeout: timeout)
    }

    func cancel() {
        self.finish(result: .failure(GatewayTXTResolverError.cancelled))
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let txt = Self.decodeTXT(sender.txtRecordData())
        if !txt.isEmpty {
            let payload = self.formatTXT(txt)
            self.logger.debug(
                "discovery: resolved TXT for \(sender.name, privacy: .public): \(payload, privacy: .public)")
        }
        self.finish(result: .success(txt))
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        self.finish(result: .failure(GatewayTXTResolverError.resolveFailed(errorDict)))
    }

    private func finish(result: Result<[String: String], Error>) {
        guard !self.didFinish else { return }
        self.didFinish = true
        self.service.stop()
        self.service.remove(from: .main, forMode: .common)
        self.completion(result)
    }

    private static func decodeTXT(_ data: Data?) -> [String: String] {
        guard let data else { return [:] }
        let dict = NetService.dictionary(fromTXTRecord: data)
        var out: [String: String] = [:]
        out.reserveCapacity(dict.count)
        for (key, value) in dict {
            if let str = String(data: value, encoding: .utf8) {
                out[key] = str
            }
        }
        return out
    }

    private func formatTXT(_ txt: [String: String]) -> String {
        txt.sorted(by: { $0.key < $1.key })
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: " ")
    }
}

enum GatewayTXTResolverError: Error {
    case cancelled
    case resolveFailed([String: NSNumber])
}
