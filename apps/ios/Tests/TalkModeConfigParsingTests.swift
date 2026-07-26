import AVFoundation
import Foundation
import OpenClawChatUI
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct TalkModeManagerTests {
    private struct CloseError: Error {}

    @Test func `encodes realtime client voice session identity`() throws {
        let params = TalkRealtimeClientCreateParams(
            sessionKey: "agent:main:main",
            voiceSessionId: "voice-1",
            provider: "openai",
            model: "gpt-realtime-2",
            voice: "marin",
            capabilities: ["voice-transcript"])
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(params)) as? [String: Any])

        #expect(object["sessionKey"] as? String == "agent:main:main")
        #expect(object["voiceSessionId"] as? String == "voice-1")
        #expect(object["capabilities"] as? [String] == ["voice-transcript"])
    }

    @Test func `decodes optional realtime client voice session id`() throws {
        let session = try JSONDecoder().decode(
            TalkRealtimeClientSession.self,
            from: Data(
                #"{"provider":"openai","transport":"webrtc","voiceSessionId":"voice-1","clientSecret":"secret"}"#.utf8))

        #expect(session.voiceSessionId == "voice-1")

        let serverOwned = try JSONDecoder().decode(
            TalkRealtimeClientSession.self,
            from: Data(#"{"provider":"openai","transport":"gateway-relay","clientSecret":"secret"}"#.utf8))
        #expect(serverOwned.voiceSessionId == nil)
    }

    @Test func `config invalidation closes and clears an adopted realtime prefetch`() async throws {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let gateway = GatewayNodeSession()
        manager.attachGateway(gateway)
        var closeRequests: [(method: String, paramsJSON: String?)] = []
        manager._test_setRealtimeVoiceSessionCloseRequest { method, paramsJSON in
            closeRequests.append((method, paramsJSON))
        }
        manager._test_preparePrefetchedRealtimeVoiceSession("vs-A")

        await manager._test_invalidatePrefetchedRealtimeSession()

        #expect(manager._test_activeRealtimeVoiceSessionId() == nil)
        #expect(!manager._test_hasPrefetchedRealtimeSession())
        let request = try #require(closeRequests.first)
        #expect(closeRequests.count == 1)
        #expect(request.method == "talk.client.close")
        let json = try #require(request.paramsJSON?.data(using: .utf8))
        let params = try #require(JSONSerialization.jsonObject(with: json) as? [String: String])
        #expect(params["voiceSessionId"] == "vs-A")
        #expect(params["sessionKey"] == "main")
    }

    @Test func `config invalidation preserves a live realtime voice session`() async {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let gateway = GatewayNodeSession()
        manager.attachGateway(gateway)
        var closeRequestCount = 0
        manager._test_setRealtimeVoiceSessionCloseRequest { _, _ in
            closeRequestCount += 1
        }
        manager._test_prepareLiveRealtimeVoiceSession(
            gateway: gateway,
            voiceSessionId: "vs-live",
            prefetchedVoiceSessionId: "vs-unused")

        await manager._test_invalidatePrefetchedRealtimeSession()

        #expect(manager._test_activeRealtimeVoiceSessionId() == "vs-live")
        #expect(!manager._test_hasPrefetchedRealtimeSession())
        #expect(closeRequestCount == 0)
        manager._test_clearRealtimeSession()
    }

    @Test func `retries realtime voice session close three times`() async throws {
        var attempts = 0

        try await TalkModeManager._test_retryRealtimeVoiceSessionClose {
            attempts += 1
            if attempts < 3 {
                throw CloseError()
            }
        }

        #expect(attempts == 3)
    }

    @Test func `encodes transcript entry id as a decimal string`() throws {
        let params = TalkRealtimeTranscriptParams(
            sessionKey: "agent:main:main",
            voiceSessionId: "voice-1",
            entryId: "1",
            role: .assistant,
            text: "hello",
            timestamp: 1234)
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(params)) as? [String: Any])

        #expect(object["entryId"] as? String == "1")
    }

    @Test func `surfaces voice confirmation id for a follow up consult`() throws {
        let error = GatewayResponseError(
            method: "talk.client.toolCall",
            code: "INVALID_REQUEST",
            message: "VOICE_CONFIRMATION_REQUIRED:confirm_123 Ask the user to confirm.",
            details: nil)

        let instruction = try #require(TalkRealtimeWebRTCSession.voiceConfirmationInstruction(from: error))
        #expect(instruction.contains("VOICE_CONFIRMATION_REQUIRED:confirm_123"))
        #expect(instruction.contains("confirmationId confirm_123"))
    }

    @Test func `recognizes open AI maximum duration errors as terminal`() throws {
        let event = try JSONDecoder().decode(
            TalkRealtimeServerEvent.self,
            from: Data(#"{"type":"error","error":{"message":"Your session hit the maximum duration of 60 minutes."}}"#
                .utf8))

        #expect(event.isMaximumDurationError)
    }

    @Test func `keeps recoverable open AI errors in the current session`() throws {
        let event = try JSONDecoder().decode(
            TalkRealtimeServerEvent.self,
            from: Data(#"{"type":"error","error":{"message":"Cancellation failed: no active response found"}}"#.utf8))

        #expect(!event.isMaximumDurationError)
    }

    @Test func `parses open AI realtime provider model and voice`() {
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

    @Test func `infers realtime provider when provider map has single entry`() {
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

        #expect(parsed.executionMode == .realtimeWebRTC)
        #expect(parsed.realtimeProvider == "openai")
        #expect(parsed.realtimeModelId == "gpt-realtime-2")
    }

    @Test func `formats generic realtime voice mode without native provider fallback`() {
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

    @Test func `defaults open AI realtime model when provider omits model`() {
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

    @Test func `resolves realtime voice picker overrides`() {
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride(nil) == nil)
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride("") == nil)
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride(" Cedar ") == "cedar")
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride("unknown") == nil)
    }

    @Test func `formats open AI realtime voice mode`() {
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

    @Test func `formats gateway relay realtime voice mode`() {
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

    @Test func `formats eleven labs voice mode`() {
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

    @Test func `formats system voice fallback mode`() {
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

    @Test func `open AI realtime selection defaults to native web RTC`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)

        manager._test_applyOpenAIRealtimeSelectionDefaults()

        #expect(manager._test_executionMode() == .realtimeWebRTC)
        #expect(manager._test_realtimeProvider() == "openai")
        #expect(manager._test_realtimeModelId() == "gpt-realtime-2")
        #expect(!manager._test_gatewayTalkUsesRealtimeRelay())
    }

    @Test func `open AI realtime selection clears stale realtime config`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "google",
                    "model": "gemini-live-2.5-flash-preview",
                    "voice": "puck",
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

        manager._test_applyLoadedTalkConfig(parsed, providerSelection: .gatewayDefault)
        manager._test_applyOpenAIRealtimeSelectionDefaults()

        #expect(manager._test_executionMode() == .realtimeWebRTC)
        #expect(manager._test_realtimeProvider() == "openai")
        #expect(manager._test_realtimeModelId() == "gpt-realtime-2")
        #expect(manager.gatewayTalkRealtimeVoiceId == nil)
        #expect(!manager._test_gatewayTalkUsesRealtimeRelay())
    }

    @Test func `open AI realtime selection keeps explicit open AI voice override`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let defaults = UserDefaults.standard
        defaults.set(" Cedar ", forKey: TalkModeRealtimeVoiceSelection.storageKey)
        defer { defaults.removeObject(forKey: TalkModeRealtimeVoiceSelection.storageKey) }
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "google",
                    "model": "gemini-live-2.5-flash-preview",
                    "voice": "puck",
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

        manager._test_applyLoadedTalkConfig(parsed, providerSelection: .openAIRealtime)

        #expect(manager._test_realtimeProvider() == "openai")
        #expect(manager._test_realtimeModelId() == "gpt-realtime-2")
        #expect(manager.gatewayTalkRealtimeVoiceId == "cedar")
    }

    @Test func `open AI selection preserves configured voice for case insensitive provider`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": " OpenAI ",
                    "voice": "marin",
                    "mode": "realtime",
                    "transport": "webrtc",
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

        manager._test_applyLoadedTalkConfig(parsed, providerSelection: .openAIRealtime)

        #expect(manager._test_realtimeProvider() == "openai")
        #expect(manager.gatewayTalkRealtimeVoiceId == "marin")
    }

    @Test func `builds generic realtime fallback issue for display`() {
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

    @Test func `native fallback keeps realtime issue visible`() {
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

    @Test func `gateway talk issue details drive realtime failure display`() {
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

    @Test func `relay startup issue survives until ready status`() {
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

    @Test func `relay close clears active realtime mode`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)

        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        #expect(manager.statusText == "Listening (Realtime)")
        #expect(manager._test_gatewayTalkActiveModeTitle() != "Not active")

        manager._test_handleRealtimeRelayStatus("Ready")

        #expect(manager.statusText == "Ready")
        #expect(manager._test_gatewayTalkActiveModeTitle() == "Not active")
        #expect(manager._test_gatewayTalkActiveModeSubtitle() == nil)
    }

    @Test func `realtime failures remain visible on the watch`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)

        manager._test_handleRealtimeRelayStatus("Realtime disconnected")
        #expect(manager.watchPresentation == .localized("Realtime disconnected"))

        manager._test_handleRealtimeRelayStatus("Backend rejected realtime request")
        #expect(manager.watchPresentation == .verbatim("Backend rejected realtime request"))

        manager._test_handleRealtimeRelayStatus("Confirmation needed")
        #expect(manager.statusText == String(localized: "Confirmation needed"))
        #expect(manager.watchPresentation == .localized("Confirmation needed"))

        manager._test_handleRealtimeRelayStatus("Reconnecting")
        #expect(manager.phase == .connecting)
        #expect(manager.watchPresentation == .phase)
    }

    @Test func `WebRTC progress remains semantic on the watch`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)

        manager._test_handleRealtimeRelayStatus("Connecting")
        #expect(manager.phase == .connecting)
        #expect(manager.watchPresentation == .phase)

        for status in ["Asking OpenClaw", "Still asking OpenClaw", "Updating OpenClaw"] {
            manager._test_handleRealtimeRelayStatus(status)
            #expect(manager.phase == .thinking)
            #expect(manager.watchPresentation == .phase)
        }
    }

    @Test func `relay close restarts enabled continuous realtime`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager._test_prepareEnabledRealtimeSessionForClose()

        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        manager._test_handleRealtimeRelayStatus("Ready")

        #expect(manager.statusText == "Reconnecting")
        #expect(manager._test_rapidRealtimeRestartCount() == 1)
        manager.isEnabled = false
    }

    @Test func `recurring realtime ready status preserves push to talk capture`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)

        #expect(manager._test_realtimeStatusPreservesPushToTalkCapture())
    }

    @Test func `relay retry clears stale fallback trigger but keeps last issue visible`() {
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

    @Test func `session switch invalidates an in flight realtime relay start`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager._test_setRealtimeRelayStartInFlight(true)

        manager.updateMainSessionKey("agent:main:replacement")

        #expect(!manager._test_realtimeRelayStartIsInFlight())
        #expect(manager._test_mainSessionKey() == "agent:main:replacement")
    }

    @Test func `duplicate start preserves realtime owned speaking phase`() async {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.updateGatewayConnected(true)
        manager.isEnabled = true
        manager.isListening = false
        manager.isSpeaking = true
        manager.statusText = "Speaking"
        manager._test_setRealtimeRelayStartInFlight(true)

        await manager.start()

        #expect(manager._test_realtimeRelayStartIsInFlight())
        #expect(!manager.isListening)
        #expect(manager.isSpeaking)
        #expect(manager.statusText == "Speaking")
    }

    @Test func `route preference change does not activate enabled idle Talk`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.isEnabled = true

        manager.applyAudioRoutePreferenceChanged()

        #expect(!manager._test_audioSessionIsActive())
    }

    @Test func `maps web RTC realtime transport to native web RTC on IOS`() {
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

        #expect(parsed.executionMode == .realtimeWebRTC)
    }

    @Test func `keeps Azure open AI realtime on gateway relay`() {
        for providerConfig in [
            ["azureEndpoint": "https://example.openai.azure.com"],
            ["azureDeployment": "realtime-prod"],
        ] {
            let config: [String: Any] = [
                "talk": [
                    "realtime": [
                        "provider": "openai",
                        "providers": ["openai": providerConfig],
                        "mode": "realtime",
                        "transport": "webrtc",
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
            let routing = TalkModeRoutingResolver.resolve(
                parsed: parsed,
                providerSelection: .openAIRealtime,
                defaultProvider: "elevenlabs",
                defaultRealtimeModelId: "gpt-realtime-2")

            #expect(parsed.executionMode == .realtimeRelay)
            #expect(routing.route == .realtimeRelay)
        }
    }

    @Test func `open AI selection keeps its Azure config on gateway relay`() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "google",
                    "providers": [
                        "google": ["model": "gemini-live"],
                        "OpenAI": ["azureDeployment": "realtime-prod"],
                    ],
                    "mode": "realtime",
                    "transport": "webrtc",
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
        let routing = TalkModeRoutingResolver.resolve(
            parsed: parsed,
            providerSelection: .openAIRealtime,
            defaultProvider: "elevenlabs",
            defaultRealtimeModelId: "gpt-realtime-2")

        #expect(parsed.realtimeProvider == "google")
        #expect(routing.route == .realtimeRelay)
    }

    @Test func `restarts an enabled continuous realtime session after provider close`() {
        #expect(TalkModeManager._test_shouldRestartRealtimeSession(
            isEnabled: true,
            gatewayConnected: true,
            captureIsContinuous: true))
        #expect(!TalkModeManager._test_shouldRestartRealtimeSession(
            isEnabled: false,
            gatewayConnected: true,
            captureIsContinuous: true))
        #expect(!TalkModeManager._test_shouldRestartRealtimeSession(
            isEnabled: true,
            gatewayConnected: false,
            captureIsContinuous: true))
        #expect(!TalkModeManager._test_shouldRestartRealtimeSession(
            isEnabled: true,
            gatewayConnected: true,
            captureIsContinuous: false))

        #expect(TalkModeManager._test_realtimeRestartAttempt(
            previousRapidRestarts: 1,
            activeDuration: 5) == 2)
        #expect(TalkModeManager._test_realtimeRestartAttempt(
            previousRapidRestarts: 2,
            activeDuration: 31) == 1)
        #expect(TalkModeManager._test_realtimeRestartDelayNanoseconds(attempt: 1) == 500_000_000)
        #expect(TalkModeManager._test_realtimeRestartDelayNanoseconds(attempt: 2) == 2_000_000_000)
        #expect(TalkModeManager._test_realtimeRestartDelayNanoseconds(attempt: 3) == nil)
    }

    @Test @MainActor func `speech restart clears only the presentation revision it owns`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager._test_markSpeechErrorStatusPendingRestart("Spracherkennungsfehler")
        manager._test_restoreListeningStatusAfterSpeechErrorRestart()
        #expect(manager.statusText == String(localized: "Listening"))
        #expect(manager.phase == .listening)

        manager._test_markSpeechErrorStatusPendingRestart("Spracherkennungsfehler")
        manager.statusText = "Neue Statusmeldung"
        manager._test_restoreListeningStatusAfterSpeechErrorRestart()
        #expect(manager.statusText == "Neue Statusmeldung")
        #expect(manager.phase == .idle)
    }

    @Test func `keeps provider web socket realtime transport on gateway relay`() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "google",
                    "mode": "realtime",
                    "transport": "provider-websocket",
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

        #expect(parsed.executionMode == .realtimeRelay)
    }

    @Test(arguments: ["direct-tools", "none"])
    func `leaves native mode for unsupported realtime brain`(brain: String) {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "google",
                    "mode": "realtime",
                    "transport": "gateway-relay",
                    "brain": brain,
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

    @Test func `keeps non open AI realtime default transport on gateway relay`() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "google",
                    "mode": "realtime",
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

        #expect(parsed.executionMode == .realtimeRelay)
    }

    @Test func `keeps non open AI web RTC transport on gateway relay`() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "google",
                    "model": "gemini-live-2.5-flash-preview",
                    "mode": "realtime",
                    "transport": "webrtc",
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

        #expect(parsed.executionMode == .realtimeRelay)
    }

    @Test func `open AI selection overrides non open AI web RTC provider`() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "google",
                    "mode": "realtime",
                    "transport": "webrtc",
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
        let routing = TalkModeRoutingResolver.resolve(
            parsed: parsed,
            providerSelection: .openAIRealtime,
            defaultProvider: "elevenlabs",
            defaultRealtimeModelId: "gpt-realtime-2")

        #expect(routing.activeProvider == "openai")
        #expect(routing.realtimeProvider == "openai")
        #expect(routing.realtimeModelId == "gpt-realtime-2")
        #expect(routing.executionMode == .realtimeWebRTC)
        #expect(routing.route == .realtimeWebRTC)
    }

    @Test func `open AI selection preserves explicit gateway owned transport`() {
        for transport in ["gateway-relay", "provider-websocket"] {
            let config: [String: Any] = [
                "talk": [
                    "realtime": [
                        "provider": "google",
                        "mode": "realtime",
                        "transport": transport,
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
            let routing = TalkModeRoutingResolver.resolve(
                parsed: parsed,
                providerSelection: .openAIRealtime,
                defaultProvider: "elevenlabs",
                defaultRealtimeModelId: "gpt-realtime-2")

            #expect(routing.realtimeProvider == "openai")
            #expect(routing.executionMode == .realtimeRelay)
            #expect(routing.route == .realtimeRelay)
        }
    }

    @Test func `speaker preference preserves external audio routes`() {
        let externalRouteOptions = TalkAudioRoute.categoryOptions(speakerphoneEnabled: false)
        #expect(externalRouteOptions.contains(.allowBluetoothHFP))
        #expect(externalRouteOptions.contains(.allowBluetoothA2DP))
        #expect(externalRouteOptions.contains(.allowAirPlay))
        #expect(!externalRouteOptions.contains(.defaultToSpeaker))
        #expect(TalkAudioRoute.categoryOptions(speakerphoneEnabled: true).contains(.defaultToSpeaker))

        #expect(TalkAudioRoute.shouldForceSpeaker(
            preferenceEnabled: true,
            outputPortTypes: [.builtInReceiver]))
        #expect(TalkAudioRoute.shouldForceSpeaker(
            preferenceEnabled: true,
            outputPortTypes: [.builtInSpeaker]))
        #expect(!TalkAudioRoute.shouldForceSpeaker(
            preferenceEnabled: false,
            outputPortTypes: [.builtInReceiver]))
        #expect(!TalkAudioRoute.shouldForceSpeaker(
            preferenceEnabled: true,
            outputPortTypes: []))

        let externalOutputs: [AVAudioSession.Port] = [
            .airPlay,
            .bluetoothA2DP,
            .bluetoothHFP,
            .bluetoothLE,
            .carAudio,
            .headphones,
            .HDMI,
            .lineOut,
            .usbAudio,
        ]
        for output in externalOutputs {
            #expect(!TalkAudioRoute.shouldForceSpeaker(
                preferenceEnabled: true,
                outputPortTypes: [output]))
        }
    }

    @Test func `maps open AI realtime default transport to native web RTC`() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "openai",
                    "mode": "realtime",
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

        #expect(parsed.executionMode == .realtimeWebRTC)
    }

    @Test func `parses redacted gateway realtime config`() {
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
        #expect(parsed.executionMode == .realtimeWebRTC)
        #expect(parsed.realtimeProvider == "openai")
        #expect(parsed.realtimeModelId == "gpt-realtime-2")
        #expect(parsed.realtimeVoiceId == "cedar")
        #expect(parsed.rawConfigApiKey == "__OPENCLAW_REDACTED__")
    }

    @Test func `leaves native mode for managed room realtime transport`() {
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

    @Test func `detects PCM format rejection from eleven labs error`() {
        let error = NSError(
            domain: "ElevenLabsTTS",
            code: 403,
            userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs failed: 403 subscription_required output_format=pcm_44100",
            ])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error))
    }

    @Test func `ignores generic playback failures for PCM format rejection`() {
        let error = NSError(
            domain: "StreamingAudio",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "queue enqueue failed"])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error) == false)
    }

    @Test func `history fallback only selects the current run reply`() {
        let messages: [[String: Any]] = [
            [
                "role": "assistant",
                "idempotencyKey": "old-run",
                "content": [["type": "text", "text": "stale answer"]],
            ],
            [
                "role": "assistant",
                "__openclaw": ["idempotencyKey": "current-run"],
                "content": [["type": "text", "text": "current answer"]],
            ],
        ]

        #expect(TalkModeManager._test_latestAssistantText(
            messages: messages,
            runId: "current-run") == "current answer")
        #expect(TalkModeManager._test_latestAssistantText(
            messages: messages,
            runId: "missing-run") == nil)
    }

    @Test func `native Talk chat request inherits thinking policy`() {
        let request = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: "agent:main:main",
            agentID: nil,
            expectedSessionRoutingContract: nil,
            message: "hello",
            thinking: TalkModeManager.chatThinkingOverride,
            idempotencyKey: "talk-1",
            attachments: [],
            runTimeoutMs: 30000)

        #expect(TalkModeManager.chatThinkingOverride == nil)
        #expect(request.method == "chat.send")
        #expect(request.params["message"]?.value as? String == "hello")
        #expect(request.params["sessionKey"]?.value as? String == "agent:main:main")
        #expect(request.params["idempotencyKey"]?.value as? String == "talk-1")
        #expect(request.params["thinking"] == nil)
        #expect(request.params["timeoutMs"]?.value as? Int == 30000)
    }

    @Test func `subscribes before sending chat completion request`() throws {
        let testsURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsURL
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Voice/TalkModeManager.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let processingStart = try #require(source.range(of: "private func runTranscriptProcessing("))
        let completionStart = try #require(
            source.range(
                of: "private func completeTranscriptResponse(",
                range: processingStart.upperBound..<source.endIndex))
        let waiterStart = try #require(
            source.range(
                of: "private func waitForChatCompletion(",
                range: completionStart.upperBound..<source.endIndex))
        let streamingStart = try #require(
            source.range(
                of: "private func streamAssistant(",
                range: waiterStart.upperBound..<source.endIndex))
        let streamingEnd = try #require(
            source.range(
                of: "private func updateIncrementalContextIfNeeded(",
                range: streamingStart.upperBound..<source.endIndex))
        let processing = source[processingStart.lowerBound..<completionStart.lowerBound]
        let completion = source[completionStart.lowerBound..<waiterStart.lowerBound]
        let streaming = source[streamingStart.lowerBound..<streamingEnd.lowerBound]
        let subscription = try #require(
            processing.range(of: "let completionSubscription = await gateway.makeServerEventSubscription"))
        let cleanup = try #require(processing.range(of: "defer { completionSubscription.cancel() }"))
        let retention = try #require(processing.range(of: "streamingOwner.completionEvents = completionEvents"))
        let send = try #require(processing.range(of: "let acknowledgement = try await sendChat("))

        #expect(subscription.lowerBound < cleanup.lowerBound)
        #expect(cleanup.lowerBound < retention.lowerBound)
        #expect(retention.lowerBound < send.lowerBound)
        #expect(processing.contains("idempotencyKey: runId"))
        #expect(completion.contains("guard let completionEvents = streamingOwner.completionEvents"))
        #expect(completion.contains("stream: completionEvents"))
        #expect(streaming.contains("as: OpenClawChatEventPayload.self"))
        #expect(streaming.contains("OpenClawChatEventText.assistantText"))
        #expect(streaming.contains(#"chatEvent.state == "delta" || chatEvent.state == "final""#))
        #expect(!streaming.contains("OpenClawAgentEventPayload"))
    }

    @Test func `late incremental final cannot reopen canceled speech ownership`() async {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let speechGeneration = manager._test_beginIncrementalSpeechOwnership()

        manager._test_stopSpeaking(storeInterruption: false)
        let completed = await manager._test_handleIncrementalAssistantFinal(
            text: "late assistant reply.",
            speechGeneration: speechGeneration)

        #expect(!completed)
        #expect(!manager._test_hasIncrementalSpeechOwnership())
    }
}
