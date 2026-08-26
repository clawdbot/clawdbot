import { createHash } from "node:crypto";
import type {
  OpenClawCrablineInbound,
  OpenClawCrablineInboundInput,
  StartedOpenClawCrablineAdapter,
  StartedOpenClawCrablineCorrelatedAdapter,
} from "@openclaw/crabline";
import type { QaBusInboundMessageInput } from "./runtime-api.js";

const TELEGRAM_QA_DRIVER_ID = "100001";
const TELEGRAM_QA_OBSERVER_ID = "100002";
const TELEGRAM_QA_ID_RANGE = 4_000_000_000_000_000n;
const TELEGRAM_QA_MAX_NATIVE_ID = (1n << 52n) - 1n;
const MATTERMOST_ID_PATTERN = /^[a-z0-9]{26}$/u;
const MATRIX_QA_SERVER_NAME = "matrix-qa.test";
const MATRIX_QA_DRIVER_ID = `@driver:${MATRIX_QA_SERVER_NAME}`;
const DISCORD_ID_PATTERN = /^\d{17,20}$/u;
const DISCORD_ID_FLOOR = 100_000_000_000_000_000n;

export function resolveDiscordQaId(value: string) {
  const trimmed = value.trim();
  if (DISCORD_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const digest = BigInt(`0x${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`);
  return String(DISCORD_ID_FLOOR + (digest % DISCORD_ID_FLOOR));
}

function resolveQaNumericId(value: string, range: bigint) {
  const digest = BigInt(`0x${createHash("sha256").update(value).digest("hex").slice(0, 16)}`);
  return 1n + (digest % range);
}

function resolveTelegramQaConversationId(value: string, kind: "direct" | "group") {
  const trimmed = value.trim();
  if (/^-?\d+$/u.test(trimmed)) {
    const numeric = BigInt(trimmed);
    if (
      numeric !== 0n &&
      numeric >= -TELEGRAM_QA_MAX_NATIVE_ID &&
      numeric <= TELEGRAM_QA_MAX_NATIVE_ID &&
      (kind === "direct" ? numeric > 0n : numeric < 0n)
    ) {
      return numeric.toString();
    }
  }
  const numeric = resolveQaNumericId(`${kind}:${trimmed}`, TELEGRAM_QA_ID_RANGE);
  return String(kind === "direct" ? numeric : -numeric);
}

function resolveMattermostQaId(value: string) {
  const trimmed = value.trim();
  return MATTERMOST_ID_PATTERN.test(trimmed)
    ? trimmed
    : createHash("sha256").update(trimmed).digest("hex").slice(0, 26);
}

export function resolveTelegramQaSenderId(senderId: string) {
  return senderId === "driver"
    ? TELEGRAM_QA_DRIVER_ID
    : senderId === "observer"
      ? TELEGRAM_QA_OBSERVER_ID
      : resolveTelegramQaConversationId(senderId, "direct");
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

function resolveDiscordQaText(text: string, botUserId: string) {
  return text.replace(
    /(^|[\s([{])@openclaw(?=$|[\s.,!?;)\]}])/gu,
    (_match, prefix: string) => `${prefix}<@${botUserId}>`,
  );
}

function resolveDiscordQaTarget(target: string) {
  const normalized = target.trim();
  if (normalized.startsWith("thread:")) {
    const threadTarget = normalized.slice("thread:".length);
    const separator = threadTarget.indexOf("/");
    if (separator > 0) {
      return `thread:${resolveDiscordQaId(threadTarget.slice(0, separator))}/${resolveDiscordQaId(threadTarget.slice(separator + 1))}`;
    }
  }
  for (const prefix of ["channel:", "group:", "dm:", "user:"]) {
    if (normalized.startsWith(prefix)) {
      return `${prefix}${resolveDiscordQaId(normalized.slice(prefix.length))}`;
    }
  }
  return resolveDiscordQaId(normalized);
}

function resolveTelegramQaTarget(target: string) {
  const normalized = target.trim();
  if (normalized.startsWith("thread:")) {
    const threadTarget = normalized.slice("thread:".length);
    const separator = threadTarget.indexOf("/");
    if (separator > 0) {
      return `thread:${resolveTelegramQaConversationId(threadTarget.slice(0, separator), "group")}/${threadTarget.slice(separator + 1)}`;
    }
  }
  for (const prefix of ["channel:", "group:"]) {
    if (normalized.startsWith(prefix)) {
      return `${prefix}${resolveTelegramQaConversationId(normalized.slice(prefix.length), "group")}`;
    }
  }
  for (const prefix of ["dm:", "user:"]) {
    if (normalized.startsWith(prefix)) {
      return `dm:${resolveTelegramQaConversationId(normalized.slice(prefix.length), "direct")}`;
    }
  }
  return resolveTelegramQaConversationId(normalized, "direct");
}

function resolveMattermostQaTarget(target: string) {
  const normalized = target.trim();
  if (normalized.startsWith("thread:")) {
    const threadTarget = normalized.slice("thread:".length);
    const separator = threadTarget.indexOf("/");
    if (separator > 0) {
      return `thread:${resolveMattermostQaId(threadTarget.slice(0, separator))}/${resolveMattermostQaId(threadTarget.slice(separator + 1))}`;
    }
  }
  for (const prefix of ["channel:", "group:", "dm:", "user:"]) {
    if (normalized.startsWith(prefix)) {
      return `${prefix}${resolveMattermostQaId(normalized.slice(prefix.length))}`;
    }
  }
  return resolveMattermostQaId(normalized);
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
        adapter.channel === "telegram"
          ? resolveTelegramQaConversationId(input.conversation.id, kind)
          : adapter.channel === "matrix"
            ? resolveMatrixQaConversationId(input.conversation.id)
            : adapter.channel === "mattermost"
              ? resolveMattermostQaId(input.conversation.id)
              : adapter.channel === "discord"
                ? resolveDiscordQaId(input.conversation.id)
                : input.conversation.id,
      kind,
    },
    senderId:
      adapter.channel === "telegram"
        ? resolveTelegramQaSenderId(input.senderId)
        : adapter.channel === "matrix"
          ? resolveMatrixQaSenderId(input.senderId)
          : adapter.channel === "mattermost"
            ? resolveMattermostQaId(input.senderId)
            : adapter.channel === "discord"
              ? resolveDiscordQaId(input.senderId)
              : input.senderId,
    text:
      adapter.channel === "matrix" && adapter.manifest.provider === "matrix"
        ? resolveMatrixQaText(input.text, adapter.manifest.botUserId)
        : adapter.channel === "discord" && adapter.manifest.provider === "discord"
          ? resolveDiscordQaText(input.text, adapter.manifest.botUserId)
          : input.text,
    ...(input.threadId && adapter.channel === "discord"
      ? { threadId: resolveDiscordQaId(input.threadId) }
      : {}),
  };
}

export function resolveCrablineStateConversation(params: {
  adapter: StartedOpenClawCrablineAdapter;
  input: QaBusInboundMessageInput;
  providerInbound: OpenClawCrablineInbound;
}) {
  return ["discord", "mattermost", "matrix", "telegram"].includes(params.adapter.channel)
    ? params.input.conversation
    : params.providerInbound.stateConversation;
}

export function createCrablineProviderDelivery(
  adapter: StartedOpenClawCrablineCorrelatedAdapter,
  target: string,
) {
  const { providerTargetKey, ...delivery } = adapter.createAgentDelivery({
    target:
      adapter.channel === "telegram"
        ? resolveTelegramQaTarget(target)
        : adapter.channel === "matrix"
          ? resolveMatrixQaTarget(target)
          : adapter.channel === "mattermost"
            ? resolveMattermostQaTarget(target)
            : adapter.channel === "discord"
              ? resolveDiscordQaTarget(target)
              : target,
  });
  return { delivery, providerTargetKey };
}
