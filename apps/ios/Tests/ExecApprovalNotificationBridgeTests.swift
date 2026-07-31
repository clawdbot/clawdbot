import Foundation
import OpenClawProtocol
import Testing
import UserNotifications
@testable import OpenClaw

private final class MockNotificationCenter: NotificationCentering, @unchecked Sendable {
    var authorization: NotificationAuthorizationStatus = .authorized
    var addedRequests: [UNNotificationRequest] = []
    var pendingRemovedIdentifiers: [[String]] = []
    var deliveredRemovedIdentifiers: [[String]] = []
    var delivered: [NotificationSnapshot] = []

    func authorizationStatus() async -> NotificationAuthorizationStatus {
        self.authorization
    }

    func add(_ request: UNNotificationRequest) async throws {
        self.addedRequests.append(request)
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) async {
        self.pendingRemovedIdentifiers.append(identifiers)
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) async {
        self.deliveredRemovedIdentifiers.append(identifiers)
    }

    func deliveredNotifications() async -> [NotificationSnapshot] {
        self.delivered
    }
}

@Suite(.serialized) struct ExecApprovalNotificationBridgeTests {
    @Test func `parse prompt maps default notification tap`() {
        let prompt = ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-123",
                    "gatewayDeviceId": "gateway-a",
                ],
            ])

        #expect(prompt == ExecApprovalNotificationPrompt(
            approvalId: "approval-123",
            gatewayDeviceId: "gateway-a"))
    }

    @Test func `parse prompt maps review action`() {
        let prompt = ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: ExecApprovalNotificationBridge.reviewActionIdentifier,
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-456",
                    "gatewayDeviceId": "gateway-b",
                ],
            ])

        #expect(prompt == ExecApprovalNotificationPrompt(
            approvalId: "approval-456",
            gatewayDeviceId: "gateway-b"))
    }

    @Test func `parse prompt ignores unexpected action identifiers`() {
        let prompt = ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: "openclaw.exec-approval.allow-once",
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-789",
                ],
            ])

        #expect(prompt == nil)
    }

    @Test @MainActor func `handle resolved push removes matching notifications`() async {
        let center = MockNotificationCenter()
        center.delivered = [
            NotificationSnapshot(
                identifier: "remote-approval-1",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-123",
                        "gatewayDeviceId": "gateway-a",
                    ],
                ]),
            NotificationSnapshot(
                identifier: "remote-other",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-123",
                        "gatewayDeviceId": "gateway-b",
                    ],
                ]),
        ]

        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-123",
            gatewayDeviceId: "gateway-a")
        await ExecApprovalNotificationBridge.removeNotifications(
            for: push,
            notificationCenter: center)

        #expect(center.pendingRemovedIdentifiers == [[
            "exec.approval-v2.9:gateway-a.approval-123",
            "exec.approval.gateway-a.approval-123",
        ]])
        #expect(center.deliveredRemovedIdentifiers == [["remote-approval-1"]])
    }

    @Test func `approval IDs preserve gateway exact boundary semantics`() throws {
        for approvalID in [
            "\u{001C}approval-control",
            "\u{0085}approval-next-line",
            "\u{200B}approval-zero-width",
            " approval",
            "approval\u{FEFF}",
        ] {
            let prompt = try #require(ExecApprovalNotificationBridge.parseRequestedPush(userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": approvalID,
                ],
            ]))
            #expect(Array(prompt.approvalId.utf8) == Array(approvalID.utf8))
        }

        for approvalID in ["", ".", ".."] {
            #expect(ExecApprovalNotificationBridge.parseRequestedPush(userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": approvalID,
                ],
            ]) == nil)
        }
    }

    @Test func `gateway device owners preserve all nonempty exact bytes`() throws {
        for exactOwner in ["\u{0085}gateway-e\u{0301}\u{0085}", " gateway", "gateway\u{FEFF}"] {
            let prompt = try #require(ExecApprovalNotificationBridge.parseRequestedPush(userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-owner-exact",
                    "gatewayDeviceId": exactOwner,
                ],
            ]))
            #expect(try Array(#require(prompt.gatewayDeviceId).utf8) == Array(exactOwner.utf8))
        }

        for invalidOwner in [""] {
            #expect(ExecApprovalNotificationBridge.parseRequestedPush(userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-owner-invalid",
                    "gatewayDeviceId": invalidOwner,
                ],
            ]) == nil)
        }
    }

    @Test @MainActor func `byte-distinct canonical approval IDs target independently`() async {
        let composedID = "approval-\u{00E9}"
        let decomposedID = "approval-e\u{0301}"
        let composed = ExecApprovalNotificationPrompt(
            approvalId: composedID,
            gatewayDeviceId: "gateway-a")
        let decomposed = ExecApprovalNotificationPrompt(
            approvalId: decomposedID,
            gatewayDeviceId: "gateway-a")
        #expect(composedID == decomposedID)
        #expect(composed != decomposed)
        #expect(Set([composed, decomposed]).count == 2)

        let center = MockNotificationCenter()
        center.delivered = [
            NotificationSnapshot(
                identifier: "composed-request",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": composedID,
                        "gatewayDeviceId": "gateway-a",
                    ],
                ]),
            NotificationSnapshot(
                identifier: "decomposed-request",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": decomposedID,
                        "gatewayDeviceId": "gateway-a",
                    ],
                ]),
        ]

        await ExecApprovalNotificationBridge.removeNotifications(
            for: composed,
            notificationCenter: center)

        let encodedComposedID = "approval-%C3%A9"
        let encodedDecomposedID = "approval-e%CC%81"
        #expect(encodedComposedID != encodedDecomposedID)
        #expect(center.pendingRemovedIdentifiers == [[
            "exec.approval-v2.9:gateway-a.\(encodedComposedID)",
            "exec.approval.gateway-a.\(composedID)",
        ]])
        #expect(center.deliveredRemovedIdentifiers == [["composed-request"]])
    }

    @Test @MainActor func `encoded notification IDs cannot alias legacy raw IDs`() async throws {
        let slashCenter = MockNotificationCenter()
        let escapedCenter = MockNotificationCenter()

        await ExecApprovalNotificationBridge.removeNotifications(
            for: ExecApprovalNotificationPrompt(approvalId: "/", gatewayDeviceId: "gateway-a"),
            notificationCenter: slashCenter)
        await ExecApprovalNotificationBridge.removeNotifications(
            for: ExecApprovalNotificationPrompt(approvalId: "%2F", gatewayDeviceId: "gateway-a"),
            notificationCenter: escapedCenter)

        let slashIdentifiers = try Set(#require(slashCenter.pendingRemovedIdentifiers.first))
        let escapedIdentifiers = try Set(#require(escapedCenter.pendingRemovedIdentifiers.first))
        #expect(slashIdentifiers == [
            "exec.approval-v2.9:gateway-a.%2F",
            "exec.approval.gateway-a./",
        ])
        #expect(escapedIdentifiers == [
            "exec.approval-v2.9:gateway-a.%252F",
            "exec.approval.gateway-a.%2F",
        ])
        #expect(slashIdentifiers.isDisjoint(with: escapedIdentifiers))
    }

    @Test func `legacy ownerless approval pushes remain parseable for authenticated route validation`() {
        let userInfo: [AnyHashable: Any] = [
            "openclaw": [
                "kind": ExecApprovalNotificationBridge.requestedKind,
                "approvalId": "approval-ownerless",
            ],
        ]

        #expect(ExecApprovalNotificationBridge.parseRequestedPush(userInfo: userInfo) ==
            ExecApprovalNotificationPrompt(
                approvalId: "approval-ownerless",
                gatewayDeviceId: nil))
        #expect(ExecApprovalNotificationBridge.shouldPresentNotification(userInfo: userInfo))
    }

    @Test @MainActor func `validated cleanup removes legacy ownerless alerts but preserves other owners`() async {
        let center = MockNotificationCenter()
        center.delivered = [
            NotificationSnapshot(
                identifier: "legacy-ownerless",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-shared",
                    ],
                ]),
            NotificationSnapshot(
                identifier: "other-owner",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-shared",
                        "gatewayDeviceId": "gateway-b",
                    ],
                ]),
        ]
        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-shared",
            gatewayDeviceId: "gateway-a")

        await ExecApprovalNotificationBridge.removeNotifications(
            for: push,
            notificationCenter: center,
            includingLegacyOwnerless: true)

        #expect(center.pendingRemovedIdentifiers == [[
            "exec.approval-v2.9:gateway-a.approval-shared",
            "exec.approval.gateway-a.approval-shared",
            "exec.approval.approval-shared",
            "exec.approval-v2.6:legacy.approval-shared",
        ]])
        #expect(center.deliveredRemovedIdentifiers == [["legacy-ownerless"]])
    }
}

@Suite(.serialized) struct PluginApprovalNotificationBridgeTests {
    @Test func `parses requested and resolved plugin pushes with kind tag`() throws {
        let requested = try #require(PluginApprovalNotificationBridge.parseRequestedPush(userInfo: [
            "openclaw": [
                "kind": PluginApprovalNotificationBridge.requestedKind,
                "approvalId": "plugin-approval-1",
                "gatewayDeviceId": "gateway-a",
            ],
        ]))
        let resolved = try #require(PluginApprovalNotificationBridge.parseResolvedPush(userInfo: [
            "openclaw": [
                "kind": PluginApprovalNotificationBridge.resolvedKind,
                "approvalId": "plugin-approval-1",
                "gatewayDeviceId": "gateway-a",
            ],
        ]))

        #expect(requested == ApprovalNotificationPrompt(
            approvalId: "plugin-approval-1",
            gatewayDeviceId: "gateway-a",
            kind: .plugin))
        #expect(resolved.kind == .plugin)
    }

    @Test func `routes default tap and plugin review action`() {
        let userInfo: [AnyHashable: Any] = [
            "openclaw": [
                "kind": PluginApprovalNotificationBridge.requestedKind,
                "approvalId": "plugin-approval-2",
            ],
        ]

        #expect(PluginApprovalNotificationBridge.parsePrompt(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: userInfo)?.kind == .plugin)
        #expect(PluginApprovalNotificationBridge.parsePrompt(
            actionIdentifier: PluginApprovalNotificationBridge.reviewActionIdentifier,
            userInfo: userInfo)?.kind == .plugin)
        #expect(ApprovalNotificationBridge.parsePrompt(
            actionIdentifier: PluginApprovalNotificationBridge.reviewActionIdentifier,
            userInfo: userInfo)?.kind == .plugin)
    }

    @Test func `exec and plugin bridges do not cross match`() {
        let execUserInfo: [AnyHashable: Any] = [
            "openclaw": [
                "kind": ExecApprovalNotificationBridge.requestedKind,
                "approvalId": "shared-approval-id",
            ],
        ]
        let pluginUserInfo: [AnyHashable: Any] = [
            "openclaw": [
                "kind": PluginApprovalNotificationBridge.requestedKind,
                "approvalId": "shared-approval-id",
            ],
        ]

        #expect(PluginApprovalNotificationBridge.parseRequestedPush(userInfo: execUserInfo) == nil)
        #expect(ExecApprovalNotificationBridge.parseRequestedPush(userInfo: pluginUserInfo) == nil)
        #expect(PluginApprovalNotificationBridge.parsePrompt(
            actionIdentifier: ExecApprovalNotificationBridge.reviewActionIdentifier,
            userInfo: pluginUserInfo) == nil)
        #expect(ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: PluginApprovalNotificationBridge.reviewActionIdentifier,
            userInfo: execUserInfo) == nil)
    }

    @Test @MainActor func `plugin cleanup uses distinct identifiers and preserves exec notification`() async {
        let center = MockNotificationCenter()
        center.delivered = [
            NotificationSnapshot(
                identifier: "plugin-request",
                userInfo: [
                    "openclaw": [
                        "kind": PluginApprovalNotificationBridge.requestedKind,
                        "approvalId": "shared-approval-id",
                        "gatewayDeviceId": "gateway-a",
                    ],
                ]),
            NotificationSnapshot(
                identifier: "exec-request",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "shared-approval-id",
                        "gatewayDeviceId": "gateway-a",
                    ],
                ]),
        ]

        await PluginApprovalNotificationBridge.removeNotifications(
            for: ApprovalNotificationPrompt(
                approvalId: "shared-approval-id",
                gatewayDeviceId: "gateway-a",
                kind: .plugin),
            notificationCenter: center)

        #expect(center.pendingRemovedIdentifiers == [[
            "plugin.approval-v2.9:gateway-a.shared-approval-id",
            "plugin.approval.gateway-a.shared-approval-id",
        ]])
        #expect(center.deliveredRemovedIdentifiers == [["plugin-request"]])
    }
}
