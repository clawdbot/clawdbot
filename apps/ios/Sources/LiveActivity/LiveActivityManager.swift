@preconcurrency import ActivityKit
import Foundation
import os

/// Minimal Live Activity lifecycle focused on connection health + stale cleanup.
@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "LiveActivity")
    private let connectingStaleSeconds: TimeInterval = 120
    private let hydrationStaleSeconds: TimeInterval = 300
    private var currentActivity: Activity<OpenClawActivityAttributes>?
    private var activityStartDate: Date = .now

    private init() {
        self.hydrateCurrentAndPruneDuplicates()
    }

    var isActive: Bool {
        guard let activity = self.currentActivity else { return false }
        guard activity.activityState == .active else {
            self.currentActivity = nil
            return false
        }
        return true
    }

    func showConnecting(statusText: String = "Connecting...", agentName: String, sessionKey: String) {
        self.hydrateCurrentAndPruneDuplicates()

        if self.currentActivity != nil {
            self.handleConnecting(statusText: statusText)
            return
        }

        let authInfo = ActivityAuthorizationInfo()
        guard authInfo.areActivitiesEnabled else {
            self.logger.info("Live Activities disabled; skipping start")
            return
        }

        self.activityStartDate = .now
        let attributes = OpenClawActivityAttributes(agentName: agentName, sessionKey: sessionKey)
        let state = self.connectingState(statusText: statusText)

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
                    content: ActivityContent(state: self.attentionState(statusText: statusText), staleDate: nil),
                    pushType: nil)
                self.currentActivity = activity
                self.logger.info("started attention live activity id=\(activity.id, privacy: .public)")
            } catch {
                self.logger.error(
                    "failed to start attention live activity: \(error.localizedDescription, privacy: .public)")
            }
            return
        }

        self.updateCurrent(state: self.attentionState(statusText: statusText), staleDate: nil)
    }

    func handleConnecting(statusText: String = "Connecting...") {
        self.updateCurrent(
            state: self.connectingState(statusText: statusText),
            staleDate: Date().addingTimeInterval(self.connectingStaleSeconds))
    }

    func handleReconnect() {
        self.endActivity(reason: "connected")
    }

    func handleDisconnect() {
        self.endActivity(reason: "disconnected")
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
            guard !state.isIdle, !state.isDisconnected else { return false }
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

    private func connectingState(statusText: String = "Connecting...") -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: statusText,
            isIdle: false,
            isDisconnected: false,
            isConnecting: true,
            startedAt: self.activityStartDate)
    }

    private func attentionState(statusText: String) -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: statusText,
            isIdle: false,
            isDisconnected: false,
            isConnecting: false,
            startedAt: self.activityStartDate)
    }

    private func idleState() -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: "Idle",
            isIdle: true,
            isDisconnected: false,
            isConnecting: false,
            startedAt: self.activityStartDate)
    }

    private func disconnectedState() -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: "Disconnected",
            isIdle: false,
            isDisconnected: true,
            isConnecting: false,
            startedAt: self.activityStartDate)
    }
}
