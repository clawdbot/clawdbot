import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import * as bundledChannelPlugins from "../channels/plugins/bundled.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  createTtsConfig,
  expectTtsPayloadResult,
  installSpeechProviders,
  maybeApplyTtsToPayload,
  maybeApplyTtsToPayloadCore,
  prefsPathFor,
  prepareSynthesisMock,
  requireFirstSynthesisRequest,
  requireRecord,
  setSummarizationEnabled,
  setTtsMachinePrefsPathResolver,
  setTtsMaxLength,
  synthesizeMock,
  synthesizeSpeech,
  testApi,
  transcodeAudioBufferMock,
  type OpenClawConfig,
  type ReplyPayload,
} from "./tts-runtime.test-support.js";

const routedPayloads = vi.hoisted(() => [] as ReplyPayload[]);

vi.mock("../channels/message/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/message/runtime.js")>();
  return {
    ...actual,
    sendDurableMessageBatchCore: async ({ payloads }: { payloads: ReplyPayload[] }) => {
      routedPayloads.push(...payloads);
      return { status: "sent", results: [{ messageId: "tts-route-1" }] };
    },
  };
});

function installStructuredReplyTestChannel(loaded: boolean): () => void {
  const previousRegistry = captureActivePluginRegistrySnapshot();
  const channelPlugin = {
    ...createChannelTestPluginBase({ id: "slack" }),
    messaging: {
      hasStructuredReplyPayload: ({ payload }: { payload: ReplyPayload }) => {
        const blocks = (payload.channelData?.slack as { blocks?: unknown } | undefined)?.blocks;
        return Array.isArray(blocks) && blocks.length > 0;
      },
    },
  };
  const originalGetBundledChannelPlugin = bundledChannelPlugins.getBundledChannelPlugin;
  const bundledPluginOverride = loaded
    ? undefined
    : vi
        .spyOn(bundledChannelPlugins, "getBundledChannelPlugin")
        .mockImplementation((channelId) =>
          channelId === channelPlugin.id
            ? channelPlugin
            : originalGetBundledChannelPlugin(channelId),
        );
  setActivePluginRegistry(
    createTestRegistry(
      loaded
        ? [
            {
              pluginId: "slack",
              source: "tts-runtime-fallback-test",
              plugin: channelPlugin,
            },
          ]
        : [],
    ),
  );
  return () => {
    bundledPluginOverride?.mockRestore();
    restoreActivePluginRegistrySnapshot(previousRegistry);
  };
}

describe("TTS runtime provider fallback and delivery behavior", () => {
  afterEach(() => {
    setTtsMachinePrefsPathResolver();
    clearRuntimeConfigSnapshot();
    delete (Object.prototype as Record<string, unknown>).polluted;
    synthesizeMock.mockClear();
    prepareSynthesisMock.mockClear();
    transcodeAudioBufferMock.mockClear();
    routedPayloads.length = 0;
    installSpeechProviders([createMockSpeechProvider()]);
  });

  it("synthesizes persisted TTS facts after the visible text has been stripped", async () => {
    const payload = setReplyPayloadMetadata(
      { text: "Visible answer" },
      {
        tts: {
          tagged: true,
          text: "Spoken answer",
          directives: [{ provider: "mock", values: {} }],
        },
      },
    );

    const result = await maybeApplyTtsToPayload({
      payload,
      cfg: createTtsConfig("openclaw-speech-core-persisted-facts"),
      channel: "telegram",
      kind: "final",
      ttsAuto: "tagged",
    });

    expect(requireFirstSynthesisRequest("persisted TTS facts")).toMatchObject({
      text: "Spoken answer",
    });
    expect(result).toMatchObject({
      text: "Visible answer",
      spokenText: "Spoken answer",
    });
  });

  it("ignores voiceModel refs that are not speech models", async () => {
    installSpeechProviders([
      createMockSpeechProvider("openai", {
        autoSelectOrder: 10,
        defaultModel: "gpt-4o-mini-tts",
        models: ["gpt-4o-mini-tts"],
        resolveConfig: ({ rawConfig }) => {
          const providers = requireRecord(rawConfig.providers, "raw provider configs");
          return {
            model: "gpt-4o-mini-tts",
            modelId: "gpt-4o-mini-tts",
            ...requireRecord(providers.openai, "raw openai provider config"),
          };
        },
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use speech provider default for unsupported realtime model.",
      cfg: {
        agents: {
          defaults: {
            voiceModel: { primary: "openai/gpt-realtime-2" },
          },
        },
        tts: {
          enabled: true,
          provider: "openai",
          prefsPath: "/tmp/openclaw-speech-core-realtime-voice-model-ignored-test.json",
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.providerModel).toBe("gpt-4o-mini-tts");
    const request = requireFirstSynthesisRequest("speech model fallback request");
    expect(request.providerConfig).toMatchObject({
      model: "gpt-4o-mini-tts",
      modelId: "gpt-4o-mini-tts",
    });
  });

  it("uses the first speech-supported voiceModel fallback as the default provider", async () => {
    installSpeechProviders([
      createMockSpeechProvider("openai", {
        autoSelectOrder: 1,
        models: ["gpt-4o-mini-tts"],
      }),
      createMockSpeechProvider("elevenlabs", {
        autoSelectOrder: 99,
        models: ["eleven_multilingual_v2"],
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use first speech-supported voice model.",
      cfg: {
        agents: {
          defaults: {
            voiceModel: {
              primary: "openai/gpt-realtime-2",
              fallbacks: ["elevenlabs/eleven_multilingual_v2"],
            },
          },
        },
        tts: {
          enabled: true,
          prefsPath: "/tmp/openclaw-speech-core-supported-voice-model-provider-test.json",
        },
      } as OpenClawConfig,
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("elevenlabs");
    expect(result.providerModel).toBe("eleven_multilingual_v2");
    expect(result.attemptedProviders).toEqual(["elevenlabs"]);
  });

  it("maps speakerVoice provider config to provider-compatible voice fields", async () => {
    const result = await synthesizeSpeech({
      text: "Use the configured speaker.",
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          providers: {
            mock: {
              speakerVoice: "cedar",
              speakerVoiceId: "voice-123",
              voice: "legacy-voice",
              voiceName: "legacy-name",
              voiceId: "legacy-id",
            },
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.providerVoice).toBe("voice-123");
    const request = requireFirstSynthesisRequest("speaker voice synthesis request");
    expect(request.providerConfig).toMatchObject({
      speakerVoice: "cedar",
      voice: "cedar",
      voiceName: "cedar",
      speakerVoiceId: "voice-123",
      voiceId: "voice-123",
    });
  });

  it("preserves alias-keyed provider config when resolving canonical providers", async () => {
    installSpeechProviders([
      createMockSpeechProvider("xiaomi", {
        aliases: ["mimo"],
        resolveConfig: ({ rawConfig }) => {
          const providers = requireRecord(rawConfig.providers, "raw provider configs");
          return requireRecord(providers.xiaomi ?? providers.mimo, "raw xiaomi provider config");
        },
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use alias provider config.",
      cfg: {
        tts: {
          enabled: true,
          provider: "xiaomi",
          providers: {
            mimo: { apiKey: "fake" },
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("alias provider synthesis request");
    expect(request.providerConfig).toMatchObject({ apiKey: "fake" });
  });

  it("maps speakerVoice persona provider config to provider-compatible voice fields", async () => {
    const result = await synthesizeSpeech({
      text: "Use the persona speaker.",
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          persona: "narrator",
          personas: {
            narrator: {
              providers: {
                mock: {
                  speakerVoice: "marin",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.providerVoice).toBe("marin");
    const request = requireFirstSynthesisRequest("persona speaker voice synthesis request");
    expect(request.providerConfig).toMatchObject({
      speakerVoice: "marin",
      voice: "marin",
      voiceName: "marin",
    });
  });

  it.each(["feishu", "whatsapp"] as const)(
    "marks %s voice-note TTS for channel-side transcoding when provider returns mp3",
    async (channel) => {
      expect(testApi.supportsTranscodedVoiceNoteTts(channel)).toBe(true);
      await expectTtsPayloadResult({
        channel,
        prefsName: `openclaw-speech-core-tts-${channel}-mp3-test`,
        text: `This ${channel} reply should be transcoded by the channel.`,
        target: "voice-note",
        audioAsVoice: true,
        mediaExtension: "mp3",
        providerResult: {
          audioBuffer: Buffer.from("mp3"),
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: false,
        },
      });
    },
  );

  it("keeps non-native voice-note channels as regular audio files", async () => {
    await expectTtsPayloadResult({
      channel: "slack",
      prefsName: "openclaw-speech-core-tts-slack-test",
      text: "Slack replies should be delivered as regular audio attachments.",
      target: "audio-file",
      audioAsVoice: undefined,
    });
  });

  it("preserves the text reply when auto-TTS audio persistence fails", async () => {
    const payload = { text: "This text must still be delivered when media storage rejects audio." };
    const result = await maybeApplyTtsToPayloadCore(
      {
        payload,
        cfg: createTtsConfig("openclaw-speech-core-auto-persistence-failure-test"),
        channel: "slack",
        kind: "final",
      },
      async () => {
        throw new Error("Media exceeds configured limit");
      },
    );

    expect(result).toBe(payload);
  });

  it.each([
    { failure: "speech provider fails", failProvider: true },
    { failure: "audio persistence fails", failProvider: false },
  ])("delivers audio-only TTS text when the $failure", async ({ failProvider }) => {
    const answer = "Your important answer is ready.";
    if (failProvider) {
      synthesizeMock.mockRejectedValueOnce(new Error("Speech provider unavailable"));
    }

    const result = await maybeApplyTtsToPayloadCore(
      {
        payload: {
          text: `[[tts:text]]  ${answer}  [[/tts:text]]`,
          audioAsVoice: true,
        },
        cfg: createTtsConfig(`openclaw-speech-core-hidden-tts-failure-${failProvider}`),
        channel: "telegram",
        kind: "final",
      },
      async () => {
        throw new Error("Media exceeds configured limit");
      },
    );

    expect(result).toEqual({ text: answer, audioAsVoice: true });
    expect((await import("./runtime-api.js")).getLastTtsAttempt()).toMatchObject({
      success: false,
      attemptedProviders: ["mock"],
    });
  });

  it.each([
    { failure: "speech provider fails", failProvider: true, structured: false, loaded: true },
    { failure: "audio persistence fails", failProvider: false, structured: false, loaded: true },
    {
      failure: "speech provider fails with visible blocks",
      failProvider: true,
      structured: true,
      loaded: true,
    },
    {
      failure: "audio persistence fails with visible blocks",
      failProvider: false,
      structured: true,
      loaded: true,
    },
    {
      failure: "speech provider fails before channel activation",
      failProvider: true,
      structured: false,
      loaded: false,
    },
    {
      failure: "audio persistence fails before channel activation",
      failProvider: false,
      structured: false,
      loaded: false,
    },
    {
      failure: "speech provider fails with visible blocks before channel activation",
      failProvider: true,
      structured: true,
      loaded: false,
    },
    {
      failure: "audio persistence fails with visible blocks before channel activation",
      failProvider: false,
      structured: true,
      loaded: false,
    },
  ])(
    "routes hidden speech through the actual dispatcher and channel router when $failure",
    async ({ failProvider, structured, loaded }) => {
      const restoreRegistry = installStructuredReplyTestChannel(loaded);
      try {
        const answer = "Your important answer is ready.";
        const cfg = createTtsConfig(
          `openclaw-speech-core-hidden-tts-router-${failProvider}-${structured}-${loaded}`,
        );
        const channelData = structured
          ? {
              slack: {
                blocks: [
                  { type: "section", text: { type: "mrkdwn", text: "Visible channel card" } },
                ],
              },
            }
          : { slack: { unfurl: false } };
        if (!loaded) {
          expect(getActivePluginRegistry()?.channels).toEqual([]);
          expect(
            getChannelPlugin("slack")?.messaging?.hasStructuredReplyPayload?.({
              payload: { channelData },
            }),
          ).toBe(structured);
        }
        const routingResults: Array<Awaited<ReturnType<typeof routeReply>>> = [];
        if (failProvider) {
          synthesizeMock.mockRejectedValueOnce(new Error("Speech provider unavailable"));
        }

        const dispatcher = createReplyDispatcher({
          beforeDeliver: (payload, info) =>
            maybeApplyTtsToPayloadCore(
              {
                payload,
                cfg,
                channel: "slack",
                kind: info.kind,
              },
              async () => {
                throw new Error("Media exceeds configured limit");
              },
            ),
          deliver: async (payload, info) => {
            routingResults.push(
              await routeReply({
                payload,
                channel: "slack",
                to: "channel:C123",
                cfg,
                replyKind: info.kind,
              }),
            );
          },
        });

        expect(
          dispatcher.sendFinalReply({
            text: `[[tts:text]]${answer}[[/tts:text]]`,
            channelData,
          }),
        ).toBe(true);
        dispatcher.markComplete();
        await dispatcher.waitForIdle();

        expect(routingResults).toEqual([{ ok: true, delivered: true, messageId: "tts-route-1" }]);
        expect(routedPayloads).toHaveLength(1);
        expect(routedPayloads[0]).toMatchObject({
          text: structured ? undefined : answer,
          channelData,
        });
        expect((await import("./runtime-api.js")).getLastTtsAttempt()).toMatchObject({
          success: false,
          attemptedProviders: ["mock"],
        });
      } finally {
        restoreRegistry();
      }
    },
  );

  it("keeps existing visible text when hidden TTS synthesis fails", async () => {
    synthesizeMock.mockRejectedValueOnce(new Error("Speech provider unavailable"));

    const result = await maybeApplyTtsToPayloadCore(
      {
        payload: {
          text: "Visible answer [[tts:text]]Hidden expressive answer[[/tts:text]]",
        },
        cfg: createTtsConfig("openclaw-speech-core-visible-hidden-tts-provider-failure"),
        channel: "telegram",
        kind: "final",
      },
      async () => "/unused.ogg",
    );

    expect(result).toEqual({ text: "Visible answer" });
  });

  it("keeps hidden TTS text private when the reply already contains an attachment", async () => {
    const result = await maybeApplyTtsToPayloadCore(
      {
        payload: {
          text: "[[tts:text]]This must remain audio-only.[[/tts:text]]",
          mediaUrl: "https://example.invalid/already-attached.png",
        },
        cfg: createTtsConfig("openclaw-speech-core-hidden-tts-existing-attachment"),
        channel: "telegram",
        kind: "final",
      },
      async () => {
        throw new Error("Media storage must not be called");
      },
    );

    expect(result).toEqual({
      text: undefined,
      mediaUrl: "https://example.invalid/already-attached.png",
    });
    expect(synthesizeMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      surface: "a presentation",
      content: { presentation: { blocks: [{ type: "text", text: "Visible presentation" }] } },
    },
    {
      surface: "an interactive reply",
      content: { interactive: { blocks: [{ type: "text", text: "Visible interactive reply" }] } },
    },
    {
      surface: "a location",
      content: { location: { latitude: 48.858844, longitude: 2.294351 } },
    },
    {
      surface: "channel data",
      content: { channelData: { visibleAction: { label: "Approve" } } },
    },
  ] satisfies Array<{ surface: string; content: Partial<ReplyPayload> }>)(
    "keeps hidden TTS text private when $surface is already deliverable",
    async ({ content }) => {
      synthesizeMock.mockRejectedValueOnce(new Error("Speech provider unavailable"));

      const result = await maybeApplyTtsToPayloadCore(
        {
          payload: {
            text: "[[tts:text]]This detail must remain audio-only.[[/tts:text]]",
            ...content,
          },
          cfg: createTtsConfig("openclaw-speech-core-hidden-tts-existing-rich-content"),
          channel: "telegram",
          kind: "final",
        },
        async () => "/unused.ogg",
      );

      expect(result).toEqual({ text: undefined, ...content });
      expect(synthesizeMock).toHaveBeenCalledOnce();
    },
  );

  it("normalizes voice-note Markdown once before synthesis", async () => {
    const text =
      'This short explanation keeps the fenced literal below from becoming code-heavy.\n\n```md\nconst literal = "[x](y)";\n```';
    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: { text },
        cfg: createTtsConfig("openclaw-speech-core-once-normalized-markdown-test"),
        channel: "telegram",
        kind: "final",
      });

      const request = requireFirstSynthesisRequest("once-normalized voice-note synthesis request");
      expect(request.text).toBe(
        'This short explanation keeps the fenced literal below from becoming code-heavy.\n\nconst literal = "[x](y)";',
      );
      expect(result.text).toBe(text);
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("skips channel auto-TTS audio for code-heavy replies", async () => {
    const text = "```ts\nexport function answer() {\n  return 42;\n}\n```";
    const result = await maybeApplyTtsToPayload({
      payload: { text },
      cfg: createTtsConfig("openclaw-speech-core-code-heavy-voice-note-test"),
      channel: "telegram",
      kind: "final",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text });
  });

  it("synthesizes code-heavy explicitly tagged hidden TTS text", async () => {
    const cfg = createTtsConfig("openclaw-speech-core-code-heavy-hidden-tts-test");
    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: {
          text: '[[tts:text]]```ts\nconst detailedAnswer = "this code should still be spoken";\n```[[/tts:text]]',
          audioAsVoice: true,
        },
        cfg,
        channel: "telegram",
        kind: "final",
      });

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("code-heavy hidden TTS request");
      expect(request.text).toBe('const detailedAnswer = "this code should still be spoken";');
      expect(result.text).toBeUndefined();
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("synthesizes explicitly tagged short hidden TTS text", async () => {
    const cfg = createTtsConfig("openclaw-speech-core-short-hidden-tts-test");
    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: {
          text: "[[tts:text]]hello[[/tts:text]]",
          audioAsVoice: true,
        },
        cfg,
        channel: "telegram",
        kind: "final",
      });

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("hidden TTS request");
      expect(request.text).toBe("hello");
      expect(result.mediaUrl).toMatch(/voice---[a-f0-9-]+\.ogg$/);
      expect(result.audioAsVoice).toBe(true);
      expect(result.text).toBeUndefined();
      expect(result.ttsSupplement).toBeUndefined();
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("truncates long TTS text on a UTF-16 boundary", async () => {
    const prefsName = "openclaw-speech-core-utf16-truncate-test";
    const prefsPath = prefsPathFor(prefsName);
    const cfg = createTtsConfig(prefsName);
    setTtsMaxLength(prefsPath, 11);
    setSummarizationEnabled(prefsPath, false);
    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: { text: `${"a".repeat(7)}😀tail long enough for TTS` },
        cfg,
        channel: "telegram",
        kind: "final",
      });

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("utf16 truncated TTS request");
      const spokenText = String(request.text);
      expect(spokenText).toBe(`${"a".repeat(7)}...`);
      expect(result.spokenText).toBe(spokenText);
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      rmSync(prefsPath, { force: true });
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("skips block delivery kind in final mode (accumulated final tail synthesizes instead)", async () => {
    synthesizeMock.mockClear();
    const cfg = createTtsConfig("openclaw-speech-core-block-kind-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: { text: "WebChat block stream chunks defer TTS to the final tail." },
      cfg,
      channel: "webchat",
      kind: "block",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect((result as { trustedLocalMedia?: boolean }).trustedLocalMedia).toBeUndefined();
    expect(result.text).toBe("WebChat block stream chunks defer TTS to the final tail.");
  });

  it("skips tool delivery kind in final mode", async () => {
    synthesizeMock.mockClear();
    const cfg = createTtsConfig("openclaw-speech-core-tool-kind-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: { text: "Intermediate tool output should not be spoken." },
      cfg,
      channel: "webchat",
      kind: "tool",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect((result as { trustedLocalMedia?: boolean }).trustedLocalMedia).toBeUndefined();
    expect(result.text).toBe("Intermediate tool output should not be spoken.");
  });

  it("keeps skipping untagged short TTS text", async () => {
    const cfg = createTtsConfig("openclaw-speech-core-short-plain-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: {
        text: "hello",
        audioAsVoice: true,
      },
      cfg,
      channel: "telegram",
      kind: "final",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: "hello",
      audioAsVoice: true,
    });
  });

  it("skips auto TTS for legacy final media directives", async () => {
    synthesizeMock.mockClear();
    const cfg = createTtsConfig("openclaw-speech-core-media-directive-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: { text: "Here is the render.\nMEDIA:/tmp/render.png" },
      cfg,
      channel: "telegram",
      kind: "final",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "Here is the render.\nMEDIA:/tmp/render.png" });
  });

  it("keeps skipping explicit tagged TTS text that strips to empty markdown", async () => {
    const cfg = createTtsConfig("openclaw-speech-core-empty-hidden-tts-test");
    const result = await maybeApplyTtsToPayload({
      payload: {
        text: "[[tts:text]]***[[/tts:text]]",
        audioAsVoice: true,
      },
      cfg,
      channel: "telegram",
      kind: "final",
    });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      audioAsVoice: true,
    });
  });
});

describe("cold speech runtime visible fallback", () => {
  it.each([
    { loaded: true, structured: false },
    { loaded: true, structured: true },
    { loaded: false, structured: false },
    { loaded: false, structured: true },
  ])(
    "delivers voice-only speech when its runtime is unavailable (loaded: $loaded, structured: $structured)",
    async ({ loaded, structured }) => {
      const { setSpeechRuntimeAvailabilityGuard } = await import("./runtime-availability.js");
      const restoreRegistry = installStructuredReplyTestChannel(loaded);
      setSpeechRuntimeAvailabilityGuard(() => {
        throw new Error("speech runtime configured cold");
      });
      routedPayloads.length = 0;
      synthesizeMock.mockClear();
      try {
        const answer = "Spoken greeting";
        const channelData = structured
          ? {
              slack: {
                blocks: [
                  { type: "section", text: { type: "mrkdwn", text: "Visible channel card" } },
                ],
              },
            }
          : { slack: { unfurl: false } };
        const cfg = createTtsConfig(`openclaw-speech-cold-runtime-${loaded}-${structured}`);
        const routingResults: Array<Awaited<ReturnType<typeof routeReply>>> = [];
        const dispatcher = createReplyDispatcher({
          beforeDeliver: (payload, info) =>
            maybeApplyTtsToPayloadCore(
              { payload, cfg, channel: "slack", kind: info.kind },
              async () => "unused",
            ),
          deliver: async (payload, info) => {
            routingResults.push(
              await routeReply({
                payload,
                channel: "slack",
                to: "channel:C123",
                cfg,
                replyKind: info.kind,
              }),
            );
          },
        });

        expect(
          dispatcher.sendFinalReply(
            setReplyPayloadMetadata(
              { text: "", channelData },
              { ttsExplicit: true, tts: { tagged: true, text: answer } },
            ),
          ),
        ).toBe(true);
        dispatcher.markComplete();
        await dispatcher.waitForIdle();

        expect(routingResults).toEqual([{ ok: true, delivered: true, messageId: "tts-route-1" }]);
        expect(routedPayloads).toHaveLength(1);
        expect(routedPayloads[0]).toMatchObject({
          text: structured ? "" : answer,
          channelData,
        });
        expect(synthesizeMock).not.toHaveBeenCalled();
      } finally {
        setSpeechRuntimeAvailabilityGuard(undefined);
        restoreRegistry();
        routedPayloads.length = 0;
      }
    },
  );

  it("keeps payloads with visible text unchanged when the runtime is unavailable", async () => {
    const { setSpeechRuntimeAvailabilityGuard } = await import("./runtime-availability.js");
    setSpeechRuntimeAvailabilityGuard(() => {
      throw new Error("speech runtime configured cold");
    });
    try {
      const payload: ReplyPayload = { text: "Visible answer" };
      setReplyPayloadMetadata(payload, {
        ttsExplicit: true,
        tts: { tagged: true, text: "Spoken greeting" },
      });
      const result = await maybeApplyTtsToPayloadCore(
        {
          payload,
          cfg: createTtsConfig("openclaw-speech-cold-runtime-unchanged-test"),
          channel: "slack",
          kind: "final",
        },
        async () => "unused",
      );
      expect(result).toBe(payload);
    } finally {
      setSpeechRuntimeAvailabilityGuard(undefined);
    }
  });
});
