import Foundation
import OpenClawKit
import OpenClawProtocol

enum ChatSubagentActivityStatus: String, Sendable {
    case queued
    case running
    case completed
    case failed
    case cancelled
    case timedOut = "timed_out"

    var isWorking: Bool {
        self == .queued || self == .running
    }
}

enum ChatSubagentActivitySource: Sendable {
    case event
    case snapshot
}

struct ChatSubagentActivity: Identifiable, Equatable, Sendable {
    let id: String
    let status: ChatSubagentActivityStatus
    let snippet: String?
    let diffStat: ChatToolDiffStat?
    let startedAt: Double
    let updatedAt: Double
    let endedAt: Double?
    let terminalObservedAt: Double?
    let childSessionKey: String?
    let terminalSummary: String?
}

struct ChatSubagentActivityPresentation: Equatable, Sendable {
    let rows: [ChatSubagentActivity]
    let hiddenWorkingCount: Int
}

struct ChatSubagentActivityState: Equatable, Sendable {
    private(set) var activitiesByID: [String: ChatSubagentActivity] = [:]

    mutating func upsert(
        _ task: TaskSummary,
        nowMilliseconds: Double,
        source: ChatSubagentActivitySource = .event)
    {
        guard let status = task.status.stringValue.flatMap(ChatSubagentActivityStatus.init(rawValue:))
        else { return }
        let previous = self.activitiesByID[task.id]
        let fallbackSnippet = Self.firstNonBlank(task.lastactivity, task.progresssummary, task.lasttoolname)
        let snippet = if !status.isWorking, previous != nil, Self.nonBlank(task.lastactivity) == nil {
            previous?.snippet
        } else {
            fallbackSnippet ?? previous?.snippet
        }
        let endedAt = Self.timestampMilliseconds(task.endedat) ?? previous?.endedAt
        let updatedAt = Self.timestampMilliseconds(task.updatedat)
            ?? previous?.updatedAt
            ?? endedAt
            ?? nowMilliseconds
        let terminalObservedAt: Double? = if status.isWorking {
            nil
        } else if let previous, !previous.status.isWorking {
            previous.terminalObservedAt
        } else {
            source == .event ? nowMilliseconds : endedAt ?? updatedAt
        }
        self.activitiesByID[task.id] = ChatSubagentActivity(
            id: task.id,
            status: status,
            snippet: snippet,
            diffStat: Self.diffStat(task.diffstat) ?? previous?.diffStat,
            startedAt: Self.timestampMilliseconds(task.startedat)
                ?? previous?.startedAt
                ?? Self.timestampMilliseconds(task.createdat)
                ?? nowMilliseconds,
            updatedAt: updatedAt,
            endedAt: endedAt,
            terminalObservedAt: terminalObservedAt,
            childSessionKey: Self.nonBlank(task.childsessionkey) ?? previous?.childSessionKey,
            terminalSummary: Self.nonBlank(task.terminalsummary) ?? previous?.terminalSummary)
    }

    mutating func remove(taskID: String) {
        self.activitiesByID[taskID] = nil
    }

    mutating func removeAll() {
        self.activitiesByID.removeAll()
    }

    mutating func removeExpired(
        nowMilliseconds: Double,
        retentionMilliseconds: Double = 60000)
    {
        self.activitiesByID = self.activitiesByID.filter { _, activity in
            activity.status.isWorking ||
                (activity.terminalObservedAt.map { nowMilliseconds - $0 < retentionMilliseconds } ?? false)
        }
    }

    func presentation(limit: Int = 5) -> ChatSubagentActivityPresentation {
        let sorted = self.activitiesByID.values.sorted { lhs, rhs in
            if lhs.updatedAt != rhs.updatedAt {
                return lhs.updatedAt > rhs.updatedAt
            }
            return lhs.id < rhs.id
        }
        let ordered = sorted.filter(\.status.isWorking) + sorted.filter { !$0.status.isWorking }
        let rows = Array(ordered.prefix(limit))
        let visibleIDs = Set(rows.map(\.id))
        let hiddenWorkingCount = ordered.count { activity in
            activity.status == .running && !visibleIDs.contains(activity.id)
        }
        return ChatSubagentActivityPresentation(
            rows: rows,
            hiddenWorkingCount: hiddenWorkingCount)
    }

    func nextExpiryMilliseconds(retentionMilliseconds: Double = 60000) -> Double? {
        self.activitiesByID.values
            .filter { !$0.status.isWorking }
            .compactMap(\.terminalObservedAt)
            .map { $0 + retentionMilliseconds }
            .min()
    }

    private static func diffStat(_ value: [String: AnyCodable]?) -> ChatToolDiffStat? {
        guard let added = value?["added"]?.intValue,
              let removed = value?["removed"]?.intValue,
              added >= 0,
              removed >= 0
        else { return nil }
        let files = value?["files"]?.intValue
        return ChatToolDiffStat(
            files: files.map { max(0, $0) },
            added: added,
            removed: removed)
    }

    private static func timestampMilliseconds(_ value: AnyCodable?) -> Double? {
        if let number = value?.doubleValue, number >= 0 { return number }
        guard let raw = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty
        else { return nil }
        if let number = Double(raw), number >= 0 { return number }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        return date.map { $0.timeIntervalSince1970 * 1000 }
    }

    private static func firstNonBlank(_ values: String?...) -> String? {
        values.lazy.compactMap(self.nonBlank).first
    }

    private static func nonBlank(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

extension OpenClawChatViewModel {
    func handleTaskEvent(_ event: OpenClawChatTaskEvent) {
        switch event {
        case let .upserted(task):
            self.foldSubagentTask(task)
        case let .deleted(taskID):
            self.updateSubagentActivityState { $0.remove(taskID: taskID) }
        case .restored:
            let session = self.currentSessionSnapshot()
            Task { await self.refreshSubagentActivities(sessionSnapshot: session) }
        }
    }

    func refreshSubagentActivities(sessionSnapshot: SessionSnapshot) async {
        let baseline = self.subagentActivityState.activitiesByID
        let tasks: [TaskSummary]
        do {
            tasks = try await self.transport.listTasks(
                sessionKey: sessionSnapshot.key,
                agentID: sessionSnapshot.deliveryAgentID)
        } catch {
            return
        }
        guard self.isCurrentSession(sessionSnapshot) else { return }
        self.updateSubagentActivityState { state in
            let now = Date().timeIntervalSince1970 * 1000
            for task in tasks where self.isCurrentSubagentTask(task) {
                // A task event received during this request is newer than its list snapshot.
                guard state.activitiesByID[task.id] == baseline[task.id] else { continue }
                state.upsert(task, nowMilliseconds: now, source: .snapshot)
            }
            state.removeExpired(nowMilliseconds: now)
        }
    }

    func clearSubagentActivities() {
        self.subagentActivityCleanupTask?.cancel()
        self.subagentActivityCleanupTask = nil
        self.subagentActivityState.removeAll()
        self.subagentActivities = []
        self.hiddenWorkingSubagentCount = 0
    }

    private func foldSubagentTask(_ task: TaskSummary) {
        guard self.isCurrentSubagentTask(task) else { return }
        self.updateSubagentActivityState { state in
            let now = Date().timeIntervalSince1970 * 1000
            state.upsert(task, nowMilliseconds: now)
            state.removeExpired(nowMilliseconds: now)
        }
    }

    private func isCurrentSubagentTask(_ task: TaskSummary) -> Bool {
        guard task.runtime == "subagent",
              let requesterSessionKey = task.sessionkey
        else { return false }
        return self.matchesCurrentSessionKey(
            incoming: requesterSessionKey,
            agentId: task.agentid,
            current: self.sessionKey)
    }

    private func updateSubagentActivityState(
        _ update: (inout ChatSubagentActivityState) -> Void)
    {
        let previous = self.subagentActivityState
        update(&self.subagentActivityState)
        guard self.subagentActivityState != previous else { return }
        let presentation = self.subagentActivityState.presentation()
        self.subagentActivities = presentation.rows
        self.hiddenWorkingSubagentCount = presentation.hiddenWorkingCount
        self.scheduleSubagentActivityCleanup()
        self.markTimelineChanged()
    }

    private func scheduleSubagentActivityCleanup() {
        self.subagentActivityCleanupTask?.cancel()
        guard let expiry = self.subagentActivityState.nextExpiryMilliseconds() else {
            self.subagentActivityCleanupTask = nil
            return
        }
        let now = Date().timeIntervalSince1970 * 1000
        let delay = max(0, Int64((expiry - now).rounded(.up)))
        self.subagentActivityCleanupTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.updateSubagentActivityState { state in
                state.removeExpired(nowMilliseconds: Date().timeIntervalSince1970 * 1000)
            }
        }
    }
}
