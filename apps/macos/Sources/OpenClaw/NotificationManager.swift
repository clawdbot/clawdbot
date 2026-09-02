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

    func send(title: String, body: String, sound: String?, priority: NotificationPriority? = nil) async -> Bool {
        guard PermissionManager.notificationCenterAvailable else {
            self.logger.warning("notification skipped: process has no bundle identity")
            return false
        }
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings()
        guard !Task.isCancelled else { return false }
        if status.authorizationStatus == .notDetermined {
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

        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
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
