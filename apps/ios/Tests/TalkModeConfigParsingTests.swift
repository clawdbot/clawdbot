import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
@Suite struct TalkModeManagerTests {
    @Test func parsesOpenAIRealtimeProviderModelAndVoice() {
        let config: [String: Any] = [
            "talk": [
                "provider": "elevenlabs",
                "providers": [
                    "elevenlabs": [
                        "modelId": "eleven_v3",
                        "voiceId": "eleven-voice",
                    ],
                ],
                "resolved": [
                    "provider": "elevenlabs",
                    "config": [
                        "modelId": "eleven_v3",
                        "voiceId": "eleven-voice",
                    ],
                ],
                "realtime": [
                    "provider": " openai ",
                    "model": " gpt-realtime-2 ",
                    "voice": " marin ",
                    "mode": "realtime",
                    "transport": "gateway-relay",
                    "brain": "agent-consult",
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.activeProvider == "elevenlabs")
        #expect(parsed.executionMode == .realtimeRelay)
        #expect(parsed.defaultModelId == "eleven_v3")
        #expect(parsed.defaultVoiceId == "eleven-voice")
        #expect(parsed.realtimeProvider == "openai")
        #expect(parsed.realtimeModelId == "gpt-realtime-2")
        #expect(parsed.realtimeVoiceId == "marin")
    }

    @Test func infersRealtimeProviderWhenProviderMapHasSingleEntry() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "mode": "realtime",
                    "transport": "webrtc",
                    "providers": [
                        "openai": [
                            "model": "gpt-realtime-2",
                        ],
                    ],
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.executionMode == .realtimeRelay)
        #expect(parsed.realtimeProvider == "openai")
        #expect(parsed.realtimeModelId == "gpt-realtime-2")
    }

    @Test func formatsGenericRealtimeVoiceModeWithoutNativeProviderFallback() {
        let descriptor = TalkVoiceModeDescriptorBuilder.build(
            providerId: "realtime",
            providerLabel: "Realtime Voice",
            modelId: "gpt-realtime-2",
            voiceId: nil,
            transport: "webrtc",
            isRealtime: true)

        #expect(descriptor.title == "Realtime Voice")
        #expect(descriptor.subtitle == "Native WebRTC • gpt-realtime-2")
    }

    @Test func defaultsOpenAIRealtimeModelWhenProviderOmitsModel() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "openai",
                    "mode": "realtime",
                    "transport": "gateway-relay",
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.executionMode == .realtimeRelay)
        #expect(parsed.defaultModelId == "eleven_v3")
        #expect(parsed.realtimeModelId == "gpt-realtime-2")
        #expect(parsed.realtimeVoiceId == nil)
    }

    @Test func resolvesRealtimeVoicePickerOverrides() {
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride(nil) == nil)
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride("") == nil)
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride(" Cedar ") == "cedar")
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride("unknown") == nil)
    }

    @Test func formatsOpenAIRealtimeVoiceMode() {
        let descriptor = TalkVoiceModeDescriptorBuilder.build(
            providerId: "openai",
            providerLabel: "OpenAI",
            modelId: "gpt-realtime-2",
            voiceId: "marin",
            transport: "webrtc",
            isRealtime: true)

        #expect(descriptor.title == "GPT Realtime 2.0")
        #expect(descriptor.subtitle == "Native WebRTC • Marin")
        #expect(descriptor.accessibilityValue == "GPT Realtime 2.0, Native WebRTC • Marin")
    }

    @Test func formatsGatewayRelayRealtimeVoiceMode() {
        let descriptor = TalkVoiceModeDescriptorBuilder.build(
            providerId: "google",
            providerLabel: "Google Live Voice",
            modelId: "gemini-live-2.5-flash-preview",
            voiceId: nil,
            transport: "gateway-relay",
            isRealtime: true)

        #expect(descriptor.title == "Google Live Voice")
        #expect(descriptor.subtitle == "Gateway Relay • gemini-live-2.5-flash-preview")
    }

    @Test func formatsElevenLabsVoiceMode() {
        let descriptor = TalkVoiceModeDescriptorBuilder.build(
            providerId: "elevenlabs",
            providerLabel: "ElevenLabs",
            modelId: "eleven_v3",
            voiceId: "voice-id",
            transport: "native",
            isRealtime: false)

        #expect(descriptor.title == "ElevenLabs")
        #expect(descriptor.subtitle == "Native • eleven_v3 • voice-id")
    }

    @Test func formatsSystemVoiceFallbackMode() {
        let descriptor = TalkVoiceModeDescriptorBuilder.build(
            providerId: "system",
            providerLabel: "iOS System Voice",
            modelId: nil,
            voiceId: "en-US",
            transport: "native",
            isRealtime: false)

        #expect(descriptor.title == "iOS System Voice")
        #expect(descriptor.subtitle == "Native • en-US")
    }

    @Test func openAIRealtimeSelectionFallbackKeepsGatewayRelayDefaults() {
        let manager = TalkModeManager(allowSimulatorCapture: true)

        manager._test_applyOpenAIRealtimeSelectionDefaults()

        #expect(manager._test_executionMode() == .realtimeRelay)
        #expect(manager._test_realtimeProvider() == "openai")
        #expect(manager._test_realtimeModelId() == "gpt-realtime-2")
        #expect(manager._test_gatewayTalkUsesRealtimeRelay())
    }

    @Test func buildsGenericRealtimeFallbackIssueForDisplay() {
        let issue = TalkRuntimeIssue.realtimeUnavailable(
            message: "OpenAI API key rejected with 401",
            provider: "openai",
            model: "gpt-realtime-2",
            transport: "gateway-relay",
            phase: "start")

        #expect(issue.code == .realtimeUnavailable)
        #expect(issue.displayMessage == "OpenAI API key rejected with 401")
        #expect(issue.diagnosticSummary.contains("provider: openai"))
        #expect(issue.diagnosticSummary.contains("model: gpt-realtime-2"))
        #expect(issue.fallbackStatusText == "Listening (iOS Speech fallback)")
        #expect(issue.fallbackBannerTitle == "Using iOS Speech fallback")
        #expect(issue.fallbackBannerOwnerLabel == "Fallback active")
        #expect(issue
            .fallbackBannerMessage ==
            "Realtime voice did not start. Talk is running with iOS speech recognition and TTS.")
        #expect(issue.technicalDetails.contains("code: realtime_unavailable"))
    }

    @Test func nativeFallbackKeepsRealtimeIssueVisible() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let issue = TalkRuntimeIssue(
            code: .realtimeUnavailable,
            message: "Realtime closed before it became ready.",
            provider: "openai",
            model: "gpt-realtime-2",
            transport: "gateway-relay",
            phase: "connect")

        manager._test_markNativeFallbackActive(after: issue)

        #expect(manager.statusText == "Listening (iOS Speech fallback)")
        #expect(manager._test_gatewayTalkActiveModeTitle() == "iOS Speech fallback")
        #expect(manager._test_gatewayTalkActiveModeSubtitle() == "Realtime closed before it became ready.")
        #expect(manager._test_gatewayTalkLastIssueText()?.contains("phase: connect") == true)
        #expect(manager._test_gatewayTalkCurrentFallbackIssue() == issue)
    }

    @Test func gatewayTalkIssueDetailsDriveRealtimeFailureDisplay() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let error = GatewayResponseError(
            method: "talk.session.create",
            code: "UNAVAILABLE",
            message: "Error: OpenAI API key rejected with 401",
            details: [
                "talkIssue": AnyCodable([
                    "code": "realtime_unavailable",
                    "message": "OpenAI API key rejected with 401",
                    "provider": "openai",
                    "model": "gpt-realtime-2",
                    "transport": "gateway-relay",
                    "phase": "request",
                ]),
            ])

        let issue = manager._test_realtimeIssue(from: error, phase: "start")

        #expect(issue.code == .realtimeUnavailable)
        #expect(issue.displayMessage == "OpenAI API key rejected with 401")
        #expect(issue.provider == "openai")
        #expect(issue.model == "gpt-realtime-2")
        #expect(issue.transport == "gateway-relay")
        #expect(issue.phase == "request")
    }

    @Test func relayStartupIssueSurvivesUntilReadyStatus() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let issue = TalkRuntimeIssue(
            code: .realtimeUnavailable,
            message: "OpenAI API key rejected with 401",
            provider: "openai",
            model: "gpt-realtime-2",
            transport: "gateway-relay",
            phase: "connect")

        manager._test_recordRealtimeIssue(issue)
        manager._test_handleRealtimeRelayStatus("Connecting realtime…")

        #expect(manager._test_gatewayTalkActiveModeTitle() == "Realtime unavailable")
        #expect(manager._test_gatewayTalkLastIssueText()?.contains("OpenAI API key rejected") == true)

        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")

        #expect(manager.statusText == "Listening (Realtime)")
        #expect(manager._test_gatewayTalkLastIssueText() == nil)
        #expect(manager._test_gatewayTalkCurrentFallbackIssue() == nil)
    }

    @Test func relayCloseClearsActiveRealtimeMode() {
        let manager = TalkModeManager(allowSimulatorCapture: true)

        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        #expect(manager.statusText == "Listening (Realtime)")
        #expect(manager._test_gatewayTalkActiveModeTitle() != "Not active")

        manager._test_handleRealtimeRelayStatus("Ready")

        #expect(manager.statusText == "Ready")
        #expect(manager._test_gatewayTalkActiveModeTitle() == "Not active")
        #expect(manager._test_gatewayTalkActiveModeSubtitle() == nil)
    }

    @Test func relayRetryClearsStaleFallbackTriggerButKeepsLastIssueVisible() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let issue = TalkRuntimeIssue(
            code: .realtimeUnavailable,
            message: "Realtime closed before it became ready.",
            provider: "openai",
            model: "gpt-realtime-2",
            transport: "gateway-relay",
            phase: "connect")

        manager._test_recordRealtimeIssue(issue)
        manager._test_markNativeFallbackActive(after: issue)
        #expect(manager._test_hasPendingRealtimeIssue())
        #expect(manager._test_gatewayTalkCurrentFallbackIssue() == issue)

        manager._test_prepareRealtimeRelayStart()

        #expect(!manager._test_hasPendingRealtimeIssue())
        #expect(manager._test_gatewayTalkCurrentFallbackIssue() == nil)
        #expect(manager._test_gatewayTalkLastIssueText()?.contains("Realtime closed before") == true)
    }

    @Test func mapsWebRTCRealtimeTransportToGatewayRelayOnIOS() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "openai",
                    "mode": "realtime",
                    "transport": "webrtc",
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.executionMode == .realtimeRelay)
    }

    @Test func parsesRedactedGatewayRealtimeConfig() {
        let config: [String: Any] = [
            "talk": [
                "providers": [
                    "elevenlabs": [
                        "apiKey": "__OPENCLAW_REDACTED__",
                        "voiceId": "bIHbv24MWmeRgasZH58o",
                    ],
                ],
                "realtime": [
                    "provider": "openai",
                    "providers": [
                        "openai": [
                            "model": "gpt-realtime-2",
                            "voice": "cedar",
                        ],
                    ],
                    "model": "gpt-realtime-2",
                    "mode": "realtime",
                    "transport": "webrtc",
                    "brain": "agent-consult",
                ],
                "provider": "elevenlabs",
                "resolved": [
                    "provider": "elevenlabs",
                    "config": [
                        "apiKey": "__OPENCLAW_REDACTED__",
                        "voiceId": "bIHbv24MWmeRgasZH58o",
                    ],
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.activeProvider == "elevenlabs")
        #expect(parsed.executionMode == .realtimeRelay)
        #expect(parsed.realtimeProvider == "openai")
        #expect(parsed.realtimeModelId == "gpt-realtime-2")
        #expect(parsed.realtimeVoiceId == "cedar")
        #expect(parsed.rawConfigApiKey == "__OPENCLAW_REDACTED__")
    }

    @Test func leavesNativeModeForManagedRoomRealtimeTransport() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "openai",
                    "mode": "realtime",
                    "transport": "managed-room",
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.executionMode == .native)
    }

    @Test func detectsPCMFormatRejectionFromElevenLabsError() {
        let error = NSError(
            domain: "ElevenLabsTTS",
            code: 403,
            userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs failed: 403 subscription_required output_format=pcm_44100",
            ])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error))
    }

    @Test func ignoresGenericPlaybackFailuresForPCMFormatRejection() {
        let error = NSError(
            domain: "StreamingAudio",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "queue enqueue failed"])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error) == false)
    }
}
