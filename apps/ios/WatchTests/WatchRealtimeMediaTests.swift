import AVFAudio
import Foundation
import Network
import Observation
import OpenClawProtocol
import Synchronization
import Testing
import XCTest
@testable import OpenClawWatchApp

@MainActor
struct WatchRealtimeMediaTests {
    @Test(arguments: ["failed", "incomplete", nil] as [String?])
    func `response and generic voice errors leave the session reusable`(status: String?) throws {
        var events = WatchRealtimeCallController.TalkEvents()
        _ = try events.accept(Self.talkFrame("session.ready", seq: 1))
        var payload: [String: Any] = ["message": "The audio could not be transcribed."]
        if let status { payload["status"] = status }
        _ = try events.accept(Self.talkFrame("session.error", seq: 2, payload: payload, final: true))
        #expect(events.controlReady)
        #expect(events.errorText == "The audio could not be transcribed.")

        _ = try events.accept(Self.talkFrame("turn.ended", seq: 3, final: true))
        _ = try events.accept(Self.talkFrame("session.ready", seq: 4))
        #expect(events.errorText == "The audio could not be transcribed.")
        _ = try events.accept(Self.talkFrame("turn.started", seq: 2))
        _ = try events.accept(Self.talkFrame("session.error", seq: 1, payload: ["message": "Stale error"]))
        #expect(events.errorText == "The audio could not be transcribed.")

        _ = try events.accept(Self.talkFrame("turn.started", seq: 5))
        #expect(events.errorText == nil)
        _ = try events.accept(Self.talkFrame(
            "transcript.done", seq: 6, payload: ["text": "Please try again"], final: true))
        #expect(events.latestUserTranscript == "Please try again")
        _ = try events.accept(Self.talkFrame(
            "output.text.done", seq: 7, payload: ["text": "I can hear you."], final: true))
        #expect(events.latestAssistantTranscript == "I can hear you.")
        #expect(events.controlReady)
    }

    @Test(arguments: [false, true])
    func `voice notices bound supplied text and provide a missing-message fallback`(missingMessage: Bool) throws {
        var events = WatchRealtimeCallController.TalkEvents()
        let message = "  e\u{301} " + String(repeating: "🦞", count: 600)
        let payload: [String: Any] = missingMessage ? ["status": "failed"] : ["message": message]
        _ = try events.accept(Self.talkFrame("session.error", seq: 1, payload: payload, final: true))
        let notice = try #require(events.errorText)
        if missingMessage {
            #expect(!notice.isEmpty)
        } else {
            #expect(notice.utf8.elementsEqual(String(message.prefix(500)).utf8))
        }
        #expect(notice.count <= 500)
        _ = try events.accept(Self.talkFrame("session.ready", seq: 2))
        #expect(events.errorText == nil)
    }

    @Test func `voice closure stays terminal and malformed envelopes fail decoding`() throws {
        var events = WatchRealtimeCallController.TalkEvents()
        _ = try events.accept(Self.talkFrame("session.ready", seq: 2))
        _ = try events.accept(Self.talkFrame("session.closed", seq: 1))
        do {
            _ = try events.accept(Self.talkFrame("session.closed", seq: 3))
            Issue.record("A current session.closed event did not terminate the voice session")
        } catch let failure as WatchRealtimeMediaFailure {
            #expect(failure.kind == .sessionEnded)
        }

        let malformed = try JSONDecoder().decode(
            EventFrame.self,
            from: Data(#"{"type":"event","event":"talk.event","payload":{"talkEvent":{"type":"session.error"}}}"#.utf8))
        do {
            _ = try events.accept(malformed)
            Issue.record("Malformed Talk event bypassed decoding")
        } catch is DecodingError {}
    }

    private static func talkFrame(
        _ type: String, seq: Int, payload: [String: Any] = [:], final: Bool = false) throws -> EventFrame
    {
        let frame: [String: Any] = [
            "type": "event",
            "event": "talk.event",
            "payload": [
                "voiceSessionId": "watch-voice-test",
                "talkEvent": [
                    "id": "event-\(seq)", "type": type, "sessionId": "watch-voice-test", "turnId": "turn-1",
                    "seq": seq, "timestamp": "2026-09-04T00:00:00Z", "mode": "realtime", "transport": "webrtc",
                    "brain": "agent-consult", "payload": payload, "final": final,
                ],
            ],
        ]
        return try JSONDecoder().decode(EventFrame.self, from: JSONSerialization.data(withJSONObject: frame))
    }

    @Test func `invalidated call admission ends before microphone and network startup`() async throws {
        let controller = WatchRealtimeCallController()
        let connection = try WatchVoiceConnection(
            gatewayID: "watch-voice-test",
            websocketURLs: [#require(URL(string: "wss://gateway.invalid"))],
            setupSentAtMs: nil)
        let current = Mutex(true)
        controller.start(connection: connection, isCurrent: { current.withLock { $0 } })
        current.withLock { $0 = false }
        let changed = XCTestExpectation(description: "The queued call notices revoked admission")
        withObservationTracking {
            _ = controller.state
        } onChange: {
            changed.fulfill()
        }

        let result = await XCTWaiter.fulfillment(of: [changed], timeout: 3)
        #expect(result == .completed)
        #expect(controller.state == .failed)
        #expect(controller.errorText != nil)
        await controller.end().value
        #expect(controller.state == .idle)
    }

    @Test(arguments: [false, true])
    func `background startup cancellation keeps its reason without clearing a replacement error`(
        rejectReplacement: Bool) async throws
    {
        let controller = WatchRealtimeCallController()
        let connection = try WatchVoiceConnection(
            gatewayID: "watch-voice-test",
            websocketURLs: [#require(URL(string: "wss://gateway.invalid"))],
            setupSentAtMs: nil)
        controller.start(connection: connection, isCurrent: { true })
        controller.setMuted(true)
        let stopped = try #require(controller.sceneDidEnterBackground())
        #expect(controller.state == .stopping)
        #expect(controller.isMuted == false)
        #expect(controller.errorText?.isEmpty == false)
        if rejectReplacement {
            controller.start(connection: connection, isCurrent: { false })
            #expect(controller.state == .failed)
        }
        let visibleReason = controller.errorText

        await stopped.value
        #expect(controller.state == (rejectReplacement ? .failed : .idle))
        #expect(controller.errorText == visibleReason)
        await controller.end().value
        #expect(controller.state == .idle)
        #expect(controller.errorText == nil)
    }

    @Test func `pre-offer Opus leaves offer creation usable`() async throws {
        let eventCount = Mutex(0)
        let transport = WatchRealtimeTransport { _ in eventCount.withLock { $0 += 1 } }
        // Audio is active before signaling; muted capture still produces Opus frames.
        transport.sendOpus(Data([0xF8, 0xFF, 0xFE]), timestamp: 0)
        do {
            let offer = try await transport.makeOffer()
            #expect(offer.hasPrefix("v=0\r\n"))
            #expect(offer.contains("\r\nm=audio "))
        } catch {
            await transport.stop()
            throw error
        }
        await transport.stop()
        #expect(eventCount.withLock { $0 } == 0)
    }

    @Test func `cancelled and stopped transports cannot begin a network session`() async throws {
        let eventCount = Mutex(0)
        let transport = WatchRealtimeTransport { _ in eventCount.withLock { $0 += 1 } }
        let (gate, continuation) = AsyncStream<Void>.makeStream()
        let request = Task {
            for await _ in gate {}
            return try await transport.makeOffer()
        }
        request.cancel()
        continuation.finish()
        do {
            _ = try await request.value
            Issue.record("Canceled offer unexpectedly connected")
        } catch is CancellationError {}
        await transport.stop()
        do {
            _ = try await transport.makeOffer()
            Issue.record("Stopped transport unexpectedly restarted")
        } catch is CancellationError {}
        do {
            try await transport.applyAnswer("A stopped transport must not parse or resolve this answer")
            Issue.record("Stopped transport unexpectedly accepted an answer")
        } catch is CancellationError {}
        #expect(eventCount.withLock { $0 } == 0)
    }

    @Test func `resolved remote addresses share one same-family ICE and Network plan`() throws {
        let local4 = NWEndpoint.hostPort(host: "192.0.2.1", port: .any)
        let local6 = NWEndpoint.hostPort(host: "2001:db8::1", port: .any)
        let remote4 = NWEndpoint.hostPort(host: "192.0.2.10", port: 4000)
        let remote6 = NWEndpoint.hostPort(host: "2001:db8::10", port: 4000)
        let translated = NWEndpoint.hostPort(host: "2001:db8:64::c000:20a", port: 4000)
        typealias Remote = WatchRealtimeTransport.RemoteAddress
        for (locals, remote, destinations, aliases) in [
            ([local4], Remote(index: 0, original: remote4, addresses: [remote4]), [remote4], []),
            ([local6], Remote(index: 0, original: remote6, addresses: [remote6]), [remote6], []),
            ([local6], Remote(index: 0, original: remote4, addresses: [translated]), [translated], [translated]),
            (
                [local4, local6],
                Remote(index: 0, original: remote4, addresses: [remote4, translated]),
                [remote4, translated],
                [translated]),
        ] {
            let plan = try WatchRealtimeTransport.discoveryPlan(remotes: [remote], locals: locals)
            #expect(plan.pairs.map(\.source) == locals)
            #expect(plan.pairs.map(\.destination) == destinations)
            #expect(plan.destinations == Set(destinations))
            #expect(plan.aliases.map(\.address) == aliases)
            #expect(plan.aliases.allSatisfy { $0.index == 0 })
        }
    }

    @Test func `failed resolution has no fallback and does not discard valid siblings`() throws {
        let local = NWEndpoint.hostPort(host: "2001:db8::1", port: .any)
        let original = NWEndpoint.hostPort(host: "192.0.2.10", port: 4000)
        let sibling = NWEndpoint.hostPort(host: "192.0.2.11", port: 4000)
        let resolved = NWEndpoint.hostPort(host: "2001:db8:64::c000:20b", port: 4000)
        let failed = WatchRealtimeTransport.RemoteAddress(index: 0, original: original, addresses: [])
        let working = WatchRealtimeTransport.RemoteAddress(index: 1, original: sibling, addresses: [resolved, resolved])
        let plan = try WatchRealtimeTransport.discoveryPlan(remotes: [failed, working], locals: [local])
        #expect(plan.pairs.count == 1)
        #expect(plan.pairs.first?.destination == resolved)
        #expect(plan.aliases.count == 1)
        #expect(plan.aliases.first?.index == 1)
        #expect(plan.aliases.first?.address == resolved)
        #expect(plan.destinations == [resolved])
        #expect(!plan.destinations.contains(original))
        #expect(!plan.destinations.contains(sibling))
        do {
            _ = try WatchRealtimeTransport.discoveryPlan(remotes: [failed], locals: [local])
            Issue.record("An empty resolved plan unexpectedly admitted a route")
        } catch {
            let failure = try #require(error as? WatchRealtimeMediaFailure)
            #expect(failure.kind == .network)
        }
    }

    @Test func `expanded endpoint and cross-pair budgets reject the complete oversized plan`() throws {
        let local = NWEndpoint.hostPort(host: "2001:db8::1", port: .any)
        let direct = (1...11).map { index in
            let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("2001:db8:1::\(index)"), port: 4000)
            return WatchRealtimeTransport.RemoteAddress(index: index - 1, original: endpoint, addresses: [endpoint])
        }
        let maximum = try WatchRealtimeTransport.discoveryPlan(remotes: Array(direct.prefix(10)), locals: [local])
        #expect(maximum.pairs.count == 10)
        #expect(throws: WatchRealtimeMediaError.self) {
            try WatchRealtimeTransport.discoveryPlan(remotes: direct, locals: [local])
        }
        let expanded = (1...100).map { index in
            WatchRealtimeTransport.RemoteAddress(
                index: index - 1,
                original: .hostPort(host: NWEndpoint.Host("192.0.2.\(index)"), port: 4000),
                addresses: index == 1 ? [.hostPort(host: "2001:db8:64::1", port: 4000)] : [])
        }
        #expect(throws: WatchRealtimeMediaError.self) {
            try WatchRealtimeTransport.discoveryPlan(remotes: expanded, locals: [local])
        }
        let local4 = NWEndpoint.hostPort(host: "192.0.2.200", port: .any)
        let anotherLocal4 = NWEndpoint.hostPort(host: "192.0.2.201", port: .any)
        let mostlyUnusable = (1...100).map { index in
            let address = NWEndpoint.hostPort(host: NWEndpoint.Host("192.0.2.\(index)"), port: 4000)
            return WatchRealtimeTransport.RemoteAddress(
                index: index - 1, original: address, addresses: index == 1 ? [address] : [])
        }
        let oneSeed = try WatchRealtimeTransport.discoveryPlan(remotes: mostlyUnusable, locals: [local4])
        #expect(oneSeed.pairs.count == 1)
        #expect(throws: WatchRealtimeMediaError.self) {
            try WatchRealtimeTransport.discoveryPlan(remotes: mostlyUnusable, locals: [local4, anotherLocal4])
        }
    }

    @Test func `native Opus encodes raw RTP and decodes variable packet durations`() throws {
        let codec = try WatchOpusCodec()
        var packets = 0
        var decodedFrames = 0
        var energy = 0.0
        for index in 0..<20 {
            let pcm = try #require(AVAudioPCMBuffer(pcmFormat: codec.pcmFormat, frameCapacity: 960))
            pcm.frameLength = 960
            let samples = try #require(pcm.floatChannelData)[0]
            for sample in 0..<960 {
                samples[sample] = Float(sin(Double(index * 960 + sample) * 2 * .pi * 440 / 48000) * 0.25)
            }
            guard let packet = try codec.encode(pcm) else { continue }
            let decoded = try codec.decode(packet)
            packets += 1
            decodedFrames += Int(decoded.frameLength)
            let output = try #require(decoded.floatChannelData)[0]
            for sample in 0..<Int(decoded.frameLength) {
                energy += Double(output[sample] * output[sample])
            }
        }
        #expect(packets >= 19)
        #expect(decodedFrames >= 18000)
        #expect(sqrt(energy / Double(max(1, decodedFrames))) > 0.01)

        // The CELT silence fixture is a 20 ms frame. RFC 6716 §3.2.3 permits
        // two equal-sized frames under code 1, independently of our encoder's framing.
        for (packet, frames) in [(Data([0xF8, 0xFF, 0xFE]), 960), (Data([0xF9, 0xFF, 0xFE, 0xFF, 0xFE]), 1920)] {
            let decoder = try WatchOpusCodec()
            var total = 0
            for _ in 0..<20 {
                try total += Int(decoder.decode(packet).frameLength)
            }
            #expect(total >= frames * 19)
        }
    }
}
