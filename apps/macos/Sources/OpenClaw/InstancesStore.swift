import Cocoa
import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import OSLog

struct InstanceInfo: Identifiable, Codable {
    let id: String
    let host: String?
    let ip: String?
    let version: String?
    let platform: String?
    let deviceFamily: String?
    let modelIdentifier: String?
    let lastInputSeconds: Int?
    let mode: String?
    let reason: String?
    let text: String
    let ts: Double

    var ageDescription: String {
        let date = Date(timeIntervalSince1970: ts / 1000)
        return age(from: date)
    }

    var lastInputDescription: String {
        guard let secs = lastInputSeconds else { return "unknown" }
        return "\(secs)s ago"
    }
}

@MainActor
@Observable
final class InstancesStore {
    static let shared = InstancesStore()
    let isPreview: Bool

    var instances: [InstanceInfo] = []
    var lastError: String?
    var statusMessage: String?
    var isLoading = false

    private let logger = Logger(subsystem: "ai.openclaw", category: "instances")
    private var task: Task<Void, Never>?
    private let interval: TimeInterval = 30
    private var eventTask: Task<Void, Never>?
    private var startCount = 0

    private struct PresenceEventPayload: Codable {
        let presence: [PresenceEntry]
    }

    init(isPreview: Bool = false) {
        self.isPreview = isPreview
    }

    func start() {
        guard !self.isPreview else { return }
        self.startCount += 1
        guard self.startCount == 1 else { return }
        guard self.task == nil else { return }
        GatewayPushSubscription.restartTask(task: &self.eventTask) { [weak self] push in
            self?.handle(push: push)
        }
        SimpleTaskSupport.startDetachedLoop(task: &self.task, interval: self.interval) { [weak self] in
            await self?.refresh()
        }
    }

    func stop() {
        guard !self.isPreview else { return }
        guard self.startCount > 0 else { return }
        self.startCount -= 1
        guard self.startCount == 0 else { return }
        self.task?.cancel()
        self.task = nil
        self.eventTask?.cancel()
        self.eventTask = nil
    }

    private func handle(push: GatewayPush) {
        switch push {
        case let .event(evt) where evt.event == "presence":
            if let payload = evt.payload {
                self.handlePresenceEventPayload(payload)
            }
        case .seqGap:
            Task { await self.refresh() }
        case let .snapshot(hello):
            self.applyPresence(hello.snapshot.presence)
        default:
            break
        }
    }

    func refresh() async {
        if self.isLoading { return }
        self.statusMessage = nil
        self.isLoading = true
        defer { self.isLoading = false }
        do {
            PresenceReporter.shared.sendImmediate(reason: "instances-refresh")
            let data = try await ControlChannel.shared.request(method: "system-presence")
            self.lastPayload = data
            if data.isEmpty {
                self.logger.error("instances fetch returned empty payload")
                self.instances = [self.localFallbackInstance(reason: "no presence payload")]
                self.lastError = nil
                self.statusMessage = "No presence payload from gateway; showing local fallback + health probe."
                await self.probeHealthIfNeeded(reason: "no payload")
                return
            }
            let decoded = try JSONDecoder().decode([PresenceEntry].self, from: data)
            let withIDs = self.normalizePresence(decoded)
            if withIDs.isEmpty {
                self.instances = [self.localFallbackInstance(reason: "no presence entries")]
                self.lastError = nil
                self.statusMessage = "Presence list was empty; showing local fallback + health probe."
                await self.probeHealthIfNeeded(reason: "empty list")
            } else {
                self.instances = withIDs
                self.lastError = nil
                self.statusMessage = nil
            }
        } catch {
            self.logger.error(
                """
                instances fetch failed: \(error.localizedDescription, privacy: .public) \
                len=\(self.lastPayload?.count ?? 0, privacy: .public) \
                utf8=\(self.snippet(self.lastPayload), privacy: .public)
                """)
            self.instances = [self.localFallbackInstance(reason: "presence decode failed")]
            self.lastError = nil
            self.statusMessage = "Presence data invalid; showing local fallback + health probe."
            await self.probeHealthIfNeeded(reason: "decode failed")
        }
    }

    private func localFallbackInstance(reason: String) -> InstanceInfo {
        let host = Host.current().localizedName ?? "this-mac"
        let ip = SystemPresenceInfo.primaryIPv4Address()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let osVersion = ProcessInfo.processInfo.operatingSystemVersion
        let platform = "macos \(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)"
        let text = "Local node: \(host)\(ip.map { " (\($0))" } ?? "") · app \(version ?? "dev")"
        let ts = Date().timeIntervalSince1970 * 1000
        return InstanceInfo(
            id: "local-\(host)",
            host: host,
            ip: ip,
            version: version,
            platform: platform,
            deviceFamily: "Mac",
            modelIdentifier: InstanceIdentity.modelIdentifier,
            lastInputSeconds: SystemPresenceInfo.lastInputSeconds(),
            mode: "local",
            reason: reason,
            text: text,
            ts: ts)
    }

    // MARK: - Helpers

    /// Keep the last raw payload for logging.
    private var lastPayload: Data?

    private func snippet(_ data: Data?, limit: Int = 256) -> String {
        guard let data else { return "<none>" }
        if data.isEmpty { return "<empty>" }
        let prefix = data.prefix(limit)
        if let asString = String(data: prefix, encoding: .utf8) {
            return asString.replacingOccurrences(of: "\n", with: " ")
        }
        return "<\(data.count) bytes non-utf8>"
    }

    private func probeHealthIfNeeded(reason: String? = nil) async {
        do {
            let data = try await ControlChannel.shared.health(timeout: 8)
            guard let snap = decodeHealthSnapshot(from: data) else { return }
            let linkId = snap.channelOrder?.first(where: {
                if let summary = snap.channels[$0] { return summary.linked != nil }
                return false
            }) ?? snap.channels.keys.first(where: {
                if let summary = snap.channels[$0] { return summary.linked != nil }
                return false
            })
            let linked = linkId.flatMap { snap.channels[$0]?.linked } ?? false
            let linkLabel =
                linkId.flatMap { snap.channelLabels?[$0] } ??
                linkId?.capitalized ??
                "channel"
            let entry = InstanceInfo(
                id: "health-\(snap.ts)",
                host: "gateway (health)",
                ip: nil,
                version: nil,
                platform: nil,
                deviceFamily: nil,
                modelIdentifier: nil,
                lastInputSeconds: nil,
                mode: "health",
                reason: "health probe",
                text: "Health ok · \(linkLabel) linked=\(linked)",
                ts: snap.ts)
            if !self.instances.contains(where: { $0.id == entry.id }) {
                self.instances.insert(entry, at: 0)
            }
            self.lastError = nil
            self.statusMessage =
                "Presence unavailable (\(reason ?? "refresh")); showing health probe + local fallback."
        } catch {
            self.logger.error("instances health probe failed: \(error.localizedDescription, privacy: .public)")
            if let reason {
                self.statusMessage =
                    "Presence unavailable (\(reason)), health probe failed: \(error.localizedDescription)"
            }
        }
    }

    func handlePresenceEventPayload(_ payload: OpenClawProtocol.AnyCodable) {
        do {
            let wrapper = try GatewayPayloadDecoding.decode(payload, as: PresenceEventPayload.self)
            self.applyPresence(wrapper.presence)
        } catch {
            self.logger.error("presence event decode failed: \(error.localizedDescription, privacy: .public)")
            self.lastError = error.localizedDescription
        }
    }

    private func normalizePresence(_ entries: [PresenceEntry]) -> [InstanceInfo] {
        entries.map { entry -> InstanceInfo in
            let key = entry.instanceid ?? entry.host ?? entry.ip ?? entry.text ?? "entry-\(entry.ts)"
            return InstanceInfo(
                id: key,
                host: entry.host,
                ip: entry.ip,
                version: entry.version,
                platform: entry.platform,
                deviceFamily: entry.devicefamily,
                modelIdentifier: entry.modelidentifier,
                lastInputSeconds: entry.lastinputseconds,
                mode: entry.mode,
                reason: entry.reason,
                text: entry.text ?? "Unnamed node",
                ts: Double(entry.ts))
        }
    }

    private func applyPresence(_ entries: [PresenceEntry]) {
        let withIDs = self.normalizePresence(entries)
        self.instances = withIDs
        self.statusMessage = nil
        self.lastError = nil
    }
}

extension InstancesStore {
    static func preview(instances: [InstanceInfo] = [
        InstanceInfo(
            id: "local",
            host: "steipete-mac",
            ip: "10.0.0.12",
            version: "1.2.3",
            platform: "macos 26.2.0",
            deviceFamily: "Mac",
            modelIdentifier: "Mac16,6",
            lastInputSeconds: 12,
            mode: "local",
            reason: "preview",
            text: "Local node: steipete-mac (10.0.0.12) · app 1.2.3",
            ts: Date().timeIntervalSince1970 * 1000),
        InstanceInfo(
            id: "gateway",
            host: "gateway",
            ip: "100.64.0.2",
            version: "1.2.3",
            platform: "linux 6.6.0",
            deviceFamily: "Linux",
            modelIdentifier: "x86_64",
            lastInputSeconds: 45,
            mode: "remote",
            reason: "preview",
            text: "Gateway node · tunnel ok",
            ts: Date().timeIntervalSince1970 * 1000 - 45000),
    ]) -> InstancesStore {
        let store = InstancesStore(isPreview: true)
        store.instances = instances
        store.statusMessage = "Preview data"
        return store
    }
}
