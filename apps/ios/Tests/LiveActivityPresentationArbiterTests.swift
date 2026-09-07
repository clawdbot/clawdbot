import Foundation
import Testing
@testable import OpenClaw

struct LiveActivityPresentationArbiterTests {
    @Test func `voice sample buffer quantizes clamps and stays bounded`() {
        var buffer = LiveActivityVoiceSampleBuffer(capacity: 3)

        for level in [-1.0, 0.25, 0.5, 2.0] {
            if let sample = LiveActivityVoiceSampleBuffer.quantize(level) {
                buffer.append(sample)
            }
        }

        #expect(buffer.payload == [64, 128, 255])
        #expect(LiveActivityVoiceSampleBuffer.quantize(.infinity) == nil)
        buffer.reset()
        #expect(buffer.payload == nil)
    }

    @Test
    func `attention outranks tools voice and connection`() {
        let now = Date()
        var arbiter = LiveActivityPresentationArbiter()
        arbiter.setConnection(Self.request(status: .connecting, detail: nil, startedAt: now))
        arbiter.setVoice(Self.request(status: .voiceListening, detail: nil, startedAt: now))
        arbiter.startTool(
            id: "tool-1",
            request: Self.request(status: .toolRunning, detail: "first", startedAt: now))
        arbiter.setAttention(Self.request(status: .approvalNeeded, detail: nil, startedAt: now))

        #expect(arbiter.current?.state.status == .approvalNeeded)

        arbiter.setAttention(nil)
        #expect(arbiter.current?.state.status == .toolRunning)
    }

    @Test
    func `parallel tools resume the newest remaining tool then voice`() {
        let now = Date()
        var arbiter = LiveActivityPresentationArbiter()
        arbiter.setVoice(Self.request(status: .voiceActive, detail: nil, startedAt: now))
        arbiter.startTool(
            id: "tool-1",
            request: Self.request(status: .toolRunning, detail: "first", startedAt: now))
        arbiter.startTool(
            id: "tool-2",
            request: Self.request(status: .toolRunning, detail: "second", startedAt: now))

        #expect(arbiter.activeToolCount == 2)
        #expect(arbiter.current?.state.verbatimDetail == "second")

        arbiter.endTool(id: "tool-2", sessionKey: "main")
        #expect(arbiter.current?.state.verbatimDetail == "first")

        arbiter.endTool(id: "tool-1", sessionKey: "main")
        #expect(arbiter.current?.state.status == .voiceActive)
    }

    @Test
    func `tool identities are scoped to their owning session`() {
        let now = Date()
        var arbiter = LiveActivityPresentationArbiter()
        arbiter.startTool(
            id: "shared-id",
            request: Self.request(
                status: .toolRunning,
                detail: "main",
                startedAt: now,
                sessionKey: "main"))
        arbiter.startTool(
            id: "shared-id",
            request: Self.request(
                status: .toolRunning,
                detail: "other",
                startedAt: now,
                sessionKey: "other"))

        #expect(arbiter.activeToolCount == 2)
        arbiter.endTool(id: "shared-id", sessionKey: "main")
        #expect(arbiter.activeToolCount == 1)
        #expect(arbiter.current?.sessionKey == "other")
    }

    @Test
    func `presentation lifecycle only carries across the same owner`() {
        let startedAt = Date(timeIntervalSince1970: 100)
        let now = Date(timeIntervalSince1970: 500)
        let existing = Self.request(
            status: .connecting,
            detail: nil,
            startedAt: startedAt,
            sessionKey: "main")

        #expect(LiveActivityManager.lifecycleStartedAt(
            existing: existing,
            agentName: "Aiden",
            sessionKey: "main",
            now: now) == startedAt)
        #expect(LiveActivityManager.lifecycleStartedAt(
            existing: existing,
            agentName: "Aiden",
            sessionKey: "other",
            now: now) == now)
        #expect(LiveActivityManager.lifecycleStartedAt(
            existing: existing,
            agentName: "Luna",
            sessionKey: "main",
            now: now) == now)
    }

    @Test
    func `voice status distinguishes active listening and speaking`() {
        #expect(LiveActivityPresentationArbiter.voiceStatus(isListening: false, isSpeaking: false) == .voiceActive)
        #expect(LiveActivityPresentationArbiter.voiceStatus(isListening: true, isSpeaking: false) == .voiceListening)
        #expect(LiveActivityPresentationArbiter.voiceStatus(isListening: true, isSpeaking: true) == .voiceSpeaking)
    }

    @Test
    func `voice sample history survives active phase changes`() {
        #expect(LiveActivityManager.shouldResetVoiceSamples(previousStatus: nil))
        #expect(!LiveActivityManager.shouldResetVoiceSamples(previousStatus: .voiceActive))
        #expect(!LiveActivityManager.shouldResetVoiceSamples(previousStatus: .voiceListening))
        #expect(!LiveActivityManager.shouldResetVoiceSamples(previousStatus: .voiceSpeaking))
    }

    @Test
    func `reconnect clears connection state without hiding active voice`() {
        let now = Date()
        var arbiter = LiveActivityPresentationArbiter()
        arbiter.setConnection(Self.request(status: .reconnecting, detail: nil, startedAt: now))
        arbiter.setAttention(Self.request(status: .actionRequired, detail: nil, startedAt: now))
        arbiter.setVoice(Self.request(status: .voiceListening, detail: nil, startedAt: now))

        arbiter.clearConnectionState()

        #expect(arbiter.attention == nil)
        #expect(arbiter.connection == nil)
        #expect(arbiter.current?.state.status == .voiceListening)
    }

    @Test
    func `live voice permanently replaces a hydrated tool fallback`() {
        let now = Date()
        var arbiter = LiveActivityPresentationArbiter()
        arbiter.adoptInitialHydratedToolFallback(
            Self.request(status: .toolRunning, detail: "restored", startedAt: now))

        arbiter.setVoice(Self.request(status: .voiceListening, detail: nil, startedAt: now))
        #expect(arbiter.hydratedToolFallback == nil)
        #expect(arbiter.current?.state.status == .voiceListening)

        arbiter.setVoice(nil)
        #expect(arbiter.current == nil)
    }

    @Test
    func `hydration trusts renewed voice and tool stale dates`() {
        let now = Date()
        let originalStart = now.addingTimeInterval(-600)
        let renewedStaleDate = now.addingTimeInterval(240)

        #expect(LiveActivityManager.shouldHydrate(
            status: .voiceSpeaking,
            startedAt: originalStart,
            staleDate: renewedStaleDate,
            now: now))
        #expect(LiveActivityManager.shouldHydrate(
            status: .toolRunning,
            startedAt: originalStart,
            staleDate: renewedStaleDate,
            now: now))
    }

    @Test
    func `hydration rejects expired and old non-heartbeat presentations`() {
        let now = Date()
        let originalStart = now.addingTimeInterval(-600)

        #expect(!LiveActivityManager.shouldHydrate(
            status: .voiceListening,
            startedAt: originalStart,
            staleDate: now.addingTimeInterval(-1),
            now: now))
        #expect(!LiveActivityManager.shouldHydrate(
            status: .reconnecting,
            startedAt: originalStart,
            staleDate: now.addingTimeInterval(240),
            now: now))
    }

    @Test
    func `voice live activity lifecycle is app owned`() throws {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourcesDirectory = testsDirectory.deletingLastPathComponent().appendingPathComponent("Sources")
        let appSource = try String(
            contentsOf: sourcesDirectory.appendingPathComponent("OpenClawApp.swift"),
            encoding: .utf8)
        let chatSource = try String(
            contentsOf: sourcesDirectory.appendingPathComponent("Design/ChatProTab.swift"),
            encoding: .utf8)
        let coordinatorSource = try String(
            contentsOf: sourcesDirectory.appendingPathComponent(
                "LiveActivity/VoiceLiveActivityCoordinator.swift"),
            encoding: .utf8)

        #expect(appSource.contains("if !Self.screenshotModeEnabled {"))
        #expect(appSource.contains("self.voiceLiveActivityCoordinator.start(appModel: self.appModel)"))
        #expect(coordinatorSource.contains("LiveActivityManager.shared.showVoice("))
        #expect(coordinatorSource.contains("LiveActivityManager.shared.updateVoiceLevel("))
        #expect(!chatSource.contains("syncVoiceLiveActivity"))
        #expect(!chatSource.contains("LiveActivityManager.shared.showVoice("))
    }

    private static func request(
        status: OpenClawActivityAttributes.ContentState.Status,
        detail: String?,
        startedAt: Date,
        sessionKey: String = "main") -> LiveActivityPresentationRequest
    {
        LiveActivityPresentationRequest(
            state: OpenClawActivityAttributes.ContentState(
                status: status,
                verbatimDetail: detail,
                startedAt: startedAt),
            staleDate: startedAt.addingTimeInterval(300),
            agentName: "Aiden",
            sessionKey: sessionKey)
    }
}
