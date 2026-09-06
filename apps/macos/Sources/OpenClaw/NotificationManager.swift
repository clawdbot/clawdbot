import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit
import Security
import UserNotifications

@MainActor
struct NotificationManager {
    private let logger = Logger(subsystem: "ai.openclaw", category: "notifications")

    private static let hasTimeSensitiveEntitlement: Bool = {
        guard let task = SecTaskCreateFromSelf(nil) else { return false }
        let key = "com.apple.developer.usernotifications.time-sensitive" as CFString
        guard let val = SecTaskCopyValueForEntitlement(task, key, nil) else { return false }
        return (val as? Bool) == true
    }()

    func send(
        title: String,
        body: String,
        sound: String?,
        priority: NotificationPriority? = nil,
        identifier: String = UUID().uuidString,
        requestPermission: Bool = true,
        isCurrent: () -> Bool = { true }) async -> Bool
    {
        guard PermissionManager.notificationCenterAvailable else {
            self.logger.warning("notification skipped: process has no bundle identity")
            return false
        }
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings()
        guard !Task.isCancelled else { return false }
        if status.authorizationStatus == .notDetermined {
            guard requestPermission else { return false }
            let granted = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            guard !Task.isCancelled else { return false }
            if granted != true {
                self.logger.warning("notification permission denied (request)")
                return false
            }
        } else if !PermissionManager.isNotificationAuthorized(status: status.authorizationStatus) {
            self.logger.warning("notification permission denied status=\(status.authorizationStatus.rawValue)")
            return false
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let soundName = sound, !soundName.isEmpty {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(soundName))
        }

        // Set interruption level based on priority
        if let priority {
            switch priority {
            case .passive:
                content.interruptionLevel = .passive
            case .active:
                content.interruptionLevel = .active
            case .timeSensitive:
                if Self.hasTimeSensitiveEntitlement {
                    content.interruptionLevel = .timeSensitive
                } else {
                    self.logger.debug(
                        "time-sensitive notification requested without entitlement; falling back to active")
                    content.interruptionLevel = .active
                }
            }
        }

        guard isCurrent() else { return false }
        let req = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        do {
            try await LiveNotificationCenter(center: center).add(req)
            self.logger.debug("notification queued")
            return true
        } catch {
            self.logger.error("notification send failed: \(error.localizedDescription)")
            return false
        }
    }
}

@MainActor
struct BackgroundSessionNotificationActions {
    private struct Action {
        let sourceIdentifier: String
        let open: () -> Void
    }

    private var actions: [String: Action] = [:]
    private var actionOrder: [String] = []
    private let maximumActions = 64

    mutating func begin(sourceIdentifier: String, open: @escaping () -> Void)
        -> (identifier: String, retired: [String])?
    {
        guard !self.actions.values.contains(where: { $0.sourceIdentifier == sourceIdentifier }) else { return nil }
        // Actions retain routes, not windows. Retire the matching OS notice when
        // bounding this process-lifetime queue so eviction leaves no dead button.
        let retired = self.actionOrder.count >= self.maximumActions ? self.retire([self.actionOrder[0]]) : []
        let requestIdentifier = "background-session-\(UUID().uuidString)"
        self.actions[requestIdentifier] = Action(sourceIdentifier: sourceIdentifier, open: open)
        self.actionOrder.append(requestIdentifier)
        return (requestIdentifier, retired)
    }

    func contains(_ identifier: String) -> Bool {
        self.actions[identifier] != nil
    }

    func openAction(for identifier: String) -> (() -> Void)? {
        self.actions[identifier]?.open
    }

    mutating func finish(identifier: String, sent: Bool, sourceIsCurrent: Bool) -> [String] {
        // add's completion can follow retirement. Each attempt owns a distinct
        // OS identifier, so late cleanup cannot remove a replacement notice.
        sent && self.contains(identifier) && sourceIsCurrent ? [] : self.retire([identifier])
    }

    mutating func retire(_ identifiers: [String]) -> [String] {
        let removed = Set(identifiers)
        self.actionOrder.removeAll { removed.contains($0) }
        for identifier in identifiers {
            self.actions.removeValue(forKey: identifier)
        }
        return identifiers
    }

    mutating func stop() -> [String] {
        self.retire(self.actionOrder)
    }
}

@MainActor
final class BackgroundSessionNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = BackgroundSessionNotifications()

    private var actions = BackgroundSessionNotificationActions()
    private var isRunning = false

    func start() {
        guard PermissionManager.notificationCenterAvailable else { return }
        UNUserNotificationCenter.current().delegate = self
        self.isRunning = true
    }

    func stop() {
        self.isRunning = false
        self.remove(self.actions.stop())
    }

    func send(identifier: String, isCurrent: @escaping () -> Bool, open: @escaping () -> Void) async {
        guard self.isRunning else { return }
        guard let admission = self.actions.begin(sourceIdentifier: identifier, open: open) else { return }
        self.remove(admission.retired)
        let sent = await NotificationManager().send(
            title: "OpenClaw",
            body: "A background session finished. Open it to see the result.",
            sound: nil,
            identifier: admission.identifier,
            requestPermission: false,
            isCurrent: { self.actions.contains(admission.identifier) && isCurrent() })
        self.remove(self.actions.finish(identifier: admission.identifier, sent: sent, sourceIsCurrent: isCurrent()))
    }

    private func remove(_ identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        guard PermissionManager.notificationCenterAvailable else { return }
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiers)
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void)
    {
        // This delegate is app-wide: an empty result would also silence existing
        // system.notify and test notifications that previously used OS presentation.
        completionHandler([.banner, .list, .sound, .badge])
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse) async
    {
        let identifier = response.notification.request.identifier
        let shouldOpen = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        await MainActor.run {
            if shouldOpen, identifier.hasPrefix("background-session-") {
                if let open = self.actions.openAction(for: identifier) {
                    open()
                } else {
                    let alert = NSAlert()
                    alert.messageText = "Background Session Notification Expired"
                    alert.informativeText = "Open the session from its Gateway's session list."
                    alert.runModal()
                }
            }
            self.remove(self.actions.retire([identifier]))
        }
    }
}

enum TestNotificationOutcome: Encodable, Equatable {
    case pending
    case sent
    case error(String)

    private enum State: String, Encodable {
        case pending
        case sent
        case error
    }

    private enum CodingKeys: String, CodingKey {
        case state
        case message
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .pending:
            try container.encode(State.pending, forKey: .state)
        case .sent:
            try container.encode(State.sent, forKey: .state)
        case let .error(message):
            try container.encode(State.error, forKey: .state)
            try container.encode(message, forKey: .message)
        }
    }
}

@MainActor
enum TestNotificationAction {
    static func send() async -> TestNotificationOutcome {
        let sent = await NotificationManager().send(
            title: "OpenClaw",
            body: "Test notification",
            sound: nil)
        return sent
            ? .sent
            : .error("Notification could not be sent. Check System Settings → Notifications and try again.")
    }
}
