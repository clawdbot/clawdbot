// Resolves outbound channel adapters and executes their send lifecycle.
import type {
  ChannelMessageAdapterShape,
  ChannelMessageSendAttemptContext,
  ChannelMessageSendAttemptKind,
  ChannelMessageSendLifecycleAdapter,
  ChannelMessageSendResult,
} from "../../channels/message/types.js";
import { unknownSendReconciliationKinds } from "../../channels/message/types.js";
import { createChannelRegistryLoader } from "../../channels/plugins/registry-loader.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundPayloadContext,
  ChannelOutboundTargetRef,
} from "../../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatErrorMessage } from "../errors.js";
import type {
  ChannelHandler,
  ChannelHandlerParams,
  DurableFinalDeliveryRequirement,
  DurableFinalDeliveryRequirements,
  OutboundDurableDeliverySupport,
  PlatformSendRoute,
} from "./deliver-contracts.js";
import { PlatformMessageNotDispatchedError, type OutboundDeliveryResult } from "./deliver-types.js";
import {
  attachOutboundDeliveryCommitHook,
  type OutboundDeliveryCommitHook,
} from "./delivery-commit-hooks.js";
import type { OutboundMessageSendOverrides } from "./message-plan.js";

const log = createSubsystemLogger("outbound/deliver");

const loadChannelBootstrapRuntime = createLazyRuntimeModule(
  () => import("./channel-bootstrap.runtime.js"),
);
const loadChannelPluginFromRegistry = createChannelRegistryLoader((entry) => entry.plugin);
export async function resolveChannelOutboundDirectiveOptions(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  channel: string;
}): Promise<{ extractMarkdownImages?: boolean }> {
  const { plugin } = await loadBootstrappedChannelPlugin(params);
  return {
    extractMarkdownImages: plugin?.outbound?.extractMarkdownImages === true ? true : undefined,
  };
}

export async function createChannelHandler(params: ChannelHandlerParams): Promise<ChannelHandler> {
  const { plugin, pluginRegistry } = await loadBootstrappedChannelPlugin(params);
  const handler = withPluginRuntimeRegistryScope(pluginRegistry, () =>
    createPluginHandler({ ...params, outbound: plugin?.outbound, message: plugin?.message }),
  );
  if (!handler) {
    const message = `Outbound not configured for channel: ${params.channel}`;
    throw new PlatformMessageNotDispatchedError(message, { cause: new Error(message) });
  }
  return scopeChannelHandler(handler, pluginRegistry);
}

async function loadBootstrappedChannelPlugin(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  channel: string;
}): Promise<{ plugin?: ChannelPlugin; pluginRegistry?: PluginRegistry }> {
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const plugin = await loadChannelPluginFromRegistry(params.channel);
  if (plugin?.outbound || plugin?.message?.send?.text) {
    // Both adapter surfaces belong to this registration, including an omitted
    // surface. A second lookup could attach another plugin's send lifecycle.
    return { plugin, pluginRegistry: scopedRegistry };
  }
  const { bootstrapOutboundChannelPlugin } = await loadChannelBootstrapRuntime();
  const pluginRegistry = bootstrapOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return {
    plugin: pluginRegistry?.channels.find((entry) => entry.plugin.id === params.channel)?.plugin,
    pluginRegistry,
  };
}

function scopeChannelHandler(
  handler: ChannelHandler,
  registry: PluginRegistry | undefined,
): ChannelHandler {
  if (!registry) {
    return handler;
  }
  return Object.fromEntries(
    Object.entries(handler).map(([key, value]) => {
      if (typeof value !== "function") {
        return [key, value];
      }
      const call = value as (...args: unknown[]) => unknown;
      return [
        key,
        (...args: unknown[]) => withPluginRuntimeRegistryScope(registry, () => call(...args)),
      ];
    }),
  ) as ChannelHandler;
}

async function runChannelMessageSendWithLifecycle<
  TResult extends ChannelMessageSendResult,
>(params: {
  lifecycle?: ChannelMessageSendLifecycleAdapter;
  ctx: ChannelMessageSendAttemptContext;
  send: () => Promise<TResult>;
}): Promise<{ result: TResult; afterCommit?: OutboundDeliveryCommitHook }> {
  if (!params.lifecycle) {
    return { result: await params.send() };
  }
  let attemptToken: unknown;
  try {
    attemptToken = await params.lifecycle.beforeSendAttempt?.(params.ctx);
    const result = await params.send();
    if (result.outcome === "not_sent") {
      return { result };
    }
    const successCtx = {
      ...params.ctx,
      result,
      ...(attemptToken !== undefined ? { attemptToken } : {}),
    };
    try {
      await params.lifecycle.afterSendSuccess?.(successCtx);
    } catch (successHookError: unknown) {
      log.warn(
        `channel message send success hook failed after platform send; preserving send result: ${formatErrorMessage(successHookError)}`,
      );
    }
    return {
      result,
      ...(params.lifecycle.afterCommit
        ? {
            afterCommit: async () => {
              await params.lifecycle?.afterCommit?.(successCtx);
            },
          }
        : {}),
    };
  } catch (error: unknown) {
    try {
      await params.lifecycle.afterSendFailure?.({
        ...params.ctx,
        error,
        ...(attemptToken !== undefined ? { attemptToken } : {}),
      });
    } catch (cleanupError: unknown) {
      log.warn(
        `channel message send failure cleanup failed; preserving original send error: ${formatErrorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

export async function resolveOutboundDurableFinalDeliverySupport(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  channel: string;
  requirements?: DurableFinalDeliveryRequirements;
}): Promise<OutboundDurableDeliverySupport> {
  const { plugin } = await loadBootstrappedChannelPlugin(params);
  const outbound = plugin?.outbound;
  const message = plugin?.message;
  if (!message?.send?.text && !outbound?.sendText) {
    return { ok: false, reason: "missing_outbound_handler" };
  }

  const messageDurableFinal = message?.durableFinal;
  const durableFinal =
    messageDurableFinal?.capabilities ?? outbound?.deliveryCapabilities?.durableFinal;
  for (const [capability, required] of Object.entries(params.requirements ?? {}) as Array<
    [DurableFinalDeliveryRequirement, boolean | undefined]
  >) {
    if (required === true && durableFinal?.[capability] !== true) {
      return { ok: false, reason: "capability_mismatch", capability };
    }
    if (
      required === true &&
      capability === "reconcileUnknownSend" &&
      typeof messageDurableFinal?.reconcileUnknownSend !== "function"
    ) {
      return { ok: false, reason: "capability_mismatch", capability };
    }
  }

  if (params.requirements?.reconcileUnknownSend === true) {
    const supportedKinds = messageDurableFinal?.reconcileUnknownSendKinds;
    // Exact durable sends reject source batches before preparation. The sole
    // logical payload chooses one transport branch; captioned media is a media attempt.
    // Keep this resolver correct for independent batch callers: heterogeneous
    // batches require every concrete branch plus whole-batch reconciliation.
    const requiredKinds = params.requirements.batch
      ? unknownSendReconciliationKinds.filter((kind) => params.requirements?.[kind] === true)
      : unknownSendReconciliationKinds
          .toReversed()
          .filter((kind) => params.requirements?.[kind] === true)
          .slice(0, 1);
    if (
      supportedKinds !== undefined &&
      requiredKinds.some((requiredKind) => supportedKinds[requiredKind] !== true)
    ) {
      return {
        ok: false,
        reason: "capability_mismatch",
        capability: "reconcileUnknownSend",
      };
    }
  }

  return {
    ok: true,
    automaticUnknownSendReconciliation:
      messageDurableFinal?.automaticUnknownSendReconciliation === true,
  };
}

function createPluginHandler(
  params: ChannelHandlerParams & {
    outbound?: ChannelOutboundAdapter;
    message?: ChannelMessageAdapterShape;
  },
): ChannelHandler | null {
  const outbound = params.outbound;
  const messageText = params.message?.send?.text;
  const messageMedia = params.message?.send?.media;
  const messagePayload = params.message?.send?.payload;
  const messageLifecycle = params.message?.send?.lifecycle;
  const assertUnknownSendReconciliationKind = (kind: ChannelMessageSendAttemptKind): void => {
    const durableFinal = params.message?.durableFinal;
    if (
      !params.requiredUnknownSendReconciliation ||
      durableFinal?.capabilities?.reconcileUnknownSend !== true
    ) {
      return;
    }
    if (
      durableFinal.reconcileUnknownSendKinds !== undefined &&
      durableFinal.reconcileUnknownSendKinds[kind] !== true
    ) {
      throw new Error(
        `Required durable message send became unsupported after outbound transforms: ${kind} unknown-send reconciliation is unavailable for ${params.channel}`,
      );
    }
  };
  if (!messageText && !outbound?.sendText) {
    return null;
  }
  const baseCtx = createChannelOutboundContextBase(params);
  const sendText = outbound?.sendText;
  const sendMedia = outbound?.sendMedia;
  // Adapters may ignore the context callback; the core handoff must still fence
  // closed turn authority before transport code can run.
  const dispatchToAdapter = async <T>(
    route: PlatformSendRoute,
    send: () => Promise<T>,
  ): Promise<T> => {
    await params.onPlatformSendStart?.(route);
    await params.onDirectAdapterHandoff?.();
    // Keep the final authority check and adapter invocation in one synchronous
    // call stack. An awaited callback leaves a microtask gap where custody can
    // change after validation but before recipient-visible transport code runs.
    params.assertDirectAdapterHandoff?.();
    return await send();
  };
  // A prepared transport id identifies one atomic platform message. Splitting it
  // would either reuse the id or leave later chunks outside reply correlation.
  const chunker = baseCtx.preparedMessageId ? null : (outbound?.chunker ?? null);
  const chunkerMode = outbound?.chunkerMode;
  const onMessageDeliveryResult = params.onDeliveryResult
    ? async (result: ChannelMessageSendResult): Promise<void> => {
        await params.onDeliveryResult?.(normalizeChannelMessageSendResult(params.channel, result));
      }
    : undefined;
  const resolveCtx = (overrides?: OutboundMessageSendOverrides) => ({
    ...baseCtx,
    replyToId: overrides && "replyToId" in overrides ? overrides.replyToId : baseCtx.replyToId,
    replyToIdSource:
      overrides && "replyToIdSource" in overrides
        ? overrides.replyToIdSource
        : baseCtx.replyToIdSource,
    threadId: overrides && "threadId" in overrides ? overrides.threadId : baseCtx.threadId,
    audioAsVoice: overrides?.audioAsVoice,
    deliveryPartIndex: overrides?.deliveryPartIndex,
    deliveryPartCount: overrides?.deliveryPartCount,
    preparedMessageId:
      overrides?.deliveryPartIndex === undefined || overrides.deliveryPartIndex === 0
        ? baseCtx.preparedMessageId
        : undefined,
    formatting:
      overrides && "formatting" in overrides
        ? { ...baseCtx.formatting, ...overrides.formatting }
        : baseCtx.formatting,
  });
  const buildTargetRef = (overrides?: OutboundMessageSendOverrides): ChannelOutboundTargetRef => ({
    channel: params.channel,
    to: params.to,
    accountId: params.accountId ?? undefined,
    threadId: overrides?.threadId ?? baseCtx.threadId,
  });
  return {
    chunker,
    chunkerMode,
    chunkedTextFormatting: outbound?.chunkedTextFormatting,
    textChunkLimit: outbound?.textChunkLimit,
    preserveMarkdownDetails:
      outbound?.preserveMarkdownDetails?.({
        cfg: params.cfg,
        accountId: params.accountId,
      }) === true,
    // sendFormattedMedia is a first-class media sender (deliver-core prefers it
    // over sendMedia), so leaving it out here silently drops media for
    // formatted-only adapters and records the fallback as a plain sent text.
    supportsMedia: Boolean(messageMedia ?? sendMedia ?? outbound?.sendFormattedMedia),
    sanitizeText: outbound?.sanitizeText
      ? (payload) =>
          outbound.sanitizeText!({
            text: payload.text ?? "",
            payload,
            cfg: params.cfg,
            accountId: params.accountId,
          })
      : undefined,
    normalizePayload: outbound?.normalizePayload
      ? (payload) =>
          outbound.normalizePayload!({
            payload,
            cfg: params.cfg,
            accountId: params.accountId,
          })
      : undefined,
    normalizePayloadBatch: outbound?.normalizePayloadBatch
      ? (payloads) => {
          const normalized = outbound.normalizePayloadBatch!({
            payloads,
            cfg: params.cfg,
            accountId: params.accountId,
          });
          return payloads.flatMap((entry, index) => {
            const payload = normalized[index];
            return payload ? [{ ...entry, payload }] : [];
          });
        }
      : undefined,
    sendTextOnlyErrorPayloads: outbound?.sendTextOnlyErrorPayloads === true,
    presentationCapabilities: outbound?.resolvePresentationCapabilities
      ? outbound.resolvePresentationCapabilities({
          cfg: params.cfg,
          accountId: params.accountId,
          formatting: params.formatting,
        })
      : outbound?.presentationCapabilities,
    renderPresentation: outbound?.renderPresentation
      ? async (payload, sourcePresentation) => {
          // The delivery owner already normalized/adapted this; cloning drops fallback fragments.
          const presentation = payload.presentation;
          if (!presentation) {
            return payload;
          }
          const ctx: ChannelOutboundPayloadContext = {
            ...resolveCtx({
              replyToId: payload.replyToId ?? baseCtx.replyToId,
              threadId: baseCtx.threadId,
              audioAsVoice: payload.audioAsVoice,
            }),
            text: payload.text ?? "",
            mediaUrl: payload.mediaUrl,
            payload,
          };
          return await outbound.renderPresentation!({
            payload,
            presentation,
            sourcePresentation,
            ctx,
          });
        }
      : undefined,
    pinDeliveredMessage: outbound?.pinDeliveredMessage
      ? async ({ target, messageId, pin, gatewayClientScopes }) =>
          outbound.pinDeliveredMessage!({
            cfg: params.cfg,
            target,
            messageId,
            pin,
            gatewayClientScopes,
          })
      : undefined,
    afterDeliverPayload: outbound?.afterDeliverPayload
      ? async ({ target, payload, results }) =>
          outbound.afterDeliverPayload!({
            cfg: params.cfg,
            target,
            payload,
            results,
          })
      : undefined,
    adoptTargetFromDelivery: outbound?.adoptTargetFromDelivery
      ? ({ target, result }) =>
          outbound.adoptTargetFromDelivery!({
            cfg: params.cfg,
            target,
            result,
          })
      : undefined,
    shouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization
      ? (payload) => outbound.shouldSkipPlainTextSanitization!({ payload })
      : undefined,
    resolveEffectiveTextChunkLimit: outbound?.resolveEffectiveTextChunkLimit
      ? ({ fallbackLimit, formatting }) =>
          outbound.resolveEffectiveTextChunkLimit!({
            cfg: params.cfg,
            accountId: params.accountId ?? undefined,
            fallbackLimit,
            formatting,
          })
      : undefined,
    sendPayload:
      messagePayload || outbound?.sendPayload
        ? async (payload, overrides) => {
            const payloadCtx = {
              ...resolveCtx(overrides),
              kind: "payload" as const satisfies ChannelMessageSendAttemptKind,
              text: payload.text ?? "",
              mediaUrl: payload.mediaUrl,
              payload,
            };
            assertUnknownSendReconciliationKind("payload");
            if (messagePayload) {
              const messagePayloadCtx = {
                ...payloadCtx,
                onDeliveryResult: onMessageDeliveryResult,
              };
              const sent = await runChannelMessageSendWithLifecycle({
                lifecycle: messageLifecycle,
                ctx: messagePayloadCtx,
                send: () =>
                  dispatchToAdapter(messagePayloadCtx, () => messagePayload(messagePayloadCtx)),
              });
              return attachOutboundDeliveryCommitHook(
                normalizeChannelMessageSendResult(params.channel, sent.result),
                sent.afterCommit,
              );
            }
            return dispatchToAdapter(payloadCtx, () => outbound!.sendPayload!(payloadCtx));
          }
        : undefined,
    sendFormattedText: outbound?.sendFormattedText
      ? async (text, overrides) => {
          const formattedCtx = {
            ...resolveCtx(overrides),
            text,
          };
          assertUnknownSendReconciliationKind("text");
          return await dispatchToAdapter(formattedCtx, () =>
            outbound.sendFormattedText!(formattedCtx),
          );
        }
      : undefined,
    sendFormattedMedia: outbound?.sendFormattedMedia
      ? async (caption, mediaUrl, overrides) => {
          const formattedCtx = {
            ...resolveCtx(overrides),
            text: caption,
            mediaUrl,
          };
          assertUnknownSendReconciliationKind("media");
          return await dispatchToAdapter(formattedCtx, () =>
            outbound.sendFormattedMedia!(formattedCtx),
          );
        }
      : undefined,
    sendText: async (text, overrides) => {
      const textCtx = {
        ...resolveCtx(overrides),
        kind: "text" as const satisfies ChannelMessageSendAttemptKind,
        text,
      };
      assertUnknownSendReconciliationKind("text");
      if (messageText) {
        const messageTextCtx = { ...textCtx, onDeliveryResult: onMessageDeliveryResult };
        const sent = await runChannelMessageSendWithLifecycle({
          lifecycle: messageLifecycle,
          ctx: messageTextCtx,
          send: () => dispatchToAdapter(messageTextCtx, () => messageText(messageTextCtx)),
        });
        return attachOutboundDeliveryCommitHook(
          normalizeChannelMessageSendResult(params.channel, sent.result),
          sent.afterCommit,
        );
      }
      return dispatchToAdapter(textCtx, () => sendText!(textCtx));
    },
    buildTargetRef,
    sendMedia: async (caption, mediaUrl, overrides) => {
      const mediaCtx = {
        ...resolveCtx(overrides),
        kind: "media" as const satisfies ChannelMessageSendAttemptKind,
        text: caption,
        mediaUrl,
      };
      assertUnknownSendReconciliationKind("media");
      if (messageMedia) {
        const messageMediaCtx = { ...mediaCtx, onDeliveryResult: onMessageDeliveryResult };
        const sent = await runChannelMessageSendWithLifecycle({
          lifecycle: messageLifecycle,
          ctx: messageMediaCtx,
          send: () => dispatchToAdapter(messageMediaCtx, () => messageMedia(messageMediaCtx)),
        });
        return attachOutboundDeliveryCommitHook(
          normalizeChannelMessageSendResult(params.channel, sent.result),
          sent.afterCommit,
        );
      }
      if (sendMedia) {
        return dispatchToAdapter(mediaCtx, () => sendMedia(mediaCtx));
      }
      return dispatchToAdapter(mediaCtx, () => sendText!(mediaCtx));
    },
  };
}

function normalizeChannelMessageSendResult(
  channel: string,
  result: ChannelMessageSendResult,
): OutboundDeliveryResult {
  const source = result as ChannelMessageSendResult & Partial<OutboundDeliveryResult>;
  return {
    ...source,
    channel,
    messageId:
      source.messageId ??
      source.receipt.primaryPlatformMessageId ??
      source.receipt.platformMessageIds[0] ??
      "",
    receipt: source.receipt,
  };
}

const createChannelOutboundContextBase = (params: ChannelHandlerParams) => ({
  cfg: params.cfg,
  to: params.to,
  accountId: params.accountId,
  replyToId: params.replyToId,
  replyToIdSource: undefined,
  replyToMode: params.replyToMode,
  formatting: params.formatting,
  threadId: params.threadId,
  identity: params.identity,
  gifPlayback: params.gifPlayback,
  forceDocument: params.forceDocument,
  deps: params.deps,
  silent: params.silent,
  mediaAccess: params.mediaAccess,
  mediaLocalRoots: params.mediaAccess?.localRoots,
  mediaReadFile: params.mediaAccess?.readFile,
  gatewayClientScopes: params.gatewayClientScopes,
  conversationReadOrigin: params.conversationReadOrigin,
  deliveryQueueId: params.deliveryQueueId,
  preparedMessageId: params.preparedMessageId,
  assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
  onPlatformSendDispatch: params.onPlatformSendDispatch,
  onDeliveryResult: params.onDeliveryResult,
});
