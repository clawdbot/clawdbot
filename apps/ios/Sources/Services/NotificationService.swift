import Foundation
import UserNotifications

/// Keeps notification failures Sendable across the system prompt and timeout tasks.
struct NotificationCallError: Error {
    let message: String
}

private final class NotificationInvokeLatch<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Result<Value, NotificationCallError>, Never>?
    private var resumed = false

    func setContinuation(_ continuation: CheckedContinuation<Result<Value, NotificationCallError>, Never>) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.continuation = continuation
    }

    func resume(_ result: Result<Value, NotificationCallError>) {
        self.lock.lock()
        guard !self.resumed else {
            self.lock.unlock()
            return
        }
        self.resumed = true
        let continuation = self.continuation
        self.continuation = nil
        self.lock.unlock()
        continuation?.resume(returning: result)
    }
}

@MainActor
enum NotificationOperationRunner {
    /// System permission prompts can stall indefinitely; the latch makes the timeout
    /// and operation race resume exactly once without blocking the app's main actor.
    static func run<Value: Sendable>(
        timeoutSeconds: Double,
        operation: @escaping @Sendable () async throws -> Value) async -> Result<Value, NotificationCallError>
    {
        let latch = NotificationInvokeLatch<Value>()
        var operationTask: Task<Void, Never>?
        var timeoutTask: Task<Void, Never>?
        defer {
            operationTask?.cancel()
            timeoutTask?.cancel()
        }
        let timeout = max(0, timeoutSeconds)
        return await withCheckedContinuation { continuation in
            latch.setContinuation(continuation)
            operationTask = Task { @MainActor in
                do {
                    try await latch.resume(.success(operation()))
                } catch {
                    latch.resume(.failure(NotificationCallError(message: error.localizedDescription)))
                }
            }
            timeoutTask = Task.detached {
                if timeout > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                }
                latch.resume(.failure(NotificationCallError(message: "notification request timed out")))
            }
        }
    }
}

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
