@preconcurrency import ActivityKit
import Foundation
import os

/// Minimal Live Activity lifecycle focused on connection health + stale cleanup.
@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "LiveActivity")
    private let connectingStaleSeconds: TimeInterval = 120
    private let hydrationStaleSeconds: TimeInterval = 300
    private var currentActivity: Activity<OpenClawActivityAttributes>?
    private var activityStartDate: Date = .now

    private init() {
        self.hydrateCurrentAndPruneDuplicates()
    }

    func showConnecting(
        statusText: String = String(localized: "Connecting..."),
        agentName: String,
        sessionKey: String)
    {
        let presentation = Self.connectingPresentation(statusText: statusText)
        self.hydrateCurrentAndPruneDuplicates()

        if self.currentActivity != nil {
            self.handleConnecting(presentation: presentation)
            return
        }

        let authInfo = ActivityAuthorizationInfo()
        guard authInfo.areActivitiesEnabled else {
            self.logger.info("Live Activities disabled; skipping start")
            return
        }

        self.activityStartDate = .now
        let attributes = OpenClawActivityAttributes(agentName: agentName, sessionKey: sessionKey)
        let state = self.connectingState(presentation: presentation)

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: ActivityContent(
                    state: state,
                    staleDate: Date().addingTimeInterval(self.connectingStaleSeconds)),
                pushType: nil)
            self.currentActivity = activity
            self.logger.info("started live activity id=\(activity.id, privacy: .public)")
        } catch {
            self.logger.error("failed to start live activity: \(error.localizedDescription, privacy: .public)")
        }
    }

    func showAttention(statusText: String, agentName: String, sessionKey: String) {
        let presentation = Self.attentionPresentation(statusText: statusText)
        self.hydrateCurrentAndPruneDuplicates()

        if self.currentActivity == nil {
            let authInfo = ActivityAuthorizationInfo()
            guard authInfo.areActivitiesEnabled else {
                self.logger.info("Live Activities disabled; skipping attention state")
                return
            }
            self.activityStartDate = .now
            let attributes = OpenClawActivityAttributes(agentName: agentName, sessionKey: sessionKey)
            do {
                let activity = try Activity.request(
                    attributes: attributes,
                    content: ActivityContent(state: self.attentionState(presentation: presentation), staleDate: nil),
                    pushType: nil)
                self.currentActivity = activity
                self.logger.info("started attention live activity id=\(activity.id, privacy: .public)")
            } catch {
                self.logger.error(
                    "failed to start attention live activity: \(error.localizedDescription, privacy: .public)")
            }
            return
        }

        self.updateCurrent(state: self.attentionState(presentation: presentation), staleDate: nil)
    }

    private func handleConnecting(presentation: StatusPresentation) {
        self.updateCurrent(
            state: self.connectingState(presentation: presentation),
            staleDate: Date().addingTimeInterval(self.connectingStaleSeconds))
    }

    func handleReconnect() {
        self.endActivity(reason: "connected")
    }

    func endActivity(reason: String) {
        guard let activity = self.currentActivity else { return }
        self.currentActivity = nil
        self.logger.info("ending live activity reason=\(reason, privacy: .public)")
        Task {
            await activity.end(
                ActivityContent(state: self.disconnectedState(), staleDate: nil),
                dismissalPolicy: .immediate)
        }
    }

    private func hydrateCurrentAndPruneDuplicates() {
        let active = Activity<OpenClawActivityAttributes>.activities
        guard !active.isEmpty else {
            self.currentActivity = nil
            return
        }

        let now = Date()
        let candidates = active.filter { activity in
            let state = activity.content.state
            guard activity.activityState == .active else { return false }
            guard state.status != .idle, state.status != .disconnected else { return false }
            return now.timeIntervalSince(state.startedAt) < self.hydrationStaleSeconds
        }

        guard !candidates.isEmpty else {
            self.currentActivity = nil
            for activity in active {
                self.end(activity: activity)
            }
            return
        }

        let keeper = candidates.max { lhs, rhs in
            lhs.content.state.startedAt < rhs.content.state.startedAt
        } ?? candidates[0]

        self.currentActivity = keeper
        self.activityStartDate = keeper.content.state.startedAt

        let stale = active.filter { $0.id != keeper.id }
        for activity in stale {
            self.end(activity: activity)
        }
    }

    private func updateCurrent(state: OpenClawActivityAttributes.ContentState, staleDate: Date? = nil) {
        guard let activity = self.currentActivity, activity.activityState == .active else {
            self.currentActivity = nil
            return
        }
        Task {
            await activity.update(ActivityContent(state: state, staleDate: staleDate))
        }
    }

    private func end(activity: Activity<OpenClawActivityAttributes>) {
        Task {
            await activity.end(
                ActivityContent(state: self.disconnectedState(), staleDate: nil),
                dismissalPolicy: .immediate)
        }
    }

    private struct StatusPresentation {
        let status: OpenClawActivityAttributes.ContentState.Status
        let verbatimDetail: String?
    }

    /// Existing callers still pass rendered app copy. Collapse known values here so
    /// ActivityKit persists semantics; only unknown external detail remains verbatim.
    private static func connectingPresentation(statusText: String) -> StatusPresentation {
        if statusText == String(localized: "Connecting...") || statusText == "Connecting..." {
            return StatusPresentation(status: .connecting, verbatimDetail: nil)
        }
        if statusText == String(localized: "Reconnecting...") || statusText == "Reconnecting..." {
            return StatusPresentation(status: .reconnecting, verbatimDetail: nil)
        }
        return StatusPresentation(status: .connecting, verbatimDetail: self.normalizedDetail(statusText))
    }

    private static func attentionPresentation(statusText: String) -> StatusPresentation {
        if statusText == String(localized: "Approval needed") || statusText == "Approval needed" {
            return StatusPresentation(status: .approvalNeeded, verbatimDetail: nil)
        }
        if statusText == String(localized: "Action required") || statusText == "Action required" {
            return StatusPresentation(status: .actionRequired, verbatimDetail: nil)
        }
        return StatusPresentation(status: .attention, verbatimDetail: self.normalizedDetail(statusText))
    }

    private static func normalizedDetail(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func connectingState(presentation: StatusPresentation) -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            status: presentation.status,
            verbatimDetail: presentation.verbatimDetail,
            startedAt: self.activityStartDate)
    }

    private func attentionState(presentation: StatusPresentation) -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            status: presentation.status,
            verbatimDetail: presentation.verbatimDetail,
            startedAt: self.activityStartDate)
    }

    private func disconnectedState() -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            status: .disconnected,
            verbatimDetail: nil,
            startedAt: self.activityStartDate)
    }
}
