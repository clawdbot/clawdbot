// Plugin runtime mock helpers build minimal runtime doubles for plugin SDK tests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { InboundDebounceCreateParams } from "../../auto-reply/inbound-debounce.js";
import { normalizeInboundTextNewlines } from "../../auto-reply/reply/inbound-text.js";
import { normalizeThinkLevel } from "../../auto-reply/thinking.shared.js";
import {
  createAckReactionHandle,
  removeAckReactionAfterReply,
  removeAckReactionHandleAfterReply,
  shouldAckReaction,
} from "../../channels/ack-reactions.js";
import { createChannelReplyPipeline } from "../../channels/message/reply-pipeline.js";
import { resolveSessionEntryResetFreshness } from "../../config/sessions/entry-freshness.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { createChannelRuntimeContextRegistry } from "../../plugins/runtime/channel-runtime-contexts.js";
import { resolveAgentCatalogCreateTarget } from "../../plugins/runtime/runtime-agent-session-catalog.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "../channel-mention-gating.js";

type InboundDebounceFlush = ReturnType<InboundDebounceCreateParams<unknown>["onFlush"]>;
type InboundDebounceFlushFactory = Parameters<InboundDebounceCreateParams<unknown>["onFlush"]>[1];

export const createTestInboundDebounceFlush: InboundDebounceFlushFactory = (params) => {
  const source = params.lifecycle;
  const completion = params.dispatch({
    abortSignal: source?.abortSignal ?? new AbortController().signal,
    onAdopted: async () => await source?.onAdopted?.(),
    onDeferred: () => source?.onDeferred?.(),
    onDeferredHeartbeat: () => source?.onDeferredHeartbeat?.(),
    onAdoptionFinalizing: () => source?.onAdoptionFinalizing?.(),
    onFailed: source?.onFailed ? async (error) => await source.onFailed?.(error) : undefined,
    onAbandoned: async () => await source?.onAbandoned?.(),
  });
  return { admission: completion, completion };
};

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-5.6-sol";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends ReadonlyArray<unknown>
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

type BuildContextParams = Parameters<PluginRuntime["channel"]["inbound"]["buildContext"]>[0];
type BuildContextResult = ReturnType<PluginRuntime["channel"]["inbound"]["buildContext"]>;
type ChannelStructuredContextEntries = NonNullable<
  Awaited<BuildContextResult>["ChannelStructuredContext"]
>;
type ChannelStructuredContextResolution =
  | { kind: "absent" }
  | { kind: "present"; entries: ChannelStructuredContextEntries };
type BoundTaskFlowRuntime = ReturnType<PluginRuntime["tasks"]["managedFlows"]["bindSession"]>;

type GenericMockProcedure = (...args: never[]) => unknown;

// Vitest's Mock<T> erases generic and overload relationships. Keep that conversion in one
// test-only boundary while ordinary runtime methods continue to use exact vi.fn<T> checking.
function createGenericMock<T extends GenericMockProcedure>(
  implementation?: T | GenericMockProcedure,
): T {
  return (implementation ? vi.fn(implementation) : vi.fn()) as ReturnType<typeof vi.fn> & T;
}

function mergeDeep<T>(base: T, overrides: DeepPartial<T>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, overrideValue] of Object.entries(overrides as Record<string, unknown>)) {
    if (overrideValue === undefined) {
      continue;
    }
    const baseValue = result[key];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      result[key] = mergeDeep(baseValue, overrideValue);
      continue;
    }
    result[key] = overrideValue;
  }
  return result as T;
}

function createTaskFlowSessionMock(): BoundTaskFlowRuntime {
  return {
    sessionKey: "agent:main:main",
    createManaged: vi.fn<BoundTaskFlowRuntime["createManaged"]>(),
    tryCreateManaged: vi.fn<BoundTaskFlowRuntime["tryCreateManaged"]>(),
    get: vi.fn<BoundTaskFlowRuntime["get"]>(),
    list: vi.fn<BoundTaskFlowRuntime["list"]>(() => []),
    findLatest: vi.fn<BoundTaskFlowRuntime["findLatest"]>(),
    resolve: vi.fn<BoundTaskFlowRuntime["resolve"]>(),
    getTaskSummary: vi.fn<BoundTaskFlowRuntime["getTaskSummary"]>(),
    setWaiting: vi.fn<BoundTaskFlowRuntime["setWaiting"]>(),
    resume: vi.fn<BoundTaskFlowRuntime["resume"]>(),
    finish: vi.fn<BoundTaskFlowRuntime["finish"]>(),
    fail: vi.fn<BoundTaskFlowRuntime["fail"]>(),
    requestCancel: vi.fn<BoundTaskFlowRuntime["requestCancel"]>(),
    cancel: vi.fn<BoundTaskFlowRuntime["cancel"]>(),
    runTask: vi.fn<BoundTaskFlowRuntime["runTask"]>(),
  };
}

function normalizeUntrustedGroupPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeInboundTextNewlines(value);
  return normalized.trim().length > 0 ? normalized : undefined;
}

function resolveMockChannelStructuredContext(
  params: Pick<BuildContextParams, "extra" | "supplemental">,
): ChannelStructuredContextResolution {
  const entries: ChannelStructuredContextEntries = [];
  const extraEntries =
    params.extra?.ChannelStructuredContext ?? params.extra?.UntrustedStructuredContext;
  if (Array.isArray(extraEntries)) {
    entries.push(...(extraEntries as ChannelStructuredContextEntries));
  }
  const supplementalEntries =
    params.supplemental?.channelStructuredContext ?? params.supplemental?.untrustedContext;
  if (supplementalEntries !== undefined) {
    entries.push(...supplementalEntries);
  }

  const groupPrompt = normalizeUntrustedGroupPrompt(
    params.supplemental?.untrustedGroupSystemPrompt,
  );
  if (groupPrompt) {
    entries.push({
      label: "Group prompt context",
      type: "group_prompt_context",
      payload: { text: groupPrompt },
    });
  }

  const contextProvided =
    extraEntries !== undefined || supplementalEntries !== undefined || groupPrompt !== undefined;
  return contextProvided ? { kind: "present", entries } : { kind: "absent" };
}

export type PluginRuntimeMediaMock = PluginRuntime["channel"]["media"];

const TEST_CONFIG_SNAPSHOT = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  parsed: {},
  sourceConfig: {},
  resolved: {},
  valid: true,
  runtimeConfig: {},
  config: {},
  issues: [],
  warnings: [],
  legacyIssues: [],
} satisfies ConfigFileSnapshot;

const TEST_SAVED_MEDIA = {
  id: "test-media.jpg",
  path: "/tmp/test-media.jpg",
  size: 0,
  contentType: "image/jpeg",
} satisfies Awaited<ReturnType<PluginRuntimeMediaMock["saveMediaBuffer"]>>;

export function createPluginRuntimeMediaMock(
  overrides: Partial<PluginRuntimeMediaMock> = {},
): PluginRuntimeMediaMock {
  const readRemoteMediaBuffer = vi.fn<PluginRuntimeMediaMock["readRemoteMediaBuffer"]>();
  return {
    readRemoteMediaBuffer,
    fetchRemoteMedia: readRemoteMediaBuffer,
    saveRemoteMedia: vi
      .fn<PluginRuntimeMediaMock["saveRemoteMedia"]>()
      .mockResolvedValue(TEST_SAVED_MEDIA),
    saveResponseMedia: vi
      .fn<PluginRuntimeMediaMock["saveResponseMedia"]>()
      .mockResolvedValue(TEST_SAVED_MEDIA),
    saveMediaBuffer: vi
      .fn<PluginRuntimeMediaMock["saveMediaBuffer"]>()
      .mockResolvedValue(TEST_SAVED_MEDIA),
    ...overrides,
  };
}

export function createPluginRuntimeMock(overrides: DeepPartial<PluginRuntime> = {}): PluginRuntime {
  const runtimeContexts = createChannelRuntimeContextRegistry();
  const runEmbeddedAgentMock = vi
    .fn<PluginRuntime["agent"]["runEmbeddedAgent"]>()
    .mockResolvedValue({
      payloads: [],
      meta: { durationMs: 0 },
    });
  const taskFlow = {
    bindSession:
      vi.fn<PluginRuntime["tasks"]["managedFlows"]["bindSession"]>(createTaskFlowSessionMock),
    fromToolContext:
      vi.fn<PluginRuntime["tasks"]["managedFlows"]["fromToolContext"]>(createTaskFlowSessionMock),
  };
  const dispatchAssembledChannelTurnMock = vi.fn<
    PluginRuntime["channel"]["inbound"]["dispatchReply"]
  >(async (params) => {
    const admission = params.admission ?? { kind: "dispatch" as const };
    const ctxPayload = params.ctxPayload;
    const record = params.record;
    const recordInboundSession = params.recordInboundSession;
    const routeSessionKey = params.routeSessionKey;
    const storePath = params.storePath;
    const sourceDelivery = params.delivery as typeof params.delivery & {
      deliverWithProviderMessageSending?: typeof params.delivery.deliver;
    };
    const sourceDeliver =
      sourceDelivery.deliverWithProviderMessageSending ?? sourceDelivery.deliver;
    if (admission.kind !== "observeOnly" && !sourceDeliver) {
      throw new Error("channel delivery mock requires a delivery callback");
    }
    const delivery =
      admission.kind === "observeOnly"
        ? { ...sourceDelivery, deliver: async () => ({ visibleReplySent: false }) }
        : { ...sourceDelivery, deliver: sourceDeliver! };
    const ctxSessionKey = ctxPayload.SessionKey;
    const sessionKey = typeof ctxSessionKey === "string" ? ctxSessionKey : routeSessionKey;
    const dispatchReplyWithBufferedBlockDispatcher =
      params.dispatchReplyWithBufferedBlockDispatcher;
    const pipeline = params.replyPipeline
      ? createChannelReplyPipeline({
          ...(params.replyPipeline as Omit<
            Parameters<typeof createChannelReplyPipeline>[0],
            "cfg" | "agentId" | "channel" | "accountId"
          >),
          cfg: params.cfg,
          agentId: params.agentId,
          channel: params.channel,
          accountId: params.accountId,
        })
      : undefined;
    const { onModelSelected, ...dispatcherPipeline } = pipeline ?? {};
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
    await params.afterRecord?.();
    const rawDispatchResult = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: params.cfg,
      dispatcherOptions: {
        ...dispatcherPipeline,
        ...params.dispatcherOptions,
        deliver: async (payload, info) => {
          const result = await delivery.deliver(payload, info);
          await delivery.onDelivered?.(payload, info, result);
          return result;
        },
        onError: delivery.onError,
      },
      replyOptions: {
        ...(onModelSelected ? { onModelSelected } : {}),
        ...params.replyOptions,
        ...(params.turnAdoptionLifecycle
          ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
          : {}),
      },
      replyResolver: params.replyResolver,
    });
    const dispatchResult =
      admission.kind === "observeOnly"
        ? { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }
        : rawDispatchResult;
    return {
      admission,
      dispatched: true,
      ctxPayload,
      routeSessionKey,
      dispatchResult,
    };
  });
  const runPreparedChannelTurnMock = createGenericMock<
    PluginRuntime["channel"]["inbound"]["runPreparedReply"]
  >(async (params: Parameters<PluginRuntime["channel"]["inbound"]["runPreparedReply"]>[0]) => {
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
      await params.afterRecord?.();
    } catch (err) {
      try {
        await params.onPreDispatchFailure?.(err);
      } catch {
        // Preserve the original session-recording error.
      }
      throw err;
    }
    const admission = params.admission ?? { kind: "dispatch" as const };
    let dispatchResult;
    if (admission.kind === "observeOnly") {
      await params.runDispatchLifecycle?.onDispatchSkipped("observeOnly");
      dispatchResult = params.observeOnlyDispatchResult ?? {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    } else {
      dispatchResult = await params.runDispatch();
    }
    return {
      admission,
      dispatched: true,
      ctxPayload: params.ctxPayload,
      routeSessionKey: params.routeSessionKey,
      dispatchResult,
    };
  });
  const dispatchChannelTurnPlanMock = createGenericMock<
    PluginRuntime["channel"]["inbound"]["dispatch"]
  >(async (params: Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0]) => {
    if (!mergedRuntime) {
      throw new Error("plugin runtime mock dispatch used before initialization");
    }
    return await dispatchAssembledChannelTurnMock({
      ...params,
      agentId: params.route.agentId,
      routeSessionKey: params.route.sessionKey,
      storePath: mergedRuntime.channel.session.resolveStorePath(params.cfg.session?.store, {
        agentId: params.route.agentId,
      }),
      recordInboundSession: mergedRuntime.channel.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher:
        mergedRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    });
  });
  const runChannelTurnMock = createGenericMock<PluginRuntime["channel"]["inbound"]["run"]>(
    async (params: Parameters<PluginRuntime["channel"]["inbound"]["run"]>[0]) => {
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
      let dispatchResult;
      if ("runDispatch" in resolved) {
        if (params.turnAdoptionLifecycle) {
          const lifecycle = resolved.runDispatchLifecycle;
          if (!lifecycle) {
            throw new Error(
              "runChannelInboundEvent prepared turns must declare runDispatchLifecycle when creating runDispatch",
            );
          }
          if (lifecycle.turnAdoptionLifecycle !== params.turnAdoptionLifecycle) {
            throw new Error(
              "runChannelInboundEvent prepared turn runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
            );
          }
        }
        const prepared =
          "route" in resolved
            ? (() => {
                if (!mergedRuntime) {
                  throw new Error("plugin runtime mock run used before initialization");
                }
                const { cfg, route, ...turn } = resolved;
                return {
                  ...turn,
                  routeSessionKey: route.sessionKey,
                  storePath: mergedRuntime.channel.session.resolveStorePath(cfg.session?.store, {
                    agentId: route.agentId,
                  }),
                  recordInboundSession: mergedRuntime.channel.session.recordInboundSession,
                };
              })()
            : resolved;
        const preparedReply: Parameters<
          PluginRuntime["channel"]["inbound"]["runPreparedReply"]
        >[0] = {
          ...prepared,
          admission,
        };
        dispatchResult = await runPreparedChannelTurnMock(preparedReply);
      } else if ("route" in resolved) {
        dispatchResult = await dispatchChannelTurnPlanMock({
          ...resolved,
          admission,
          ...(params.turnAdoptionLifecycle
            ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
            : {}),
        });
      } else {
        dispatchResult = await dispatchAssembledChannelTurnMock({
          ...resolved,
          admission,
          ...(params.turnAdoptionLifecycle
            ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
            : {}),
        });
      }
      const result = {
        ...dispatchResult,
        admission,
      } as Parameters<NonNullable<typeof params.adapter.onFinalize>>[0];
      await params.adapter.onFinalize?.(result);
      return result;
    },
  );
  const buildChannelInboundEventContextMock = createGenericMock<
    PluginRuntime["channel"]["inbound"]["buildContext"]
  >((params: BuildContextParams) => {
    const channelStructuredContext = resolveMockChannelStructuredContext(params);
    const extra = { ...params.extra };
    delete extra.UntrustedStructuredContext;
    const structuredContextField =
      channelStructuredContext.kind === "present"
        ? { ChannelStructuredContext: channelStructuredContext.entries }
        : {};
    return {
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
      media: params.media,
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
      CommandAuthorized: params.access?.commands?.authorized ?? false,
      ...extra,
      ...structuredContextField,
    } as Awaited<BuildContextResult>;
  });
  const sessionRuntime = {
    resolveStorePath: vi.fn<PluginRuntime["channel"]["session"]["resolveStorePath"]>(
      () => "/tmp/sessions.json",
    ),
    readSessionUpdatedAt: vi.fn<PluginRuntime["channel"]["session"]["readSessionUpdatedAt"]>(
      () => undefined,
    ),
    recordSessionMetaFromInbound:
      vi.fn<PluginRuntime["channel"]["session"]["recordSessionMetaFromInbound"]>(),
    recordInboundSession: vi.fn<PluginRuntime["channel"]["session"]["recordInboundSession"]>(),
    updateLastRoute: vi.fn<PluginRuntime["channel"]["session"]["updateLastRoute"]>(),
    resolveEntryResetFreshness: vi.fn(resolveSessionEntryResetFreshness),
  };
  const base: PluginRuntime = {
    version: "1.0.0-test",
    gateway: {
      isAvailable: vi.fn(async () => false),
      request: vi.fn(),
    },
    config: {
      current: vi.fn<PluginRuntime["config"]["current"]>(() => ({})),
      mutateConfigFile: createGenericMock<PluginRuntime["config"]["mutateConfigFile"]>(
        async () => ({
          path: "/tmp/openclaw.json",
          previousHash: null,
          persistedHash: null,
          snapshot: TEST_CONFIG_SNAPSHOT,
          nextConfig: {},
          afterWrite: { mode: "auto" },
          followUp: { mode: "auto", requiresRestart: false },
          result: undefined,
        }),
      ),
      replaceConfigFile: vi.fn<PluginRuntime["config"]["replaceConfigFile"]>(
        async ({ nextConfig }) => ({
          path: "/tmp/openclaw.json",
          previousHash: null,
          persistedHash: null,
          snapshot: TEST_CONFIG_SNAPSHOT,
          nextConfig,
          afterWrite: { mode: "auto" },
          followUp: { mode: "auto", requiresRestart: false },
        }),
      ),
    },
    agent: {
      defaults: {
        model: DEFAULT_MODEL,
        provider: DEFAULT_PROVIDER,
      },
      resolveAgentDir: vi.fn<PluginRuntime["agent"]["resolveAgentDir"]>(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn<PluginRuntime["agent"]["resolveAgentWorkspaceDir"]>(
        () => "/tmp/workspace",
      ),
      resolveAgentIdentity: vi.fn<PluginRuntime["agent"]["resolveAgentIdentity"]>(() => ({
        name: "test-agent",
      })),
      resolveSessionCatalogCreateTarget: vi.fn<
        PluginRuntime["agent"]["resolveSessionCatalogCreateTarget"]
      >(resolveAgentCatalogCreateTarget),
      resolveThinkingDefault: vi.fn<PluginRuntime["agent"]["resolveThinkingDefault"]>(() => "off"),
      resolveCliBackendDispatchEligibility: vi.fn<
        PluginRuntime["agent"]["resolveCliBackendDispatchEligibility"]
      >(() => undefined),
      normalizeThinkingLevel:
        vi.fn<PluginRuntime["agent"]["normalizeThinkingLevel"]>(normalizeThinkLevel),
      resolveThinkingPolicy: vi.fn<PluginRuntime["agent"]["resolveThinkingPolicy"]>(() => ({
        levels: [
          { id: "off", label: "off" },
          { id: "minimal", label: "minimal" },
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
        ],
      })),
      runCommandFromIngress: vi.fn<PluginRuntime["agent"]["runCommandFromIngress"]>(),
      runEmbeddedAgent: runEmbeddedAgentMock,
      resolveAgentTimeoutMs: vi.fn<PluginRuntime["agent"]["resolveAgentTimeoutMs"]>(() => 30_000),
      ensureAgentWorkspace: vi
        .fn<PluginRuntime["agent"]["ensureAgentWorkspace"]>()
        .mockResolvedValue({ dir: "/tmp/workspace" }),
      session: {
        resolveStorePath: vi.fn<PluginRuntime["agent"]["session"]["resolveStorePath"]>(
          () => "/tmp/agent-sessions.json",
        ),
        createSessionEntry: vi.fn(
          async (
            params: Parameters<PluginRuntime["agent"]["session"]["createSessionEntry"]>[0],
          ) => {
            const sessionId = "plugin-runtime-mock-session";
            const key = params.key;
            const sessionInitialEntry =
              "acpSessionBinding" in params.initialEntry
                ? {
                    acpSessionBinding: {
                      acpBackendId: params.initialEntry.acpBackendId,
                      ...params.initialEntry.acpSessionBinding,
                    },
                    ...(params.initialEntry.modelSelectionLocked
                      ? { modelSelectionLocked: true as const }
                      : {}),
                    ...(params.initialEntry.pluginExtensions
                      ? { pluginExtensions: structuredClone(params.initialEntry.pluginExtensions) }
                      : {}),
                    ...(params.initialEntry.pluginOwnerId
                      ? { pluginOwnerId: params.initialEntry.pluginOwnerId }
                      : {}),
                  }
                : structuredClone(params.initialEntry);
            const initialEntry = {
              sessionId,
              updatedAt: Date.now(),
              ...(params.label !== undefined ? { label: params.label } : {}),
              ...(params.spawnedCwd !== undefined ? { spawnedCwd: params.spawnedCwd } : {}),
              ...sessionInitialEntry,
              ...(params.afterCreate ? { initializationPending: true as const } : {}),
            };
            const initialized = {
              key,
              agentId: params.agentId ?? "main",
              sessionId,
              entry: initialEntry,
            };
            const finalPatch = await params.afterCreate?.(structuredClone(initialized));
            if (finalPatch !== undefined) {
              const patchKeys = Object.keys(finalPatch);
              if (patchKeys.length !== 1 || patchKeys[0] !== "pluginExtensions") {
                throw new Error("session creation final patch may only contain pluginExtensions");
              }
            }
            return {
              ...initialized,
              entry:
                params.afterCreate === undefined
                  ? initialEntry
                  : {
                      ...initialEntry,
                      ...(finalPatch === undefined
                        ? {}
                        : {
                            pluginExtensions: structuredClone(finalPatch.pluginExtensions),
                          }),
                      initializationPending: undefined,
                    },
            };
          },
        ) as PluginRuntime["agent"]["session"]["createSessionEntry"],
        getSessionEntry: vi.fn<PluginRuntime["agent"]["session"]["getSessionEntry"]>(
          () => undefined,
        ),
        listSessionEntries: vi.fn<PluginRuntime["agent"]["session"]["listSessionEntries"]>(
          () => [],
        ),
        patchSessionEntry: vi
          .fn<PluginRuntime["agent"]["session"]["patchSessionEntry"]>()
          .mockResolvedValue(null),
        upsertSessionEntry: vi
          .fn<PluginRuntime["agent"]["session"]["upsertSessionEntry"]>()
          .mockResolvedValue(undefined),
        runWithWorkAdmission: vi.fn(
          async (_params, run) => await run(new AbortController().signal),
        ) as PluginRuntime["agent"]["session"]["runWithWorkAdmission"],
        updateSessionStoreEntry: vi
          .fn<PluginRuntime["agent"]["session"]["updateSessionStoreEntry"]>()
          .mockResolvedValue(null),
      },
    },
    system: {
      enqueueSystemEvent: vi.fn<PluginRuntime["system"]["enqueueSystemEvent"]>(),
      requestHeartbeat: vi.fn<PluginRuntime["system"]["requestHeartbeat"]>(),
      requestHeartbeatNow: vi.fn<PluginRuntime["system"]["requestHeartbeatNow"]>(),
      runHeartbeatOnce: vi.fn<PluginRuntime["system"]["runHeartbeatOnce"]>(async () => ({
        status: "ran" as const,
        durationMs: 0,
      })),
      runCommandWithTimeout: vi.fn<PluginRuntime["system"]["runCommandWithTimeout"]>(),
      formatNativeDependencyHint: vi.fn<PluginRuntime["system"]["formatNativeDependencyHint"]>(
        () => "",
      ),
    },
    media: {
      loadWebMedia: vi.fn<PluginRuntime["media"]["loadWebMedia"]>(),
      detectMime: vi.fn<PluginRuntime["media"]["detectMime"]>(),
      mediaKindFromMime: vi.fn<PluginRuntime["media"]["mediaKindFromMime"]>(),
      isVoiceCompatibleAudio: vi.fn<PluginRuntime["media"]["isVoiceCompatibleAudio"]>(),
      getImageMetadata: vi.fn<PluginRuntime["media"]["getImageMetadata"]>(),
      resizeToJpeg: vi.fn<PluginRuntime["media"]["resizeToJpeg"]>(),
    },
    tts: {
      prepareTtsRequest: vi.fn<PluginRuntime["tts"]["prepareTtsRequest"]>(),
      textToSpeech: vi.fn<PluginRuntime["tts"]["textToSpeech"]>(),
      textToSpeechStream: vi.fn<PluginRuntime["tts"]["textToSpeechStream"]>(),
      textToSpeechTelephony: vi.fn<PluginRuntime["tts"]["textToSpeechTelephony"]>(),
      listVoices: vi.fn<PluginRuntime["tts"]["listVoices"]>(),
    },
    mediaUnderstanding: {
      resolveAudioInputBudget: vi
        .fn<PluginRuntime["mediaUnderstanding"]["resolveAudioInputBudget"]>()
        .mockResolvedValue({ enabled: true, maxBytes: 20 * 1024 * 1024 }),
      runFile: vi.fn<PluginRuntime["mediaUnderstanding"]["runFile"]>(),
      describeImageFile: vi.fn<PluginRuntime["mediaUnderstanding"]["describeImageFile"]>(),
      describeImageFileWithModel:
        vi.fn<PluginRuntime["mediaUnderstanding"]["describeImageFileWithModel"]>(),
      extractStructuredWithModel:
        vi.fn<PluginRuntime["mediaUnderstanding"]["extractStructuredWithModel"]>(),
      describeVideoFile: vi.fn<PluginRuntime["mediaUnderstanding"]["describeVideoFile"]>(),
      transcribeAudioFile: vi.fn<PluginRuntime["mediaUnderstanding"]["transcribeAudioFile"]>(),
    },
    imageGeneration: {
      generate: vi.fn<PluginRuntime["imageGeneration"]["generate"]>(),
      listProviders: vi.fn<PluginRuntime["imageGeneration"]["listProviders"]>(),
    },
    musicGeneration: {
      generate: vi.fn<PluginRuntime["musicGeneration"]["generate"]>(),
      listProviders: vi.fn<PluginRuntime["musicGeneration"]["listProviders"]>(),
    },
    videoGeneration: {
      generate: vi.fn<PluginRuntime["videoGeneration"]["generate"]>(),
      listProviders: vi.fn<PluginRuntime["videoGeneration"]["listProviders"]>(),
    },
    webSearch: {
      listProviders: vi.fn<PluginRuntime["webSearch"]["listProviders"]>(),
      search: vi.fn<PluginRuntime["webSearch"]["search"]>(),
    },
    channel: {
      text: {
        chunkByNewline: vi.fn((text: string) => (text ? [text] : [])),
        chunkMarkdownText: vi.fn((text: string) => [text]),
        chunkMarkdownTextWithMode: vi.fn((text: string) => (text ? [text] : [])),
        chunkText: vi.fn((text: string) => (text ? [text] : [])),
        chunkTextWithMode: vi.fn((text: string) => (text ? [text] : [])),
        resolveChunkMode: vi.fn<PluginRuntime["channel"]["text"]["resolveChunkMode"]>(
          () => "length",
        ),
        resolveTextChunkLimit: vi.fn(() => 4000),
        hasControlCommand: vi.fn(() => false),
        resolveMarkdownTableMode: vi.fn<
          PluginRuntime["channel"]["text"]["resolveMarkdownTableMode"]
        >(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn<
          PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
        >(async () => ({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        })),
        createReplyDispatcherWithTyping:
          vi.fn<PluginRuntime["channel"]["reply"]["createReplyDispatcherWithTyping"]>(),
        resolveEffectiveMessagesConfig:
          vi.fn<PluginRuntime["channel"]["reply"]["resolveEffectiveMessagesConfig"]>(),
        resolveHumanDelayConfig:
          vi.fn<PluginRuntime["channel"]["reply"]["resolveHumanDelayConfig"]>(),
        dispatchReplyFromConfig:
          vi.fn<PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]>(),
        settleReplyDispatcher: vi.fn<PluginRuntime["channel"]["reply"]["settleReplyDispatcher"]>(
          async ({ dispatcher, onSettled }) => {
            dispatcher.markComplete();
            try {
              await dispatcher.waitForIdle();
            } finally {
              await onSettled?.();
            }
          },
        ),
        withReplyDispatcher: createGenericMock<
          PluginRuntime["channel"]["reply"]["withReplyDispatcher"]
        >(
          async ({
            dispatcher,
            run,
            onSettled,
          }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
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
          },
        ),
        finalizeInboundContext: createGenericMock<
          PluginRuntime["channel"]["reply"]["finalizeInboundContext"]
        >((ctx: Record<string, unknown>) => ctx),
        formatAgentEnvelope: vi.fn<PluginRuntime["channel"]["reply"]["formatAgentEnvelope"]>(
          (opts: { body: string }) => opts.body,
        ),
        resolveEnvelopeFormatOptions: vi.fn<
          PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"]
        >(() => ({})),
      },
      routing: {
        buildAgentSessionKey: vi.fn<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>(
          ({ agentId, channel, peer }) =>
            `agent:${agentId}:${channel}:${peer?.kind ?? "direct"}:${peer?.id ?? "peer"}`,
        ),
        resolveAgentRoute: vi.fn<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>(() => ({
          agentId: "main",
          channel: "test",
          accountId: "default",
          sessionKey: "agent:main:test:dm:peer",
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: "session",
          matchedBy: "default",
        })),
      },
      pairing: {
        buildPairingReply: vi.fn<PluginRuntime["channel"]["pairing"]["buildPairingReply"]>(
          () => "Pairing code: TESTCODE",
        ),
        readAllowFromStore: vi
          .fn<PluginRuntime["channel"]["pairing"]["readAllowFromStore"]>()
          .mockResolvedValue([]),
        removeAllowFromStoreEntry: vi
          .fn<PluginRuntime["channel"]["pairing"]["removeAllowFromStoreEntry"]>()
          .mockResolvedValue({
            changed: false,
            allowFrom: [],
          }),
        upsertPairingRequest: vi
          .fn<PluginRuntime["channel"]["pairing"]["upsertPairingRequest"]>()
          .mockResolvedValue({
            code: "TESTCODE",
            created: true,
          }),
      },
      media: createPluginRuntimeMediaMock(),
      session: sessionRuntime,
      mentions: {
        buildMentionRegexes: vi.fn<PluginRuntime["channel"]["mentions"]["buildMentionRegexes"]>(
          () => [/\bbert\b/i],
        ),
        matchesMentionPatterns: vi.fn<
          PluginRuntime["channel"]["mentions"]["matchesMentionPatterns"]
        >((text: string, regexes: RegExp[]) => regexes.some((regex) => regex.test(text))),
        matchesMentionWithExplicit: vi.fn<
          PluginRuntime["channel"]["mentions"]["matchesMentionWithExplicit"]
        >((params: { text: string; mentionRegexes: RegExp[]; explicitWasMentioned?: boolean }) =>
          params.explicitWasMentioned === true
            ? true
            : params.mentionRegexes.some((regex) => regex.test(params.text)),
        ),
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
        resolveGroupPolicy: vi.fn<PluginRuntime["channel"]["groups"]["resolveGroupPolicy"]>(() => ({
          allowlistEnabled: false,
          allowed: true,
        })),
        resolveRequireMention: vi.fn<PluginRuntime["channel"]["groups"]["resolveRequireMention"]>(
          () => false,
        ),
      },
      debounce: {
        createInboundDebouncer: createGenericMock<
          PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]
        >((params: Pick<InboundDebounceCreateParams<unknown>, "onFlush">) => {
          const activeCompletions = new Set<Promise<void>>();
          const runFlush = async (flush: InboundDebounceFlush) => {
            const completion = flush.completion.catch(() => undefined);
            activeCompletions.add(completion);
            void completion.finally(() => activeCompletions.delete(completion));
            await Promise.race([flush.admission, completion]);
          };
          return {
            enqueue: async (item: unknown) => {
              await runFlush(params.onFlush([item], createTestInboundDebounceFlush));
            },
            flushKey: vi.fn(),
            cancelKey: vi.fn(() => false),
            drain: async () => {
              await Promise.all(activeCompletions);
            },
          };
        }),
        resolveInboundDebounceMs: vi.fn<
          PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"]
        >((params: unknown) => {
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
        }),
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn<
          PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"]
        >(() => false),
        isControlCommandMessage:
          vi.fn<PluginRuntime["channel"]["commands"]["isControlCommandMessage"]>(),
        shouldComputeCommandAuthorized:
          vi.fn<PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"]>(),
        shouldHandleTextCommands:
          vi.fn<PluginRuntime["channel"]["commands"]["shouldHandleTextCommands"]>(),
      },
      outbound: {
        loadAdapter: vi.fn<PluginRuntime["channel"]["outbound"]["loadAdapter"]>(),
      },
      inbound: {
        run: runChannelTurnMock,
        dispatch: dispatchChannelTurnPlanMock,
        dispatchReply: dispatchAssembledChannelTurnMock,
        buildContext: buildChannelInboundEventContextMock,
        runPreparedReply: runPreparedChannelTurnMock,
      },
      threadBindings: {
        setIdleTimeoutBySessionKey:
          vi.fn<PluginRuntime["channel"]["threadBindings"]["setIdleTimeoutBySessionKey"]>(),
        setMaxAgeBySessionKey:
          vi.fn<PluginRuntime["channel"]["threadBindings"]["setMaxAgeBySessionKey"]>(),
      },
      runtimeContexts: {
        register: vi.fn<PluginRuntime["channel"]["runtimeContexts"]["register"]>(
          runtimeContexts.register,
        ),
        get: createGenericMock<PluginRuntime["channel"]["runtimeContexts"]["get"]>(
          runtimeContexts.get,
        ),
        watch: vi.fn<PluginRuntime["channel"]["runtimeContexts"]["watch"]>(runtimeContexts.watch),
      },
      activity: {
        record: vi.fn(),
        get: vi.fn(() => ({ inboundAt: null, outboundAt: null })),
      },
    },
    events: {
      onAgentEvent: vi.fn<PluginRuntime["events"]["onAgentEvent"]>(() => () => {}),
      onSessionTranscriptUpdate: vi.fn<PluginRuntime["events"]["onSessionTranscriptUpdate"]>(
        () => () => {},
      ),
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
      openBlobStore: createGenericMock<PluginRuntime["state"]["openBlobStore"]>(() => {
        throw new Error("openBlobStore mock is not configured");
      }),
      openKeyedStore: createGenericMock<PluginRuntime["state"]["openKeyedStore"]>(() => {
        throw new Error("openKeyedStore mock is not configured");
      }),
      openSyncKeyedStore: createGenericMock<PluginRuntime["state"]["openSyncKeyedStore"]>(() => {
        throw new Error("openSyncKeyedStore mock is not configured");
      }),
      openChannelIngressQueue: createGenericMock<PluginRuntime["state"]["openChannelIngressQueue"]>(
        () => {
          throw new Error("openChannelIngressQueue mock is not configured");
        },
      ),
      openChannelIngressDrain: createGenericMock<PluginRuntime["state"]["openChannelIngressDrain"]>(
        () => {
          throw new Error("openChannelIngressDrain mock is not configured");
        },
      ),
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
    },
    modelAuth: {
      getApiKeyForModel: vi.fn<PluginRuntime["modelAuth"]["getApiKeyForModel"]>(),
      getRuntimeAuthForModel: vi.fn<PluginRuntime["modelAuth"]["getRuntimeAuthForModel"]>(),
      resolveApiKeyForProvider: vi.fn<PluginRuntime["modelAuth"]["resolveApiKeyForProvider"]>(),
    },
    subagent: {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      deleteSession: vi.fn(),
    },
    hooks: {
      dispatchHookAgentTurn: vi.fn(),
    },
    sandbox: {
      resolveWorkspaceAuthority: vi.fn(),
      prepareWorkspaceAuthority: vi.fn(),
    },
    worktrees: {
      resolveCheckoutRoot: vi.fn(),
      hasSelfContainedCheckoutMetadata: vi.fn(),
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    },
    llm: {
      acquireLocalService: vi.fn(),
      complete: vi.fn().mockResolvedValue({
        text: "{}",
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        agentId: "main",
        usage: {},
        execution: {
          mode: "direct-provider",
          owner: { kind: "provider", id: DEFAULT_PROVIDER },
        },
        audit: { caller: { kind: "plugin", id: "test" } },
      }),
    },
    nodes: {
      list: vi.fn(async () => ({ nodes: [] })),
      invoke: vi.fn(),
      openDuplex: vi.fn(),
    },
  };

  const mergedRuntime = mergeDeep(base, overrides);
  return mergedRuntime;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
