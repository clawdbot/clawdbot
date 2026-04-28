import Foundation
@preconcurrency import UserNotifications

struct ExecApprovalNotificationPrompt: Equatable {
    let approvalId: String
}

enum ExecApprovalNotificationBridge {
    static let requestedKind = "exec.approval.requested"
    static let resolvedKind = "exec.approval.resolved"
    static let categoryIdentifier = "openclaw.exec-approval"
    static let reviewActionIdentifier = "openclaw.exec-approval.review"

    private static let localRequestPrefix = "exec.approval."

    static func registerCategory(center: UNUserNotificationCenter = .current()) {
        let category = UNNotificationCategory(
            identifier: self.categoryIdentifier,
            actions: [
                UNNotificationAction(
                    identifier: self.reviewActionIdentifier,
                    title: "Review",
                    options: [.foreground]),
            ],
            intentIdentifiers: [],
            options: [])

        center.getNotificationCategories { categories in
            var updated = categories
            updated.update(with: category)
            center.setNotificationCategories(updated)
        }
    }

    static func shouldPresentNotification(userInfo: [AnyHashable: Any]) -> Bool {
        self.payloadKind(userInfo: userInfo) == self.requestedKind
    }

    static func parsePrompt(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]) -> ExecApprovalNotificationPrompt?
    {
        guard actionIdentifier == UNNotificationDefaultActionIdentifier
            || actionIdentifier == self.reviewActionIdentifier
        else {
            return nil
        }
        guard self.payloadKind(userInfo: userInfo) == self.requestedKind else { return nil }
        guard let approvalId = self.approvalID(from: userInfo) else { return nil }
        return ExecApprovalNotificationPrompt(approvalId: approvalId)
    }

    @MainActor
    static func handleResolvedPushIfNeeded(
        userInfo: [AnyHashable: Any],
        notificationCenter: NotificationCentering) async -> Bool
    {
        guard self.payloadKind(userInfo: userInfo) == self.resolvedKind,
              let approvalId = self.approvalID(from: userInfo)
        else {
            return false
        }

        await self.removeNotifications(forApprovalID: approvalId, notificationCenter: notificationCenter)
        return true
    }

    @MainActor
    static func removeNotifications(
        forApprovalID approvalId: String,
        notificationCenter: NotificationCentering) async
    {
        let normalizedID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedID.isEmpty else { return }

        await notificationCenter.removePendingNotificationRequests(
            withIdentifiers: [self.localRequestIdentifier(for: normalizedID)])

        let delivered = await notificationCenter.deliveredNotifications()
        let identifiers = delivered.compactMap { snapshot -> String? in
            guard self.approvalID(from: snapshot.userInfo) == normalizedID else { return nil }
            return snapshot.identifier
        }
        await notificationCenter.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    static func approvalID(from userInfo: [AnyHashable: Any]) -> String? {
        let raw = self.openClawPayload(userInfo: userInfo)?["approvalId"] as? String
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func localRequestIdentifier(for approvalId: String) -> String {
        "\(self.localRequestPrefix)\(approvalId)"
    }

    static func payloadKind(userInfo: [AnyHashable: Any]) -> String {
        let raw = self.openClawPayload(userInfo: userInfo)?["kind"] as? String
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "unknown" : trimmed
    }

    private static func openClawPayload(userInfo: [AnyHashable: Any]) -> [String: Any]? {
        if let payload = userInfo["openclaw"] as? [String: Any] {
            return payload
        }
        if let payload = userInfo["openclaw"] as? [AnyHashable: Any] {
            return payload.reduce(into: [String: Any]()) { partialResult, pair in
                guard let key = pair.key as? String else { return }
                partialResult[key] = pair.value
            }
        }
        return nil
    }
}
