import Foundation
@preconcurrency import UserNotifications

private struct ExecApprovalNotificationUTF8Key: Hashable {
    let bytes: [UInt8]

    init(_ rawValue: String) {
        self.bytes = Array(rawValue.utf8)
    }

    var notificationComponent: String {
        let hexDigits = Array("0123456789ABCDEF".utf8)
        var encoded: [UInt8] = []
        encoded.reserveCapacity(self.bytes.count)
        for byte in self.bytes {
            switch byte {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x2E, 0x5F, 0x7E:
                encoded.append(byte)
            default:
                encoded.append(0x25)
                encoded.append(hexDigits[Int(byte >> 4)])
                encoded.append(hexDigits[Int(byte & 0x0F)])
            }
        }
        guard let component = String(bytes: encoded, encoding: .utf8) else {
            preconditionFailure("Percent-encoded approval ID must be UTF-8")
        }
        return component
    }
}

private enum ExecApprovalNotificationID {
    static func validated(_ rawValue: String?) -> String? {
        ExecApprovalIdentifier.exact(rawValue)
    }

    static func key(_ rawValue: String?) -> ExecApprovalNotificationUTF8Key? {
        self.validated(rawValue).map(ExecApprovalNotificationUTF8Key.init)
    }
}

struct ExecApprovalNotificationPrompt: Codable, Equatable, Hashable {
    let approvalId: String
    let gatewayDeviceId: String?

    static func == (lhs: Self, rhs: Self) -> Bool {
        let sameApprovalID = ExecApprovalNotificationUTF8Key(lhs.approvalId) ==
            ExecApprovalNotificationUTF8Key(rhs.approvalId)
        let sameGatewayID = lhs.gatewayDeviceId.map(ExecApprovalNotificationUTF8Key.init) ==
            rhs.gatewayDeviceId.map(ExecApprovalNotificationUTF8Key.init)
        return sameApprovalID && sameGatewayID
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(ExecApprovalNotificationUTF8Key(self.approvalId))
        hasher.combine(self.gatewayDeviceId.map(ExecApprovalNotificationUTF8Key.init))
    }
}

enum ExecApprovalNotificationBridge {
    static let requestedKind = "exec.approval.requested"
    static let resolvedKind = "exec.approval.resolved"
    static let categoryIdentifier = "openclaw.exec-approval"
    static let reviewActionIdentifier = "openclaw.exec-approval.review"

    // A disjoint top-level namespace prevents encoded v2 identifiers from aliasing
    // arbitrary owner/id combinations created by the legacy dotted format.
    private static let encodedRequestPrefix = "exec.approval-v2."
    private static let legacyRequestPrefix = "exec.approval."

    static func registerCategory(center: UNUserNotificationCenter = .current()) {
        let category = UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [
                UNNotificationAction(
                    identifier: reviewActionIdentifier,
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
        self.parsePush(userInfo: userInfo, expectedKind: self.requestedKind) != nil
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
        return self.parseRequestedPush(userInfo: userInfo)
    }

    static func parseRequestedPush(userInfo: [AnyHashable: Any]) -> ExecApprovalNotificationPrompt? {
        self.parsePush(userInfo: userInfo, expectedKind: self.requestedKind)
    }

    static func parseResolvedPush(userInfo: [AnyHashable: Any]) -> ExecApprovalNotificationPrompt? {
        self.parsePush(userInfo: userInfo, expectedKind: self.resolvedKind)
    }

    @MainActor
    static func removeNotifications(
        for push: ExecApprovalNotificationPrompt,
        notificationCenter: NotificationCentering,
        includingLegacyOwnerless: Bool = false) async
    {
        guard let requestIdentifier = self.localRequestIdentifier(for: push) else { return }
        let legacyOwner = push.gatewayDeviceId ?? "legacy"
        var pendingIdentifiers = [
            requestIdentifier,
            "\(self.legacyRequestPrefix)\(legacyOwner).\(push.approvalId)",
        ]
        if includingLegacyOwnerless {
            pendingIdentifiers.append("\(self.legacyRequestPrefix)\(push.approvalId)")
            if let ownerlessIdentifier = self.localRequestIdentifier(for: ExecApprovalNotificationPrompt(
                approvalId: push.approvalId,
                gatewayDeviceId: nil))
            {
                pendingIdentifiers.append(ownerlessIdentifier)
            }
        }
        var seenPendingIdentifiers = Set<String>()
        pendingIdentifiers = pendingIdentifiers.filter { seenPendingIdentifiers.insert($0).inserted }
        await notificationCenter.removePendingNotificationRequests(
            withIdentifiers: pendingIdentifiers)

        let delivered = await notificationCenter.deliveredNotifications()
        let identifiers = delivered.compactMap { snapshot -> String? in
            guard let requestedPush = self.parseRequestedPush(userInfo: snapshot.userInfo) else { return nil }
            let matchesCurrentOwner = requestedPush == push
            let matchesLegacyOwnerless = includingLegacyOwnerless &&
                ExecApprovalNotificationUTF8Key(requestedPush.approvalId) ==
                ExecApprovalNotificationUTF8Key(push.approvalId) &&
                requestedPush.gatewayDeviceId == nil
            guard matchesCurrentOwner || matchesLegacyOwnerless else { return nil }
            return snapshot.identifier
        }
        await notificationCenter.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    static func approvalID(from userInfo: [AnyHashable: Any]) -> String? {
        let raw = self.openClawPayload(userInfo: userInfo)?["approvalId"] as? String
        return ExecApprovalNotificationID.validated(raw)
    }

    private static func parsePush(
        userInfo: [AnyHashable: Any],
        expectedKind: String) -> ExecApprovalNotificationPrompt?
    {
        guard let payload = self.openClawPayload(userInfo: userInfo),
              self.payloadKind(userInfo: userInfo) == expectedKind,
              let approvalId = approvalID(from: userInfo)
        else {
            return nil
        }
        let gatewayDeviceId: String?
        if let rawGatewayDeviceId = payload["gatewayDeviceId"] {
            guard let rawGatewayDeviceId = rawGatewayDeviceId as? String,
                  let exactGatewayDeviceId = GatewayStableIdentifier.exact(rawGatewayDeviceId)
            else { return nil }
            gatewayDeviceId = exactGatewayDeviceId
        } else {
            gatewayDeviceId = nil
        }
        return ExecApprovalNotificationPrompt(
            approvalId: approvalId,
            gatewayDeviceId: gatewayDeviceId)
    }

    private static func localRequestIdentifier(for push: ExecApprovalNotificationPrompt) -> String? {
        let owner = push.gatewayDeviceId ?? "legacy"
        guard let approvalComponent = ExecApprovalNotificationID.key(push.approvalId)?.notificationComponent else {
            return nil
        }
        let ownerComponent = ExecApprovalNotificationUTF8Key(owner).notificationComponent
        return "\(self.encodedRequestPrefix)\(ownerComponent.utf8.count):\(ownerComponent).\(approvalComponent)"
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
