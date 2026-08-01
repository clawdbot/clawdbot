// Operator commands for inspecting and resubmitting failed channel ingress events.
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { formatDurationHuman } from "../../infra/format-time/format-duration.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

type ChannelsDeadLettersOptions = {
  channel?: string;
  account?: string;
  limit?: string | number;
  json?: boolean;
};

function resolveScope(options: ChannelsDeadLettersOptions) {
  const channelId = options.channel?.trim();
  if (!channelId) {
    throw new Error("--channel is required.");
  }
  return { channelId, accountId: options.account?.trim() || "default" };
}

function parseLimit(value: unknown): number {
  const parsed = parseStrictPositiveInteger(value ?? "100");
  if (parsed === undefined) {
    throw new Error("--limit must be a positive integer.");
  }
  return parsed;
}

/** List retained ingress failures for one channel account. */
export async function channelsDeadLettersListCommand(
  options: ChannelsDeadLettersOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const { channelId, accountId } = resolveScope(options);
  const queue = createChannelIngressQueue({ channelId, accountId });
  if (!queue.listFailed) {
    throw new Error("This runtime does not support channel ingress dead-letter inspection.");
  }
  const deadLetters = await queue.listFailed({ limit: parseLimit(options.limit) });
  if (options.json) {
    writeRuntimeJson(runtime, { channelId, accountId, deadLetters });
    return;
  }
  runtime.log(theme.heading(`Channel ingress dead letters (${channelId}/${accountId})`));
  if (deadLetters.length === 0) {
    runtime.log(theme.muted("No dead-lettered ingress events."));
    return;
  }
  const now = Date.now();
  for (const entry of deadLetters) {
    const age = formatDurationHuman(Math.max(0, now - entry.failedAt));
    runtime.log(
      `- ${sanitizeTerminalText(entry.id)}: ${sanitizeTerminalText(entry.reason)}; attempts=${entry.attempts}; failed ${age} ago`,
    );
  }
}

/** Atomically return one retained ingress failure to its channel/account queue. */
export async function channelsDeadLettersResubmitCommand(
  eventId: string,
  options: ChannelsDeadLettersOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const { channelId, accountId } = resolveScope(options);
  const queue = createChannelIngressQueue({ channelId, accountId });
  if (!queue.resubmit) {
    throw new Error("This runtime does not support channel ingress dead-letter resubmission.");
  }
  const result = await queue.resubmit(eventId);
  if (result.kind === "resubmitted") {
    if (options.json) {
      writeRuntimeJson(runtime, { channelId, accountId, eventId, result });
    } else {
      runtime.log(
        `${theme.success("Resubmitted")} channel ingress event ${sanitizeTerminalText(eventId)} (${channelId}/${accountId}).`,
      );
    }
    return;
  }
  if (result.kind === "completed") {
    throw new Error(`Ingress event ${eventId} is completed and cannot be resubmitted.`);
  }
  if (result.kind === "active") {
    throw new Error(`Ingress event ${eventId} is already ${result.status}.`);
  }
  if (result.kind === "unrecoverable") {
    throw new Error(`Ingress event ${eventId} has no retained payload and cannot be resubmitted.`);
  }
  throw new Error(`Ingress event ${eventId} was not found for ${channelId}/${accountId}.`);
}
