import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct AgentAutomationModelsTests {
    @Test func `draft decodes editable gateway fields`() throws {
        let draft = try #require(AgentAutomationDraft(job: Self.job()))

        #expect(draft.name == "Release briefing")
        #expect(draft.sessionTarget == "isolated")
        #expect(draft.schedule == .every(everyMs: "86400000", anchorMs: "1783468800000"))
        #expect(draft.payload == .agentTurn(
            message: "Summarize release readiness.",
            model: "openai/gpt-5.2",
            thinking: ""))
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

    @Test func `automation pagination requires a forward offset`() {
        let page = CronJobsListLite(jobs: [], total: 201, hasMore: true, nextOffset: 200)
        #expect(nextCronJobsListOffset(page: page, currentOffset: 0) == 200)
        #expect(nextCronJobsListOffset(page: page, currentOffset: 200) == nil)
    }

    @Test func `legacy cron list defaults to a single page`() throws {
        let page = try JSONDecoder().decode(
            CronJobsListLite.self,
            from: Data(#"{"jobs":[],"total":0}"#.utf8))
        #expect(page.snapshotRevision == nil)
        #expect(!page.hasMore)
        #expect(page.nextOffset == nil)
    }

    @Test func `automation pagination pins total and snapshot revision`() throws {
        let first = try JSONDecoder().decode(
            CronJobsListLite.self,
            from: Data(#"{"jobs":[],"snapshotRevision":" rev-1 ","total":201,"hasMore":true,"nextOffset":200}"#.utf8))
        let changedRevision = CronJobsListLite(
            jobs: [],
            snapshotRevision: "rev-2",
            total: 201,
            hasMore: false,
            nextOffset: nil)
        let changedTotal = CronJobsListLite(
            jobs: [],
            snapshotRevision: "rev-1",
            total: 200,
            hasMore: false,
            nextOffset: nil)

        let identity = try #require(cronJobsSnapshotIdentity(page: first, maximumCount: 20000))
        #expect(identity == CronJobsSnapshotIdentity(total: 201, revision: "rev-1"))
        #expect(cronJobsSnapshotIdentity(page: changedRevision, maximumCount: 20000) != identity)
        #expect(cronJobsSnapshotIdentity(page: changedTotal, maximumCount: 20000) != identity)

        let legacyTerminal = try JSONDecoder().decode(
            CronJobsListLite.self,
            from: Data(#"{"jobs":[]}"#.utf8))
        #expect(cronJobsSnapshotIdentity(page: legacyTerminal, maximumCount: 20000) ==
            CronJobsSnapshotIdentity(total: nil, revision: nil))
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
        #expect(source.contains("\"expectedProcessInstanceId\": processInstanceID"))
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
        #expect(cronSource.contains("\"expectedProcessInstanceId\": processInstanceID"))
        #expect(cronSource.contains("guard currentInstanceID == processInstanceID else"))
        #expect(cronSource
            .contains(
                "presentAutomationEditor(\n                    job: job,\n                    sourceGatewayID: sourceGatewayID"))
    }

    private static func job(
        payload: AnyCodable? = nil,
        schedule: AnyCodable? = nil,
        deleteAfterRun: Bool = false) -> CronJob
    {
        CronJob(
            id: "release-briefing",
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
}
