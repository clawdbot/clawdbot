import ClawdbotKit
import ClawdbotProtocol
import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class WorkActivityStore {
    static let shared = WorkActivityStore()

    struct Activity: Equatable {
        let sessionKey: String
        let role: SessionRole
        let kind: ActivityKind
        let label: String
        let startedAt: Date
        var lastUpdate: Date
    }

    private(set) var current: Activity?
    private(set) var iconState: IconState = .idle
    private(set) var lastToolLabel: String?
    private(set) var lastToolUpdatedAt: Date?

    private var jobs: [String: Activity] = [:]
    private var tools: [String: Activity] = [:]
    private var currentSessionKey: String?
    private var toolSeqBySession: [String: Int] = [:]

    private var mainSessionKeyStorage = "main"
    private let toolResultGrace: TimeInterval = 2.0

    var mainSessionKey: String { self.mainSessionKeyStorage }

    func handleJob(sessionKey: String, state: String) {
        let isStart = state.lowercased() == "started" || state.lowercased() == "streaming"
        if isStart {
            let activity = Activity(
                sessionKey: sessionKey,
                role: self.role(for: sessionKey),
                kind: .job,
                label: "job",
                startedAt: Date(),
                lastUpdate: Date())
            self.setJobActive(activity)
        } else {
            // Job ended (done/error/aborted/etc). Clear everything for this session.
            self.clearTool(sessionKey: sessionKey)
            self.clearJob(sessionKey: sessionKey)
        }
    }

    func handleTool(
        sessionKey: String,
        phase: String,
        name: String?,
        meta: String?,
        args: [String: ClawdbotProtocol.AnyCodable]?)
    {
        let toolKind = Self.mapToolKind(name)
        let label = Self.buildLabel(name: name, meta: meta, args: args)
        if phase.lowercased() == "start" {
            self.lastToolLabel = label
            self.lastToolUpdatedAt = Date()
            self.toolSeqBySession[sessionKey, default: 0] += 1
            let activity = Activity(
                sessionKey: sessionKey,
                role: self.role(for: sessionKey),
                kind: .tool(toolKind),
                label: label,
                startedAt: Date(),
                lastUpdate: Date())
            self.setToolActive(activity)
        } else {
            // Delay removal slightly to avoid flicker on rapid result/start bursts.
            let key = sessionKey
            let seq = self.toolSeqBySession[key, default: 0]
            Task { [weak self] in
                let nsDelay = UInt64((self?.toolResultGrace ?? 0) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nsDelay)
                await MainActor.run {
                    guard let self else { return }
                    guard self.toolSeqBySession[key, default: 0] == seq else { return }
                    self.lastToolUpdatedAt = Date()
                    self.clearTool(sessionKey: key)
                }
            }
        }
    }

    func resolveIconState(override selection: IconOverrideSelection) {
        switch selection {
        case .system:
            self.iconState = self.deriveIconState()
        case .idle:
            self.iconState = .idle
        default:
            let base = selection.toIconState()
            switch base {
            case let .workingMain(kind),
                 let .workingOther(kind):
                self.iconState = .overridden(kind)
            case let .overridden(kind):
                self.iconState = .overridden(kind)
            case .idle:
                self.iconState = .idle
            }
        }
    }

    private func setJobActive(_ activity: Activity) {
        self.jobs[activity.sessionKey] = activity
        // Main session preempts immediately.
        if activity.role == .main {
            self.currentSessionKey = activity.sessionKey
        } else if self.currentSessionKey == nil || !self.isActive(sessionKey: self.currentSessionKey!) {
            self.currentSessionKey = activity.sessionKey
        }
        self.refreshDerivedState()
    }

    private func setToolActive(_ activity: Activity) {
        self.tools[activity.sessionKey] = activity
        // Main session preempts immediately.
        if activity.role == .main {
            self.currentSessionKey = activity.sessionKey
        } else if self.currentSessionKey == nil || !self.isActive(sessionKey: self.currentSessionKey!) {
            self.currentSessionKey = activity.sessionKey
        }
        self.refreshDerivedState()
    }

    func setMainSessionKey(_ sessionKey: String) {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard trimmed != self.mainSessionKeyStorage else { return }
        self.mainSessionKeyStorage = trimmed
        if let current = self.currentSessionKey, !self.isActive(sessionKey: current) {
            self.pickNextSession()
        }
        self.refreshDerivedState()
    }

    private func clearJob(sessionKey: String) {
        guard self.jobs[sessionKey] != nil else { return }
        self.jobs.removeValue(forKey: sessionKey)

        if self.currentSessionKey == sessionKey, !self.isActive(sessionKey: sessionKey) {
            self.pickNextSession()
        }
        self.refreshDerivedState()
    }

    private func clearTool(sessionKey: String) {
        guard self.tools[sessionKey] != nil else { return }
        self.tools.removeValue(forKey: sessionKey)

        if self.currentSessionKey == sessionKey, !self.isActive(sessionKey: sessionKey) {
            self.pickNextSession()
        }
        self.refreshDerivedState()
    }

    private func pickNextSession() {
        // Prefer main if present.
        if self.isActive(sessionKey: self.mainSessionKeyStorage) {
            self.currentSessionKey = self.mainSessionKeyStorage
            return
        }

        // Otherwise, pick most recent by lastUpdate across job/tool.
        let keys = Set(self.jobs.keys).union(self.tools.keys)
        let next = keys.max(by: { self.lastUpdate(for: $0) < self.lastUpdate(for: $1) })
        self.currentSessionKey = next
    }

    private func role(for sessionKey: String) -> SessionRole {
        sessionKey == self.mainSessionKeyStorage ? .main : .other
    }

    private func isActive(sessionKey: String) -> Bool {
        self.jobs[sessionKey] != nil || self.tools[sessionKey] != nil
    }

    private func lastUpdate(for sessionKey: String) -> Date {
        max(self.jobs[sessionKey]?.lastUpdate ?? .distantPast, self.tools[sessionKey]?.lastUpdate ?? .distantPast)
    }

    private func currentActivity(for sessionKey: String) -> Activity? {
        // Prefer tool overlay if present, otherwise job.
        self.tools[sessionKey] ?? self.jobs[sessionKey]
    }

    private func refreshDerivedState() {
        if let key = self.currentSessionKey, !self.isActive(sessionKey: key) {
            self.currentSessionKey = nil
        }
        self.current = self.currentSessionKey.flatMap { self.currentActivity(for: $0) }
        self.iconState = self.deriveIconState()
    }

    private func deriveIconState() -> IconState {
        guard let sessionKey = self.currentSessionKey,
              let activity = self.currentActivity(for: sessionKey)
        else { return .idle }

        switch activity.role {
        case .main: return .workingMain(activity.kind)
        case .other: return .workingOther(activity.kind)
        }
    }

    private static func mapToolKind(_ name: String?) -> ToolKind {
        switch name?.lowercased() {
        case "bash", "shell": .bash
        case "read": .read
        case "write": .write
        case "edit": .edit
        case "attach": .attach
        default: .other
        }
    }

    private static func buildLabel(
        name: String?,
        meta: String?,
        args: [String: ClawdbotProtocol.AnyCodable]?) -> String
    {
        let wrappedArgs = self.wrapToolArgs(args)
        let display = ToolDisplayRegistry.resolve(name: name ?? "tool", args: wrappedArgs, meta: meta)
        if let detail = display.detailLine, !detail.isEmpty {
            return "\(display.label): \(detail)"
        }

        return display.label
    }

    private static func wrapToolArgs(_ args: [String: ClawdbotProtocol.AnyCodable]?) -> ClawdbotKit.AnyCodable? {
        guard let args else { return nil }
        let converted: [String: Any] = args.mapValues { self.unwrapJSONValue($0.value) }
        return ClawdbotKit.AnyCodable(converted)
    }

    private static func unwrapJSONValue(_ value: Any) -> Any {
        if let dict = value as? [String: ClawdbotProtocol.AnyCodable] {
            return dict.mapValues { self.unwrapJSONValue($0.value) }
        }
        if let array = value as? [ClawdbotProtocol.AnyCodable] {
            return array.map { self.unwrapJSONValue($0.value) }
        }
        if let dict = value as? [String: Any] {
            return dict.mapValues { self.unwrapJSONValue($0) }
        }
        if let array = value as? [Any] {
            return array.map { self.unwrapJSONValue($0) }
        }
        return value
    }
}
