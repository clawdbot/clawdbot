import MoltbotProtocol
import Foundation
import Testing
@testable import Moltbot

@Suite
@MainActor
struct WorkActivityStoreTests {
    @Test func mainSessionJobPreemptsOther() {
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

    @Test func jobStaysWorkingAfterToolResultGrace() async {
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

    @Test func toolLabelExtractsFirstLineAndShortensHome() {
        let store = WorkActivityStore()
        let home = NSHomeDirectory()

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "bash",
            meta: nil,
            args: [
                "command": AnyCodable("echo hi\necho bye"),
                "path": AnyCodable("\(home)/Projects/moltbot"),
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

    @Test func resolveIconStateHonorsOverrideSelection() {
        let store = WorkActivityStore()
        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        store.resolveIconState(override: .idle)
        #expect(store.iconState == .idle)

        store.resolveIconState(override: .otherEdit)
        #expect(store.iconState == .overridden(.tool(.edit)))
    }
}
