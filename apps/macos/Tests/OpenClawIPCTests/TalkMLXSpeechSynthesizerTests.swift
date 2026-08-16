import Darwin
import Foundation
import OpenClawMLXTTSProtocol
import Testing
@testable import OpenClaw

#if arch(arm64)
@Suite(.serialized)
struct TalkMLXSpeechSynthesizerTests {
    @Test @MainActor
    func `shutdown reaps a TERM-resistant helper before returning`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-mlx-tts-lifecycle-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let helper = directory.appendingPathComponent("openclaw-mlx-tts-test-helper")
        let pidFile = directory.appendingPathComponent("helper.pid")
        let readyFrame = directory.appendingPathComponent("ready.frame")
        defer { TestProcessSupport.killLeakedProcesses(in: [pidFile]) }
        try MLXTTSFrameCodec.encode(MLXTTSEvent.ready).write(to: readyFrame)
        try Data("""
        #!/bin/sh
        trap '' TERM
        printf '%s\\n' "$$" > "$OPENCLAW_MLX_TTS_PID_FILE"
        /bin/cat "$OPENCLAW_MLX_TTS_READY_FILE"
        exec /bin/sleep 30
        """.utf8).write(to: helper)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper.path)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_MLX_TTS_BIN": helper.path,
            "OPENCLAW_MLX_TTS_PID_FILE": pidFile.path,
            "OPENCLAW_MLX_TTS_READY_FILE": readyFrame.path,
        ]) {
            let synthesizer = TalkMLXSpeechSynthesizer.shared
            await synthesizer.shutdown()
            let synthesis = Task {
                try await synthesizer.synthesize(
                    text: "hold transport open",
                    modelRepo: nil,
                    language: nil,
                    voicePreset: nil)
            }
            let pid = try await TestProcessSupport.waitForPID(in: pidFile)

            await synthesizer.shutdown()
            let helperWasReaped = await TestProcessSupport.waitUntilGone(
                pid,
                timeout: .milliseconds(100))
            if !helperWasReaped {
                _ = kill(pid, SIGKILL)
            }
            synthesis.cancel()
            _ = try? await synthesis.value

            #expect(await TestProcessSupport.waitUntilGone(pid))
            #expect(helperWasReaped)
        }
    }

    @Test
    func `stale startup exit cannot discard the replacement helper`() async throws {
        let stale = TestMLXTransport(mode: .staleStartupClose)
        let replacement = TestMLXTransport(mode: .audio)
        let factory = TestMLXTransportFactory([stale, replacement])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let staleSynthesis = Task {
            try await synthesizer.synthesize(
                text: "stale startup",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await factory.waitForCall()
        await synthesizer.shutdown()

        _ = try await synthesizer.synthesize(
            text: "replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        await stale.finishStaleClose()
        _ = try? await staleSynthesis.value
        _ = try await synthesizer.synthesize(
            text: "reuse replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)

        #expect(await factory.callCount == 2)
        await synthesizer.shutdown()
    }

    @Test
    func `reuses resident helper across utterances`() async throws {
        let transport = TestMLXTransport(mode: .audio)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let first = try await synthesizer.synthesize(
            text: "first",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        let second = try await synthesizer.synthesize(
            text: "second",
            modelRepo: "repo-a",
            language: "en",
            voicePreset: "voice-a")

        #expect(first.starts(with: Data("RIFF".utf8)))
        #expect(second.starts(with: Data("RIFF".utf8)))
        #expect(await factory.callCount == 1)
        let requests = await transport.sent
        #expect(requests.count == 2)
        guard case let .synthesize(firstRequest) = requests[0],
              case let .synthesize(secondRequest) = requests[1]
        else {
            Issue.record("expected two synthesis requests")
            return
        }
        #expect(firstRequest.modelRepo == TalkMLXSpeechSynthesizer.defaultModelRepo)
        #expect(secondRequest.modelRepo == "repo-a")
        #expect(secondRequest.language == "en")
        #expect(secondRequest.voice == "voice-a")
    }

    @Test
    func `streams pcm and forwards Fish reference inputs`() async throws {
        let transport = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let playback = try await synthesizer.synthesizeStream(
            text: "[whisper] keep this quiet",
            modelRepo: "mlx-community/fish-audio-s2-pro-8bit",
            language: nil,
            voicePreset: nil,
            referenceAudioPath: "/tmp/reference.wav",
            referenceText: "reference transcript")
        var received = Data()
        for try await chunk in playback.chunks {
            received.append(chunk)
        }

        #expect(playback.sampleRate == 32000)
        #expect(received == Data([0x00, 0x00, 0xFF, 0x7F]))
        let requests = await transport.sent
        guard let firstRequest = requests.first,
              case let .synthesize(request) = firstRequest
        else {
            Issue.record("expected synthesis request")
            return
        }
        #expect(request.stream)
        #expect(request.referenceAudioPath == "/tmp/reference.wav")
        #expect(request.referenceText == "reference transcript")
        #expect(request.text == "[whisper] keep this quiet")
    }

    @Test
    func `ending stream consumption cancels the helper request`() async throws {
        let transport = TestMLXTransport(mode: .streamWaitForCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        var playback: MLXTTSPlaybackStream? = try await synthesizer.synthesizeStream(
            text: "stop streaming",
            modelRepo: nil,
            language: nil,
            voicePreset: nil,
            referenceAudioPath: nil,
            referenceText: nil)
        #expect(playback?.sampleRate == 32000)
        playback = nil
        await transport.waitForCancelRequest()

        #expect(await transport.closeCount == 0)
    }

    @Test
    func `stream stall terminates the helper`() async throws {
        let transport = TestMLXTransport(mode: .streamWaitForCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let playback = try await synthesizer.synthesizeStream(
            text: "stall after first chunk boundary",
            modelRepo: nil,
            language: nil,
            voicePreset: nil,
            referenceAudioPath: nil,
            referenceText: nil,
            stallTimeoutSeconds: 0.01)

        do {
            for try await _ in playback.chunks {}
            Issue.record("expected stream timeout")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.timedOut {
            #expect(await transport.closeCount == 1)
        }
    }

    @Test
    func `retries once after helper crash`() async throws {
        let crashed = TestMLXTransport(mode: .crash)
        let restarted = TestMLXTransport(mode: .audio)
        let factory = TestMLXTransportFactory([crashed, restarted])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let data = try await synthesizer.synthesize(
            text: "retry me",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)

        #expect(data.starts(with: Data("RIFF".utf8)))
        #expect(await factory.callCount == 2)
        #expect(await crashed.closeCount == 1)
        #expect(await restarted.sent.count == 1)
    }

    @Test
    func `cancel uses protocol without closing helper`() async throws {
        let transport = TestMLXTransport(mode: .waitForCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let synthesis = Task {
            try await synthesizer.synthesize(
                text: "cancel me",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.cancelCurrent()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount == 0)
            #expect(await transport.sent.contains { request in
                if case .cancel = request {
                    return true
                }
                return false
            })
        }
    }

    @Test
    func `late audio after cancel is discarded`() async throws {
        let transport = TestMLXTransport(mode: .audioAfterCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let synthesis = Task {
            try await synthesizer.synthesize(
                text: "discard me",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.cancelCurrent()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount == 0)
        }
    }

    @Test
    func `unresponsive cancel terminates helper without retry`() async throws {
        let transport = TestMLXTransport(mode: .ignoreCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60),
            cancelGraceDuration: .milliseconds(10))

        let synthesis = Task {
            try await synthesizer.synthesize(
                text: "cancel me hard",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.cancelCurrent()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount == 1)
            #expect(await factory.callCount == 1)
        }
    }

    @Test
    func `shutdown terminates unresponsive in-flight helper`() async throws {
        let transport = TestMLXTransport(mode: .ignoreCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let synthesis = Task {
            try await synthesizer.synthesize(
                text: "stop during shutdown",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.shutdown()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount == 1)
            #expect(await transport.sent.contains(.shutdown))
        }
    }

    @Test
    func `memory pressure during synthesis preserves fallback`() async throws {
        let transport = TestMLXTransport(mode: .ignoreCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let synthesis = Task {
            try await synthesizer.synthesize(
                text: "fall back after pressure",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.handleMemoryPressure()

        do {
            _ = try await synthesis.value
            Issue.record("expected generation failure")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.audioGenerationFailed {
            #expect(await transport.closeCount == 1)
            #expect(await transport.sent.contains(.shutdown))
        }
    }

    @Test
    func `cancel can terminate helper before ready`() async throws {
        let transport = TestMLXTransport(mode: .startupHang)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60),
            cancelGraceDuration: .milliseconds(10))

        let synthesis = Task {
            try await synthesizer.synthesize(
                text: "never ready",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await factory.waitForCall()
        await synthesizer.cancelCurrent()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount >= 1)
            #expect(await factory.callCount == 1)
        }
    }

    @Test
    func `idle timeout shuts down resident helper`() async throws {
        let transport = TestMLXTransport(mode: .audio)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .milliseconds(10))

        _ = try await synthesizer.synthesize(
            text: "brief",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        await transport.waitForShutdown()

        #expect(await transport.closeCount == 1)
    }

    @Test
    func `pcm response becomes playable WAV`() throws {
        let wav = try TalkMLXSpeechSynthesizer.makeWAV(audio: MLXTTSAudio(
            id: "one",
            sampleRate: 32000,
            pcm: Data([0x00, 0x00, 0xFF, 0x7F])))

        #expect(wav.count == 48)
        #expect(wav.prefix(4) == Data("RIFF".utf8))
        #expect(wav.subdata(in: 8..<12) == Data("WAVE".utf8))
        #expect(wav.suffix(4) == Data([0x00, 0x00, 0xFF, 0x7F]))
    }
}

private enum TestMLXTransportError: Error {
    case closed
}

private actor TestMLXTransport: MLXTTSTransport {
    enum Mode: Equatable, Sendable {
        case audio
        case audioAfterCancel
        case crash
        case ignoreCancel
        case staleStartupClose
        case startupHang
        case stream
        case streamWaitForCancel
        case waitForCancel
    }

    let mode: Mode
    private(set) var sent: [MLXTTSRequest] = []
    private(set) var closeCount = 0
    private var events: [MLXTTSEvent] = [.ready]
    private var closed = false

    init(mode: Mode) {
        self.mode = mode
        if mode == .startupHang || mode == .staleStartupClose {
            self.events = []
        }
    }

    func send(_ request: MLXTTSRequest) {
        self.sent.append(request)
        switch request {
        case let .synthesize(synthesize):
            switch self.mode {
            case .audio:
                self.events.append(.audio(MLXTTSAudio(
                    id: synthesize.id,
                    sampleRate: 32000,
                    pcm: Data([0x00, 0x00, 0xFF, 0x7F]))))
            case .stream:
                self.events.append(.streamStarted(MLXTTSStreamStart(
                    id: synthesize.id,
                    sampleRate: 32000)))
                self.events.append(.audioChunk(MLXTTSAudioChunk(
                    id: synthesize.id,
                    pcm: Data([0x00, 0x00, 0xFF, 0x7F]))))
                self.events.append(.completed(id: synthesize.id))
            case .streamWaitForCancel:
                self.events.append(.streamStarted(MLXTTSStreamStart(
                    id: synthesize.id,
                    sampleRate: 32000)))
            case .crash:
                self.closed = true
            case .audioAfterCancel, .ignoreCancel, .staleStartupClose, .startupHang, .waitForCancel:
                break
            }
        case let .cancel(id):
            if self.mode == .audioAfterCancel {
                self.events.append(.audio(MLXTTSAudio(
                    id: id,
                    sampleRate: 32000,
                    pcm: Data([0x00, 0x00, 0xFF, 0x7F]))))
            } else if self.mode != .ignoreCancel, self.mode != .startupHang {
                self.events.append(.canceled(id: id))
            }
        case .shutdown:
            if self.mode != .staleStartupClose {
                self.closed = true
            }
        }
    }

    func nextEvent() async throws -> MLXTTSEvent {
        while self.events.isEmpty {
            if self.closed {
                throw TestMLXTransportError.closed
            }
            await Task.yield()
        }
        return self.events.removeFirst()
    }

    func close() {
        self.closeCount += 1
        if self.mode != .staleStartupClose {
            self.closed = true
        }
    }

    func finishStaleClose() {
        self.closed = true
    }

    func waitForSynthesisRequest() async {
        while !self.sent.contains(where: {
            if case .synthesize = $0 {
                return true
            }
            return false
        }) {
            await Task.yield()
        }
    }

    func waitForShutdown() async {
        while !self.sent.contains(.shutdown) || self.closeCount == 0 {
            await Task.yield()
        }
    }

    func waitForCancelRequest() async {
        while !self.sent.contains(where: {
            if case .cancel = $0 {
                return true
            }
            return false
        }) {
            await Task.yield()
        }
    }
}

private actor TestMLXTransportFactory {
    private var transports: [TestMLXTransport]
    private(set) var callCount = 0

    init(_ transports: [TestMLXTransport]) {
        self.transports = transports
    }

    func make() throws -> any MLXTTSTransport {
        self.callCount += 1
        guard !self.transports.isEmpty else {
            throw TestMLXTransportError.closed
        }
        return self.transports.removeFirst()
    }

    func waitForCall() async {
        while self.callCount == 0 {
            await Task.yield()
        }
    }
}
#endif
