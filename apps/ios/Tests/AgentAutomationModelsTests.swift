import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct AgentAutomationModelsTests {
    @Test func `draft decodes editable gateway fields`() throws {
        let cases: [(schedule: String, expected: AgentAutomationScheduleDraft)] = [
            (
                #"{"kind":"every","everyMs":86400000,"anchorMs":1783468800000}"#,
                .every(everyMs: "86400000", anchorMs: "1783468800000")),
            (
                #"{"kind":"every","everyMs":"86400000","anchorMs":"1783468800000"}"#,
                .every(everyMs: "86400000", anchorMs: "1783468800000")),
            (#"{"kind":"every","everyMs":86400000}"#, .every(everyMs: "86400000", anchorMs: "")),
            (
                #"{"kind":"cron","expr":"0 9 * * *","staggerMs":300000}"#,
                .cron(expression: "0 9 * * *", timezone: "", staggerMs: "300000")),
            (
                #"{"kind":"cron","expr":"0 9 * * *","staggerMs":"300000"}"#,
                .cron(expression: "0 9 * * *", timezone: "", staggerMs: "300000")),
            (
                #"{"kind":"cron","expr":"0 9 * * *"}"#,
                .cron(expression: "0 9 * * *", timezone: "", staggerMs: "")),
        ]
        for testCase in cases {
            let schedule = try JSONDecoder().decode(AnyCodable.self, from: Data(testCase.schedule.utf8))
            let draft = try #require(AgentAutomationDraft(job: Self.job(schedule: schedule)))

            #expect(draft.name == "Release briefing")
            #expect(draft.sessionTarget == "isolated")
            #expect(draft.schedule == testCase.expected)
            #expect(draft.payload == .agentTurn(
                message: "Summarize release readiness.",
                model: "openai/gpt-5.2",
                thinking: ""))
        }
    }

    @Test func `update includes exact revision and only normalized changes`() throws {
        let job = Self.job()
        var draft = try #require(AgentAutomationDraft(job: job))
        draft.name = " Release briefing v2 "
        draft.payload = .agentTurn(
            message: "Summarize release readiness.",
            model: "",
            thinking: "")

        let json = try buildAgentAutomationUpdateParams(job: job, draft: draft)
        let root = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let patch = try #require(root["patch"] as? [String: Any])
        let payload = try #require(patch["payload"] as? [String: Any])

        #expect(root["id"] as? String == job.id)
        #expect(root["expectedConfigRevision"] as? String == "sha256:test-revision")
        #expect(patch["name"] as? String == "Release briefing v2")
        #expect(payload["kind"] as? String == "agentTurn")
        #expect(payload["model"] is NSNull)
        #expect(payload["message"] == nil)
    }

    @Test func `semantic command formatting is not a change`() throws {
        let job = Self.job(
            payload: AnyCodable([
                "kind": AnyCodable("command"),
                "argv": AnyCodable([AnyCodable("openclaw"), AnyCodable("status")]),
                "cwd": AnyCodable("/tmp"),
            ]))
        var draft = try #require(AgentAutomationDraft(job: job))
        draft.payload = .command(argvJSON: "[ \"openclaw\", \"status\" ]", cwd: "/tmp")

        #expect(throws: AgentAutomationEditError.self) {
            _ = try buildAgentAutomationUpdateParams(job: job, draft: draft)
        }
    }

    @Test func `enable update is revision safe`() throws {
        let root = try #require(
            try JSONSerialization.jsonObject(
                with: Data(buildAgentAutomationEnabledParams(job: Self.job(), enabled: false).utf8)) as? [String: Any])
        let patch = try #require(root["patch"] as? [String: Any])

        #expect(root["expectedConfigRevision"] as? String == "sha256:test-revision")
        #expect(patch["enabled"] as? Bool == false)
    }

    @Test func `tracked run outcome preserves failures and skips`() {
        #expect(agentAutomationRunOutcome(status: "ok", error: nil) == .success)
        #expect(agentAutomationRunOutcome(status: "skipped", error: nil) == .skipped)
        #expect(agentAutomationRunOutcome(status: "error", error: nil) == .failure)
        #expect(agentAutomationRunOutcome(status: "ok", error: "delivery failed") == .failure)
        #expect(agentAutomationRunOutcome(status: nil, error: nil) == .unknown)
        #expect(agentAutomationRunOutcome(status: "future-status", error: nil) == .unknown)
    }

    @Test func `invalid spec skip refreshes persisted diagnostics`() {
        #expect(agentAutomationRunSkipShouldRefresh(reason: "invalid-spec"))
        #expect(!agentAutomationRunSkipShouldRefresh(reason: "already-running"))
        #expect(!agentAutomationRunSkipShouldRefresh(reason: nil))
    }

    @Test @MainActor func `queued run registry keeps exact reservation until terminal release`() {
        let registry = AgentAutomationPendingRunRegistry()

        #expect(registry.reserve(jobID: "job-1", runID: "run-1"))
        #expect(!registry.reserve(jobID: "job-1", runID: "run-2"))
        #expect(registry.runID(for: "job-1") == "run-1")

        registry.release(jobID: "job-1", runID: "run-2")
        #expect(registry.runID(for: "job-1") == "run-1")

        registry.release(jobID: "job-1", runID: "run-1")
        #expect(registry.runID(for: "job-1") == nil)
    }

    @Test func `successful delete-after-run one-shot dismisses`() {
        let oneShot = Self.job(
            schedule: AnyCodable(["kind": AnyCodable("at"), "at": AnyCodable("2026-07-14T16:00:00Z")]),
            deleteAfterRun: true)
        #expect(agentAutomationDeletesAfterSuccessfulRun(job: oneShot, outcome: .success))
        #expect(!agentAutomationDeletesAfterSuccessfulRun(job: oneShot, outcome: .failure))
        #expect(!agentAutomationDeletesAfterSuccessfulRun(job: Self.job(), outcome: .success))
    }

    @Test func `semantic dirty state ignores normalized no-op edits`() throws {
        let job = Self.job()
        var draft = try #require(AgentAutomationDraft(job: job))
        draft.name = "  Release briefing  "
        #expect(!agentAutomationHasSemanticChanges(job: job, draft: draft))

        draft.name = "Release briefing v2"
        #expect(agentAutomationHasSemanticChanges(job: job, draft: draft))
    }

    @Test @MainActor func `cron collector preserves snapshot order and normalized revision`() async throws {
        let collected = await Self.collectCronPages([
            Self.cronPage(["z", "a"], total: 3, revision: " rev-1 ", hasMore: true, nextOffset: 2),
            Self.cronPage(["m"], total: 3, revision: "rev-1\n"),
        ], maximumPageCount: 2)
        let snapshot = try #require(collected.snapshot)

        #expect(collected.offsets == [0, 2])
        #expect(snapshot.jobs.map(\.id) == ["z", "a", "m"])
        #expect(snapshot.snapshotRevision == "rev-1")
        #expect(snapshot.total == 3)
        #expect(!snapshot.hasMore)
        #expect(snapshot.nextOffset == nil)
    }

    @Test @MainActor func `cron collector accepts empty advancing pages and absent identity`() async throws {
        let collected = await Self.collectCronPages([
            Self.cronPage(revision: " \n", hasMore: true, nextOffset: 3),
            Self.cronPage(["a"], nextOffset: 99),
        ])
        let snapshot = try #require(collected.snapshot)

        #expect(collected.offsets == [0, 3])
        #expect(snapshot.jobs.map(\.id) == ["a"])
        #expect(snapshot.snapshotRevision == nil)
        #expect(snapshot.total == nil)
        #expect(!snapshot.hasMore)
        #expect(snapshot.nextOffset == nil)
    }

    @Test func `legacy cron list defaults to a single page`() throws {
        let page = try JSONDecoder().decode(
            CronJobsListLite.self,
            from: Data(#"{"jobs":[],"total":0}"#.utf8))
        #expect(page.snapshotRevision == nil)
        #expect(!page.hasMore)
        #expect(page.nextOffset == nil)
    }

    @Test @MainActor func `cron collector rejects snapshot identity changes including missing values`() async {
        let cases: [(name: String, firstTotal: Int?, firstRevision: String?, total: Int?, revision: String?)] = [
            ("revision changes", 2, "rev-1", 2, "rev-2"),
            ("revision appears", 2, nil, 2, "rev-1"),
            ("revision disappears", 2, "rev-1", 2, nil),
            ("total changes", 2, "rev-1", 3, "rev-1"),
            ("total appears", nil, nil, 2, nil),
            ("total disappears", 2, nil, nil, nil),
        ]
        for scenario in cases {
            let collected = await Self.collectCronPages([
                Self.cronPage(
                    ["a"], total: scenario.firstTotal, revision: scenario.firstRevision,
                    hasMore: true, nextOffset: 1),
                Self.cronPage(["b"], total: scenario.total, revision: scenario.revision),
            ])
            #expect(collected.snapshot == nil, "\(scenario.name)")
            #expect(collected.offsets == [0, 1], "\(scenario.name)")
        }
    }

    @Test @MainActor func `cron collector rejects duplicate rows count contradictions and missing pages`() async {
        let first = Self.cronPage(["a"], hasMore: true, nextOffset: 1)
        let cases: [(name: String, pages: [CronJobsListLite?], offsets: [Int])] = [
            ("duplicate within page", [Self.cronPage(["a", "a"])], [0]),
            ("duplicate across pages", [first, Self.cronPage(["a"])], [0, 1]),
            ("negative total", [Self.cronPage(total: -1)], [0]),
            ("total below collected count", [Self.cronPage(["a", "b"], total: 1)], [0]),
            ("more after exact total", [Self.cronPage(["a"], total: 1, hasMore: true, nextOffset: 1)], [0]),
            ("page exceeds job budget", [Self.cronPage(["a", "b", "c", "d"])], [0]),
            ("aggregate exceeds job budget", [
                Self.cronPage(["a", "b"], hasMore: true, nextOffset: 2), Self.cronPage(["c", "d"]),
            ], [0, 2]),
            ("first fetch unavailable", [nil], [0]),
            ("later fetch unavailable", [first, nil], [0, 1]),
        ]
        for scenario in cases {
            let collected = await Self.collectCronPages(scenario.pages)
            #expect(collected.snapshot == nil, "\(scenario.name)")
            #expect(collected.offsets == scenario.offsets, "\(scenario.name)")
        }
    }

    @Test @MainActor func `cron collector rejects missing nonadvancing and over-budget offsets`() async {
        let firstOffsets: [Int?] = [nil, -1, 0, 4]
        for nextOffset in firstOffsets {
            let collected = await Self.collectCronPages([
                Self.cronPage(["a"], hasMore: true, nextOffset: nextOffset),
            ])
            #expect(collected.snapshot == nil)
            #expect(collected.offsets == [0])
        }
        for nextOffset in [0, 1, 2] {
            let collected = await Self.collectCronPages([
                Self.cronPage(["a"], hasMore: true, nextOffset: 2),
                Self.cronPage(["b"], hasMore: true, nextOffset: nextOffset),
            ])
            #expect(collected.snapshot == nil)
            #expect(collected.offsets == [0, 2])
        }
    }

    @Test @MainActor func `cron collector preserves terminal metadata at each caller budget`() async throws {
        let empty = await Self.collectCronPages([Self.cronPage(total: 0)])
        #expect(empty.offsets == [0])
        #expect(empty.snapshot?.jobs.isEmpty == true)
        #expect(empty.snapshot?.total == 0)

        for limits in [(pages: 5, jobs: 1000), (pages: 100, jobs: 20000)] {
            var pages: [CronJobsListLite?] = (1...limits.pages).map {
                Self.cronPage(total: limits.jobs, hasMore: true, nextOffset: $0)
            }
            let exhausted = await Self.collectCronPages(
                pages, maximumPageCount: limits.pages, maximumJobCount: limits.jobs)
            #expect(exhausted.snapshot == nil)
            #expect(exhausted.offsets == Array(0..<limits.pages))

            pages[limits.pages - 1] = Self.cronPage(["a"], total: limits.jobs)
            let completed = await Self.collectCronPages(
                pages, maximumPageCount: limits.pages, maximumJobCount: limits.jobs)
            let snapshot = try #require(completed.snapshot)
            #expect(completed.offsets == Array(0..<limits.pages))
            #expect(snapshot.jobs.map(\.id) == ["a"])
            #expect(snapshot.total == nil)
            #expect(!snapshot.hasMore)
            #expect(snapshot.nextOffset == nil)

            let oversized = await Self.collectCronPages(
                [Self.cronPage(total: limits.jobs + 1)],
                maximumPageCount: limits.pages, maximumJobCount: limits.jobs)
            #expect(oversized.snapshot == nil)
            #expect(oversized.offsets == [0])
        }
    }

    @Test func `automation editor selection preserves tapped snapshot`() {
        let job = Self.job()
        let selection = AgentProTab.AutomationEditorSelection(
            initialJob: job,
            sourceGatewayID: "gateway-a")

        #expect(selection.id == job.id)
        #expect(selection.initialJob.name == job.name)
        #expect(selection.sourceGatewayID == "gateway-a")
    }

    @Test func `detail source guards route and exact queued run`() throws {
        let source = try String(
            contentsOf: Self.sourceURL("Design/AgentAutomationDetailScreen.swift"),
            encoding: .utf8)
        let models = try String(
            contentsOf: Self.sourceURL("Design/AgentAutomationModels.swift"),
            encoding: .utf8)

        #expect(source.contains("distinguishPreDispatchRouteChange: true"))
        #expect(source.contains("currentRoute() == route"))
        #expect(source.contains("gatewayChangedAfterDispatch"))
        #expect(source.contains("ifGatewayID: self.sourceGatewayID"))
        #expect(source.contains("\"runId\": runID"))
        #expect(source.contains("pendingRunRegistry"))
        #expect(!source.contains("self.pendingRunID = nil"))
        #expect(source.contains("self.pendingRunRegistry.release(jobID: self.job.id, runID: runID)"))
        #expect(Self.containsDictionaryAssignment(
            dictionary: "runParams",
            key: "expectedProcessInstanceId",
            value: "processInstanceID",
            in: source))
        #expect(source.contains("guard self.pendingRunID == runID else { return }"))
        #expect(models.contains("expectedConfigRevision"))
        #expect(source.contains("Delete Automation"))
        #expect(source.contains("OpenClawType.subheadSemiBold"))
        #expect(source.contains("!self.hasUnsavedChanges"))

        let tabSource = try String(
            contentsOf: Self.sourceURL("Design/AgentProTab.swift"),
            encoding: .utf8)
        let cronSource = try String(
            contentsOf: Self.sourceURL("Design/AgentProTab+Cron.swift"),
            encoding: .utf8)
        #expect(tabSource.contains("initialJob: selection.initialJob"))
        #expect(!tabSource.contains("overview.cronJobs.first(where:"))
        #expect(cronSource.contains("sourceGatewayID: sourceGatewayID"))
        #expect(cronSource.contains("guard pendingCronRuns.runID(for: job.id) == nil else { return }"))
        #expect(cronSource.contains("self.pendingCronRuns.reserve(jobID: jobID, runID: runID)"))
        #expect(cronSource.contains("entries.contains(where: { $0.runid == runID })"))
        #expect(cronSource.contains("method: \"system.info\""))
        #expect(Self.containsDictionaryAssignment(
            dictionary: "runParams",
            key: "expectedProcessInstanceId",
            value: "processInstanceID",
            in: cronSource))
        #expect(cronSource.contains("guard currentInstanceID == processInstanceID else"))
        #expect(cronSource
            .contains(
                "presentAutomationEditor(\n                    job: job,\n                    sourceGatewayID: sourceGatewayID"))
    }

    @MainActor
    private static func collectCronPages(
        _ pages: [CronJobsListLite?],
        maximumPageCount: Int = 3,
        maximumJobCount: Int = 3) async -> (snapshot: CronJobsListLite?, offsets: [Int])
    {
        var offsets: [Int] = []
        let snapshot = await CronJobsListLite.collect(
            maximumPageCount: maximumPageCount,
            maximumJobCount: maximumJobCount)
        { offset in
            let index = offsets.count
            offsets.append(offset)
            return index < pages.count ? pages[index] : nil
        }
        return (snapshot, offsets)
    }

    private static func cronPage(
        _ ids: [String] = [],
        total: Int? = nil,
        revision: String? = nil,
        hasMore: Bool = false,
        nextOffset: Int? = nil) -> CronJobsListLite
    {
        CronJobsListLite(
            jobs: ids.map { Self.job(id: $0) },
            snapshotRevision: revision,
            total: total,
            hasMore: hasMore,
            nextOffset: nextOffset)
    }

    private static func job(
        id: String = "release-briefing",
        payload: AnyCodable? = nil,
        schedule: AnyCodable? = nil,
        deleteAfterRun: Bool = false) -> CronJob
    {
        CronJob(
            id: id,
            name: "Release briefing",
            description: "Daily mobile release overview",
            enabled: true,
            deleteafterrun: deleteAfterRun,
            createdatms: 1_783_468_800_000,
            updatedatms: 1_783_555_200_000,
            configrevision: "sha256:test-revision",
            schedule: schedule ?? AnyCodable([
                "kind": AnyCodable("every"),
                "everyMs": AnyCodable(86_400_000),
                "anchorMs": AnyCodable(1_783_468_800_000),
            ]),
            sessiontarget: AnyCodable("isolated"),
            wakemode: AnyCodable("now"),
            payload: payload ?? AnyCodable([
                "kind": AnyCodable("agentTurn"),
                "message": AnyCodable("Summarize release readiness."),
                "model": AnyCodable("openai/gpt-5.2"),
            ]),
            state: [:],
            nextrunatms: 1_783_641_600_000)
    }

    private static func sourceURL(_ path: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources")
            .appendingPathComponent(path)
    }

    private static func containsDictionaryAssignment(
        dictionary: String,
        key: String,
        value: String,
        in source: String) -> Bool
    {
        let pattern = [
            #"\b"#,
            NSRegularExpression.escapedPattern(for: dictionary),
            #"\s*\[\s*""#,
            NSRegularExpression.escapedPattern(for: key),
            #""\s*\]\s*=\s*"#,
            NSRegularExpression.escapedPattern(for: value),
            #"\b"#,
        ].joined()
        return source.range(of: pattern, options: .regularExpression) != nil
    }
}
