import OpenClawChatUI
import Testing
@testable import OpenClaw

struct TalkProStateTests {
    @Test func `disabled talk without loaded config can start and retry load`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: false,
            isEnabled: false,
            statusText: "Offline",
            isConfigLoaded: false,
            isListening: false,
            isSpeaking: false,
            isUserSpeechDetected: false,
            permissionState: .unknown)

        #expect(state.title == "Voice config unavailable")
        #expect(state.primaryAction == .start)
        #expect(state.primaryButtonTitle == "Start Talk")
        #expect(state.waveformPhase(micLevel: 0.8, playbackLevel: nil) == .idle)
    }

    @Test func `enabled talk without loaded config can be stopped`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: false,
            isEnabled: true,
            statusText: "Offline",
            isConfigLoaded: false,
            isListening: false,
            isSpeaking: false,
            isUserSpeechDetected: false,
            permissionState: .unknown)

        #expect(state.title == "Voice config unavailable")
        #expect(state.primaryAction == .stop)
        #expect(state.primaryButtonTitle == "Stop Talk")
        #expect(state.waveformPhase(micLevel: 0.8, playbackLevel: nil) == .idle)
    }

    @Test func `enabled talk with loaded config can be stopped`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: false,
            isEnabled: true,
            statusText: "Ready",
            isConfigLoaded: true,
            isListening: false,
            isSpeaking: false,
            isUserSpeechDetected: false,
            permissionState: .ready)

        #expect(state.title == "Ready to talk")
        #expect(state.primaryAction == .stop)
    }

    @Test func `missing scope takes priority over unloaded config`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: false,
            isEnabled: false,
            statusText: "Offline",
            isConfigLoaded: false,
            isListening: false,
            isSpeaking: false,
            isUserSpeechDetected: false,
            permissionState: .missingScope("operator.talk.secrets"))

        #expect(state.title == "Gateway permission required")
        #expect(state.primaryAction == .enablePermission)
        #expect(state.primaryButtonTitle == "Enable Talk")
    }

    @Test func `demo mode keeps talk disabled`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: true,
            isEnabled: true,
            statusText: "Ready",
            isConfigLoaded: true,
            isListening: true,
            isSpeaking: true,
            isUserSpeechDetected: true,
            permissionState: .ready)

        #expect(state.title == "Demo mode only")
        #expect(state.primaryAction == .waiting)
        #expect(state.primaryButtonTitle == "Demo Mode Only")
        #expect(state.primaryButtonIcon == "lock.fill")
        #expect(state.waveformPhase(micLevel: 0.8, playbackLevel: nil) == .idle)
    }

    @Test func `listening drives the wave with the real mic level`() {
        let state = Self.readyState(isListening: true)
        #expect(state.waveformPhase(micLevel: 0.4, playbackLevel: nil)
            == .listening(level: 0.4, speechActive: false))
    }

    @Test func `detected speech keeps the real mic level and marks speech active`() {
        let state = Self.readyState(isListening: true, isUserSpeechDetected: true)
        #expect(state.waveformPhase(micLevel: 0.7, playbackLevel: nil)
            == .listening(level: 0.7, speechActive: true))
    }

    @Test func `speaking forwards the playback envelope when available`() {
        let state = Self.readyState(isSpeaking: true)
        #expect(state.waveformPhase(micLevel: 0, playbackLevel: 0.55) == .speaking(level: 0.55))
        #expect(state.waveformPhase(micLevel: 0, playbackLevel: nil) == .speaking(level: nil))
    }

    private static func readyState(
        isListening: Bool = false,
        isSpeaking: Bool = false,
        isUserSpeechDetected: Bool = false) -> TalkProState
    {
        TalkProState(
            gatewayConnected: true,
            isDemoMode: false,
            isEnabled: true,
            statusText: "Ready",
            isConfigLoaded: true,
            isListening: isListening,
            isSpeaking: isSpeaking,
            isUserSpeechDetected: isUserSpeechDetected,
            permissionState: .ready)
    }
}
