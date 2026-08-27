import type { ModelRef } from "../agents/model-ref-shared.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";

type TurnModelSelectionSource =
  | "locked"
  | "explicit"
  | "heartbeat"
  | "session"
  | "parent"
  | "channel"
  | "default";

export type TurnModelSelectionVerdict = ModelRef & { source: TurnModelSelectionSource };
export type TurnModelSelectionPath = "reply" | "status" | "harness" | "command";

export const TURN_MODEL_DEFAULT_REF = { provider: "openai", model: "default-model" } as const;
export const TURN_MODEL_CHANNEL_REF = {
  provider: "anthropic",
  model: "channel-model",
} as const;
export const TURN_MODEL_SESSION_REF = { provider: "google", model: "session-model" } as const;
const TURN_MODEL_PARENT_REF = { provider: "xai", model: "parent-model" } as const;
export const TURN_MODEL_OVERRIDE_REF = { provider: "mistral", model: "turn-model" } as const;
const TURN_MODEL_LOCKED_REF = { provider: "cohere", model: "locked-model" } as const;
export const TURN_MODEL_PERSISTED_CHANNEL_REF = {
  provider: "anthropic",
  model: "persisted-channel-model",
} as const;
export const TURN_MODEL_LIVE_CHANNEL_REF = {
  provider: "google",
  model: "live-channel-model",
} as const;
export const TURN_MODEL_PERSISTED_PEER_REF = {
  provider: "xai",
  model: "persisted-peer-model",
} as const;
const TURN_MODEL_LIVE_PEER_REF = {
  provider: "mistral",
  model: "live-peer-model",
} as const;
const TURN_MODEL_COMMAND_STALE_PEER_REF = {
  provider: "cohere",
  model: "command-stale-peer-model",
} as const;

export function turnModelRefLabel(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

const SOURCE_BY_REF = new Map<string, TurnModelSelectionSource>([
  [turnModelRefLabel(TURN_MODEL_DEFAULT_REF), "default"],
  [turnModelRefLabel(TURN_MODEL_CHANNEL_REF), "channel"],
  [turnModelRefLabel(TURN_MODEL_SESSION_REF), "session"],
  [turnModelRefLabel(TURN_MODEL_PARENT_REF), "parent"],
  [turnModelRefLabel(TURN_MODEL_OVERRIDE_REF), "heartbeat"],
  [turnModelRefLabel(TURN_MODEL_LOCKED_REF), "locked"],
  [turnModelRefLabel(TURN_MODEL_PERSISTED_CHANNEL_REF), "channel"],
  [turnModelRefLabel(TURN_MODEL_LIVE_CHANNEL_REF), "channel"],
  [turnModelRefLabel(TURN_MODEL_PERSISTED_PEER_REF), "channel"],
  [turnModelRefLabel(TURN_MODEL_LIVE_PEER_REF), "channel"],
  [turnModelRefLabel(TURN_MODEL_COMMAND_STALE_PEER_REF), "channel"],
]);

export function turnModelVerdict(
  ref: ModelRef,
  override?: TurnModelSelectionSource,
): TurnModelSelectionVerdict {
  const source = override ?? SOURCE_BY_REF.get(turnModelRefLabel(ref));
  if (!source) {
    throw new Error(`unknown selection source for ${turnModelRefLabel(ref)}`);
  }
  return { ...ref, source };
}

export function createTurnModelEntry(params: {
  sessionId?: string;
  channel?: string;
  chatType?: "direct" | "group";
  groupId?: string;
  groupChannel?: string;
  parentSessionKey?: string;
  directUserId?: string;
  override?: ModelRef;
  locked?: boolean;
}): SessionEntry {
  return {
    sessionId: params.sessionId ?? "child-session",
    updatedAt: 1,
    ...(params.channel
      ? {
          delivery: normalizeSessionDeliveryState({
            context: { channel: params.channel },
            origin: {
              provider: params.channel,
              ...(params.chatType ? { chatType: params.chatType } : {}),
              ...(params.directUserId ? { nativeDirectUserId: params.directUserId } : {}),
            },
          }),
        }
      : {}),
    ...(params.chatType ? { chatType: params.chatType } : {}),
    ...(params.groupId ? { groupId: params.groupId } : {}),
    ...(params.groupChannel ? { groupChannel: params.groupChannel } : {}),
    ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
    ...(params.override
      ? {
          providerOverride: params.override.provider,
          modelOverride: params.override.model,
          modelOverrideSource: "user" as const,
        }
      : {}),
    ...(params.locked ? { modelSelectionLocked: true, agentHarnessId: "turn-model-recorder" } : {}),
  };
}

export type TurnModelDifferentialFixture = {
  name: string;
  ctx: Partial<FinalizedMsgContext>;
  child: SessionEntry;
  parent?: { key: string; entry: SessionEntry };
  modelByChannel?: Record<string, Record<string, string>>;
  heartbeat?: boolean;
  locked?: boolean;
  expected: Record<TurnModelSelectionPath, TurnModelSelectionVerdict>;
};

export const TURN_MODEL_DIFFERENTIAL_FIXTURES: TurnModelDifferentialFixture[] = [
  {
    name: "default only",
    ctx: { Provider: undefined, Surface: undefined, ChatType: "group" },
    child: createTurnModelEntry({ chatType: "group", groupId: "room" }),
    expected: {
      reply: turnModelVerdict(TURN_MODEL_DEFAULT_REF),
      status: turnModelVerdict(TURN_MODEL_DEFAULT_REF),
      harness: turnModelVerdict(TURN_MODEL_DEFAULT_REF),
      command: turnModelVerdict(TURN_MODEL_DEFAULT_REF),
    },
  },
  {
    name: "channel wildcard",
    ctx: { Provider: "telegram", Surface: "telegram", ChatType: "group" },
    child: createTurnModelEntry({ channel: "telegram", chatType: "group", groupId: "room" }),
    modelByChannel: { telegram: { "*": turnModelRefLabel(TURN_MODEL_CHANNEL_REF) } },
    expected: {
      reply: turnModelVerdict(TURN_MODEL_CHANNEL_REF),
      status: turnModelVerdict(TURN_MODEL_CHANNEL_REF),
      harness: turnModelVerdict(TURN_MODEL_CHANNEL_REF),
      command: turnModelVerdict(TURN_MODEL_CHANNEL_REF),
    },
  },
  {
    name: "current session override before channel",
    ctx: { Provider: "telegram", Surface: "telegram", ChatType: "group" },
    child: createTurnModelEntry({
      channel: "telegram",
      chatType: "group",
      groupId: "room",
      override: TURN_MODEL_SESSION_REF,
    }),
    modelByChannel: { telegram: { "*": turnModelRefLabel(TURN_MODEL_CHANNEL_REF) } },
    expected: {
      reply: turnModelVerdict(TURN_MODEL_SESSION_REF),
      status: turnModelVerdict(TURN_MODEL_SESSION_REF),
      harness: turnModelVerdict(TURN_MODEL_SESSION_REF),
      command: turnModelVerdict(TURN_MODEL_SESSION_REF),
    },
  },
  {
    name: "heartbeat or explicit turn override",
    ctx: { Provider: "telegram", Surface: "telegram", ChatType: "group" },
    child: createTurnModelEntry({ channel: "telegram", chatType: "group", groupId: "room" }),
    modelByChannel: { telegram: { "*": turnModelRefLabel(TURN_MODEL_CHANNEL_REF) } },
    heartbeat: true,
    expected: {
      reply: turnModelVerdict(TURN_MODEL_OVERRIDE_REF),
      status: turnModelVerdict(TURN_MODEL_OVERRIDE_REF),
      harness: turnModelVerdict(TURN_MODEL_OVERRIDE_REF),
      command: turnModelVerdict(TURN_MODEL_OVERRIDE_REF, "explicit"),
    },
  },
  {
    name: "locked stored selection",
    ctx: { Provider: "telegram", Surface: "telegram", ChatType: "group" },
    child: createTurnModelEntry({
      channel: "telegram",
      chatType: "group",
      groupId: "room",
      override: TURN_MODEL_LOCKED_REF,
      locked: true,
    }),
    locked: true,
    modelByChannel: { telegram: { "*": turnModelRefLabel(TURN_MODEL_CHANNEL_REF) } },
    expected: {
      reply: turnModelVerdict(TURN_MODEL_LOCKED_REF),
      status: turnModelVerdict(TURN_MODEL_LOCKED_REF),
      harness: turnModelVerdict(TURN_MODEL_LOCKED_REF),
      command: turnModelVerdict(TURN_MODEL_LOCKED_REF),
    },
  },
  {
    name: "persisted delivery channel versus current authorized channel",
    ctx: { Provider: "telegram", Surface: "telegram", ChatType: "group" },
    child: createTurnModelEntry({ channel: "discord", chatType: "group", groupId: "room" }),
    modelByChannel: {
      discord: { room: turnModelRefLabel(TURN_MODEL_PERSISTED_CHANNEL_REF) },
      telegram: { room: turnModelRefLabel(TURN_MODEL_LIVE_CHANNEL_REF) },
    },
    expected: {
      reply: turnModelVerdict(TURN_MODEL_PERSISTED_CHANNEL_REF),
      status: turnModelVerdict(TURN_MODEL_LIVE_CHANNEL_REF),
      harness: turnModelVerdict(TURN_MODEL_PERSISTED_CHANNEL_REF),
      command: turnModelVerdict(TURN_MODEL_LIVE_CHANNEL_REF),
    },
  },
  {
    name: "persisted peer versus live sender",
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:live-peer",
      SenderId: "live-peer",
    },
    child: createTurnModelEntry({
      channel: "discord",
      chatType: "direct",
      directUserId: "stale-peer",
    }),
    modelByChannel: {
      discord: {
        "stale-peer": turnModelRefLabel(TURN_MODEL_PERSISTED_PEER_REF),
        "*": turnModelRefLabel(TURN_MODEL_CHANNEL_REF),
      },
      telegram: {
        "live-peer": turnModelRefLabel(TURN_MODEL_LIVE_PEER_REF),
        "stale-peer": turnModelRefLabel(TURN_MODEL_COMMAND_STALE_PEER_REF),
        "*": turnModelRefLabel(TURN_MODEL_LIVE_CHANNEL_REF),
      },
    },
    expected: {
      reply: turnModelVerdict(TURN_MODEL_PERSISTED_PEER_REF),
      status: turnModelVerdict(TURN_MODEL_LIVE_PEER_REF),
      harness: turnModelVerdict(TURN_MODEL_PERSISTED_PEER_REF),
      command: turnModelVerdict(TURN_MODEL_COMMAND_STALE_PEER_REF),
    },
  },
  {
    name: "parent persisted override versus channel",
    ctx: { Provider: "telegram", Surface: "telegram", ChatType: "group" },
    child: createTurnModelEntry({
      channel: "telegram",
      chatType: "group",
      groupId: "thread",
      parentSessionKey: "agent:main:telegram:group:parent",
    }),
    parent: {
      key: "agent:main:telegram:group:parent",
      entry: createTurnModelEntry({ sessionId: "parent-session", override: TURN_MODEL_PARENT_REF }),
    },
    modelByChannel: { telegram: { "*": turnModelRefLabel(TURN_MODEL_CHANNEL_REF) } },
    expected: {
      reply: turnModelVerdict(TURN_MODEL_PARENT_REF),
      status: turnModelVerdict(TURN_MODEL_PARENT_REF),
      harness: turnModelVerdict(TURN_MODEL_PARENT_REF),
      command: turnModelVerdict(TURN_MODEL_PARENT_REF),
    },
  },
];
