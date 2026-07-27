// Normalizes payloads and applies post-send presentation/media effects.
import type { ReplyPayload } from "../../auto-reply/types.js";
import { adaptMessagePresentationForChannel } from "../../channels/plugins/outbound/interactive.js";
import type { ChannelOutboundTargetRef } from "../../channels/plugins/types.adapters.js";
import {
  hasReplyPayloadContent,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  type ReplyPayloadDeliveryPin,
} from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { diagnosticErrorCategory } from "../diagnostic-error-metadata.js";
import {
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  type DiagnosticMessageDeliveryKind,
} from "../diagnostic-events.js";
import { formatErrorMessage } from "../errors.js";
import type {
  ChannelHandler,
  DeliverOutboundPayloadsCoreParams,
  NormalizedPayloadForChannelDelivery,
} from "./deliver-contracts.js";
import type { OutboundDeliveryResult, OutboundPayloadDeliveryKind } from "./deliver-types.js";
import type { DeliveryMirror } from "./mirror.js";
import {
  summarizeOutboundPayloadForTransport,
  type NormalizedOutboundPayload,
  type OutboundPayloadPlan,
} from "./payloads.js";
import { stripInternalRuntimeScaffolding } from "./protocol-scaffolding.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

const log = createSubsystemLogger("outbound/deliver");

export function sessionKeyForDeliveryDiagnostics(params: {
  mirror?: DeliveryMirror;
  session?: OutboundSessionContext;
}): string | undefined {
  return params.mirror?.sessionKey ?? params.session?.key ?? params.session?.policyKey;
}

export function deliveryKindForPayload(
  payload: ReplyPayload,
  payloadSummary: NormalizedOutboundPayload,
): OutboundPayloadDeliveryKind {
  if (payloadSummary.mediaUrls.length > 0 || payload.mediaUrl || payload.mediaUrls?.length) {
    return "media";
  }
  if (payload.presentation || payload.interactive || payload.channelData || payload.audioAsVoice) {
    return "other";
  }
  return "text";
}

export function emitMessageDeliveryStarted(params: {
  channel: Exclude<OutboundChannel, "none">;
  deliveryKind: DiagnosticMessageDeliveryKind;
  sessionKey?: string;
}): void {
  emitDiagnosticEvent({
    type: "message.delivery.started",
    channel: params.channel,
    deliveryKind: params.deliveryKind,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitMessageDeliveryCompleted(params: {
  channel: Exclude<OutboundChannel, "none">;
  deliveryKind: DiagnosticMessageDeliveryKind;
  durationMs: number;
  resultCount: number;
  sessionKey?: string;
}): void {
  emitDiagnosticEvent({
    type: "message.delivery.completed",
    channel: params.channel,
    deliveryKind: params.deliveryKind,
    durationMs: params.durationMs,
    resultCount: params.resultCount,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitMessageDeliveryError(params: {
  channel: Exclude<OutboundChannel, "none">;
  deliveryKind: DiagnosticMessageDeliveryKind;
  durationMs: number;
  error: unknown;
  sessionKey?: string;
}): void {
  emitDiagnosticEvent({
    type: "message.delivery.error",
    channel: params.channel,
    deliveryKind: params.deliveryKind,
    durationMs: params.durationMs,
    errorCategory: diagnosticErrorCategory(params.error),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function normalizeEmptyPayloadForDelivery(payload: ReplyPayload): ReplyPayload | null {
  const text = typeof payload.text === "string" ? payload.text : "";
  if (!text.trim()) {
    if (!hasReplyPayloadContent({ ...payload, text }, { extraContent: payload.location != null })) {
      return null;
    }
    if (text) {
      return {
        ...payload,
        text: "",
      };
    }
  }
  return payload;
}

export function normalizePayloadsForChannelDelivery(
  plan: readonly OutboundPayloadPlan[],
  handler: ChannelHandler,
): NormalizedPayloadForChannelDelivery[] {
  const normalizedPayloads: NormalizedPayloadForChannelDelivery[] = [];
  for (const entry of plan) {
    let sanitizedPayload = stripInternalRuntimeScaffoldingFromPayload(entry.payload);
    if (handler.sanitizeText && sanitizedPayload.text) {
      if (!handler.shouldSkipPlainTextSanitization?.(sanitizedPayload)) {
        sanitizedPayload = {
          ...sanitizedPayload,
          text: handler.sanitizeText(sanitizedPayload),
        };
      }
    }
    const normalizedPayload = handler.normalizePayload
      ? handler.normalizePayload(sanitizedPayload)
      : sanitizedPayload;
    const normalized = normalizedPayload
      ? normalizeEmptyPayloadForDelivery(
          stripInternalRuntimeScaffoldingFromPayload(normalizedPayload),
        )
      : null;
    if (normalized) {
      normalizedPayloads.push({ index: entry.sourceIndex, payload: normalized });
    }
  }
  return handler.normalizePayloadBatch
    ? handler.normalizePayloadBatch(normalizedPayloads)
    : normalizedPayloads;
}

function stripInternalRuntimeScaffoldingFromValue(value: unknown): unknown {
  if (typeof value === "string") {
    return stripInternalRuntimeScaffolding(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const stripped = stripInternalRuntimeScaffoldingFromValue(entry);
      changed ||= stripped !== entry;
      return stripped;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const stripped = stripInternalRuntimeScaffoldingFromValue(entry);
    changed ||= stripped !== entry;
    next[key] = stripped;
  }
  return changed ? next : value;
}

/** Every media reference a payload set carries, in payload order. */
export function collectPayloadMediaSources(payloads: readonly ReplyPayload[]): string[] {
  return payloads.flatMap((payload) => [
    ...(typeof payload.mediaUrl === "string" && payload.mediaUrl.trim() ? [payload.mediaUrl] : []),
    ...(payload.mediaUrls ?? []).filter((url) => typeof url === "string" && url.trim()),
  ]);
}

/**
 * Resolves the media read capability for one send. Queue staging and the live
 * send must resolve it identically: staging copies exactly the bytes the send is
 * already allowed to read, so a narrower gate here would reject media the send
 * would have delivered, and a wider one would widen read authority.
 */
export function resolveOutboundMediaAccessForSend(
  params: DeliverOutboundPayloadsCoreParams,
  channel: string,
  mediaSources: readonly string[],
): OutboundMediaAccess {
  if (mediaSources.length === 0) {
    return params.mediaAccess ?? {};
  }
  return resolveAgentScopedOutboundMediaAccess({
    cfg: params.cfg,
    agentId: params.session?.agentId ?? params.mirror?.agentId,
    mediaSources,
    mediaAccess: params.mediaAccess,
    sessionKey: params.session?.policyKey ?? params.session?.key,
    messageProvider: params.session?.key ? undefined : channel,
    accountId: params.session?.requesterAccountId ?? params.accountId,
    requesterSenderId: params.session?.requesterSenderId,
    requesterSenderName: params.session?.requesterSenderName,
    requesterSenderUsername: params.session?.requesterSenderUsername,
    requesterSenderE164: params.session?.requesterSenderE164,
  });
}

export function stripInternalRuntimeScaffoldingFromPayload(payload: ReplyPayload): ReplyPayload {
  const stripped = stripInternalRuntimeScaffoldingFromValue(payload);
  return stripped && typeof stripped === "object" && !Array.isArray(stripped)
    ? (stripped as ReplyPayload)
    : payload;
}

export function buildPayloadSummary(payload: ReplyPayload): NormalizedOutboundPayload {
  return summarizeOutboundPayloadForTransport(payload);
}

export function hasDeliveryResultIdentity(result: OutboundDeliveryResult): boolean {
  return Boolean(
    result.messageId ||
    result.chatId ||
    result.channelId ||
    result.roomId ||
    result.conversationId ||
    result.toJid ||
    result.pollId,
  );
}

function normalizeDeliveryPin(payload: ReplyPayload): ReplyPayloadDeliveryPin | undefined {
  const pin = payload.delivery?.pin;
  if (pin === true) {
    return { enabled: true };
  }
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
    return undefined;
  }
  if (!pin.enabled) {
    return undefined;
  }
  const normalized: ReplyPayloadDeliveryPin = { enabled: true };
  if (pin.notify === true) {
    normalized.notify = true;
  }
  if (pin.required === true) {
    normalized.required = true;
  }
  return normalized;
}

export async function maybePinDeliveredMessage(params: {
  handler: ChannelHandler;
  payload: ReplyPayload;
  target: ChannelOutboundTargetRef;
  messageId?: string;
  gatewayClientScopes?: readonly string[];
}): Promise<void> {
  const pin = normalizeDeliveryPin(params.payload);
  if (!pin) {
    return;
  }
  if (!params.messageId) {
    if (pin.required) {
      throw new Error("Delivery pin requested, but no delivered message id was returned.");
    }
    log.warn("Delivery pin requested, but no delivered message id was returned.", {
      channel: params.target.channel,
      to: params.target.to,
    });
    return;
  }
  if (!params.handler.pinDeliveredMessage) {
    if (pin.required) {
      throw new Error(`Delivery pin is not supported by channel: ${params.target.channel}`);
    }
    log.warn("Delivery pin requested, but channel does not support pinning delivered messages.", {
      channel: params.target.channel,
      to: params.target.to,
    });
    return;
  }
  try {
    await params.handler.pinDeliveredMessage({
      target: params.target,
      messageId: params.messageId,
      pin,
      gatewayClientScopes: params.gatewayClientScopes,
    });
  } catch (err) {
    if (pin.required) {
      throw err;
    }
    log.warn("Delivery pin requested, but channel failed to pin delivered message.", {
      channel: params.target.channel,
      to: params.target.to,
      messageId: params.messageId,
      error: formatErrorMessage(err),
    });
  }
}

export async function maybeNotifyAfterDeliveredPayload(params: {
  handler: ChannelHandler;
  payload: ReplyPayload;
  target: ChannelOutboundTargetRef;
  results: readonly OutboundDeliveryResult[];
}): Promise<void> {
  if (!params.handler.afterDeliverPayload || params.results.length === 0) {
    return;
  }
  try {
    await params.handler.afterDeliverPayload({
      target: params.target,
      payload: params.payload,
      results: params.results,
    });
  } catch (err) {
    log.warn("Plugin outbound adapter after-delivery hook failed.", {
      channel: params.target.channel,
      to: params.target.to,
      error: formatErrorMessage(err),
    });
  }
}

export async function renderPresentationForDelivery(
  handler: ChannelHandler,
  payload: ReplyPayload,
): Promise<ReplyPayload> {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  const adaptedPresentation = adaptMessagePresentationForChannel({
    presentation,
    capabilities: handler.presentationCapabilities,
  });
  const textIsFallback = payload.presentationTextMode === "fallback";
  const adaptedPayload = {
    ...payload,
    ...(textIsFallback ? { text: undefined } : {}),
    presentation: adaptedPresentation,
  };
  const rendered = handler.renderPresentation
    ? await handler.renderPresentation(adaptedPayload)
    : null;
  if (rendered) {
    const {
      presentation: _presentation,
      presentationTextMode: _presentationTextMode,
      ...withoutPresentation
    } = rendered;
    return withoutPresentation;
  }
  const {
    presentation: _presentation,
    presentationTextMode: _presentationTextMode,
    ...withoutPresentation
  } = payload;
  return {
    ...withoutPresentation,
    text: textIsFallback
      ? (payload.text ??
        renderMessagePresentationFallbackText({ presentation: adaptedPresentation }))
      : renderMessagePresentationFallbackText({
          text: payload.text,
          presentation: adaptedPresentation,
        }),
  };
}
