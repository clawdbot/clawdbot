import { vi } from "vitest";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "../channel-mention-gating.js";
import {
  createAckReactionHandle,
  removeAckReactionAfterReply,
  removeAckReactionHandleAfterReply,
  shouldAckReaction,
} from "../testing.js";
import type { PluginRuntime } from "../testing.js";

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-5.5";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends ReadonlyArray<unknown>
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep<T>(base: T, overrides: DeepPartial<T>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, overrideValue] of Object.entries(overrides as Record<string, unknown>)) {
    if (overrideValue === undefined) {
      continue;
    }
    const baseValue = result[key];
    if (isObject(baseValue) && isObject(overrideValue)) {
      result[key] = mergeDeep(baseValue, overrideValue);
      continue;
    }
    result[key] = overrideValue;
  }
  return result as T;
}

function createTaskFlowSessionMock() {
  return {
    sessionKey: "agent:main:main",
    createManaged: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
    findLatest: vi.fn(),
    resolve: vi.fn(),
    getTaskSummary: vi.fn(),
    setWaiting: vi.fn(),
    resume: vi.fn(),
    finish: vi.fn(),
    fail: vi.fn(),
    requestCancel: vi.fn(),
    cancel: vi.fn(),
    runTask: vi.fn(),
  };
}

function createDeprecatedRuntimeConfigError(name: "loadConfig" | "writeConfigFile"): Error {
  return new Error(
    `Plugin runtime config.${name}() is deprecated in tests; pass cfg/current() or use mutateConfigFile()/replaceConfigFile().`,
  );
}

export function createPluginRuntimeMock(overrides: DeepPartial<PluginRuntime> = {}): PluginRuntime {
  const taskFlow = {
    bindSession: vi.fn(
      createTaskFlowSessionMock,
    ) as unknown as PluginRuntime["tasks"]["managedFlows"]["bindSession"],
    fromToolContext: vi.fn(
      createTaskFlowSessionMock,
    ) as unknown as PluginRuntime["tasks"]["managedFlows"]["fromToolContext"],
  };
  const base: PluginRuntime = {
    version: "1.0.0-test",
    config: {
      current: vi.fn(() => ({})) as unknown as PluginRuntime["config"]["current"],
      mutateConfigFile: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        previousHash: null,
        snapshot: {} as never,
        nextConfig: {},
        afterWrite: { mode: "auto" },
        followUp: { mode: "auto", requiresRestart: false },
        result: undefined,
      })) as unknown as PluginRuntime["config"]["mutateConfigFile"],
      replaceConfigFile: vi.fn(async ({ nextConfig }) => ({
        path: "/tmp/openclaw.json",
        previousHash: null,
        snapshot: {} as never,
        nextConfig,
        afterWrite: { mode: "auto" },
        followUp: { mode: "auto", requiresRestart: false },
      })) as unknown as PluginRuntime["config"]["replaceConfigFile"],
      loadConfig: vi.fn(() => {
        throw createDeprecatedRuntimeConfigError("loadConfig");
      }) as unknown as PluginRuntime["config"]["loadConfig"],
      writeConfigFile: vi.fn(async () => {
        throw createDeprecatedRuntimeConfigError("writeConfigFile");
      }) as unknown as PluginRuntime["config"]["writeConfigFile"],
    },
    agent: {
      defaults: {
        model: DEFAULT_MODEL,
        provider: DEFAULT_PROVIDER,
      },
      resolveAgentDir: vi.fn(
        () => "/tmp/agent",
      ) as unknown as PluginRuntime["agent"]["resolveAgentDir"],
      resolveAgentWorkspaceDir: vi.fn(
        () => "/tmp/workspace",
      ) as unknown as PluginRuntime["agent"]["resolveAgentWorkspaceDir"],
      resolveAgentIdentity: vi.fn(() => ({
        name: "test-agent",
      })) as unknown as PluginRuntime["agent"]["resolveAgentIdentity"],
      resolveThinkingDefault: vi.fn(
        () => "off",
      ) as unknown as PluginRuntime["agent"]["resolveThinkingDefault"],
      normalizeThinkingLevel: vi.fn(
        (raw?: string | null) => raw,
      ) as unknown as PluginRuntime["agent"]["normalizeThinkingLevel"],
      resolveThinkingPolicy: vi.fn(() => ({
        levels: [
          { id: "off", label: "off" },
          { id: "minimal", label: "minimal" },
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
        ],
      })) as unknown as PluginRuntime["agent"]["resolveThinkingPolicy"],
      runEmbeddedPiAgent: vi.fn().mockResolvedValue({
        payloads: [],
        meta: {},
      }) as unknown as PluginRuntime["agent"]["runEmbeddedPiAgent"],
      runEmbeddedAgent: vi.fn().mockResolvedValue({
        payloads: [],
        meta: {},
      }) as unknown as PluginRuntime["agent"]["runEmbeddedAgent"],
      resolveAgentTimeoutMs: vi.fn(
        () => 30_000,
      ) as unknown as PluginRuntime["agent"]["resolveAgentTimeoutMs"],
      ensureAgentWorkspace: vi
        .fn()
        .mockResolvedValue(undefined) as unknown as PluginRuntime["agent"]["ensureAgentWorkspace"],
      session: {
        resolveStorePath: vi.fn(
          () => "/tmp/agent-sessions.json",
        ) as unknown as PluginRuntime["agent"]["session"]["resolveStorePath"],
        loadSessionStore: vi.fn(
          () => ({}),
        ) as unknown as PluginRuntime["agent"]["session"]["loadSessionStore"],
        saveSessionStore: vi
          .fn()
          .mockResolvedValue(
            undefined,
          ) as unknown as PluginRuntime["agent"]["session"]["saveSessionStore"],
        resolveSessionFilePath: vi.fn(
          (sessionId: string) => `/tmp/${sessionId}.json`,
        ) as unknown as PluginRuntime["agent"]["session"]["resolveSessionFilePath"],
      },
    },
    system: {
      enqueueSystemEvent: vi.fn() as unknown as PluginRuntime["system"]["enqueueSystemEvent"],
      requestHeartbeatNow: vi.fn() as unknown as PluginRuntime["system"]["requestHeartbeatNow"],
      runHeartbeatOnce: vi.fn(async () => ({
        status: "ran" as const,
        durationMs: 0,
      })) as unknown as PluginRuntime["system"]["runHeartbeatOnce"],
      runCommandWithTimeout: vi.fn() as unknown as PluginRuntime["system"]["runCommandWithTimeout"],
      formatNativeDependencyHint: vi.fn(
        () => "",
      ) as unknown as PluginRuntime["system"]["formatNativeDependencyHint"],
    },
    media: {
      loadWebMedia: vi.fn() as unknown as PluginRuntime["media"]["loadWebMedia"],
      detectMime: vi.fn() as unknown as PluginRuntime["media"]["detectMime"],
      mediaKindFromMime: vi.fn() as unknown as PluginRuntime["media"]["mediaKindFromMime"],
      isVoiceCompatibleAudio:
        vi.fn() as unknown as PluginRuntime["media"]["isVoiceCompatibleAudio"],
      getImageMetadata: vi.fn() as unknown as PluginRuntime["media"]["getImageMetadata"],
      resizeToJpeg: vi.fn() as unknown as PluginRuntime["media"]["resizeToJpeg"],
    },
    tts: {
      textToSpeech: vi.fn() as unknown as PluginRuntime["tts"]["textToSpeech"],
      textToSpeechTelephony: vi.fn() as unknown as PluginRuntime["tts"]["textToSpeechTelephony"],
      listVoices: vi.fn() as unknown as PluginRuntime["tts"]["listVoices"],
    },
    mediaUnderstanding: {
      runFile: vi.fn() as unknown as PluginRuntime["mediaUnderstanding"]["runFile"],
      describeImageFile:
        vi.fn() as unknown as PluginRuntime["mediaUnderstanding"]["describeImageFile"],
      describeImageFileWithModel:
        vi.fn() as unknown as PluginRuntime["mediaUnderstanding"]["describeImageFileWithModel"],
      describeVideoFile:
        vi.fn() as unknown as PluginRuntime["mediaUnderstanding"]["describeVideoFile"],
      transcribeAudioFile:
        vi.fn() as unknown as PluginRuntime["mediaUnderstanding"]["transcribeAudioFile"],
    },
    imageGeneration: {
      generate: vi.fn() as unknown as PluginRuntime["imageGeneration"]["generate"],
      listProviders: vi.fn() as unknown as PluginRuntime["imageGeneration"]["listProviders"],
    },
    musicGeneration: {
      generate: vi.fn() as unknown as PluginRuntime["musicGeneration"]["generate"],
      listProviders: vi.fn() as unknown as PluginRuntime["musicGeneration"]["listProviders"],
    },
    videoGeneration: {
      generate: vi.fn() as unknown as PluginRuntime["videoGeneration"]["generate"],
      listProviders: vi.fn() as unknown as PluginRuntime["videoGeneration"]["listProviders"],
    },
    webSearch: {
      listProviders: vi.fn() as unknown as PluginRuntime["webSearch"]["listProviders"],
      search: vi.fn() as unknown as PluginRuntime["webSearch"]["search"],
    },
    stt: {
      transcribeAudioFile: vi.fn() as unknown as PluginRuntime["stt"]["transcribeAudioFile"],
    },
    channel: {
      text: {
        chunkByNewline: vi.fn((text: string) => (text ? [text] : [])),
        chunkMarkdownText: vi.fn((text: string) => [text]),
        chunkMarkdownTextWithMode: vi.fn((text: string) => (text ? [text] : [])),
        chunkText: vi.fn((text: string) => (text ? [text] : [])),
        chunkTextWithMode: vi.fn((text: string) => (text ? [text] : [])),
        resolveChunkMode: vi.fn(
          () => "length",
        ) as unknown as PluginRuntime["channel"]["text"]["resolveChunkMode"],
        resolveTextChunkLimit: vi.fn(() => 4000),
        hasControlCommand: vi.fn(() => false),
        resolveMarkdownTableMode: vi.fn(
          () => "code",
        ) as unknown as PluginRuntime["channel"]["text"]["resolveMarkdownTableMode"],
        convertMarkdownTables: vi.fn((text: string) => text),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(
          async () => undefined,
        ) as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
        createReplyDispatcherWithTyping:
          vi.fn() as unknown as PluginRuntime["channel"]["reply"]["createReplyDispatcherWithTyping"],
        resolveEffectiveMessagesConfig:
          vi.fn() as unknown as PluginRuntime["channel"]["reply"]["resolveEffectiveMessagesConfig"],
        resolveHumanDelayConfig:
          vi.fn() as unknown as PluginRuntime["channel"]["reply"]["resolveHumanDelayConfig"],
        dispatchReplyFromConfig:
          vi.fn() as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"],
        withReplyDispatcher: vi.fn(async ({ dispatcher, run, onSettled }) => {
          try {
            return await run();
          } finally {
            dispatcher.markComplete();
            try {
              await dispatcher.waitForIdle();
            } finally {
              await onSettled?.();
            }
          }
        }) as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
        finalizeInboundContext: vi.fn(
          (ctx: Record<string, unknown>) => ctx,
        ) as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        formatAgentEnvelope: vi.fn(
          (opts: { body: string }) => opts.body,
        ) as unknown as PluginRuntime["channel"]["reply"]["formatAgentEnvelope"],
        formatInboundEnvelope: vi.fn(
          (opts: { body: string }) => opts.body,
        ) as unknown as PluginRuntime["channel"]["reply"]["formatInboundEnvelope"],
        resolveEnvelopeFormatOptions: vi.fn(() => ({
          template: "channel+name+time",
        })) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
      },
      routing: {
        buildAgentSessionKey: vi.fn(
          ({
            agentId,
            channel,
            peer,
          }: {
            agentId: string;
            channel: string;
            peer?: { kind?: string; id?: string };
          }) => `agent:${agentId}:${channel}:${peer?.kind ?? "direct"}:${peer?.id ?? "peer"}`,
        ) as unknown as PluginRuntime["channel"]["routing"]["buildAgentSessionKey"],
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          accountId: "default",
          sessionKey: "agent:main:test:dm:peer",
        })) as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
      },
      pairing: {
        buildPairingReply: vi.fn(
          () => "Pairing code: TESTCODE",
        ) as unknown as PluginRuntime["channel"]["pairing"]["buildPairingReply"],
        readAllowFromStore: vi
          .fn()
          .mockResolvedValue(
            [],
          ) as unknown as PluginRuntime["channel"]["pairing"]["readAllowFromStore"],
        upsertPairingRequest: vi.fn().mockResolvedValue({
          code: "TESTCODE",
          created: true,
        }) as unknown as PluginRuntime["channel"]["pairing"]["upsertPairingRequest"],
      },
      media: {
        fetchRemoteMedia:
          vi.fn() as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/test-media.jpg",
          contentType: "image/jpeg",
        }) as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
      },
      session: {
        resolveStorePath: vi.fn(
          () => "/tmp/sessions.json",
        ) as unknown as PluginRuntime["channel"]["session"]["resolveStorePath"],
        readSessionUpdatedAt: vi.fn(
          () => undefined,
        ) as unknown as PluginRuntime["channel"]["session"]["readSessionUpdatedAt"],
        recordSessionMetaFromInbound:
          vi.fn() as unknown as PluginRuntime["channel"]["session"]["recordSessionMetaFromInbound"],
        recordInboundSession:
          vi.fn() as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
        updateLastRoute:
          vi.fn() as unknown as PluginRuntime["channel"]["session"]["updateLastRoute"],
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => [
          /\bbert\b/i,
        ]) as unknown as PluginRuntime["channel"]["mentions"]["buildMentionRegexes"],
        matchesMentionPatterns: vi.fn((text: string, regexes: RegExp[]) =>
          regexes.some((regex) => regex.test(text)),
        ) as unknown as PluginRuntime["channel"]["mentions"]["matchesMentionPatterns"],
        matchesMentionWithExplicit: vi.fn(
          (params: { text: string; mentionRegexes: RegExp[]; explicitWasMentioned?: boolean }) =>
            params.explicitWasMentioned === true
              ? true
              : params.mentionRegexes.some((regex) => regex.test(params.text)),
        ) as unknown as PluginRuntime["channel"]["mentions"]["matchesMentionWithExplicit"],
        implicitMentionKindWhen,
        resolveInboundMentionDecision,
      },
      reactions: {
        createAckReactionHandle,
        shouldAckReaction,
        removeAckReactionAfterReply,
        removeAckReactionHandleAfterReply,
      },
      groups: {
        resolveGroupPolicy: vi.fn(
          () => "open",
        ) as unknown as PluginRuntime["channel"]["groups"]["resolveGroupPolicy"],
        resolveRequireMention: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["groups"]["resolveRequireMention"],
      },
      debounce: {
        createInboundDebouncer: vi.fn(
          (params: { onFlush: (items: unknown[]) => Promise<void> }) => ({
            enqueue: async (item: unknown) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          }),
        ) as unknown as PluginRuntime["channel"]["debounce"]["createInboundDebouncer"],
        resolveInboundDebounceMs: vi.fn((params: unknown) => {
          // Match the production contract so channel plugins that delegate to
          // `core.channel.debounce.resolveInboundDebounceMs({ cfg, channel })`
          // see the same per-channel/global/default precedence in tests as
          // they would at runtime. Prior to this, the mock returned 0
          // unconditionally, which meant any channel that delegated (vs.
          // reading config directly) effectively disabled its debounce
          // window in tests — a footgun that silently hid coverage for
          // per-channel overrides.
          const p = params as
            | {
                cfg?: {
                  messages?: {
                    inbound?: {
                      debounceMs?: unknown;
                      byChannel?: Record<string, unknown>;
                    };
                  };
                };
                channel?: string;
                overrideMs?: unknown;
              }
            | undefined;
          const override = typeof p?.overrideMs === "number" ? p.overrideMs : undefined;
          if (typeof override === "number") {
            return override;
          }
          const inbound = p?.cfg?.messages?.inbound;
          const perChannel =
            p?.channel && inbound?.byChannel ? inbound.byChannel[p.channel] : undefined;
          if (typeof perChannel === "number") {
            return perChannel;
          }
          if (typeof inbound?.debounceMs === "number") {
            return inbound.debounceMs;
          }
          return 0;
        }) as unknown as PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"],
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"],
        isControlCommandMessage:
          vi.fn() as unknown as PluginRuntime["channel"]["commands"]["isControlCommandMessage"],
        shouldComputeCommandAuthorized:
          vi.fn() as unknown as PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"],
        shouldHandleTextCommands:
          vi.fn() as unknown as PluginRuntime["channel"]["commands"]["shouldHandleTextCommands"],
      },
      outbound: {
        loadAdapter: vi.fn() as unknown as PluginRuntime["channel"]["outbound"]["loadAdapter"],
      },
      threadBindings: {
        setIdleTimeoutBySessionKey:
          vi.fn() as unknown as PluginRuntime["channel"]["threadBindings"]["setIdleTimeoutBySessionKey"],
        setMaxAgeBySessionKey:
          vi.fn() as unknown as PluginRuntime["channel"]["threadBindings"]["setMaxAgeBySessionKey"],
      },
      runtimeContexts: {
        register: vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
          const lease = { dispose: vi.fn() };
          abortSignal?.addEventListener("abort", lease.dispose, { once: true });
          return lease;
        }) as unknown as PluginRuntime["channel"]["runtimeContexts"]["register"],
        get: vi.fn() as unknown as PluginRuntime["channel"]["runtimeContexts"]["get"],
        watch: vi.fn(() =>
          vi.fn(),
        ) as unknown as PluginRuntime["channel"]["runtimeContexts"]["watch"],
      },
      activity: {} as PluginRuntime["channel"]["activity"],
    },
    events: {
      onAgentEvent: vi.fn(() => () => {}) as unknown as PluginRuntime["events"]["onAgentEvent"],
      onSessionTranscriptUpdate: vi.fn(
        () => () => {},
      ) as unknown as PluginRuntime["events"]["onSessionTranscriptUpdate"],
    },
    logging: {
      shouldLogVerbose: vi.fn(() => false),
      getChildLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
    state: {
      resolveStateDir: vi.fn(() => "/tmp/openclaw"),
    },
    tasks: {
      runs: {
        bindSession: vi.fn(),
        fromToolContext: vi.fn(),
      } as PluginRuntime["tasks"]["runs"],
      flows: {
        bindSession: vi.fn(),
        fromToolContext: vi.fn(),
      } as PluginRuntime["tasks"]["flows"],
      managedFlows: taskFlow,
      flow: taskFlow,
    },
    taskFlow,
    modelAuth: {
      getApiKeyForModel: vi.fn() as unknown as PluginRuntime["modelAuth"]["getApiKeyForModel"],
      getRuntimeAuthForModel:
        vi.fn() as unknown as PluginRuntime["modelAuth"]["getRuntimeAuthForModel"],
      resolveApiKeyForProvider:
        vi.fn() as unknown as PluginRuntime["modelAuth"]["resolveApiKeyForProvider"],
    },
    subagent: {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    },
    nodes: {
      list: vi.fn(async () => ({ nodes: [] })),
      invoke: vi.fn(),
    },
  };

  return mergeDeep(base, overrides);
}
