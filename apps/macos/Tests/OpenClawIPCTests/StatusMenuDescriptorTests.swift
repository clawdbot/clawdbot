import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct StatusMenuDescriptorTests {
    private static let referenceDate = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func `connected menu preserves section and entry order`() {
        let snapshot = StatusMenuDescriptor.Snapshot(
            quickChatEnabled: true,
            debugEnabled: true,
            updateReady: true,
            hasUsage: true,
            sessions: [Self.session("main")],
            now: Self.referenceDate)

        let descriptor = StatusMenuDescriptor.build(from: snapshot)

        #expect(descriptor.sections.map(\.id) == ["header", "sessions", "actions", "summaries", "footer"])
        #expect(descriptor.sections.flatMap(\.entries).map(\.id) == [
            "header",
            "session.main",
            "action.dashboard",
            "action.quickChat",
            "action.talkMode",
            "summary.automations",
            "summary.usage",
            "summary.devices",
            "action.settings",
            "action.connection",
            "action.debug",
            "action.about",
            "update.ready",
            "action.quit",
        ])
    }

    @Test func `connection states replace sessions with visible explanations`() {
        let states: [(StatusMenuDescriptor.Connection, String)] = [
            (.unconfigured, "Gateway not configured"),
            (.disconnected, "Gateway disconnected"),
            (.connecting, "Connecting…"),
            (.degraded, "Gateway needs attention"),
        ]

        for (connection, expectedMessage) in states {
            let descriptor = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(
                connection: connection,
                sessions: [Self.session("main")],
                now: Self.referenceDate))
            let entries = Self.entries(in: "sessions", descriptor: descriptor)

            #expect(entries.map(\.id) == ["placeholder"])
            guard case let .placeholder(message) = entries.first?.kind else {
                Issue.record("Missing placeholder for connection state \(connection)")
                continue
            }
            #expect(message == expectedMessage)
        }
    }

    @Test func `paused menu preserves cached sessions and available actions`() {
        let descriptor = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(
            isPaused: true,
            voiceWakeSupported: false,
            sessions: [Self.session("main")],
            now: Self.referenceDate))

        #expect(Self.entries(in: "sessions", descriptor: descriptor).map(\.id) == ["session.main"])
        #expect(Self.entries(in: "actions", descriptor: descriptor).map(\.id) == [
            "action.dashboard",
            "action.talkMode",
        ])
    }

    @Test func `multiple gateways retain eligible option alternate identities`() {
        let primary = DashboardGatewayMenuItem(
            target: .primary,
            name: "Mac Studio",
            health: .ok,
            isPrimary: true,
            canPromote: false,
            shortcutNumber: 1)
        let secondary = DashboardGatewayMenuItem(
            target: .profile("travel"),
            name: "Travel",
            health: .unknown,
            isPrimary: false,
            canPromote: true,
            shortcutNumber: 2)

        let single = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(gateways: [primary]))
        let multiple = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(
            gateways: [primary, secondary]))

        #expect(!single.sections.contains { $0.id == "gateways" })
        #expect(multiple.sections.map(\.id) == [
            "header",
            "sessions",
            "actions",
            "summaries",
            "gateways",
            "footer",
        ])
        #expect(Self.entries(in: "gateways", descriptor: multiple).map(\.id) == [
            "gateway.header",
            "gateway.primary",
            "gateway.profile:travel",
            "gateway.profile:travel.alternate",
        ])
    }

    @Test func `pending approvals attach to matching sessions and preserve unmatched requests`() {
        let approvals = [
            Self.approval("second", sessionKey: "other"),
            Self.approval("orphan", sessionKey: "missing"),
            Self.approval("first", sessionKey: "main"),
            Self.approval("global", sessionKey: nil),
        ]
        let descriptor = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(
            sessions: [Self.session("other", age: 60), Self.session("main", age: 120)],
            approvals: approvals,
            now: Self.referenceDate))

        #expect(Self.entries(in: "sessions", descriptor: descriptor).map(\.id) == [
            "approval.orphan",
            "approval.global",
            "approval.first",
            "session.main",
            "approval.second",
            "session.other",
        ])
    }

    @Test func `disconnected approvals remain actionable above the gateway explanation`() {
        let descriptor = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(
            connection: .disconnected,
            approvals: [Self.approval("pending", sessionKey: "main")]))

        #expect(Self.entries(in: "sessions", descriptor: descriptor).map(\.id) == [
            "approval.pending",
            "placeholder",
        ])
    }

    @Test func `stalled usage remains visible without a completed usage cache`() {
        let states: [(Bool, Bool, Bool)] = [
            (false, false, false),
            (true, false, true),
            (false, true, true),
            (true, true, true),
        ]

        for (hasUsage, isUsageStalled, expectedVisible) in states {
            let descriptor = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(
                hasUsage: hasUsage,
                isUsageStalled: isUsageStalled))
            let usageVisible = Self.entries(in: "summaries", descriptor: descriptor)
                .contains { $0.id == "summary.usage" }

            #expect(usageVisible == expectedVisible)
        }
    }

    @Test func `sessions cap at six and expose the complete dashboard list`() {
        let rows = (1...8).map { index in Self.session("session-\(index)", age: TimeInterval(index)) }
        let descriptor = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(
            sessions: rows,
            approvals: [Self.approval("hidden", sessionKey: "session-8")],
            now: Self.referenceDate))

        #expect(Self.entries(in: "sessions", descriptor: descriptor).map(\.id) == [
            "approval.hidden",
            "session.session-1",
            "session.session-2",
            "session.session-3",
            "session.session-4",
            "session.session-5",
            "session.session-6",
            "action.allSessions",
        ])

        let exactLimit = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(
            sessions: Array(rows.prefix(6)),
            now: Self.referenceDate))
        #expect(!Self.entries(in: "sessions", descriptor: exactLimit).contains { $0.id == "action.allSessions" })
    }

    @Test func `active rows keep main first and filter the exact twenty-four-hour window`() {
        let rows = [
            Self.session("stale", age: 86401),
            Self.session("older", age: 120),
            Self.session("main", age: 172_800),
            Self.session("newer", age: 30),
            Self.session("boundary", age: 86400),
            Self.session("undated", updatedAt: nil),
        ]

        let visible = StatusMenuDescriptor.activeRows(from: rows, now: Self.referenceDate)

        #expect(visible.map(\.key) == ["main", "newer", "older", "boundary"])
    }

    @Test func `configured main session replaces the canonical main alias`() {
        let rows = [
            Self.session("main", age: 1),
            Self.session("recent", age: 2),
            Self.session("agent:primary", updatedAt: nil),
        ]

        let visible = StatusMenuDescriptor.activeRows(
            from: rows,
            mainSessionKey: "agent:primary",
            now: Self.referenceDate)

        #expect(visible.map(\.key) == ["agent:primary", "recent"])
    }

    @Test func `session errors remain visible instead of appearing as an empty success`() {
        let descriptor = StatusMenuDescriptor.build(from: StatusMenuDescriptor.Snapshot(
            sessionError: "The gateway session list could not be loaded."))
        let entries = Self.entries(in: "sessions", descriptor: descriptor)

        guard case let .placeholder(message) = entries.first?.kind else {
            Issue.record("Expected the session failure to be visible")
            return
        }
        #expect(message == "The gateway session list could not be loaded.")
    }

    private static func entries(
        in sectionID: String,
        descriptor: StatusMenuDescriptor) -> [StatusMenuDescriptor.Entry]
    {
        descriptor.sections.first { $0.id == sectionID }?.entries ?? []
    }

    private static func session(_ key: String, age: TimeInterval = 0) -> SessionRow {
        self.session(key, updatedAt: self.referenceDate.addingTimeInterval(-age))
    }

    private static func session(_ key: String, updatedAt: Date?) -> SessionRow {
        SessionRow(
            id: key,
            key: key,
            kind: .direct,
            displayName: nil,
            updatedAt: updatedAt,
            sessionId: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            tokens: SessionTokenStats(total: 0, contextTokens: 200_000))
    }

    private static func approval(_ id: String, sessionKey: String?) -> ExecApprovalQueueItem {
        ExecApprovalQueueItem(
            id: id,
            request: ExecApprovalPromptRequest(command: "echo ready", sessionKey: sessionKey),
            createdAtMs: 1,
            expiresAtMs: 2)
    }
}
