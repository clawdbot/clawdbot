import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct SettingsViewSmokeTests {
    @Test func `cron settings builds body`() {
        let store = CronJobsStore(isPreview: true)
        store.schedulerEnabled = false
        store.schedulerStorePath = "/tmp/openclaw-cron-store.json"

        let job1 = CronJob(
            id: "job-1",
            agentId: "ops",
            name: "  Morning Check-in  ",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_100_000,
            schedule: .cron(expr: "0 8 * * *", tz: "UTC"),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: "ping"),
            delivery: nil,
            state: CronJobState(
                nextRunAtMs: 1_700_000_200_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: "ok",
                lastError: nil,
                lastDurationMs: 123))

        let job2 = CronJob(
            id: "job-2",
            agentId: nil,
            name: "",
            description: nil,
            enabled: false,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_100_000,
            schedule: .every(everyMs: 30000, anchorMs: nil),
            sessionTarget: .isolated,
            wakeMode: .nextHeartbeat,
            payload: .agentTurn(
                message: "hello",
                thinking: "low",
                timeoutSeconds: 30,
                deliver: nil,
                channel: nil,
                to: nil,
                bestEffortDeliver: nil),
            delivery: CronDelivery(mode: .announce, channel: "sms", to: "+15551234567", bestEffort: true),
            state: CronJobState(
                nextRunAtMs: nil,
                runningAtMs: nil,
                lastRunAtMs: nil,
                lastStatus: nil,
                lastError: nil,
                lastDurationMs: nil))

        store.jobs = [job1, job2]
        store.selectedJobId = job1.id
        store.runEntries = [
            CronRunLogEntry(
                ts: 1_700_000_050_000,
                jobId: job1.id,
                action: "finished",
                status: "ok",
                error: nil,
                summary: "ok",
                runAtMs: 1_700_000_050_000,
                durationMs: 123,
                nextRunAtMs: 1_700_000_200_000),
        ]

        let view = CronSettings(store: store)
        _ = view.body
    }

    @Test func `cron settings renders in hosting view`() {
        let store = CronJobsStore(isPreview: true)
        store.schedulerEnabled = false
        store.jobs = [
            CronJob(
                id: "job-1",
                agentId: "ops",
                name: "Morning Check-in",
                description: "Summary job",
                enabled: true,
                deleteAfterRun: nil,
                createdAtMs: 1_700_000_000_000,
                updatedAtMs: 1_700_000_100_000,
                schedule: .cron(expr: "0 8 * * *", tz: "UTC"),
                sessionTarget: .isolated,
                wakeMode: .nextHeartbeat,
                payload: .agentTurn(
                    message: "Summarize",
                    thinking: "low",
                    timeoutSeconds: 120,
                    deliver: nil,
                    channel: nil,
                    to: nil,
                    bestEffortDeliver: nil),
                delivery: CronDelivery(mode: .announce, channel: "whatsapp", to: "+15551234567", bestEffort: true),
                state: CronJobState(
                    nextRunAtMs: 1_700_000_200_000,
                    runningAtMs: nil,
                    lastRunAtMs: 1_700_000_050_000,
                    lastStatus: "ok",
                    lastError: nil,
                    lastDurationMs: 1200)),
        ]
        store.selectedJobId = "job-1"
        store.runEntries = [
            CronRunLogEntry(
                ts: 1_700_000_050_000,
                jobId: "job-1",
                action: "finished",
                status: "ok",
                error: nil,
                summary: "done",
                runAtMs: 1_700_000_050_000,
                durationMs: 1200,
                nextRunAtMs: 1_700_000_200_000),
        ]

        let view = CronSettings(store: store, channelsStore: ChannelsStore(isPreview: true))
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 700)
        hosting.layoutSubtreeIfNeeded()
        _ = hosting.fittingSize
    }

    @Test func `cron settings exercises private views`() {
        CronSettings.exerciseForTesting()
    }

    @Test func `config settings builds body`() {
        let view = ConfigSettings()
        _ = view.body
    }

    @Test func `debug settings builds body`() {
        let view = DebugSettings()
        _ = view.body
    }

    @Test func `general settings builds body`() {
        let state = AppState(preview: true)
        let view = GeneralSettings(state: state)
        _ = view.body
    }

    @Test func `general settings exercises branches`() {
        GeneralSettings.exerciseForTesting()
    }

    @Test func `sessions settings builds body`() {
        let view = SessionsSettings(rows: SessionRow.previewRows, isPreview: true)
        _ = view.body
    }

    @Test func `instances settings builds body`() {
        let store = InstancesStore(isPreview: true)
        store.instances = [
            InstanceInfo(
                id: "local",
                host: "this-mac",
                ip: "127.0.0.1",
                version: "1.0",
                platform: "macos 15.0",
                deviceFamily: "Mac",
                modelIdentifier: "MacPreview",
                lastInputSeconds: 12,
                mode: "local",
                reason: "test",
                text: "test instance",
                ts: Date().timeIntervalSince1970 * 1000),
        ]
        let view = InstancesSettings(store: store)
        _ = view.body
    }

    @Test func `permissions settings builds body`() {
        let view = PermissionsSettings(
            status: [
                .notifications: true,
                .screenRecording: false,
            ],
            refresh: {},
            showOnboarding: {})
        _ = view.body
    }

    @Test func `settings root view builds body`() {
        let state = AppState(preview: true)
        let view = SettingsRootView(state: state, updater: nil, initialTab: .general)
        _ = view.body
    }

    @Test func `about settings builds body`() {
        let view = AboutSettings(updater: nil)
        _ = view.body
    }

    @Test func `voice wake settings builds body`() {
        let state = AppState(preview: true)
        let view = VoiceWakeSettings(state: state, isActive: false)
        _ = view.body
    }

    @Test func `skills settings builds body`() {
        let view = SkillsSettings(state: .preview)
        _ = view.body
    }

    @Test func `exec approvals settings builds body`() {
        let view = ExecApprovalsSettings()
        _ = view.body
    }
}
