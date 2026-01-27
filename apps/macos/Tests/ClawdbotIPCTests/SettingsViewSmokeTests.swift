import SwiftUI
import Testing
@testable import Moltbot

@Suite(.serialized)
@MainActor
struct SettingsViewSmokeTests {
    @Test func cronSettingsBuildsBody() {
        let store = CronJobsStore(isPreview: true)
        store.schedulerEnabled = false
        store.schedulerStorePath = "/tmp/moltbot-cron-store.json"

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
            isolation: nil,
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
                deliver: true,
                channel: "sms",
                to: "+15551234567",
                bestEffortDeliver: true),
            isolation: CronIsolation(postToMainPrefix: "[cron] "),
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

    @Test func cronSettingsExercisesPrivateViews() {
        CronSettings.exerciseForTesting()
    }

    @Test func configSettingsBuildsBody() {
        let view = ConfigSettings()
        _ = view.body
    }

    @Test func debugSettingsBuildsBody() {
        let view = DebugSettings()
        _ = view.body
    }

    @Test func generalSettingsBuildsBody() {
        let state = AppState(preview: true)
        let view = GeneralSettings(state: state)
        _ = view.body
    }

    @Test func generalSettingsExercisesBranches() {
        GeneralSettings.exerciseForTesting()
    }

    @Test func sessionsSettingsBuildsBody() {
        let view = SessionsSettings(rows: SessionRow.previewRows, isPreview: true)
        _ = view.body
    }

    @Test func instancesSettingsBuildsBody() {
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

    @Test func permissionsSettingsBuildsBody() {
        let view = PermissionsSettings(
            status: [
                .notifications: true,
                .screenRecording: false,
            ],
            refresh: {},
            showOnboarding: {})
        _ = view.body
    }

    @Test func settingsRootViewBuildsBody() {
        let state = AppState(preview: true)
        let view = SettingsRootView(state: state, updater: nil, initialTab: .general)
        _ = view.body
    }

    @Test func aboutSettingsBuildsBody() {
        let view = AboutSettings(updater: nil)
        _ = view.body
    }

    @Test func voiceWakeSettingsBuildsBody() {
        let state = AppState(preview: true)
        let view = VoiceWakeSettings(state: state, isActive: false)
        _ = view.body
    }

    @Test func skillsSettingsBuildsBody() {
        let view = SkillsSettings(state: .preview)
        _ = view.body
    }
}
