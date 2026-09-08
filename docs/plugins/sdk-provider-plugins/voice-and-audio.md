---
summary: "Speech, realtime transcription, realtime voice, and media understanding provider capabilities"
read_when:
  - You are adding text-to-speech to a provider plugin
  - You are implementing realtime transcription or realtime voice
  - You need the realtime voice mark, tool-result, and delegation contract
  - You are registering a media understanding provider
title: "Provider voice capabilities"
sidebarTitle: "Voice and audio"
---

Audio-side capabilities a provider plugin can register alongside text
inference. Part of the [Building provider
plugins](/plugins/sdk-provider-plugins) guide.

## Voice and audio capabilities

Register each capability inside `register(api)` alongside your existing
`api.registerProvider(...)` call. Pick only the tabs you need:

<Tabs>
  <Tab title="Speech (TTS)">
    ```typescript
    import {
      assertOkOrThrowProviderError,
      postJsonRequest,
    } from "openclaw/plugin-sdk/provider-http";

    api.registerSpeechProvider({
      id: "acme-ai",
      label: "Acme Speech",
      defaultTimeoutMs: 120_000,
      isConfigured: ({ config }) => Boolean(config.messages?.tts),
      synthesize: async (req) => {
        const { response, release } = await postJsonRequest({
          url: "https://api.example.com/v1/speech",
          headers: new Headers({ "Content-Type": "application/json" }),
          body: { text: req.text },
          timeoutMs: req.timeoutMs,
          fetchFn: fetch,
          auditContext: "acme speech",
        });
        try {
          await assertOkOrThrowProviderError(response, "Acme Speech API error");
          return {
            audioBuffer: Buffer.from(await response.arrayBuffer()),
            outputFormat: "mp3",
            fileExtension: ".mp3",
            voiceCompatible: false,
          };
        } finally {
          await release();
        }
      },
    });
    ```

    Use `assertOkOrThrowProviderError(...)` for provider HTTP failures so
    plugins share capped error-body reads, JSON error parsing, and
    request-id suffixes. Pass `{ requestHeaders: headers }` as its third
    argument when requests carry credentials: this redacts reflected header
    values before error details and metadata are retained. Pass the same
    option to `readProviderJsonResponse(...)` to omit unsafe parser excerpts.
    For provider-specific failure payloads, use
    `redactProviderResponseErrorText(text, headers)` or the bounded
    `readProviderResponseErrorText(response, limitBytes, headers)` helper
    from the same SDK entrypoint.

  </Tab>
  <Tab title="Realtime transcription">
    Consumers can pass candidate provider IDs as the optional second argument
    to `listRealtimeTranscriptionProviders(cfg, providerIds)`. This discovers
    providers named in plugin-local config without broadening the active
    registry or bypassing plugin enablement and allow/deny policy.

    Prefer `createRealtimeTranscriptionWebSocketSession(...)` - the shared
    helper handles proxy capture, reconnect backoff, close flushing, ready
    handshakes, audio queueing, and close-event diagnostics. Your plugin
    only maps upstream events.

    ```typescript
    api.registerRealtimeTranscriptionProvider({
      id: "acme-ai",
      label: "Acme Realtime Transcription",
      isConfigured: () => true,
      createSession: (req) => {
        const apiKey = String(req.providerConfig.apiKey ?? "");
        return createRealtimeTranscriptionWebSocketSession({
          providerId: "acme-ai",
          callbacks: req,
          url: "wss://api.example.com/v1/realtime-transcription",
          headers: { Authorization: `Bearer ${apiKey}` },
          onMessage: (event, transport) => {
            if (event.type === "session.created") {
              transport.sendJson({ type: "session.update" });
              transport.markReady();
              return;
            }
            if (event.type === "transcript.final") {
              req.onTranscript?.(event.text);
            }
          },
          sendAudio: (audio, transport) => {
            transport.sendJson({
              type: "audio.append",
              audio: audio.toString("base64"),
            });
          },
          onClose: (transport) => {
            transport.sendJson({ type: "audio.end" });
          },
        });
      },
    });
    ```

    Batch STT providers that POST multipart audio should use
    `buildAudioTranscriptionFormData(...)` from
    `openclaw/plugin-sdk/provider-http`. The helper normalizes upload
    filenames, including AAC uploads that need an M4A-style filename for
    compatible transcription APIs.

    Official plugins can use the private `blob-runtime` helper
    `bufferToBlobPart(buffer)` for other multipart uploads. Pass it directly to
    `new Blob(...)` to preserve the Buffer range without an intermediate copy;
    shared backing is copied when needed. Construct the Blob before awaiting
    other work so it snapshots the bytes immediately.

  </Tab>
  <Tab title="Realtime voice">
    Consumers can pass candidate provider IDs as the optional second argument
    to `listRealtimeVoiceProviders(cfg, providerIds)`. Omit the argument for
    ordinary catalog discovery; per-call candidates do not change that catalog.
    Automatic realtime voice and Voice Call transcription selection uses declared alias config as
    defaults, with earlier aliases preferred and canonical values taking precedence.
    An explicitly selected alias still overrides canonical config without inheriting
    settings from other aliases.

    ```typescript
    api.registerRealtimeVoiceProvider({
      id: "acme-ai",
      label: "Acme Realtime Voice",
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
        outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
        supportsBargeIn: true,
        handlesInputAudioBargeIn: true,
        supportsToolCalls: true,
      },
      isConfigured: ({ providerConfig }) => Boolean(providerConfig.apiKey),
      createBridge: (req) => ({
        // Set this only if the provider accepts multiple tool responses for
        // one call, for example an immediate "working" response followed by
        // the final result.
        supportsToolResultContinuation: false,
        connect: async () => {},
        sendAudio: () => {},
        setMediaTimestamp: () => {},
        handleBargeIn: () => {},
        submitToolResult: () => {},
        acknowledgeMark: () => {},
        close: () => {},
        isConnected: () => true,
      }),
    });
    ```

    Declare `capabilities` so `talk.catalog` can expose valid modes,
    transports, audio formats, and feature flags to browser and native Talk
    clients. Implement `handleBargeIn` when a transport can detect that a
    human is interrupting assistant playback and the provider supports
    truncating or clearing the active audio response.
    When native audio events identify an item, pass that identity alongside
    PCM as `req.onAudio(audio, { itemId })`; omit
    metadata for transports without native item IDs. If supplied,
    `req.getPlaybackState()` returns retained items in playback order with
    cumulative, item-relative `audioEndMs`; queued items have zero duration.
    Snapshot these offsets before clearing output and synchronize discarded
    output using the provider's native cancellation and truncation semantics.
    An empty snapshot means no retained audio, even if a new response is
    generating. Hosts without playback measurements omit the callback and
    keep the existing media-timestamp and playback-mark contract.

    After emitting PCM, providers can call `req.onMark?.(name, acknowledge)`
    with an acknowledgment callback bound to that exact provider connection.
    The callback must reject replaced connections and retired marks, while
    remaining valid if a newer response starts before older playback drains.
    Transports invoke scoped callbacks in order after consuming the associated
    PCM, not when receiving or encoding it. Cancellation and failure retire
    provider mark ownership separately; discarded PCM is never reported as played.
    The existing `onMark(name)` and `bridge.acknowledgeMark(name)` contract
    remains available to remote transports and installed providers. Discord
    retains immediate acknowledgments for those legacy unscoped marks.
    `onEvent` observes diagnostic events. OpenAI and xAI report outbound
    frames after submitting them to the local socket; the callback neither
    acknowledges remote receipt nor vetoes the frame. Control requested
    inside an observer runs after that frame.
    `submitToolResult` may return `void` for synchronous submission, or a
    `Promise<void>` for an asynchronous completion boundary the provider
    bridge can expose. Gateway relay sessions wait for that promise before
    confirming a final result or clearing the linked run; reject it when
    submission fails.
    Set `supportsToolResultSuppression: false` when the provider cannot
    honor `options.suppressResponse`. OpenClaw then avoids suppression for
    internal forced-consult and cancellation results, and rejects direct
    suppressed-result requests instead of silently starting a response.
    Consumers of `createRealtimeVoiceBridgeSession` may likewise return a
    promise from `onToolCall`; synchronous throws and rejections are routed
    to the session's `onError` callback.
    The host may pass `sendUserMessage(text, { toolChoice })` while the
    response state is idle to force one named function for that response;
    later responses return to the session's configured tool choice.
    Set `handlesInputAudioBargeIn` only when provider VAD confirms an
    interruption by calling `onClearAudio("barge-in")`. Providers that omit
    the flag use OpenClaw's local input-audio fallback detection.

    A browser-session request's `clientControl: { owner: "gateway" }`
    records explicitly negotiated server-owned control. The request type
    requires `gatewayControl.bindControl` with that claim; requests without
    it retain the legacy callback shape. The presence of
    `gatewayControl` callbacks alone is not that negotiation: native
    delegation can also use them for lifecycle handling while the browser
    retains its data channel and transcript reporting.

    For negotiated control, keep vendor authentication and signaling
    private, bind supported `submitToolResult` and `sendUserMessage`
    commands with `gatewayControl.bindControl(...)`, and forward provider
    readiness, transcripts, and terminal events through the supplied
    callbacks. Bind instance methods to their receiver. A sideband does not
    need to invent media methods or create another audio peer.
    `bindBridge(fullBridge)` remains available for the stable 2026.8.1 SDK
    contract and is removed only with a versioned SDK break. The Gateway
    remains the owner of tool policy and run lifecycle; never infer control
    ownership from a model name or duplicate client-owned transcript writes.

    Bridge requests and negotiated browser `gatewayControl` may provide
    `handleDelegationInput(rawText, respond): "control" | "consult"`.
    Invoke this synchronous, side-effectful admission hook on native delegation
    input before consuming transcript context, replacing pending work, or
    aborting an active consultation. Only `consult` permits task fallthrough.
    A `control` result consumes the request, including refusal or failure; do
    not launch a task or send a task receipt. Status and cancellation are
    controls even while idle; redirects and follow-ups require call-owned work.
    Ordinary idle requests still fall through to consultation.

    The host prepares delegation ownership from the resolved
    `handlesAgentConsult` capability, not `supportsToolCalls: false` or callback
    presence. In this mode, finalized transcripts only update history and
    observability. Tool-capable, unspecified, and tool-less nondelegating
    providers retain their existing transcript behavior. Without the hook,
    retain the existing delegation and acknowledgment policy.

    The host binds steering authority to the actual admitted backend attempt
    after harness policy preparation. Backing agent harnesses forward the
    existing attempt fingerprint when registering their handle. Realtime voice
    providers do not calculate authority or copy a target fingerprint into
    incoming user input. Caller
    policy is projected by the host against the exact live registration, and
    closed or replaced owners refuse injection. Normal reply-owned attempts
    retain their original authority snapshot and concrete model route. A
    maintenance attempt that only borrows a reply operation for lifecycle
    management receives authority from its own prepared execution instead.
    Backend queues revalidate ownership after asynchronous input preparation,
    immediately before inserting a message or answering a pending question.

    Bind `respond(message)` to the incoming control delegation and exact
    call/transport instance. Submit at most once, consuming the response before
    the first send attempt; multiple wire chunks are one response. Do not retry
    it on send failure, target a newer delegation/socket, or deliver after
    close/detach. Cancellation may abort the backing task without invalidating
    its control reply. Keep delegation IDs and wire encoding inside the provider;
    independent host speech and task receipts use session context instead.
    Submission does not establish completion or audible delivery.

    The session facade admits this hook after bridge adoption, including before
    readiness, and fences actions and replies after closure. Callback failures
    are contained without task fallthrough. `onTranscript` retains its `void`
    callback contract, including assignable async handlers and close-time final
    transcript flushing.

    A host `runAgentConsult` rejection named `AbortError` represents
    cancellation, even when the provider's own signal is still live. Do not
    turn it into a failed-task or retry reply. `TimeoutError` remains a
    failure. Closing a transport and canceling accepted host work are
    separate lifecycle operations.

  </Tab>
  <Tab title="Media understanding">
    Audio providers with their own credential and endpoint contracts can
    implement `transcribeAudioWithContext(request)`. The host calls it after
    loading each audio file. The request includes the audio bytes, filename,
    model, prompt, language, timeout, transport settings, configuration,
    agent directory, and selected profile. Resolve credentials for that call;
    do not retain credentials across attachment downloads.

    Return `{ ok: true, value: { text, model } }` after transcription. Return
    `{ ok: false, error }` only for authentication or configuration rejected
    **before uploading audio**. The host records that error and automatic
    selection may try the next provider or local backend. Canonical missing
    provider auth leaves the automatic candidate unavailable without a failed
    attempt. Upload and HTTP failures must throw: automatic selection then
    stops without sending the recording to another provider. Explicit model
    lists retain their authored fallback order.

    Return the model when known; otherwise the host retains the requested
    model in its result. `transcribeAudio` remains available for providers
    using host-owned API-key resolution and rotation.

    ```typescript
    api.registerMediaUnderstandingProvider({
      id: "acme-ai",
      capabilities: ["image", "audio"],
      describeImage: async (req) => ({ text: "A photo of..." }),
      transcribeAudio: async (req) => ({ text: "Transcript..." }),
    });
    ```

    Local or self-hosted media providers that intentionally do not require
    credentials can expose `resolveAuth` and return `kind: "none"`.
    OpenClaw still keeps the normal auth gate for providers that do not
    explicitly opt in. Existing providers can keep reading `req.apiKey`;
    new providers should prefer `req.auth`.

    ```typescript
    api.registerMediaUnderstandingProvider({
      id: "local-audio",
      capabilities: ["audio"],
      resolveAuth: () => ({
        kind: "none",
        source: "local-audio plugin no-auth",
      }),
      transcribeAudio: async (req) => ({ text: "Transcript..." }),
    });
    ```

  </Tab>
</Tabs>
