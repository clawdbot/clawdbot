import type { SlackMonitorContext } from "../context.js";

export type SlackSystemEventHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

export type SlackSystemEventTestOverrides = {
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  channelType?: "im" | "channel";
  channelUsers?: string[];
  reactionMode?: "off" | "own" | "all" | "allowlist";
  reactionAllowlist?: Array<string | number>;
  userNames?: Record<string, string>;
};

export function createSlackSystemEventTestHarness(overrides?: SlackSystemEventTestOverrides) {
  const handlers: Record<string, SlackSystemEventHandler> = {};
  const channelType = overrides?.channelType ?? "im";
  const app = {
    event: (name: string, handler: SlackSystemEventHandler) => {
      handlers[name] = handler;
    },
  };
  const ctx = {
    app,
    runtime: { error: () => {} },
    botUserId: "U_BOT",
    botId: "B_BOT",
    dmEnabled: true,
    dmPolicy: overrides?.dmPolicy ?? "open",
    defaultRequireMention: true,
    channelsConfig: overrides?.channelUsers
      ? {
          C1: {
            users: overrides.channelUsers,
            enabled: true,
          },
        }
      : undefined,
    groupPolicy: "open",
    allowFrom: overrides?.allowFrom ?? [],
    allowNameMatching: false,
    reactionMode: overrides?.reactionMode ?? "all",
    reactionAllowlist: overrides?.reactionAllowlist ?? [],
    shouldDropMismatchedSlackEvent: () => false,
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({
      name: channelType === "im" ? "direct" : "general",
      type: channelType,
    }),
    resolveUserName: async (userId: string) => ({
      name: overrides?.userNames?.[userId] ?? "alice",
    }),
    resolveSlackSystemEventSessionKey: () => "agent:main:main",
  } as unknown as SlackMonitorContext;

  return {
    ctx,
    getHandler(name: string): SlackSystemEventHandler | null {
      return handlers[name] ?? null;
    },
  };
}
