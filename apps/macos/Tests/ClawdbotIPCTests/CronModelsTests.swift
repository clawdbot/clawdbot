import Foundation
import Testing
@testable import Moltbot

@Suite
struct CronModelsTests {
    @Test func scheduleAtEncodesAndDecodes() throws {
        let schedule = CronSchedule.at(atMs: 123)
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func scheduleEveryEncodesAndDecodesWithAnchor() throws {
        let schedule = CronSchedule.every(everyMs: 5000, anchorMs: 10000)
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func scheduleCronEncodesAndDecodesWithTimezone() throws {
        let schedule = CronSchedule.cron(expr: "*/5 * * * *", tz: "Europe/Vienna")
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func payloadAgentTurnEncodesAndDecodes() throws {
        let payload = CronPayload.agentTurn(
            message: "hello",
            thinking: "low",
            timeoutSeconds: 15,
            deliver: true,
            channel: "whatsapp",
            to: "+15551234567",
            bestEffortDeliver: false)
        let data = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(CronPayload.self, from: data)
        #expect(decoded == payload)
    }

    @Test func jobEncodesAndDecodesDeleteAfterRun() throws {
        let job = CronJob(
            id: "job-1",
            agentId: nil,
            name: "One-shot",
            description: nil,
            enabled: true,
            deleteAfterRun: true,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: .at(atMs: 1_700_000_000_000),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: "ping"),
            isolation: nil,
            state: CronJobState())
        let data = try JSONEncoder().encode(job)
        let decoded = try JSONDecoder().decode(CronJob.self, from: data)
        #expect(decoded.deleteAfterRun == true)
    }

    @Test func scheduleDecodeRejectsUnknownKind() {
        let json = """
        {"kind":"wat","atMs":1}
        """
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(CronSchedule.self, from: Data(json.utf8))
        }
    }

    @Test func payloadDecodeRejectsUnknownKind() {
        let json = """
        {"kind":"wat","text":"hello"}
        """
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(CronPayload.self, from: Data(json.utf8))
        }
    }

    @Test func displayNameTrimsWhitespaceAndFallsBack() {
        let base = CronJob(
            id: "x",
            agentId: nil,
            name: "  hello  ",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: .at(atMs: 0),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: "hi"),
            isolation: nil,
            state: CronJobState())
        #expect(base.displayName == "hello")

        var unnamed = base
        unnamed.name = "   "
        #expect(unnamed.displayName == "Untitled job")
    }

    @Test func nextRunDateAndLastRunDateDeriveFromState() {
        let job = CronJob(
            id: "x",
            agentId: nil,
            name: "t",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: .at(atMs: 0),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: "hi"),
            isolation: nil,
            state: CronJobState(
                nextRunAtMs: 1_700_000_000_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: nil,
                lastError: nil,
                lastDurationMs: nil))
        #expect(job.nextRunDate == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(job.lastRunDate == Date(timeIntervalSince1970: 1_700_000_050))
    }
}
