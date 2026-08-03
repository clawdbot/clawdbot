import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct WorkActivityStoreTests {
    @Test func `main session job preempts other`() {
        let store = WorkActivityStore()

        store.handleJob(sessionKey: "discord:group:1", state: "started")
        #expect(store.iconState == .workingOther(.job))
        #expect(store.current?.sessionKey == "discord:group:1")

        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))
        #expect(store.current?.sessionKey == "main")

        store.handleJob(sessionKey: "main", state: "finished")
        #expect(store.iconState == .workingOther(.job))
        #expect(store.current?.sessionKey == "discord:group:1")

        store.handleJob(sessionKey: "discord:group:1", state: "finished")
        #expect(store.iconState == .idle)
        #expect(store.current == nil)
    }

    @Test func `job stays working after tool result grace`() async {
        let store = WorkActivityStore()

        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("/tmp/file.txt")])
        #expect(store.iconState == .workingMain(.tool(.read)))

        store.handleTool(
            sessionKey: "main",
            phase: "result",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("/tmp/file.txt")])

        for _ in 0..<50 {
            if store.iconState == .workingMain(.job) { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(store.iconState == .workingMain(.job))

        store.handleJob(sessionKey: "main", state: "done")
        #expect(store.iconState == .idle)
    }

    @Test func `tool label extracts first line and shortens home`() {
        let store = WorkActivityStore()
        let home = NSHomeDirectory()

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "bash",
            meta: nil,
            args: [
                "command": AnyCodable("echo hi\necho bye"),
                "path": AnyCodable("\(home)/Projects/openclaw"),
            ])

        #expect(store.current?.label == "bash: echo hi")
        #expect(store.iconState == .workingMain(.tool(.bash)))

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("\(home)/secret.txt")])

        #expect(store.current?.label == "read: ~/secret.txt")
        #expect(store.iconState == .workingMain(.tool(.read)))
    }

    @Test func `resolve icon state honors override selection`() {
        let store = WorkActivityStore()
        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        store.resolveIconState(override: .idle)
        #expect(store.iconState == .idle)

        store.resolveIconState(override: .otherEdit)
        #expect(store.iconState == .overridden(.tool(.edit)))
    }
}
