import Foundation
import Testing
@testable import Clawdis

@Suite
struct CronModelsTests {
    @Test func scheduleAtEncodesAndDecodes() throws {
        let schedule = CronSchedule.at(atMs: 123)
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func scheduleEveryEncodesAndDecodesWithAnchor() throws {
        let schedule = CronSchedule.every(everyMs: 5_000, anchorMs: 10_000)
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

    @Test func displayNameTrimsWhitespaceAndFallsBack() {
        let base = CronJob(
            id: "x",
            name: "  hello  ",
            enabled: true,
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
            name: "t",
            enabled: true,
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

