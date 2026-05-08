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
  const dispatchAssembledChannelTurnMock = vi.fn(async (params: Record<string, unknown>) => {
    const ctxPayload = params.ctxPayload as Record<string, unknown>;
    const record = params.record as
      | Parameters<PluginRuntime["channel"]["turn"]["runPrepared"]>[0]["record"]
      | undefined;
    const recordInboundSession = params.recordInboundSession as Parameters<
      PluginRuntime["channel"]["turn"]["runPrepared"]
    >[0]["recordInboundSession"];
    const routeSessionKey = params.routeSessionKey as string;
    const storePath = params.storePath as string;
    const delivery = params.delivery as {
      deliver: (payload: unknown, info: unknown) => Promise<unknown>;
      onError?: (err: unknown, info: { kind: string }) => void;
    };
    const ctxSessionKey = ctxPayload.SessionKey;
    const sessionKey = typeof ctxSessionKey === "string" ? ctxSessionKey : routeSessionKey;
    const dispatchReplyWithBufferedBlockDispatcher =
      params.dispatchReplyWithBufferedBlockDispatcher as (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: unknown, info: unknown) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
        replyOptions?: unknown;
        replyResolver?: unknown;
      }) => Promise<unknown>;
    await recordInboundSession({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      groupResolution: record?.groupResolution,
      createIfMissing: record?.createIfMissing,
      updateLastRoute: record?.updateLastRoute,
      onRecordError: record?.onRecordError ?? (() => undefined),
      trackSessionMetaTask: record?.trackSessionMetaTask,
    });
    const dispatchResult = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: params.cfg,
      dispatcherOptions: {
        ...(params.dispatcherOptions as Record<string, unknown> | undefined),
        deliver: async (payload, info) => {
          await delivery.deliver(payload, info);
        },
        onError: delivery.onError,
      },
      replyOptions: params.replyOptions,
      replyResolver: params.replyResolver,
    });
    return {
      admission: params.admission ?? { kind: "dispatch" },
      dispatched: true,
      ctxPayload,
      routeSessionKey,
      dispatchResult,
    };
  });
  const runPreparedChannelTurnMock = vi.fn(
    async (params: Parameters<PluginRuntime["channel"]["turn"]["runPrepared"]>[0]) => {
      try {
        await params.recordInboundSession({
          storePath: params.storePath,
          sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
          ctx: params.ctxPayload,
          groupResolution: params.record?.groupResolution,
          createIfMissing: params.record?.createIfMissing,
          updateLastRoute: params.record?.updateLastRoute,
          onRecordError: params.record?.onRecordError ?? (() => undefined),
          trackSessionMetaTask: params.record?.trackSessionMetaTask,
        });
      } catch (err) {
        try {
          await params.onPreDispatchFailure?.(err);
        } catch {
          // Preserve the original session-recording error.
        }
        throw err;
      }
      const admission = params.admission ?? { kind: "dispatch" as const };
      const dispatchResult =
        admission.kind === "observeOnly"
          ? (params.observeOnlyDispatchResult ?? {
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 0 },
            })
          : await params.runDispatch();
      return {
        admission,
        dispatched: true,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.routeSessionKey,
        dispatchResult,
      };
    },
  ) as unknown as PluginRuntime["channel"]["turn"]["runPrepared"];
  const runChannelTurnMock = vi.fn(
    async (params: Parameters<PluginRuntime["channel"]["turn"]["run"]>[0]) => {
      const input = await params.adapter.ingest(params.raw);
      if (!input) {
        return {
          admission: { kind: "drop" as const, reason: "ingest-null" },
          dispatched: false,
        };
      }
      const eventClass = (await params.adapter.classify?.(input)) ?? {
        kind: "message" as const,
        canStartAgentTurn: true,
      };
      if (!eventClass.canStartAgentTurn) {
        return {
          admission: { kind: "handled" as const, reason: `event:${eventClass.kind}` },
          dispatched: false,
        };
      }
      const preflightValue = await params.adapter.preflight?.(input, eventClass);
      const preflight =
        preflightValue && "kind" in preflightValue
          ? { admission: preflightValue }
          : (preflightValue ?? {});
      if (
        preflight.admission &&
        preflight.admission.kind !== "dispatch" &&
        preflight.admission.kind !== "observeOnly"
      ) {
        return {
          admission: preflight.admission,
          dispatched: false,
        };
      }
      const resolved = await params.adapter.resolveTurn(input, eventClass, preflight ?? {});
      const admission =
        resolved.admission ?? preflight.admission ?? ({ kind: "dispatch" } as const);
      const dispatchResult =
        "runDispatch" in resolved
          ? await runPreparedChannelTurnMock({
              ...resolved,
              admission,
            })
          : await dispatchAssembledChannelTurnMock({
              ...resolved,
              admission,
              delivery:
                admission.kind === "observeOnly"
                  ? { deliver: async () => ({ visibleReplySent: false }) }
                  : resolved.delivery,
            });
      const result = {
        ...dispatchResult,
        admission,
      } as Parameters<NonNullable<typeof params.adapter.onFinalize>>[0];
      await params.adapter.onFinalize?.(result);
      return result;
    },
  ) as unknown as PluginRuntime["channel"]["turn"]["run"];
  const buildChannelTurnContextMock = vi.fn(
    (params: Parameters<PluginRuntime["channel"]["turn"]["buildContext"]>[0]) =>
      ({
        Body: params.message.body ?? params.message.rawBody,
        BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
        RawBody: params.message.rawBody,
        CommandBody: params.message.commandBody ?? params.message.rawBody,
        BodyForCommands: params.message.commandBody ?? params.message.rawBody,
        From: params.from,
        To: params.reply.to,
        SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
        AccountId: params.route.accountId ?? params.accountId,
        MessageSid: params.messageId,
        MessageSidFull: params.messageIdFull,
        ReplyToId: params.reply.replyToId ?? params.supplemental?.quote?.id,
        ReplyToIdFull: params.reply.replyToIdFull ?? params.supplemental?.quote?.fullId,
        MediaPath: params.media?.[0]?.path,
        MediaUrl: params.media?.[0]?.url ?? params.media?.[0]?.path,
        MediaType: params.media?.[0]?.contentType ?? params.media?.[0]?.kind,
        ChatType: params.conversation.kind,
        ConversationLabel: params.conversation.label,
        SenderName: params.sender.name ?? params.sender.displayLabel,
        SenderId: params.sender.id,
        SenderUsername: params.sender.username,
        Timestamp: params.timestamp,
        WasMentioned: params.access?.mentions?.wasMentioned,
        GroupSystemPrompt: params.supplemental?.groupSystemPrompt,
        Provider: params.provider ?? params.channel,
        Surface: params.surface ?? params.provider ?? params.channel,
        OriginatingChannel: params.channel,
        OriginatingTo: params.reply.originatingTo,
        CommandAuthorized: params.access?.commands
          ? params.access.commands.authorizers.some((entry) => entry.allowed)
          : false,
        ...params.extra,
      }) as ReturnType<PluginRuntime["channel"]["turn"]["buildContext"]>,
  ) as unknown as PluginRuntime["channel"]["turn"]["buildContext"];
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
        updateSessionStore: vi
          .fn()
          .mockResolvedValue(
            undefined,
          ) as unknown as PluginRuntime["agent"]["session"]["updateSessionStore"],
        updateSessionStoreEntry: vi
          .fn()
          .mockResolvedValue(
            null,
          ) as unknown as PluginRuntime["agent"]["session"]["updateSessionStoreEntry"],
        resolveSessionFilePath: vi.fn(
          (sessionId: string) => `/tmp/${sessionId}.json`,
        ) as unknown as PluginRuntime["agent"]["session"]["resolveSessionFilePath"],
      },
    },
    system: {
      enqueueSystemEvent: vi.fn() as unknown as PluginRuntime["system"]["enqueueSystemEvent"],
      requestHeartbeat: vi.fn() as unknown as PluginRuntime["system"]["requestHeartbeat"],
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
      textToSpeechStream: vi.fn() as unknown as PluginRuntime["tts"]["textToSpeechStream"],
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
        settleReplyDispatcher: vi.fn(async ({ dispatcher, onSettled }) => {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }) as unknown as PluginRuntime["channel"]["reply"]["settleReplyDispatcher"],
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
      turn: {
        run: runChannelTurnMock,
        runResolved: vi.fn(
          async (params: Parameters<PluginRuntime["channel"]["turn"]["runResolved"]>[0]) =>
            await runChannelTurnMock({
              channel: params.channel,
              accountId: params.accountId,
              raw: params.raw,
              log: params.log,
              adapter: {
                ingest: (raw) =>
                  typeof params.input === "function" ? params.input(raw) : params.input,
                resolveTurn: params.resolveTurn,
              },
            }),
        ) as unknown as PluginRuntime["channel"]["turn"]["runResolved"],
        buildContext: buildChannelTurnContextMock,
        runPrepared: runPreparedChannelTurnMock,
        dispatchAssembled:
          dispatchAssembledChannelTurnMock as unknown as PluginRuntime["channel"]["turn"]["dispatchAssembled"],
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
      openKeyedStore: vi.fn(() => {
        throw new Error("openKeyedStore mock is not configured");
      }) as unknown as PluginRuntime["state"]["openKeyedStore"],
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
    llm: {
      complete: vi.fn(),
    },
    nodes: {
      list: vi.fn(async () => ({ nodes: [] })),
      invoke: vi.fn(),
    },
  };

  return mergeDeep(base, overrides);
}
