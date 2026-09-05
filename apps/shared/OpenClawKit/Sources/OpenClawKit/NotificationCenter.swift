import Foundation
import UserNotifications

public struct NotificationSnapshot: @unchecked Sendable {
    public let identifier: String
    public let userInfo: [AnyHashable: Any]
}

public enum NotificationAuthorizationStatus: Sendable {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral
}

public protocol NotificationCentering: Sendable {
    func authorizationStatus() async -> NotificationAuthorizationStatus
    func add(_ request: UNNotificationRequest) async throws
    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) async
    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) async
    func deliveredNotifications() async -> [NotificationSnapshot]
}

public struct LiveNotificationCenter: NotificationCentering, @unchecked Sendable {
    private let center: UNUserNotificationCenter

    public init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    public func authorizationStatus() async -> NotificationAuthorizationStatus {
        let settings = await self.center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized:
            return .authorized
        case .provisional:
            return .provisional
        #if os(iOS)
        case .ephemeral:
            return .ephemeral
        #endif
        case .denied:
            return .denied
        case .notDetermined:
            return .notDetermined
        @unknown default:
            return .denied
        }
    }

    public func add(_ request: UNNotificationRequest) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            // Permission reads do not cancel with their caller; retire its effect before enqueueing.
            guard !Task.isCancelled else {
                cont.resume(throwing: CancellationError())
                return
            }
            self.center.add(request) { error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: ())
                }
            }
        }
    }

    public func removePendingNotificationRequests(withIdentifiers identifiers: [String]) async {
        guard !identifiers.isEmpty else { return }
        self.center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    public func removeDeliveredNotifications(withIdentifiers identifiers: [String]) async {
        guard !identifiers.isEmpty else { return }
        self.center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    public func deliveredNotifications() async -> [NotificationSnapshot] {
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
