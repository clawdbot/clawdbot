import { createHash } from "node:crypto";
import type {
  OpenClawCrablineInbound,
  OpenClawCrablineInboundInput,
  StartedOpenClawCrablineAdapter,
} from "@openclaw/crabline";
import type { QaBusInboundMessageInput } from "./runtime-api.js";

const TELEGRAM_QA_DRIVER_ID = "100001";
const TELEGRAM_QA_OBSERVER_ID = "100002";
const MATRIX_QA_SERVER_NAME = "matrix-qa.test";
const MATRIX_QA_DRIVER_ID = `@driver:${MATRIX_QA_SERVER_NAME}`;

export function resolveTelegramQaSenderId(senderId: string) {
  return senderId === "driver"
    ? TELEGRAM_QA_DRIVER_ID
    : senderId === "observer"
      ? TELEGRAM_QA_OBSERVER_ID
      : senderId;
}

function resolveMatrixQaSenderId(senderId: string) {
  return senderId === "driver"
    ? MATRIX_QA_DRIVER_ID
    : senderId === "observer"
      ? `@observer:${MATRIX_QA_SERVER_NAME}`
      : senderId;
}

function resolveMatrixQaConversationId(conversationId: string) {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    throw new Error("Matrix QA conversation id must be non-empty");
  }
  if (trimmed.startsWith("!") && trimmed.includes(":")) {
    return trimmed;
  }
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  return `!${digest}:${MATRIX_QA_SERVER_NAME}`;
}

function normalizeExplicitMatrixTarget(target: string) {
  let normalized = target.trim();
  for (const prefix of ["matrix:", "room:", "user:"]) {
    if (normalized.toLowerCase().startsWith(prefix)) {
      normalized = normalized.slice(prefix.length).trim();
    }
  }
  return /^[!@#]/u.test(normalized) && normalized.includes(":") ? normalized : undefined;
}

function encodeQaThreadComponent(value: string) {
  return value.replaceAll("%", "%25").replaceAll("/", "%2F");
}

function resolveMatrixQaTarget(target: string) {
  const explicitTarget = normalizeExplicitMatrixTarget(target);
  if (explicitTarget) {
    return explicitTarget;
  }
  if (target.startsWith("thread:")) {
    if (target.startsWith("thread:/v1/")) {
      const rest = target.slice("thread:/v1/".length);
      const separator = rest.indexOf("/");
      if (separator > 0) {
        try {
          const conversationId = decodeURIComponent(rest.slice(0, separator));
          const resolvedConversationId =
            normalizeExplicitMatrixTarget(conversationId) ??
            resolveMatrixQaConversationId(conversationId);
          return `thread:/v1/${encodeQaThreadComponent(resolvedConversationId)}${rest.slice(separator)}`;
        } catch {
          return target;
        }
      }
    }
    const threadTarget = target.slice("thread:".length);
    const separator = threadTarget.indexOf("/");
    if (separator > 0) {
      const conversationId = threadTarget.slice(0, separator);
      const resolvedConversationId =
        normalizeExplicitMatrixTarget(conversationId) ??
        resolveMatrixQaConversationId(conversationId);
      return `thread:${resolvedConversationId}${threadTarget.slice(separator)}`;
    }
  }
  for (const prefix of ["channel:", "group:", "dm:"]) {
    if (target.startsWith(prefix)) {
      const conversationId = target.slice(prefix.length);
      const resolvedConversationId =
        normalizeExplicitMatrixTarget(conversationId) ??
        resolveMatrixQaConversationId(conversationId);
      return `${prefix}${resolvedConversationId}`;
    }
  }
  return resolveMatrixQaConversationId(target);
}

function resolveMatrixQaText(text: string, botUserId: string) {
  return text.replace(
    /(^|[\s([{])@openclaw(?=$|[\s.,!?;)\]}])/gu,
    (_match, prefix: string) => `${prefix}${botUserId}`,
  );
}

export function createCrablineProviderInboundInput(
  adapter: StartedOpenClawCrablineAdapter,
  input: QaBusInboundMessageInput,
): OpenClawCrablineInboundInput {
  const kind = input.conversation.kind === "direct" ? "direct" : "group";
  return {
    ...input,
    conversation: {
      ...input.conversation,
      id:
        adapter.channel === "matrix"
          ? resolveMatrixQaConversationId(input.conversation.id)
          : input.conversation.id,
      kind,
    },
    senderId:
      adapter.channel === "telegram"
        ? resolveTelegramQaSenderId(input.senderId)
        : adapter.channel === "matrix"
          ? resolveMatrixQaSenderId(input.senderId)
          : input.senderId,
    text:
      adapter.channel === "matrix" && adapter.manifest.provider === "matrix"
        ? resolveMatrixQaText(input.text, adapter.manifest.botUserId)
        : input.text,
  };
}

export function resolveCrablineStateConversation(params: {
  adapter: StartedOpenClawCrablineAdapter;
  input: QaBusInboundMessageInput;
  providerInbound: OpenClawCrablineInbound;
}) {
  return params.adapter.channel === "matrix"
    ? params.input.conversation
    : params.providerInbound.stateConversation;
}

export function createCrablineProviderDelivery(
  adapter: StartedOpenClawCrablineAdapter,
  target: string,
) {
  const delivery = adapter.createAgentDelivery({
    target: adapter.channel === "matrix" ? resolveMatrixQaTarget(target) : target,
  });
  return {
    delivery,
    providerTargetKey:
      adapter.channel === "matrix" ? delivery.to.replace(/^room:/u, "") : delivery.to,
  };
}
