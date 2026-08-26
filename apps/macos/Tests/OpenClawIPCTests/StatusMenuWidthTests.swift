import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct StatusMenuWidthTests {
    private static let workerFailure =
        "Mac node degraded — node-host worker stopped after 6 unexpected exits while restarting the local " +
        "capability host and reconnecting its registered native tools"
    private static let workerDiagnostic = [
        "[openclaw] bootstrap failed: state database uses a newer schema version than this installed CLI",
        "[openclaw] run openclaw doctor to inspect the current installation and its persisted local state",
        "[openclaw] check that the application and worker are using the same installed OpenClaw release",
    ].joined(separator: "\n")

    @Test func `long native and hosted content cannot expand the status menu`() throws {
        let state = AppState(preview: true)
        state.connectionMode = .local

        let healthStore = HealthStore.shared
        let previousSnapshot = healthStore.snapshot
        let previousError = healthStore.lastError
        healthStore.__setSnapshotForTest(nil, lastError: "\(Self.workerFailure)\n\(Self.workerDiagnostic)")

        let cronStore = CronJobsStore.shared
        let previousJobs = cronStore.jobs
        let nextRun = Date().addingTimeInterval(3600)
        cronStore.jobs = (1...5).map { Self.cronJob(index: $0, nextRun: nextRun) }
        defer {
            healthStore.__setSnapshotForTest(previousSnapshot, lastError: previousError)
            cronStore.jobs = previousJobs
        }

        let session = Self.session(
            "A very long session title that continues for considerably more than forty-five characters")
        let approval = ExecApprovalQueueItem(
            id: "long-command",
            request: ExecApprovalPromptRequest(
                command: "openclaw doctor --fix --verbose --check-every-registered-capability-host",
                sessionKey: session.key),
            createdAtMs: 1,
            expiresAtMs: Int(Date().addingTimeInterval(60).timeIntervalSince1970 * 1000))
        let gateways = [
            DashboardGatewayMenuItem(
                target: .primary,
                name: "Primary gateway with an unusually long operator-assigned descriptive name",
                health: .ok,
                isPrimary: true,
                canPromote: false,
                shortcutNumber: 1),
            DashboardGatewayMenuItem(
                target: .profile("remote-office"),
                name: "Remote office gateway with an even longer descriptive operator-assigned name",
                health: .unknown,
                isPrimary: false,
                canPromote: true,
                shortcutNumber: 2),
        ]

        var descriptor = StatusMenuDescriptor.build(from: .init(
            updateReady: true,
            hasUsage: true,
            sessions: [session],
            approvals: [approval],
            gateways: gateways))
        let sessionsIndex = try #require(descriptor.sections.firstIndex { $0.id == "sessions" })
        descriptor.sections[sessionsIndex].entries.append(.init(.placeholder(
            "The gateway session list could not be loaded because the remote operator connection " +
                "closed before every requested capability and session entry finished loading.")))

        let menu = NSMenu()
        let renderer = StatusMenuRenderer(menu: menu, state: state)
        renderer.render(descriptor)

        #expect(menu.minimumWidth == StatusMenuMetrics.width)
        #expect(menu.size.width == StatusMenuMetrics.width)
        #expect(menu.items.contains { $0.title == "Automations · 5 jobs · next in 1h" })
        #expect(menu.items.contains { $0.representedObject as? String == "gateway.header" })
        #expect(menu.items.contains { $0.representedObject as? String == "gateway.primary" })
        #expect(menu.items.contains { $0.representedObject as? String == "gateway.profile:remote-office" })
        #expect(menu.items.contains {
            $0.representedObject as? String == "gateway.profile:remote-office.alternate"
        })

        let hostedItems = menu.items.filter { $0.view != nil }
        #expect(hostedItems.count >= 3)
        for item in hostedItems {
            let view = try #require(item.view)
            #expect(view.frame.width == StatusMenuMetrics.width)
            #expect(view.frame.height > 0)
        }

        let placeholder = try #require(menu.items.first { $0.representedObject as? String == "placeholder" })
        #expect(placeholder.title.contains("…"))
        let primaryGateway = try #require(menu.items.first { $0.representedObject as? String == "gateway.primary" })
        #expect(primaryGateway.title.contains("…"))
    }

    @Test func `wrapped status headers are measured after their width is constrained`() throws {
        let state = AppState(preview: true)
        state.connectionMode = .local

        let healthStore = HealthStore.shared
        let previousSnapshot = healthStore.snapshot
        let previousError = healthStore.lastError
        defer { healthStore.__setSnapshotForTest(previousSnapshot, lastError: previousError) }

        let menu = NSMenu()
        let renderer = StatusMenuRenderer(menu: menu, state: state)
        let descriptor = StatusMenuDescriptor(sections: [
            .init(id: "header", entries: [.init(.header)]),
        ])

        healthStore.__setSnapshotForTest(nil, lastError: "Ready")
        renderer.render(descriptor)
        let header = try #require(menu.items.first?.view)
        let shortHeight = header.frame.height

        healthStore.__setSnapshotForTest(nil, lastError: "\(Self.workerFailure)\n\(Self.workerDiagnostic)")
        renderer.reconcile(descriptor)
        let wrappedHeader = try #require(menu.items.first?.view)

        #expect(wrappedHeader === header)
        #expect(shortHeight > 0)
        #expect(wrappedHeader.frame.width == StatusMenuMetrics.width)
        #expect(wrappedHeader.frame.height > shortHeight)
        #expect(menu.size.width == StatusMenuMetrics.width)
    }

    @Test func `native menu titles fit their measured chrome budget`() {
        let longTitle =
            "A gateway with a very long operator-assigned display name that must preserve both " +
            "its beginning and its useful identifying suffix"
        let fitted = StatusMenuMetrics.fittedTitle(longTitle)
        let measuredWidth = (fitted as NSString).size(withAttributes: [
            .font: NSFont.menuFont(ofSize: 0),
        ]).width

        #expect(fitted.contains("…"))
        #expect(fitted.first == longTitle.first)
        #expect(fitted.last == longTitle.last)
        #expect(measuredWidth <= StatusMenuMetrics.titleWidthBudget)
        #expect(StatusMenuMetrics.titleWidthBudget < StatusMenuMetrics.width)

        #expect(StatusMenuMetrics.fittedTitle("Settings…") == "Settings…")
    }

    private static func session(_ displayName: String) -> SessionRow {
        SessionRow(
            id: "long-session",
            key: "long-session",
            kind: .direct,
            displayName: displayName,
            updatedAt: Date(),
            sessionId: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            systemSent: false,
            abortedLastRun: false,
            tokens: SessionTokenStats(input: 10000, output: 10000, total: 20000, contextTokens: 200_000),
            model: nil)
    }

    private static func cronJob(index: Int, nextRun: Date) -> CronJob {
        CronJob(
            id: "menu-job-\(index)",
            agentId: nil,
            name: "Automation \(index)",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: .every(everyMs: 3_600_000, anchorMs: nil),
            sessionTarget: .isolated,
            wakeMode: .now,
            payload: .systemEvent(text: "test"),
            delivery: nil,
            state: CronJobState(
                nextRunAtMs: Int(nextRun.timeIntervalSince1970 * 1000),
                runningAtMs: nil,
                lastRunAtMs: nil,
                lastStatus: nil,
                lastError: nil,
                lastDurationMs: nil))
    }
}
