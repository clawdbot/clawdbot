import Foundation
import UserNotifications

struct NotificationSnapshot: @unchecked Sendable {
    let identifier: String
    let userInfo: [AnyHashable: Any]
}

enum NotificationAuthorizationStatus {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral
}

enum NotificationServingPreference {
    static let storageKey = "notifications.serving.enabled"
    static let defaultEnabled = true

    static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: self.storageKey) != nil else {
            return self.defaultEnabled
        }
        return defaults.bool(forKey: self.storageKey)
    }
}

protocol NotificationCentering: Sendable {
    func authorizationStatus() async -> NotificationAuthorizationStatus
    func add(_ request: UNNotificationRequest) async throws
    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) async
    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) async
    func deliveredNotifications() async -> [NotificationSnapshot]
}

struct LiveNotificationCenter: NotificationCentering, @unchecked Sendable {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func authorizationStatus() async -> NotificationAuthorizationStatus {
        let settings = await self.center.notificationSettings()
        return switch settings.authorizationStatus {
        case .authorized:
            .authorized
        case .provisional:
            .provisional
        case .ephemeral:
            .ephemeral
        case .denied:
            .denied
        case .notDetermined:
            .notDetermined
        @unknown default:
            .denied
        }
    }

    func add(_ request: UNNotificationRequest) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.center.add(request) { error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: ())
                }
            }
        }
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) async {
        guard !identifiers.isEmpty else { return }
        self.center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) async {
        guard !identifiers.isEmpty else { return }
        self.center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    func deliveredNotifications() async -> [NotificationSnapshot] {
        await withCheckedContinuation { continuation in
            self.center.getDeliveredNotifications { notifications in
                continuation.resume(
                    returning: notifications.map { notification in
                        NotificationSnapshot(
                            identifier: notification.request.identifier,
                            userInfo: notification.request.content.userInfo)
                    })
            }
        }
    }
}
