import Foundation
import OpenClawProtocol
@preconcurrency import UserNotifications

private struct ApprovalNotificationUTF8Key: Hashable {
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

private enum ApprovalNotificationID {
    static func validated(_ rawValue: String?) -> String? {
        ExecApprovalIdentifier.exact(rawValue)
    }

    static func key(_ rawValue: String?) -> ApprovalNotificationUTF8Key? {
        self.validated(rawValue).map(ApprovalNotificationUTF8Key.init)
    }
}

struct ApprovalNotificationPrompt: Codable, Equatable, Hashable {
    let approvalId: String
    let gatewayDeviceId: String?
    let kind: ApprovalKind

    init(
        approvalId: String,
        gatewayDeviceId: String?,
        kind: ApprovalKind = .exec)
    {
        self.approvalId = approvalId
        self.gatewayDeviceId = gatewayDeviceId
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey {
        case approvalId
        case gatewayDeviceId
        case kind
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.approvalId = try container.decode(String.self, forKey: .approvalId)
        self.gatewayDeviceId = try container.decodeIfPresent(String.self, forKey: .gatewayDeviceId)
        // Persisted exec recovery pushes predate the kind tag.
        self.kind = try container.decodeIfPresent(ApprovalKind.self, forKey: .kind) ?? .exec
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        let sameApprovalID = ApprovalNotificationUTF8Key(lhs.approvalId) ==
            ApprovalNotificationUTF8Key(rhs.approvalId)
        let sameGatewayID = lhs.gatewayDeviceId.map(ApprovalNotificationUTF8Key.init) ==
            rhs.gatewayDeviceId.map(ApprovalNotificationUTF8Key.init)
        return lhs.kind == rhs.kind && sameApprovalID && sameGatewayID
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(self.kind)
        hasher.combine(ApprovalNotificationUTF8Key(self.approvalId))
        hasher.combine(self.gatewayDeviceId.map(ApprovalNotificationUTF8Key.init))
    }
}

typealias ExecApprovalNotificationPrompt = ApprovalNotificationPrompt

private struct ApprovalNotificationConfiguration {
    let kind: ApprovalKind
    let requestedKind: String
    let resolvedKind: String
    let categoryIdentifier: String
    let reviewActionIdentifier: String
    let encodedRequestPrefix: String
    let legacyRequestPrefix: String
}

enum ApprovalNotificationBridge {
    static func registerCategories(center: UNUserNotificationCenter = .current()) {
        let categories = [
            ExecApprovalNotificationBridge.configuration,
            PluginApprovalNotificationBridge.configuration,
        ].map(self.category(for:))
        center.getNotificationCategories { existingCategories in
            var updated = existingCategories
            for category in categories {
                updated.update(with: category)
            }
            center.setNotificationCategories(updated)
        }
    }

    static func parsePrompt(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt?
    {
        self.parsePrompt(
            actionIdentifier: actionIdentifier,
            userInfo: userInfo,
            configuration: ExecApprovalNotificationBridge.configuration)
            ?? self.parsePrompt(
                actionIdentifier: actionIdentifier,
                userInfo: userInfo,
                configuration: PluginApprovalNotificationBridge.configuration)
    }

    static func parseRequestedPush(userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt? {
        let exec = ExecApprovalNotificationBridge.configuration
        let plugin = PluginApprovalNotificationBridge.configuration
        return self.parsePush(userInfo: userInfo, expectedKind: exec.requestedKind, configuration: exec)
            ?? self.parsePush(
                userInfo: userInfo,
                expectedKind: plugin.requestedKind,
                configuration: plugin)
    }

    static func parseResolvedPush(userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt? {
        let exec = ExecApprovalNotificationBridge.configuration
        let plugin = PluginApprovalNotificationBridge.configuration
        return self.parsePush(userInfo: userInfo, expectedKind: exec.resolvedKind, configuration: exec)
            ?? self.parsePush(
                userInfo: userInfo,
                expectedKind: plugin.resolvedKind,
                configuration: plugin)
    }

    @MainActor
    static func removeNotifications(
        for push: ApprovalNotificationPrompt,
        notificationCenter: NotificationCentering,
        includingLegacyOwnerless: Bool = false) async
    {
        guard let configuration = configuration(for: push.kind) else { return }
        await self.removeNotifications(
            for: push,
            notificationCenter: notificationCenter,
            includingLegacyOwnerless: includingLegacyOwnerless,
            configuration: configuration)
    }

    fileprivate static func shouldPresentNotification(
        userInfo: [AnyHashable: Any],
        configuration: ApprovalNotificationConfiguration) -> Bool
    {
        self.parsePush(
            userInfo: userInfo,
            expectedKind: configuration.requestedKind,
            configuration: configuration) != nil
    }

    fileprivate static func parsePrompt(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any],
        configuration: ApprovalNotificationConfiguration) -> ApprovalNotificationPrompt?
    {
        guard actionIdentifier == UNNotificationDefaultActionIdentifier
            || actionIdentifier == configuration.reviewActionIdentifier
        else {
            return nil
        }
        return self.parsePush(
            userInfo: userInfo,
            expectedKind: configuration.requestedKind,
            configuration: configuration)
    }

    fileprivate static func parseRequestedPush(
        userInfo: [AnyHashable: Any],
        configuration: ApprovalNotificationConfiguration) -> ApprovalNotificationPrompt?
    {
        self.parsePush(
            userInfo: userInfo,
            expectedKind: configuration.requestedKind,
            configuration: configuration)
    }

    fileprivate static func parseResolvedPush(
        userInfo: [AnyHashable: Any],
        configuration: ApprovalNotificationConfiguration) -> ApprovalNotificationPrompt?
    {
        self.parsePush(
            userInfo: userInfo,
            expectedKind: configuration.resolvedKind,
            configuration: configuration)
    }

    @MainActor
    fileprivate static func removeNotifications(
        for push: ApprovalNotificationPrompt,
        notificationCenter: NotificationCentering,
        includingLegacyOwnerless: Bool,
        configuration: ApprovalNotificationConfiguration) async
    {
        guard push.kind == configuration.kind,
              let requestIdentifier = localRequestIdentifier(for: push, configuration: configuration)
        else { return }
        let legacyOwner = push.gatewayDeviceId ?? "legacy"
        var pendingIdentifiers = [
            requestIdentifier,
            "\(configuration.legacyRequestPrefix)\(legacyOwner).\(push.approvalId)",
        ]
        if includingLegacyOwnerless {
            pendingIdentifiers.append("\(configuration.legacyRequestPrefix)\(push.approvalId)")
            if let ownerlessIdentifier = localRequestIdentifier(
                for: ApprovalNotificationPrompt(
                    approvalId: push.approvalId,
                    gatewayDeviceId: nil,
                    kind: push.kind),
                configuration: configuration)
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
            guard let requestedPush = self.parseRequestedPush(
                userInfo: snapshot.userInfo,
                configuration: configuration)
            else { return nil }
            let matchesCurrentOwner = requestedPush == push
            let matchesLegacyOwnerless = includingLegacyOwnerless &&
                ApprovalNotificationUTF8Key(requestedPush.approvalId) ==
                ApprovalNotificationUTF8Key(push.approvalId) &&
                requestedPush.gatewayDeviceId == nil
            guard matchesCurrentOwner || matchesLegacyOwnerless else { return nil }
            return snapshot.identifier
        }
        await notificationCenter.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    private static func category(
        for configuration: ApprovalNotificationConfiguration) -> UNNotificationCategory
    {
        UNNotificationCategory(
            identifier: configuration.categoryIdentifier,
            actions: [
                UNNotificationAction(
                    identifier: configuration.reviewActionIdentifier,
                    title: "Review",
                    options: [.foreground]),
            ],
            intentIdentifiers: [],
            options: [])
    }

    private static func configuration(for kind: ApprovalKind) -> ApprovalNotificationConfiguration? {
        switch kind {
        case .exec:
            ExecApprovalNotificationBridge.configuration
        case .plugin:
            PluginApprovalNotificationBridge.configuration
        case .systemAgent:
            nil
        }
    }

    private static func approvalID(from userInfo: [AnyHashable: Any]) -> String? {
        let raw = self.openClawPayload(userInfo: userInfo)?["approvalId"] as? String
        return ApprovalNotificationID.validated(raw)
    }

    private static func parsePush(
        userInfo: [AnyHashable: Any],
        expectedKind: String,
        configuration: ApprovalNotificationConfiguration) -> ApprovalNotificationPrompt?
    {
        guard let payload = openClawPayload(userInfo: userInfo),
              payloadKind(userInfo: userInfo) == expectedKind,
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
        return ApprovalNotificationPrompt(
            approvalId: approvalId,
            gatewayDeviceId: gatewayDeviceId,
            kind: configuration.kind)
    }

    private static func localRequestIdentifier(
        for push: ApprovalNotificationPrompt,
        configuration: ApprovalNotificationConfiguration) -> String?
    {
        let owner = push.gatewayDeviceId ?? "legacy"
        guard let approvalComponent = ApprovalNotificationID.key(push.approvalId)?.notificationComponent else {
            return nil
        }
        let ownerComponent = ApprovalNotificationUTF8Key(owner).notificationComponent
        return "\(configuration.encodedRequestPrefix)\(ownerComponent.utf8.count):" +
            "\(ownerComponent).\(approvalComponent)"
    }

    private static func payloadKind(userInfo: [AnyHashable: Any]) -> String {
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

enum ExecApprovalNotificationBridge {
    static let requestedKind = "exec.approval.requested"
    static let resolvedKind = "exec.approval.resolved"
    static let categoryIdentifier = "openclaw.exec-approval"
    static let reviewActionIdentifier = "openclaw.exec-approval.review"

    fileprivate static let configuration = ApprovalNotificationConfiguration(
        kind: .exec,
        requestedKind: ExecApprovalNotificationBridge.requestedKind,
        resolvedKind: ExecApprovalNotificationBridge.resolvedKind,
        categoryIdentifier: ExecApprovalNotificationBridge.categoryIdentifier,
        reviewActionIdentifier: ExecApprovalNotificationBridge.reviewActionIdentifier,
        encodedRequestPrefix: "exec.approval-v2.",
        legacyRequestPrefix: "exec.approval.")

    static func shouldPresentNotification(userInfo: [AnyHashable: Any]) -> Bool {
        ApprovalNotificationBridge.shouldPresentNotification(
            userInfo: userInfo,
            configuration: self.configuration)
    }

    static func parsePrompt(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt?
    {
        ApprovalNotificationBridge.parsePrompt(
            actionIdentifier: actionIdentifier,
            userInfo: userInfo,
            configuration: self.configuration)
    }

    static func parseRequestedPush(userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt? {
        ApprovalNotificationBridge.parseRequestedPush(
            userInfo: userInfo,
            configuration: self.configuration)
    }

    @MainActor
    static func removeNotifications(
        for push: ApprovalNotificationPrompt,
        notificationCenter: NotificationCentering,
        includingLegacyOwnerless: Bool = false) async
    {
        await ApprovalNotificationBridge.removeNotifications(
            for: push,
            notificationCenter: notificationCenter,
            includingLegacyOwnerless: includingLegacyOwnerless,
            configuration: self.configuration)
    }
}

enum PluginApprovalNotificationBridge {
    static let requestedKind = "plugin.approval.requested"
    static let resolvedKind = "plugin.approval.resolved"
    static let categoryIdentifier = "openclaw.plugin-approval"
    static let reviewActionIdentifier = "openclaw.plugin-approval.review"

    fileprivate static let configuration = ApprovalNotificationConfiguration(
        kind: .plugin,
        requestedKind: PluginApprovalNotificationBridge.requestedKind,
        resolvedKind: PluginApprovalNotificationBridge.resolvedKind,
        categoryIdentifier: PluginApprovalNotificationBridge.categoryIdentifier,
        reviewActionIdentifier: PluginApprovalNotificationBridge.reviewActionIdentifier,
        encodedRequestPrefix: "plugin.approval-v2.",
        legacyRequestPrefix: "plugin.approval.")

    static func shouldPresentNotification(userInfo: [AnyHashable: Any]) -> Bool {
        ApprovalNotificationBridge.shouldPresentNotification(
            userInfo: userInfo,
            configuration: self.configuration)
    }

    static func parsePrompt(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt?
    {
        ApprovalNotificationBridge.parsePrompt(
            actionIdentifier: actionIdentifier,
            userInfo: userInfo,
            configuration: self.configuration)
    }

    static func parseRequestedPush(userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt? {
        ApprovalNotificationBridge.parseRequestedPush(
            userInfo: userInfo,
            configuration: self.configuration)
    }

    static func parseResolvedPush(userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt? {
        ApprovalNotificationBridge.parseResolvedPush(
            userInfo: userInfo,
            configuration: self.configuration)
    }

    @MainActor
    static func removeNotifications(
        for push: ApprovalNotificationPrompt,
        notificationCenter: NotificationCentering,
        includingLegacyOwnerless: Bool = false) async
    {
        await ApprovalNotificationBridge.removeNotifications(
            for: push,
            notificationCenter: notificationCenter,
            includingLegacyOwnerless: includingLegacyOwnerless,
            configuration: self.configuration)
    }
}
