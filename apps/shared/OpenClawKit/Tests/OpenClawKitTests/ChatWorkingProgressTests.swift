import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatWorkingProgressTests {
    private let session = "agent:main:main"
    private let previousEndedAt = 900_000.0
    private let runEndedAt = 1_000_000.0

    @Test func `stance selection is deterministic for a run and salt`() {
        let salt: UInt32 = 0xA1B2_C3D4
        let run = "run-4c71b7e8"
        let first = ChatWorkingClawStance.seeded(run, salt: salt)
        #expect(first == ChatWorkingClawStance.seeded(run, salt: salt))
        #expect(first == .southpaw)
        #expect(ChatWorkingClawStance.seeded("run-a", salt: salt) == .standard)
        #expect(ChatWorkingClawStance.seeded("run-8", salt: salt) == .spin)
    }

    @Test func `working identity survives run rekey but resets for turn and session`() throws {
        let messageID = try #require(UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"))
        let nextMessageID = try #require(UUID(uuidString: "11111111-2222-3333-4444-555555555555"))
        let local = ChatWorkingIdentity.resolve(
            sessionKey: self.session,
            pendingRunIDs: ["local-run"],
            localUserMessageIDsByRunID: ["local-run": messageID],
            fallbackGeneration: 1)
        let remote = ChatWorkingIdentity.resolve(
            sessionKey: self.session,
            pendingRunIDs: ["remote-run"],
            localUserMessageIDsByRunID: ["remote-run": messageID],
            fallbackGeneration: 3)
        let nextTurn = ChatWorkingIdentity.resolve(
            sessionKey: self.session,
            pendingRunIDs: ["next-run"],
            localUserMessageIDsByRunID: ["next-run": nextMessageID],
            fallbackGeneration: 4)
        let nextSession = ChatWorkingIdentity.resolve(
            sessionKey: "agent:other:main",
            pendingRunIDs: ["remote-run"],
            localUserMessageIDsByRunID: ["remote-run": messageID],
            fallbackGeneration: 3)

        #expect(local == remote)
        #expect(local != nextTurn)
        #expect(local != nextSession)
    }

    @Test func `phrase rotation keeps adjacent buckets distinct and visits the full list`() {
        let indices = (0..<ChatWorkingPhrase.resources.count).map {
            ChatWorkingPhrase.index(seed: "run-phrase-seed", bucket: $0)
        }
        #expect(Set(indices).count == ChatWorkingPhrase.resources.count)
        for pair in zip(indices, indices.dropFirst()) {
            #expect(pair.0 != pair.1)
        }
        #expect(ChatWorkingPhrase.index(seed: "run-phrase-seed", elapsedMilliseconds: 29999) == nil)
        #expect(ChatWorkingPhrase.index(seed: "run-phrase-seed", elapsedMilliseconds: 30000) == indices[0])
        #expect(ChatWorkingPhrase.index(seed: "run-phrase-seed", elapsedMilliseconds: 75000) == indices[1])
    }

    @Test func `working phrases keep English defaults without a generated catalog`() {
        #expect(ChatWorkingPhrase.resources == [
            "Shelling",
            "Scuttling",
            "Clawing",
            "Pinching",
            "Molting",
            "Bubbling",
            "Tiding",
            "Reefing",
            "Cracking",
            "Sifting",
            "Brining",
            "Nautiling",
            "Krilling",
            "Barnacling",
            "Lobstering",
            "Tidepooling",
            "Pearling",
            "Snapping",
            "Surfacing",
        ])
    }

    @Test func `compact duration clamps and keeps two meaningful units`() {
        #expect(ChatWorkingDurationFormatter.compact(milliseconds: 0) == "1s")
        #expect(ChatWorkingDurationFormatter.compact(milliseconds: 51000) == "51s")
        #expect(ChatWorkingDurationFormatter.compact(milliseconds: 90000) == "1m 30s")
        #expect(ChatWorkingDurationFormatter.compact(milliseconds: 3_601_000) == "1h 1s")
        #expect(!ChatWorkingDurationFormatter.compact(milliseconds: 1e30).isEmpty)
    }

    @Test func `recap token text distinguishes unknown zero one and many`() {
        let locale = Locale(identifier: "en_US")
        #expect(ChatTurnRecapText.tokens(nil, locale: locale) == nil)
        #expect(ChatTurnRecapText.tokens(0, locale: locale) == "0 tokens")
        #expect(ChatTurnRecapText.tokens(1, locale: locale) == "1 token")
        #expect(ChatTurnRecapText.tokens(485, locale: locale) == "485 tokens")
        #expect(ChatTurnRecapText.done(runtimeMs: 51000, locale: locale) == "Done in 51s")
    }

    @Test func `recap resolves on a fresh terminal then sticks`() {
        var resolver = ChatTurnRecapResolver()
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.previousEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.previousEndedAt)) == nil)
        let row = self.doneRow(self.runEndedAt, runtimeMs: 51000, outputTokens: 485)
        let recap = ChatTurnRecap(runtimeMs: 51000, outputTokens: 485)
        #expect(resolver.resolve(sessionKey: self.session, indicatorVisible: false, row: row) == recap)
        #expect(resolver.resolve(sessionKey: self.session, indicatorVisible: false, row: row) == recap)
    }

    @Test func `recap rejects stale and regressed terminal stamps`() {
        var resolver = ChatTurnRecapResolver()
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.previousEndedAt))
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.previousEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.previousEndedAt - 5000)) == nil)
    }

    @Test func `recap expires an unresolved watch`() {
        var resolver = ChatTurnRecapResolver()
        let start = Date(timeIntervalSince1970: 1000)
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.previousEndedAt),
            now: start)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.previousEndedAt),
            now: start) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.previousEndedAt),
            now: start.addingTimeInterval(31)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt),
            now: start.addingTimeInterval(60)) == nil)
    }

    @Test func `recap consumes a fresh done row without runtime`() {
        var resolver = ChatTurnRecapResolver()
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.previousEndedAt))
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: ChatTurnRecapSessionRow(status: "done", endedAt: self.runEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt + 1000)) == nil)
    }

    @Test func `recap accepts a cleared run-start baseline`() {
        var resolver = ChatTurnRecapResolver()
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: ChatTurnRecapSessionRow(status: "running")) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt, runtimeMs: 2000)) ==
            ChatTurnRecap(runtimeMs: 2000, outputTokens: nil))
    }

    @Test func `recap never resolves without watching an indicator`() {
        var resolver = ChatTurnRecapResolver()
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt)) == nil)
    }

    @Test func `recap consumes a watch whose baseline was never observed`() {
        var resolver = ChatTurnRecapResolver()
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: nil) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.previousEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt)) == nil)
    }

    @Test func `recap adopts the first row observed mid-watch`() {
        var resolver = ChatTurnRecapResolver()
        _ = resolver.resolve(sessionKey: self.session, indicatorVisible: true, row: nil)
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.previousEndedAt))
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.previousEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt, runtimeMs: 6000)) ==
            ChatTurnRecap(runtimeMs: 6000, outputTokens: nil))
    }

    @Test func `recap forfeits when a terminal stamp changes mid-watch`() {
        var resolver = ChatTurnRecapResolver()
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: ChatTurnRecapSessionRow(status: "running"))
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.previousEndedAt))
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.previousEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt, runtimeMs: 4000)) == nil)
    }

    @Test func `recap forfeits a failed turn that races the indicator`() {
        var resolver = ChatTurnRecapResolver()
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: ChatTurnRecapSessionRow(status: "running"))
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: ChatTurnRecapSessionRow(status: "failed", endedAt: self.runEndedAt))
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: ChatTurnRecapSessionRow(status: "failed", endedAt: self.runEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt + 60000)) == nil)
    }

    @Test func `recap freezes against later unwatched terminals`() {
        var resolver = ChatTurnRecapResolver()
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.previousEndedAt))
        let settled = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt, runtimeMs: 51000, outputTokens: 485))
        #expect(settled == ChatTurnRecap(runtimeMs: 51000, outputTokens: 485))
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt + 90000, runtimeMs: 7000, outputTokens: 42)) == settled)
    }

    @Test func `recap hides when the next indicator appears`() {
        var resolver = ChatTurnRecapResolver()
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.previousEndedAt))
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt)) != nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.runEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt)) == nil)
    }

    @Test func `recap ignores stale failure rows`() {
        var resolver = ChatTurnRecapResolver()
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: ChatTurnRecapSessionRow(status: "failed", endedAt: self.previousEndedAt))
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: ChatTurnRecapSessionRow(status: "failed", endedAt: self.previousEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt, runtimeMs: 3000)) ==
            ChatTurnRecap(runtimeMs: 3000, outputTokens: nil))
    }

    @Test func `recap consumes a fresh failed row`() {
        var resolver = ChatTurnRecapResolver()
        _ = resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: true,
            row: self.doneRow(self.previousEndedAt))
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: ChatTurnRecapSessionRow(status: "failed", endedAt: self.runEndedAt)) == nil)
        #expect(resolver.resolve(
            sessionKey: self.session,
            indicatorVisible: false,
            row: self.doneRow(self.runEndedAt + 1000)) == nil)
    }

    private func doneRow(
        _ endedAt: Double,
        runtimeMs: Double = 51000,
        outputTokens: Int? = nil) -> ChatTurnRecapSessionRow
    {
        ChatTurnRecapSessionRow(
            status: "done",
            endedAt: endedAt,
            runtimeMs: runtimeMs,
            outputTokens: outputTokens)
    }
}
