import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct CritterStatusBeatsTests {
    @Test func `failed gateway recovery triggers reconnect beat`() {
        #expect(CritterStatusLabel.reconnectBeat(
            lastSettled: .failed("boom"),
            to: .running(details: nil)))
    }

    @Test func `recovery through starting still reads as a comeback`() {
        // failed -> starting -> running: .starting never settles, so the
        // running transition is still judged against the failure.
        #expect(!CritterStatusLabel.isSettled(.starting))
        #expect(CritterStatusLabel.reconnectBeat(
            lastSettled: .failed("boom"),
            to: .attachedExisting(details: nil)))
    }

    @Test func `cold start stays quiet`() {
        #expect(!CritterStatusLabel.reconnectBeat(lastSettled: nil, to: .running(details: nil)))
    }

    @Test func `deliberate stop then start stays quiet`() {
        #expect(!CritterStatusLabel.reconnectBeat(lastSettled: .stopped, to: .running(details: nil)))
    }

    @Test func `already running gateway stays quiet`() {
        #expect(!CritterStatusLabel.reconnectBeat(
            lastSettled: .running(details: nil),
            to: .running(details: nil)))
    }

    @Test func `failure after failure stays quiet`() {
        #expect(!CritterStatusLabel.reconnectBeat(lastSettled: .failed("boom"), to: .failed("again")))
        #expect(!CritterStatusLabel.reconnectBeat(lastSettled: .failed("boom"), to: .stopped))
        #expect(!CritterStatusLabel.reconnectBeat(lastSettled: .failed("boom"), to: .starting))
    }

    @Test func `every non-starting status settles`() {
        #expect(CritterStatusLabel.isSettled(.stopped))
        #expect(CritterStatusLabel.isSettled(.running(details: nil)))
        #expect(CritterStatusLabel.isSettled(.attachedExisting(details: "pid 1")))
        #expect(CritterStatusLabel.isSettled(.failed("boom")))
    }

    @Test func `missing work start stays quiet`() {
        let endedAt = Date(timeIntervalSinceReferenceDate: 100)

        #expect(!CritterStatusLabel.workCompletionBeat(
            startedAt: nil,
            endedAt: endedAt,
            minimumDuration: 10))
    }

    @Test func `short work stays quiet`() {
        let startedAt = Date(timeIntervalSinceReferenceDate: 100)

        #expect(!CritterStatusLabel.workCompletionBeat(
            startedAt: startedAt,
            endedAt: startedAt.addingTimeInterval(5),
            minimumDuration: 10))
    }

    @Test func `long work triggers completion beat`() {
        let startedAt = Date(timeIntervalSinceReferenceDate: 100)

        #expect(CritterStatusLabel.workCompletionBeat(
            startedAt: startedAt,
            endedAt: startedAt.addingTimeInterval(15),
            minimumDuration: 10))
    }

    @Test func `minimum work duration triggers completion beat`() {
        let startedAt = Date(timeIntervalSinceReferenceDate: 100)

        #expect(CritterStatusLabel.workCompletionBeat(
            startedAt: startedAt,
            endedAt: startedAt.addingTimeInterval(10),
            minimumDuration: 10))
    }
}
