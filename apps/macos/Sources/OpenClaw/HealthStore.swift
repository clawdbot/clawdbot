import Foundation
import Network
import Observation
import SwiftUI

struct HealthSnapshot: Codable {
    struct ChannelSummary: Codable {
        struct Probe: Codable {
            struct Bot: Codable {
                let username: String?
            }

            struct Webhook: Codable {
                let url: String?
            }

            let ok: Bool?
            let status: Int?
            let error: String?
            let elapsedMs: Double?
            let bot: Bot?
            let webhook: Webhook?
        }

        let enabled: Bool?
        let configured: Bool?
        let linked: Bool?
        let authAgeMs: Double?
        let probe: Probe?
        let lastProbeAt: Double?
        let running: Bool?
        let connected: Bool?
        let lifecycle: String?
        let healthState: String?
        let lastError: String?
    }

    struct SessionInfo: Codable {
        let key: String
        let updatedAt: Double?
        let age: Double?
    }

    struct Sessions: Codable {
        let path: String
        let count: Int
        let recent: [SessionInfo]
    }

    let ok: Bool?
    let ts: Double
    let durationMs: Double
    let channels: [String: ChannelSummary]
    let channelOrder: [String]?
    let channelLabels: [String: String]?
    let heartbeatSeconds: Int?
    let sessions: Sessions
}

enum HealthState: Equatable {
    case unknown
    case ok
    case linkingNeeded
    case degraded(String)

    var tint: Color {
        switch self {
        case .ok: .green
        case .linkingNeeded: .red
        case .degraded: .orange
        case .unknown: .secondary
        }
    }
}

@MainActor
@Observable
final class HealthStore {
    private enum ChannelFailure: String {
        case notRunning = "not-running"
        case terminalDisconnect = "terminal-disconnect"
        case blocked
        case stuck
        case disconnected
        case staleSocket = "stale-socket"
        case ingressUnavailable = "ingress-unavailable"
    }

    static let shared = HealthStore()

    private static let logger = Logger(subsystem: "ai.openclaw", category: "health")

    private(set) var snapshot: HealthSnapshot?
    private(set) var lastSuccess: Date?
    private(set) var lastError: String?
    private(set) var isRefreshing = false

    private var loopTask: Task<Void, Never>?
    private let refreshInterval: TimeInterval = 60

    private init() {
        // Avoid background health polling in SwiftUI previews and tests.
        if !ProcessInfo.processInfo.isPreview, !ProcessInfo.processInfo.isRunningTests {
            self.start()
        }
    }

    /// Test-only escape hatch: the HealthStore is a process-wide singleton but
    /// state derivation is pure from `snapshot` + `lastError`.
    func __setSnapshotForTest(_ snapshot: HealthSnapshot?, lastError: String? = nil) {
        self.snapshot = snapshot
        self.lastError = lastError
    }

    func start() {
        guard self.loopTask == nil else { return }
        self.loopTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.refresh()
                try? await Task.sleep(nanoseconds: UInt64(self.refreshInterval * 1_000_000_000))
            }
        }
    }

    func refresh(onDemand: Bool = false) async {
        guard !self.isRefreshing, !Task.isCancelled else { return }
        self.isRefreshing = true
        defer { self.isRefreshing = false }
        let previousError = self.lastError

        do {
            let data = try await ControlChannel.shared.health(timeout: 15)
            guard !Task.isCancelled else { return }
            if let decoded = decodeHealthSnapshot(from: data) {
                self.snapshot = decoded
                self.lastSuccess = Date()
                self.lastError = nil
                if previousError != nil {
                    Self.logger.info("health refresh recovered")
                }
            } else {
                self.lastError = "health output not JSON"
                if onDemand { self.snapshot = nil }
                if previousError != self.lastError {
                    Self.logger.warning("health refresh failed: output not JSON")
                }
            }
        } catch {
            guard !Task.isCancelled else { return }
            let desc = error.localizedDescription
            self.lastError = desc
            if onDemand { self.snapshot = nil }
            if previousError != desc {
                Self.logger.error("health refresh failed \(desc, privacy: .public)")
            }
        }
    }

    private static func currentChannelFailure(_ summary: HealthSnapshot.ChannelSummary) -> String? {
        if let error = summary.lastError, !error.isEmpty { return error }
        if let probe = summary.probe, probe.ok == false { return self.describeProbeFailure(probe) }
        // Gateway owns grace windows; other producer health strings remain informational while healthy.
        // Blocked lifecycles retain their channel-authored terminal detail instead of a shared reason.
        if summary.lifecycle == "blocked" { return summary.healthState ?? ChannelFailure.blocked.rawValue }
        return summary.healthState.flatMap(ChannelFailure.init(rawValue:))?.rawValue
    }

    private static func describeProbeFailure(_ probe: HealthSnapshot.ChannelSummary.Probe) -> String {
        let elapsed = probe.elapsedMs.map { "\(Int($0))ms" }
        if let error = probe.error, error.lowercased().contains("timeout") {
            if let elapsed { return "Health check timed out (\(elapsed))" }
            return "Health check timed out"
        }
        let code = probe.status.map { "status \($0)" } ?? "status unknown"
        let reason = probe.error?.isEmpty == false ? probe.error! : "health probe failed"
        if let elapsed { return "\(reason) (\(code), \(elapsed))" }
        return "\(reason) (\(code))"
    }

    private func resolveHealthChannel(
        _ snap: HealthSnapshot) -> (id: String, summary: HealthSnapshot.ChannelSummary)?
    {
        let order = snap.channelOrder ?? Array(snap.channels.keys)
        let channels = order.compactMap { id in snap.channels[id].map { (id: id, summary: $0) } }
        return channels.first { $0.summary.linked == true }
            ?? channels.first { $0.summary.linked != nil }
            ?? channels.first { $0.summary.configured == true }
            ?? channels.first {
                $0.summary.configured != nil || $0.summary.running != nil || $0.summary.connected != nil ||
                    $0.summary.lifecycle != nil
            }
    }

    private func resolveFallbackChannel(
        _ snap: HealthSnapshot,
        excluding id: String?) -> (id: String, summary: HealthSnapshot.ChannelSummary)?
    {
        let order = snap.channelOrder ?? Array(snap.channels.keys)
        for channelId in order {
            if channelId == id { continue }
            guard let summary = snap.channels[channelId], summary.enabled != false else { continue }
            if summary.configured == true, summary.linked != false, Self.currentChannelFailure(summary) == nil {
                return (id: channelId, summary: summary)
            }
        }
        return nil
    }

    private var presentation: (state: HealthState, summary: String) {
        if let error = self.lastError, !error.isEmpty {
            return (.degraded(error), "Health check failed: \(error)")
        }
        guard let snap = self.snapshot, let link = self.resolveHealthChannel(snap) else {
            return (.unknown, "Health check pending")
        }
        let label = snap.channelLabels?[link.id] ?? link.id.capitalized
        if link.summary.enabled == false { return (.unknown, "\(label) disabled") }
        if link.summary.linked == false {
            // Linking is optional if another channel is healthy; keep the state and label in agreement.
            if let fallback = self.resolveFallbackChannel(snap, excluding: link.id) {
                let label = snap.channelLabels?[fallback.id] ?? fallback.id.capitalized
                return (.degraded("Not linked"), "\(label) ok · Not linked — run openclaw login")
            }
            return (.linkingNeeded, "Not linked — run openclaw login")
        }
        if link.summary.linked == nil, link.summary.configured != true {
            return (.unknown, "\(label) not configured")
        }
        let failure = Self.currentChannelFailure(link.summary)
        let state = failure.map(HealthState.degraded) ?? .ok
        if link.summary.linked == nil {
            if let failure { return (state, "\(label) degraded · \(failure)") }
            if link.summary.lifecycle == "ready" { return (state, "\(label) ready") }
            let summary = link.summary.running == true || link.summary.connected == true
                ? "\(label) running"
                : "\(label) configured"
            return (state, summary)
        }
        let auth = link.summary.authAgeMs.map { msToAge($0) } ?? "unknown"
        if let probe = link.summary.probe, probe.ok == false {
            let status = probe.status.map(String.init) ?? "?"
            let suffix = probe.status == nil ? "probe degraded" : "probe degraded · status \(status)"
            return (state, "linked · auth \(auth) · \(suffix)")
        }
        return (state, "linked · auth \(auth)" + (failure.map { " · \($0)" } ?? ""))
    }

    var state: HealthState {
        self.presentation.state
    }

    var summaryLine: String {
        if self.isRefreshing { return "Health check running…" }
        return self.presentation.summary
    }

    /// Short, human-friendly detail for the last failure, used in the UI.
    var detailLine: String? {
        if let error = self.lastError, !error.isEmpty {
            let lower = error.lowercased()
            if lower.contains("connection refused") {
                let port = GatewayEnvironment.gatewayPort()
                let host = GatewayConnectivityCoordinator.shared.localEndpointHostLabel ?? "127.0.0.1:\(port)"
                return "The gateway control port (\(host)) isn’t listening — restart OpenClaw to bring it back."
            }
            if lower.contains("timeout") {
                return "Timed out waiting for the control server; the gateway may be crashed or still starting."
            }
            return error
        }
        return nil
    }

    func describeFailure(from snap: HealthSnapshot, fallback: String?) -> String {
        if let link = self.resolveHealthChannel(snap) {
            if link.summary.linked == false { return "Not linked — run openclaw login" }
            if let failure = Self.currentChannelFailure(link.summary) { return failure }
        }
        if let fallback, !fallback.isEmpty {
            return fallback
        }
        return "health probe failed"
    }

    var degradedSummary: String? {
        guard case let .degraded(reason) = self.state else { return nil }
        if reason == "[object Object]" || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let snap = self.snapshot
        {
            return self.describeFailure(from: snap, fallback: reason)
        }
        return reason
    }
}

func msToAge(_ ms: Double) -> String {
    let minutes = Int(round(ms / 60000))
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m" }
    let hours = Int(round(Double(minutes) / 60))
    if hours < 48 { return "\(hours)h" }
    let days = Int(round(Double(hours) / 24))
    return "\(days)d"
}

/// Decode a health snapshot, tolerating stray log lines before/after the JSON blob.
func decodeHealthSnapshot(from data: Data) -> HealthSnapshot? {
    let decoder = JSONDecoder()
    if let snap = try? decoder.decode(HealthSnapshot.self, from: data) {
        return snap
    }
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    guard let firstBrace = text.firstIndex(of: "{"), let lastBrace = text.lastIndex(of: "}") else {
        return nil
    }
    let slice = text[firstBrace...lastBrace]
    let cleaned = Data(slice.utf8)
    return try? decoder.decode(HealthSnapshot.self, from: cleaned)
}
