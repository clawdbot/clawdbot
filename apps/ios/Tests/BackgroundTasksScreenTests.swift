import Foundation
import Testing
@testable import OpenClaw

struct BackgroundTasksScreenTests {
    @Test func `decodes bounded prompt and derives terminal output`() throws {
        let data = Data(#"""
        {
          "id":"task-1",
          "taskId":"task-1",
          "status":"failed",
          "runtime":"subagent",
          "title":"Audit tasks",
          "updatedAt":"2026-07-16T09:00:00.000Z",
          "prompt":"Review the background task UI",
          "terminalSummary":"Partial result",
          "error":"Worker failed"
        }
        """#.utf8)

        let task = try JSONDecoder().decode(MobileBackgroundTask.self, from: data)

        #expect(task.displayTitle == "Audit tasks")
        #expect(task.statusLabel == "Failed")
        #expect(task.runtimeLabel == "Subagent")
        #expect(task.prompt == "Review the background task UI")
        #expect(task.output == "Worker failed")
        #expect(task.activityMilliseconds > 0)
    }

    @Test func `groups active work and deduplicates newest task snapshot`() throws {
        let recent = try self.task(id: "finished", status: "completed", updatedAt: 4000)
        let stale = try self.task(id: "running", status: "running", updatedAt: 2000)
        let current = try self.task(id: "running", status: "running", updatedAt: 6000)

        let merged = MobileBackgroundTaskList.merge(recent: [recent, stale], active: [current])

        #expect(merged.map(\.id) == ["running", "finished"])
        #expect(merged.filter(\.isActive).map(\.id) == ["running"])
        #expect(merged.filter { !$0.isActive }.map(\.id) == ["finished"])
    }

    @Test func `untitled task uses canonical ledger id`() throws {
        let data = Data(#"""
        {
          "id":"ledger-1",
          "taskId":"runtime-1",
          "status":"running",
          "runtime":"cli",
          "kind":"exec"
        }
        """#.utf8)

        let task = try JSONDecoder().decode(MobileBackgroundTask.self, from: data)

        #expect(task.displayTitle == "ledger-1")
        #expect(task.isActive)
        #expect(task.runtimeLabel == "CLI")
    }

    @Test func `terminal snapshot wins a timestamp tie`() throws {
        let running = try self.task(id: "same", status: "running", updatedAt: 4000)
        let finished = try self.task(id: "same", status: "completed", updatedAt: 4000)

        let merged = MobileBackgroundTaskList.merge(recent: [finished], active: [running])

        #expect(merged.map(\.status) == ["completed"])
    }

    @Test func `loads active before terminal without overlapping status queries`() async throws {
        let running = try self.task(id: "same", status: "running", updatedAt: 2000)
        let completed = try self.task(id: "same", status: "completed", updatedAt: 3000)
        let probe = OrderedBackgroundTaskRequestProbe(active: [running], finished: [completed])

        let tasks = try await MobileBackgroundTaskList.load { status, limit in
            await probe.request(status: status, limit: limit)
        }
        let snapshot = await probe.snapshot()

        #expect(tasks.map(\.status) == ["completed"])
        #expect(snapshot.calls == [
            "queued,running|200",
            "completed,failed,cancelled,timed_out|100",
        ])
        #expect(!snapshot.overlapped)
    }

    private func task(id: String, status: String, updatedAt: Int) throws -> MobileBackgroundTask {
        let data = Data(#"""
        {
          "id":"\#(id)",
          "taskId":"\#(id)",
          "status":"\#(status)",
          "runtime":"cli",
          "title":"\#(id)",
          "updatedAt":\#(updatedAt)
        }
        """#.utf8)
        return try JSONDecoder().decode(MobileBackgroundTask.self, from: data)
    }
}

private actor OrderedBackgroundTaskRequestProbe {
    private let active: [MobileBackgroundTask]
    private let finished: [MobileBackgroundTask]
    private var calls: [String] = []
    private var inFlight = 0
    private var overlapped = false

    init(active: [MobileBackgroundTask], finished: [MobileBackgroundTask]) {
        self.active = active
        self.finished = finished
    }

    func request(status: [String], limit: Int) async -> [MobileBackgroundTask] {
        self.calls.append("\(status.joined(separator: ","))|\(limit)")
        self.inFlight += 1
        self.overlapped = self.overlapped || self.inFlight > 1
        await Task.yield()
        self.inFlight -= 1
        return status.contains("running") ? self.active : self.finished
    }

    func snapshot() -> (calls: [String], overlapped: Bool) {
        (self.calls, self.overlapped)
    }
}
