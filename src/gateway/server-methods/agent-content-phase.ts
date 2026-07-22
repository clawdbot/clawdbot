import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveExplicitAgentSessionKey,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatUncaughtError } from "../../infra/errors.js";
import {
  loadVoiceWakeRoutingConfig,
  resolveVoiceWakeRouteByTrigger,
} from "../../infra/voicewake-routing.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import {
  classifySessionKeyShape,
  isAcpSessionKey,
  normalizeAgentId,
} from "../../routing/session-key.js";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import {
  isGatewayMessageChannel,
  isInternalNonDeliveryChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  MediaOffloadError,
  parseMessageWithAttachments,
  resolveChatAttachmentMaxBytes,
  type ChatAttachment,
} from "../chat-attachments.js";
import {
  loadSessionEntry,
  resolveGatewayModelSupportsImages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ExplicitRecipientSession = Awaited<
  ReturnType<
    typeof import("../../infra/outbound/agent-delivery.js").resolveAgentExplicitRecipientSession
  >
>;

type AgentContentPhaseResult = {
  agentId?: string;
  requestedSessionKey?: string;
  effectiveTranscriptInputText: string;
  message: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  imageOrder: PromptImageOrderEntry[];
  media: MediaFact[];
  replyTo: string;
  recipientChannel?: string;
  recipientAccountId?: string;
  recipientThreadId?: string | number;
  to: string;
};

function formatAttachmentFailureForLog(err: unknown): string {
  const primary = formatUncaughtError(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) {
    return primary;
  }
  const causeText = formatUncaughtError(cause);
  return !causeText || causeText === primary ? primary : `${primary}\nCaused by: ${causeText}`;
}

function logAttachmentFailure(
  logGateway: Pick<GatewayRequestHandlerOptions["context"]["logGateway"], "error">,
  label: string,
  err: unknown,
): void {
  logGateway.error(label, {
    error: formatAttachmentFailureForLog(err),
    consoleMessage: `${label}: ${formatForLog(err)}`,
  });
}

export async function prepareAgentContentPhase(params: {
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  context: GatewayRequestHandlerOptions["context"];
  respond: GatewayRequestHandlerOptions["respond"];
  isRawModelRun: boolean;
  inputProvenance?: InputProvenance;
  normalizedAttachments: ChatAttachment[];
  requestedSessionKeyRaw?: string;
  requestedSessionKey?: string;
  requestedSessionId?: string;
  requestedToRaw?: string;
  sessionKeyFromTo?: string;
  agentId?: string;
  providerOverride?: string;
  modelOverride?: string;
  explicitRecipientSession?: ExplicitRecipientSession;
  knownAgents: string[];
}): Promise<AgentContentPhaseResult | undefined> {
  const transcriptInputText = (params.request.message ?? "").trim();
  let message = params.isRawModelRun
    ? transcriptInputText
    : annotateInterSessionPromptText(transcriptInputText, params.inputProvenance);
  let images: AgentContentPhaseResult["images"] = [];
  let imageOrder: PromptImageOrderEntry[] = [];
  let media: MediaFact[] = [];
  let agentId = params.agentId;
  let requestedSessionKey = params.requestedSessionKey;

  if (params.normalizedAttachments.length > 0) {
    let baseProvider: string | undefined;
    let baseModel: string | undefined;
    let requestedAcpMeta: ReturnType<typeof readAcpSessionMeta>;
    if (params.requestedSessionKeyRaw) {
      const { cfg, entry, canonicalKey } = loadSessionEntry(params.requestedSessionKeyRaw, {
        ...(agentId ? { agentId } : {}),
        clone: false,
      });
      const sessionAgentId =
        canonicalKey === "global" && agentId ? agentId : resolveAgentIdFromSessionKey(canonicalKey);
      const modelRef = resolveSessionModelRef(cfg, entry, sessionAgentId);
      baseProvider = modelRef.provider;
      baseModel = modelRef.model;
      requestedAcpMeta = readAcpSessionMeta({ sessionKey: canonicalKey });
    }
    const isConfirmedAcpSession =
      params.request.acpTurnSource === "manual_spawn" &&
      isAcpSessionKey(params.requestedSessionKeyRaw) &&
      requestedAcpMeta != null;
    const supportsInlineImages = isConfirmedAcpSession
      ? true
      : await resolveGatewayModelSupportsImages({
          loadGatewayModelCatalog: params.context.loadGatewayModelCatalog,
          provider: params.providerOverride || baseProvider,
          model: params.modelOverride || baseModel,
        });
    try {
      const parsed = await parseMessageWithAttachments(message, params.normalizedAttachments, {
        maxBytes: resolveChatAttachmentMaxBytes(params.cfg),
        log: params.context.logGateway,
        supportsInlineImages,
        acceptNonImage: false,
      });
      message = parsed.message.trim();
      images = parsed.images;
      imageOrder = parsed.imageOrder;
      media = parsed.media;
    } catch (err) {
      logAttachmentFailure(params.context.logGateway, "agent attachment parse failed", err);
      params.respond(
        false,
        undefined,
        errorShape(
          err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
          String(err),
        ),
      );
      return undefined;
    }
  }

  const isKnownGatewayChannel = (value: string): boolean =>
    isGatewayMessageChannel(value) || isInternalNonDeliveryChannel(value);
  const channelHints = normalizeStringEntries(
    [params.request.channel, params.request.replyChannel].filter(
      (value): value is string => typeof value === "string",
    ),
  );
  for (const rawChannel of channelHints) {
    const normalized = normalizeMessageChannel(rawChannel);
    if (normalized && normalized !== "last" && !isKnownGatewayChannel(normalized)) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: unknown channel: ${normalized}`,
        ),
      );
      return undefined;
    }
  }

  const voiceWakeTrigger = normalizeOptionalString(params.request.voiceWakeTrigger) ?? "";
  const replyTo = normalizeOptionalString(params.request.replyTo) ?? "";
  const recipientChannel = params.explicitRecipientSession?.channel ?? params.request.channel;
  const recipientAccountId = params.explicitRecipientSession?.accountId ?? params.request.accountId;
  const recipientThreadId = params.explicitRecipientSession?.threadId ?? params.request.threadId;
  const to = params.sessionKeyFromTo
    ? ""
    : (params.explicitRecipientSession?.to ?? params.requestedToRaw ?? "");
  const explicitVoiceWakeSessionTarget =
    !agentId && params.requestedSessionKeyRaw
      ? (() => {
          const { cfg, canonicalKey } = loadSessionEntry(params.requestedSessionKeyRaw!, {
            clone: false,
          });
          const routedAgentId = resolveAgentIdFromSessionKey(canonicalKey);
          const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
          if (routedAgentId !== defaultAgentId) {
            return true;
          }
          return canonicalKey !== resolveAgentMainSessionKey({ cfg, agentId: routedAgentId });
        })()
      : false;
  const canAutoRouteVoiceWake =
    !agentId && !explicitVoiceWakeSessionTarget && !params.requestedSessionId && !replyTo && !to;
  if (Object.hasOwn(params.request, "voiceWakeTrigger") && canAutoRouteVoiceWake) {
    try {
      const route = resolveVoiceWakeRouteByTrigger({
        trigger: voiceWakeTrigger || undefined,
        config: await loadVoiceWakeRoutingConfig(),
      });
      if ("agentId" in route) {
        if (params.knownAgents.includes(route.agentId)) {
          agentId = route.agentId;
          requestedSessionKey = resolveExplicitAgentSessionKey({ cfg: params.cfg, agentId });
        } else {
          params.context.logGateway.warn(
            `voicewake routing ignored unknown agentId="${route.agentId}" trigger="${voiceWakeTrigger}"`,
          );
        }
      } else if ("sessionKey" in route) {
        if (classifySessionKeyShape(route.sessionKey) !== "malformed_agent") {
          const canonicalKey = loadSessionEntry(route.sessionKey, { clone: false }).canonicalKey;
          const routedAgentId = resolveAgentIdFromSessionKey(canonicalKey);
          if (params.knownAgents.includes(routedAgentId)) {
            requestedSessionKey = canonicalKey;
            agentId = routedAgentId;
          } else {
            params.context.logGateway.warn(
              `voicewake routing ignored unknown session agent="${routedAgentId}" sessionKey="${canonicalKey}" trigger="${voiceWakeTrigger}"`,
            );
          }
        } else {
          params.context.logGateway.warn(
            `voicewake routing ignored malformed sessionKey="${route.sessionKey}" trigger="${voiceWakeTrigger}"`,
          );
        }
      }
    } catch (err) {
      params.context.logGateway.warn(`voicewake routing load failed: ${formatForLog(err)}`);
    }
  }

  return {
    agentId,
    requestedSessionKey,
    effectiveTranscriptInputText: transcriptInputText,
    message,
    images,
    imageOrder,
    media,
    replyTo,
    recipientChannel,
    recipientAccountId,
    recipientThreadId,
    to,
  };
}
