import Foundation
import Testing
@testable import OpenClaw

struct CronModelsTests {
    private func makeCronJob(
        name: String,
        payloadText: String,
        state: CronJobState = CronJobState()) -> CronJob
    {
        CronJob(
            id: "x",
            agentId: nil,
            name: name,
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: .at(at: "2026-02-03T18:00:00Z"),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: payloadText),
            delivery: nil,
            state: state)
    }

    @Test func `schedule at encodes and decodes`() throws {
        let schedule = CronSchedule.at(at: "2026-02-03T18:00:00Z")
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func `schedule at decodes legacy at ms`() throws {
        let json = """
        {"kind":"at","atMs":1700000000000}
        """
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: Data(json.utf8))
        if case let .at(at) = decoded {
            #expect(at.hasPrefix("2023-"))
        } else {
            #expect(Bool(false))
        }
    }

    @Test func `schedule every encodes and decodes with anchor`() throws {
        let schedule = CronSchedule.every(everyMs: 5000, anchorMs: 10000)
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func `schedule cron encodes and decodes with timezone`() throws {
        let schedule = CronSchedule.cron(expr: "*/5 * * * *", tz: "Europe/Vienna")
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func `payload agent turn encodes and decodes`() throws {
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

    @Test func `payload command encodes and decodes`() throws {
        let payload = CronPayload.command(
            argv: ["printf", "done"],
            cwd: "/tmp",
            env: ["MODE": "safe"],
            input: "stdin",
            timeoutSeconds: 30,
            noOutputTimeoutSeconds: 10,
            outputMaxBytes: 4096,
            toolsAllow: ["exec"],
            toolsAllowIsDefault: false)
        let data = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(CronPayload.self, from: data)
        #expect(decoded == payload)
        #expect(decoded.isEditableInMacApp == false)
    }

    @Test func `payload script encodes and decodes`() throws {
        let payload = CronPayload.script(
            script: "const result = await agent('check status')",
            timeoutSeconds: 90,
            toolBudget: 4,
            toolsAllow: ["web_search"],
            toolsAllowIsDefault: true)
        let data = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(CronPayload.self, from: data)
        #expect(decoded == payload)
        #expect(decoded.isEditableInMacApp == false)
    }

    @Test func `job encodes and decodes delete after run`() throws {
        let job = CronJob(
            id: "job-1",
            agentId: nil,
            name: "One-shot",
            description: nil,
            enabled: true,
            deleteAfterRun: true,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: .at(at: "2026-02-03T18:00:00Z"),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: "ping"),
            delivery: nil,
            state: CronJobState())
        let data = try JSONEncoder().encode(job)
        let decoded = try JSONDecoder().decode(CronJob.self, from: data)
        #expect(decoded.deleteAfterRun == true)
    }

    @Test func `schedule decode rejects unknown kind`() {
        let json = """
        {"kind":"wat","at":"2026-02-03T18:00:00Z"}
        """
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(CronSchedule.self, from: Data(json.utf8))
        }
    }

    @Test func `payload decode rejects unknown kind`() {
        let json = """
        {"kind":"wat","text":"hello"}
        """
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(CronPayload.self, from: Data(json.utf8))
        }
    }

    @Test func `display name trims whitespace and falls back`() {
        let base = self.makeCronJob(name: "  hello  ", payloadText: "hi")
        #expect(base.displayName == "hello")

        var unnamed = base
        unnamed.name = "   "
        #expect(unnamed.displayName == "Untitled job")
    }

    @Test func `next run date and last run date derive from state`() {
        let job = self.makeCronJob(
            name: "t",
            payloadText: "hi",
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

    @Test func `decode cron list response skips malformed jobs`() throws {
        let json = """
        {
          "jobs": [
            {
              "id": "good",
              "name": "Healthy job",
              "enabled": true,
              "createdAtMs": 1,
              "updatedAtMs": 2,
              "schedule": { "kind": "at", "at": "2026-03-01T10:00:00Z" },
              "sessionTarget": "main",
              "wakeMode": "now",
              "payload": { "kind": "systemEvent", "text": "hello" },
              "state": {}
            },
            {
              "id": "bad",
              "name": "Broken job",
              "enabled": true,
              "createdAtMs": 1,
              "updatedAtMs": 2,
              "schedule": { "kind": "at", "at": "2026-03-01T10:00:00Z" },
              "payload": { "kind": "systemEvent", "text": "hello" },
              "state": {}
            }
          ],
          "total": 2,
          "offset": 0,
          "limit": 50,
          "hasMore": false,
          "nextOffset": null
        }
        """

        let jobs = try GatewayConnection.decodeCronListResponse(Data(json.utf8))

        #expect(jobs.count == 1)
        #expect(jobs.first?.id == "good")
    }

    @Test func `decode cron list response keeps command and script jobs`() throws {
        let json = """
        {
          "jobs": [
            {
              "id": "command",
              "name": "Command job",
              "enabled": true,
              "createdAtMs": 1,
              "updatedAtMs": 2,
              "schedule": { "kind": "every", "everyMs": 60000 },
              "sessionTarget": "isolated",
              "wakeMode": "now",
              "payload": { "kind": "command", "argv": ["printf", "done"] },
              "state": {}
            },
            {
              "id": "script",
              "name": "Script job",
              "enabled": true,
              "createdAtMs": 1,
              "updatedAtMs": 2,
              "schedule": { "kind": "every", "everyMs": 60000 },
              "sessionTarget": "isolated",
              "wakeMode": "now",
              "payload": { "kind": "script", "script": "await agent('check status')", "toolBudget": 4 },
              "state": {}
            }
          ]
        }
        """

        let jobs = try GatewayConnection.decodeCronListResponse(Data(json.utf8))

        #expect(jobs.map(\.id) == ["command", "script"])
    }

    @Test func `decode cron runs response skips malformed entries`() throws {
        let json = """
        {
          "entries": [
            {
              "ts": 1,
              "jobId": "good",
              "action": "finished",
              "status": "ok"
            },
            {
              "jobId": "bad",
              "action": "finished",
              "status": "ok"
            }
          ]
        }
        """

        let entries = try GatewayConnection.decodeCronRunsResponse(Data(json.utf8))

        #expect(entries.count == 1)
        #expect(entries.first?.jobId == "good")
    }
}
