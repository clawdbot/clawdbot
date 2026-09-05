import Foundation
import OpenClawKit

/// Keeps notification failures Sendable across the system prompt and timeout tasks.
struct NotificationCallError: Error {
    let message: String
}

@MainActor
enum NotificationOperationRunner {
    /// Permission callbacks may ignore cancellation. The shared race retires their task
    /// before returning so late callbacks cannot start a notification for a cancelled caller.
    static func run<Value: Sendable>(
        timeoutSeconds: Double,
        operation: @escaping @Sendable () async throws -> Value) async -> Result<Value, NotificationCallError>
    {
        do {
            let value = try await AsyncTimeout.withTimeout(
                seconds: timeoutSeconds,
                onTimeout: { NotificationCallError(message: "notification request timed out") },
                operation: operation)
            return .success(value)
        } catch let error as NotificationCallError {
            return .failure(error)
        } catch {
            return .failure(NotificationCallError(message: error.localizedDescription))
        }
    }
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
