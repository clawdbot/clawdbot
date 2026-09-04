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
    private let control: ControlChannel
    private var gateway: GatewayConnection {
        self.control.gateway
    }

    private struct Output {
        let revision: UInt64?
        var lease: GatewayConnection.ServerLease?
        var instances: [InstanceInfo] = []
        var lastError: String?
        var statusMessage: String?
    }

    private final class Refresh {
        let revision: UInt64?
        var lease: GatewayConnection.ServerLease?
        var task: Task<Void, Never>?

        init(revision: UInt64?) {
            self.revision = revision
        }
    }

    private var output: Output
    private var activeRefresh: Refresh?
    var instances: [InstanceInfo] {
        self.sourceIsCurrent ? self.output.instances : []
    }

    var lastError: String? {
        self.sourceIsCurrent ? self.output.lastError : nil
    }

    var statusMessage: String? {
        self.sourceIsCurrent ? self.output.statusMessage : nil
    }

    var isLoading: Bool {
        self.activeRefresh.map(self.refreshIsCurrent) == true
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "instances")
    private var task: Task<Void, Never>?
    private let interval: TimeInterval = 30
    private var eventTask: Task<Void, Never>?
    private var startCount = 0

    private struct PresenceEventPayload: Codable {
        let presence: [PresenceEntry]
    }

    init(isPreview: Bool = false, control: ControlChannel = .shared) {
        self.isPreview = isPreview
        self.control = control
        self.output = Output(revision: control.gateway.selectedEndpointRevision)
    }

    isolated deinit {
        self.task?.cancel()
        self.eventTask?.cancel()
        self.activeRefresh?.task?.cancel()
    }

    func start() {
        guard !self.isPreview else { return }
        self.startCount += 1
        guard self.startCount == 1 else { return }
        guard self.task == nil else { return }
        GatewayPushSubscription.restartTask(task: &self.eventTask, connection: self.gateway) { [weak self] delivery in
            self?.handle(delivery)
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
        self.cancelRefresh()
    }

    private func handle(_ delivery: GatewayConnection.PushDelivery) {
        self.clearReplacedSource()
        guard let push = delivery.push else {
            if self.activeRefresh?.lease == delivery.serverLease { self.cancelRefresh() }
            if case let .disconnected(reason) = delivery.event, delivery.isCurrent {
                self.output.lastError = reason
                self.output.statusMessage = nil
            }
            return
        }
        switch push {
        case let .event(evt) where evt.event == "presence":
            if let payload = evt.payload {
                self.output.lease = delivery.serverLease
                self.handlePresenceEventPayload(payload)
            }
        case .seqGap:
            self.cancelRefresh()
            _ = self.beginRefresh()
        case let .snapshot(hello):
            // Subscription replays are older than a read already admitted on this socket.
            guard self.output.lease != delivery.serverLease else { return }
            self.output.lease = delivery.serverLease
            // The initial hello belongs to the acquisition that precedes the explicit read.
            if let refresh = self.activeRefresh, refresh.lease == nil,
               refresh.revision == self.output.revision
            {
                refresh.lease = delivery.serverLease
            } else {
                self.cancelRefresh()
            }
            self.applyPresence(hello.snapshot.presence)
        default:
            break
        }
    }

    func refresh() async {
        guard !Task.isCancelled, let task = self.beginRefresh() else { return }
        await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }

    private func beginRefresh() -> Task<Void, Never>? {
        self.clearReplacedSource()
        if let refresh = self.activeRefresh, self.refreshIsCurrent(refresh) { return nil }
        self.cancelRefresh()
        self.output.statusMessage = nil
        let refresh = Refresh(revision: self.gateway.selectedEndpointRevision)
        self.activeRefresh = refresh
        let task = Task<Void, Never> { [weak self] in
            await self?.performRefresh(refresh: refresh)
        }
        refresh.task = task
        return task
    }

    private func cancelRefresh() {
        self.activeRefresh?.task?.cancel()
        self.activeRefresh = nil
    }

    private func refreshIsCurrent(_ refresh: Refresh) -> Bool {
        self.activeRefresh === refresh && refresh.task?.isCancelled != true &&
            refresh.revision == self.gateway.selectedEndpointRevision &&
            refresh.lease.map(self.gateway.serverLeaseMatchesCurrentState) != false
    }

    private var sourceIsCurrent: Bool {
        self.output.revision == self.gateway.selectedEndpointRevision &&
            self.output.lease.map(self.gateway.serverLeaseMatchesCurrentRoute) != false
    }

    private func clearReplacedSource() {
        if !self.sourceIsCurrent {
            self.output = Output(revision: self.gateway.selectedEndpointRevision)
        }
    }

    private func performRefresh(refresh: Refresh) async {
        defer {
            if self.activeRefresh === refresh { self.activeRefresh = nil }
        }
        guard self.refreshIsCurrent(refresh) else { return }
        var payload: Data?
        let reason: String
        do {
            let lease = try await self.control.acquireServerLease()
            guard self.refreshIsCurrent(refresh), self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
            refresh.lease = lease
            self.output.lease = lease
            PresenceReporter.shared.sendImmediate(reason: "instances-refresh")
            let data = try await self.control.request(method: "system-presence", ifCurrentServerLease: lease)
            guard self.refreshIsCurrent(refresh) else { return }
            payload = data
            let entries = data.isEmpty ? [] : try JSONDecoder().decode([PresenceEntry].self, from: data)
            if !entries.isEmpty {
                self.applyPresence(entries)
                return
            }
            reason = data.isEmpty ? "no presence payload" : "no presence entries"
        } catch {
            guard !(error is CancellationError), self.refreshIsCurrent(refresh) else { return }
            self.logger.error(
                """
                instances fetch failed: \(error.localizedDescription, privacy: .public) \
                len=\(payload?.count ?? 0, privacy: .public) utf8=\(self.snippet(payload), privacy: .public)
                """)
            reason = "presence decode failed"
        }
        self.output.instances = [self.localFallbackInstance(reason: reason)]
        self.output.lastError = nil
        self.output.statusMessage = "Presence unavailable (\(reason)); showing local fallback."
        if let lease = refresh.lease {
            await self.probeHealthIfNeeded(reason: reason, lease: lease, refresh: refresh)
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
            lastInputSeconds: nil,
            mode: "local",
            reason: reason,
            text: text,
            ts: ts)
    }

    // MARK: - Helpers

    private func snippet(_ data: Data?, limit: Int = 256) -> String {
        guard let data else { return "<none>" }
        if data.isEmpty { return "<empty>" }
        let prefix = data.prefix(limit)
        if let asString = String(data: prefix, encoding: .utf8) {
            return asString.replacingOccurrences(of: "\n", with: " ")
        }
        return "<\(data.count) bytes non-utf8>"
    }

    private func probeHealthIfNeeded(reason: String, lease: GatewayConnection.ServerLease, refresh: Refresh) async {
        do {
            let data = try await self.control.health(timeout: 8, ifCurrentServerLease: lease)
            guard self.refreshIsCurrent(refresh), let snap = decodeHealthSnapshot(from: data) else { return }
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
                self.output.instances.insert(entry, at: 0)
            }
            self.output.lastError = nil
            self.output.statusMessage =
                "Presence unavailable (\(reason)); showing health probe + local fallback."
        } catch {
            guard self.refreshIsCurrent(refresh) else { return }
            self.logger.error("instances health probe failed: \(error.localizedDescription, privacy: .public)")
            self.output.statusMessage =
                "Presence unavailable (\(reason)), health probe failed: \(error.localizedDescription)"
        }
    }

    func handlePresenceEventPayload(_ payload: OpenClawProtocol.AnyCodable) {
        do {
            let wrapper = try GatewayPayloadDecoding.decode(payload, as: PresenceEventPayload.self)
            self.cancelRefresh()
            self.applyPresence(wrapper.presence)
        } catch {
            self.logger.error("presence event decode failed: \(error.localizedDescription, privacy: .public)")
            self.output.lastError = error.localizedDescription
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
        self.output.instances = withIDs
        self.output.statusMessage = nil
        self.output.lastError = nil
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
        store.output.instances = instances
        store.output.statusMessage = "Preview data"
        return store
    }
}
