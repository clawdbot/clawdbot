import type { ChannelHeartbeatDeps, ChannelPlugin } from "../channels/plugins/types.public.js";
import { createTypingCallbacks, type TypingCallbacks } from "../channels/typing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const DEFAULT_HEARTBEAT_TYPING_INTERVAL_SECONDS = 6;

type HeartbeatTypingLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
};

type HeartbeatTypingTarget = {
  channel: string;
  to?: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

export function createHeartbeatTypingCallbacks(params: {
  cfg: OpenClawConfig;
  target: HeartbeatTypingTarget;
  plugin?: Pick<ChannelPlugin, "heartbeat">;
  deps?: ChannelHeartbeatDeps;
  typingIntervalSeconds?: number;
  log?: HeartbeatTypingLogger;
}): TypingCallbacks | undefined {
  const sendTyping = params.plugin?.heartbeat?.sendTyping;
  const to = params.target.to?.trim();
  if (!sendTyping || !to) {
    return undefined;
  }

  const clearTyping = params.plugin?.heartbeat?.clearTyping;
  const keepaliveIntervalMs =
    typeof params.typingIntervalSeconds === "number" && params.typingIntervalSeconds > 0
      ? params.typingIntervalSeconds * 1000
      : DEFAULT_HEARTBEAT_TYPING_INTERVAL_SECONDS * 1000;
  const target = {
    cfg: params.cfg,
    to,
    ...(params.target.accountId !== undefined ? { accountId: params.target.accountId } : {}),
    ...(params.target.threadId !== undefined ? { threadId: params.target.threadId } : {}),
    ...(params.deps ? { deps: params.deps } : {}),
  };

  return createTypingCallbacks({
    start: async () => {
      await sendTyping(target);
    },
    ...(clearTyping
      ? {
          stop: async () => {
            await clearTyping(target);
          },
        }
      : {}),
    ...(keepaliveIntervalMs ? { keepaliveIntervalMs } : {}),
    onStartError: (err) => {
      params.log?.debug?.(`heartbeat typing failed for ${params.target.channel}`, {
        error: String(err),
        channel: params.target.channel,
        accountId: params.target.accountId,
      });
    },
  });
}
