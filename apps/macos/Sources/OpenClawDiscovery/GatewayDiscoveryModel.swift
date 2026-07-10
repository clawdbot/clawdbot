import Foundation
import Network
import Observation
import OpenClawKit
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
        public var id: String {
            self.stableID
        }

        public var displayName: String
        // Resolved service endpoint (SRV + A/AAAA). Used for routing; do not trust TXT for routing.
        public var serviceHost: String?
        public var servicePort: Int?
        public var lanHost: String?
        public var tailnetDns: String?
        public var sshPort: Int
        public var gatewayPort: Int?
        public var gatewayTls: Bool
        public var gatewayDirectReachable: Bool
        public var cliPath: String?
        public var stableID: String
        public var debugID: String
        public var isLocal: Bool

        public init(
            displayName: String,
            serviceHost: String? = nil,
            servicePort: Int? = nil,
            lanHost: String? = nil,
            tailnetDns: String? = nil,
            sshPort: Int,
            gatewayPort: Int? = nil,
            gatewayTls: Bool = false,
            gatewayDirectReachable: Bool = false,
            cliPath: String? = nil,
            stableID: String,
            debugID: String,
            isLocal: Bool)
        {
            self.displayName = displayName
            self.serviceHost = serviceHost
            self.servicePort = servicePort
            self.lanHost = lanHost
            self.tailnetDns = tailnetDns
            self.sshPort = sshPort
            self.gatewayPort = gatewayPort
            self.gatewayTls = gatewayTls
            self.gatewayDirectReachable = gatewayDirectReachable
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
    private var resolvedServiceByID: [String: ResolvedGatewayService] = [:]
    private var pendingServiceResolvers: [String: GatewayServiceResolver] = [:]
    private var wideAreaFallbackTask: Task<Void, Never>?
    private var wideAreaFallbackGateways: [DiscoveredGateway] = []
    private var tailscaleServeFallbackTask: Task<Void, Never>?
    private var tailscaleServeFallbackGateways: [DiscoveredGateway] = []
    private let logger = Logger(subsystem: "ai.openclaw", category: "gateway-discovery")

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
        if !self.browsers.isEmpty {
            return
        }

        for domain in OpenClawBonjour.gatewayServiceDomains {
            let browser = GatewayDiscoveryBrowserSupport.makeBrowser(
                serviceType: OpenClawBonjour.gatewayServiceType,
                domain: domain,
                queueLabelPrefix: "ai.openclaw.macos.gateway-discovery",
                onState: { [weak self] state in
                    guard let self else { return }
                    self.statesByDomain[domain] = state
                    self.updateStatusText()
                },
                onResults: { [weak self] results in
                    guard let self else { return }
                    self.resultsByDomain[domain] = results
                    self.updateGateways(for: domain)
                    self.recomputeGateways()
                })
            self.browsers[domain] = browser
        }

        self.scheduleWideAreaFallback()
        self.scheduleTailscaleServeFallback()
    }

    public func refreshWideAreaFallbackNow(timeoutSeconds: TimeInterval = 5.0) {
        guard let domain = OpenClawBonjour.wideAreaGatewayServiceDomain else { return }
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

    public func refreshTailscaleServeFallbackNow(timeoutSeconds: TimeInterval = 5.0) {
        Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: timeoutSeconds)
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.tailscaleServeFallbackGateways = self.mapTailscaleServeBeacons(beacons)
                self.recomputeGateways()
            }
        }
    }

    public func refreshRemoteFallbackNow(timeoutSeconds: TimeInterval = 5.0) {
        self.refreshWideAreaFallbackNow(timeoutSeconds: timeoutSeconds)
        self.refreshTailscaleServeFallbackNow(timeoutSeconds: timeoutSeconds)
    }

    public func stop() {
        for browser in self.browsers.values {
            browser.cancel()
        }
        self.browsers = [:]
        self.resultsByDomain = [:]
        self.gatewaysByDomain = [:]
        self.statesByDomain = [:]
        self.resolvedServiceByID = [:]
        self.pendingServiceResolvers.values.forEach { $0.cancel() }
        self.pendingServiceResolvers = [:]
        self.wideAreaFallbackTask?.cancel()
        self.wideAreaFallbackTask = nil
        self.wideAreaFallbackGateways = []
        self.tailscaleServeFallbackTask?.cancel()
        self.tailscaleServeFallbackTask = nil
        self.tailscaleServeFallbackGateways = []
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
                serviceHost: beacon.host,
                servicePort: beacon.port,
                lanHost: beacon.lanHost,
                tailnetDns: beacon.tailnetDns,
                sshPort: beacon.sshPort ?? 22,
                gatewayPort: beacon.gatewayPort,
                gatewayTls: beacon.gatewayTls,
                gatewayDirectReachable: beacon.gatewayDirectReachable,
                cliPath: beacon.cliPath,
                stableID: stableID,
                debugID: "\(beacon.instanceName)@\(beacon.host):\(beacon.port)",
                isLocal: isLocal)
        }
    }

    private func mapTailscaleServeBeacons(
        _ beacons: [TailscaleServeGatewayBeacon]) -> [DiscoveredGateway]
    {
        beacons.map { beacon in
            let stableID = "tailscale-serve|\(beacon.tailnetDns.lowercased())"
            let isLocal = Self.isLocalGateway(
                lanHost: nil,
                tailnetDns: beacon.tailnetDns,
                displayName: beacon.displayName,
                serviceName: nil,
                local: self.localIdentity)
            return DiscoveredGateway(
                displayName: beacon.displayName,
                serviceHost: beacon.host,
                servicePort: beacon.port,
                lanHost: nil,
                tailnetDns: beacon.tailnetDns,
                sshPort: 22,
                gatewayPort: beacon.port,
                gatewayTls: true,
                gatewayDirectReachable: true,
                cliPath: nil,
                stableID: stableID,
                debugID: "\(beacon.host):\(beacon.port)",
                isLocal: isLocal)
        }
    }

    private func recomputeGateways() {
        let primary = self.sortedDeduped(gateways: self.gatewaysByDomain.values.flatMap(\.self))
        let primaryFiltered = self.filterLocalGateways ? primary.filter { !$0.isLocal } : primary

        // Bonjour can return only "local" results for the wide-area domain (or no results at all),
        // and cross-network setups may rely on Tailscale Serve without DNS-SD.
        let fallback = self.wideAreaFallbackGateways + self.tailscaleServeFallbackGateways
        guard !fallback.isEmpty else {
            self.gateways = primaryFiltered
            return
        }

        let combined = self.sortedDeduped(gateways: primary + fallback)
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
            let resolved = self.resolvedServiceByID[stableID]
            let resolvedTXT = resolved?.txt ?? [:]
            let txt = Self.txtDictionary(from: result).merging(
                resolvedTXT,
                uniquingKeysWith: { _, new in new })

            let advertisedName = txt["displayName"]
                .map(Self.prettifyInstanceName)
                .flatMap { $0.isEmpty ? nil : $0 }
            let prettyName =
                advertisedName ?? Self.prettifyServiceName(decodedName)

            let parsedTXT = Self.parseGatewayTXT(txt)

            // Always attempt NetService resolution for the endpoint (host/port and TXT).
            // TXT is unauthenticated; do not use it for routing.
            if resolved == nil {
                self.ensureServiceResolution(
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
                serviceHost: resolved?.host,
                servicePort: resolved?.port,
                lanHost: parsedTXT.lanHost,
                tailnetDns: parsedTXT.tailnetDns,
                sshPort: parsedTXT.sshPort,
                gatewayPort: parsedTXT.gatewayPort,
                gatewayTls: parsedTXT.gatewayTls,
                gatewayDirectReachable: parsedTXT.gatewayDirectReachable,
                cliPath: parsedTXT.cliPath,
                stableID: stableID,
                debugID: GatewayEndpointID.prettyDescription(result.endpoint),
                isLocal: isLocal)
        }
        .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }

        if let wideAreaDomain = OpenClawBonjour.wideAreaGatewayServiceDomain,
           domain == wideAreaDomain,
           self.hasUsableWideAreaResults
        {
            self.wideAreaFallbackGateways = []
        }
    }

    private func scheduleWideAreaFallback() {
        guard let domain = OpenClawBonjour.wideAreaGatewayServiceDomain else { return }
        if Self.isRunningTests {
            return
        }
        guard self.wideAreaFallbackTask == nil else { return }
        self.wideAreaFallbackTask = Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            var attempt = 0
            let startedAt = Date()
            while !Task.isCancelled, Date().timeIntervalSince(startedAt) < 35.0 {
                let hasResults = await MainActor.run {
                    self.hasUsableWideAreaResults
                }
                if hasResults {
                    return
                }

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

    private func scheduleTailscaleServeFallback() {
        if Self.isRunningTests {
            return
        }
        guard self.tailscaleServeFallbackTask == nil else { return }
        self.tailscaleServeFallbackTask = Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            var attempt = 0
            let startedAt = Date()
            while !Task.isCancelled, Date().timeIntervalSince(startedAt) < 35.0 {
                let shouldContinue = await MainActor.run {
                    Self.shouldContinueTailscaleServeDiscovery(
                        currentGateways: self.gateways,
                        tailscaleServeGateways: self.tailscaleServeFallbackGateways)
                }
                if !shouldContinue {
                    return
                }

                let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 2.4)
                if !beacons.isEmpty {
                    await MainActor.run { [weak self] in
                        guard let self else { return }
                        self.tailscaleServeFallbackGateways = self.mapTailscaleServeBeacons(beacons)
                        self.recomputeGateways()
                    }
                    return
                }

                attempt += 1
                let backoff = min(8.0, 0.8 + (Double(attempt) * 0.8))
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            }
        }
    }

    static func shouldContinueTailscaleServeDiscovery(
        currentGateways _: [DiscoveredGateway],
        tailscaleServeGateways: [DiscoveredGateway]) -> Bool
    {
        // Tailscale Serve is a parallel discovery source. DNS-SD results should not suppress the
        // probe, otherwise Serve-only gateways disappear as soon as any other remote gateway is found.
        tailscaleServeGateways.isEmpty
    }

    private var hasUsableWideAreaResults: Bool {
        guard let domain = OpenClawBonjour.wideAreaGatewayServiceDomain else { return false }
        guard let gateways = self.gatewaysByDomain[domain], !gateways.isEmpty else { return false }
        if !self.filterLocalGateways {
            return true
        }
        return gateways.contains(where: { !$0.isLocal })
    }

    static func dedupeKey(for gateway: DiscoveredGateway) -> String {
        if let host = gateway.serviceHost?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
            !host.isEmpty,
            let port = gateway.servicePort,
            port > 0
        {
            return "endpoint|\(host):\(port)"
        }
        return "stable|\(gateway.stableID)"
    }

    private func sortedDeduped(gateways: [DiscoveredGateway]) -> [DiscoveredGateway] {
        var seen = Set<String>()
        let deduped = gateways.filter { gateway in
            let key = Self.dedupeKey(for: gateway)
            if seen.contains(key) {
                return false
            }
            seen.insert(key)
            return true
        }
        return deduped.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    private nonisolated static var isRunningTests: Bool {
        // Keep discovery background work from running forever during SwiftPM test runs.
        if Bundle.allBundles.contains(where: { $0.bundleURL.pathExtension == "xctest" }) {
            return true
        }

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
        self.statusText = GatewayDiscoveryStatusText.make(
            states: Array(self.statesByDomain.values),
            hasBrowsers: !self.browsers.isEmpty)
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
        public var gatewayTls: Bool
        public var gatewayDirectReachable: Bool
        public var cliPath: String?
    }

    public static func parseGatewayTXT(_ txt: [String: String]) -> GatewayTXT {
        var lanHost: String?
        var tailnetDns: String?
        var sshPort = 22
        var gatewayPort: Int?
        var gatewayTls = false
        var gatewayDirectReachable = false
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
        if let value = txt["gatewayTls"] {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            gatewayTls = normalized == "1" || normalized == "true" || normalized == "yes"
        }
        if let value = txt["gatewayDirectReachable"] {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            gatewayDirectReachable = normalized == "1" || normalized == "true" || normalized == "yes"
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
            gatewayTls: gatewayTls,
            gatewayDirectReachable: gatewayDirectReachable,
            cliPath: cliPath)
    }

    public static func buildSSHTarget(user: String, host: String, port: Int) -> String {
        var target = "\(user)@\(host)"
        if port != 22 {
            target += ":\(port)"
        }
        return target
    }

    private func ensureServiceResolution(
        stableID: String,
        serviceName: String,
        type: String,
        domain: String)
    {
        guard self.resolvedServiceByID[stableID] == nil else { return }
        guard self.pendingServiceResolvers[stableID] == nil else { return }

        let resolver = GatewayServiceResolver(
            name: serviceName,
            type: type,
            domain: domain,
            logger: self.logger)
        { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                self.pendingServiceResolvers[stableID] = nil
                switch result {
                case let .success(resolved):
                    self.resolvedServiceByID[stableID] = resolved
                    self.updateGatewaysForAllDomains()
                    self.recomputeGateways()
                case .failure:
                    break
                }
            }
        }

        self.pendingServiceResolvers[stableID] = resolver
        resolver.start()
    }

    private nonisolated static func prettifyInstanceName(_ decodedName: String) -> String {
        let normalized = decodedName.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let stripped = normalized.replacingOccurrences(of: " (OpenClaw)", with: "")
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
        if trimmed.isEmpty {
            return nil
        }
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
        if trimmed.isEmpty {
            return nil
        }
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

struct ResolvedGatewayService: Equatable {
    var txt: [String: String]
    var host: String?
    var port: Int?
}

final class GatewayServiceResolver: NSObject, NetServiceDelegate {
    private let service: NetService
    private let completion: (Result<ResolvedGatewayService, Error>) -> Void
    private let logger: Logger
    private var didFinish = false

    init(
        name: String,
        type: String,
        domain: String,
        logger: Logger,
        completion: @escaping (Result<ResolvedGatewayService, Error>) -> Void)
    {
        self.service = NetService(domain: domain, type: type, name: name)
        self.completion = completion
        self.logger = logger
        super.init()
        self.service.delegate = self
    }

    func start(timeout: TimeInterval = 2.0) {
        BonjourServiceResolverSupport.start(self.service, timeout: timeout)
    }

    func cancel() {
        self.finish(result: .failure(GatewayServiceResolverError.cancelled))
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let txt = Self.decodeTXT(sender.txtRecordData())
        let host = Self.normalizeHost(sender.hostName)
        let port = sender.port > 0 ? sender.port : nil
        if !txt.isEmpty {
            let payload = self.formatTXT(txt)
            self.logger.debug(
                "discovery: resolved TXT for \(sender.name, privacy: .public): \(payload, privacy: .public)")
        }
        let resolved = ResolvedGatewayService(txt: txt, host: host, port: port)
        self.finish(result: .success(resolved))
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        self.finish(result: .failure(GatewayServiceResolverError.resolveFailed(errorDict)))
    }

    private func finish(result: Result<ResolvedGatewayService, Error>) {
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

    private static func normalizeHost(_ raw: String?) -> String? {
        BonjourServiceResolverSupport.normalizeHost(raw)
    }

    private func formatTXT(_ txt: [String: String]) -> String {
        txt.sorted(by: { $0.key < $1.key })
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: " ")
    }
}

enum GatewayServiceResolverError: Error {
    case cancelled
    case resolveFailed([String: NSNumber])
}
