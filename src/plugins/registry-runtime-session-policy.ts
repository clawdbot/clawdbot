import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import { parseSessionDeliveryRoute } from "../sessions/session-key-utils.js";
import type { PluginRuntime } from "./runtime/types.js";

export const PLUGIN_GATEWAY_SESSION_MUTATION_METHODS = new Set([
  "agent",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "message.action",
  "plugins.sessionAction",
  "send",
  "sessions.abort",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.branches.switch",
  "sessions.rewind",
  "sessions.fork",
  "sessions.create",
  "sessions.delete",
  "sessions.patchMany",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reset",
  "sessions.send",
  "sessions.steer",
  "wake",
]);

export const PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS = new Set([
  "sessions.cleanup",
  "sessions.groups.delete",
  "sessions.groups.rename",
]);

type ResetParams = Parameters<PluginRuntime["agent"]["session"]["resetSessionEntryLifecycle"]>[0];
type ChannelResetParams = Parameters<
  PluginRuntime["channel"]["session"]["resetSessionEntryLifecycle"]
>[0];
type ResetContext = {
  agentId?: string;
  entry: SessionEntry;
  reason: "reset";
  sessionFile?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};
type ResetWithOwnerParams = ResetParams & {
  assertActiveOwner?: () => void;
  releasePhysicalOwner?: (context: ResetContext) => Promise<void> | void;
};
type LockedHarnessResolution =
  | {
      harnessId?: string;
      ownerPluginId: string;
      registration?: {
        harness: {
          reset?: (params: {
            agentId?: string;
            reason: "reset";
            sessionFile?: string;
            sessionId: string;
            sessionKey: string;
          }) => Promise<void> | void;
        };
      };
    }
  | undefined;

function resolveChannelSessionKeyOwner(sessionKey: string): string | undefined {
  const delivery = parseSessionDeliveryRoute(sessionKey);
  if (delivery) {
    return delivery.channel;
  }
  const normalized = normalizeOptionalLowercaseString(sessionKey);
  if (!normalized || normalized.startsWith("agent:")) {
    return undefined;
  }
  const [channelId, peerKind, peerId] = normalized.split(":");
  return channelId && peerId && ["channel", "direct", "dm", "group"].includes(peerKind ?? "")
    ? channelId
    : undefined;
}

async function releaseLockedSessionPhysicalOwner(params: {
  context: ResetContext;
  expectedOwnerPluginId?: string;
  resolveLockedSessionHarnessRegistration: (
    sessionKey: string,
    entry: SessionEntry,
    action: string,
  ) => LockedHarnessResolution;
}): Promise<void> {
  const locked = params.resolveLockedSessionHarnessRegistration(
    params.context.sessionKey,
    params.context.entry,
    "reset",
  );
  const registration = locked?.registration;
  if (
    !locked ||
    (params.expectedOwnerPluginId !== undefined &&
      locked.ownerPluginId !== params.expectedOwnerPluginId) ||
    !registration
  ) {
    throw new Error(
      `Locked session "${params.context.sessionKey}" is owned by plugin "${locked?.ownerPluginId ?? "unknown"}"${params.expectedOwnerPluginId ? `, not "${params.expectedOwnerPluginId}"` : ""}.`,
    );
  }
  if (!registration.harness.reset) {
    throw new Error(
      `Agent harness "${locked.harnessId}" must implement reset before locked sessions can be reset.`,
    );
  }
  await registration.harness.reset({
    ...(params.context.agentId !== undefined ? { agentId: params.context.agentId } : {}),
    reason: params.context.reason,
    ...(params.context.sessionFile !== undefined
      ? { sessionFile: params.context.sessionFile }
      : {}),
    sessionId: params.context.sessionId,
    sessionKey: params.context.sessionKey,
  });
}

export async function resetPluginSessionEntryLifecycle(params: {
  assertStoredSessionEntryOwned: (params: {
    action: string;
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    sessionKey: string;
    storePath?: string;
  }) => SessionEntry | undefined;
  pluginId: string;
  request: ResetParams;
  reset: (params: ResetWithOwnerParams) => Promise<SessionEntry | null>;
  resolveLockedSessionHarnessRegistration: (
    sessionKey: string,
    entry: SessionEntry,
    action: string,
  ) => LockedHarnessResolution;
}): Promise<SessionEntry | null> {
  const request = params.request;
  params.assertStoredSessionEntryOwned({
    action: "reset",
    sessionKey: request.sessionKey,
    ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
    ...(request.env !== undefined ? { env: request.env } : {}),
    ...(request.storePath !== undefined ? { storePath: request.storePath } : {}),
  });
  return await params.reset({
    ...request,
    releasePhysicalOwner: async (context: ResetContext) =>
      await releaseLockedSessionPhysicalOwner({
        context,
        expectedOwnerPluginId: params.pluginId,
        resolveLockedSessionHarnessRegistration: params.resolveLockedSessionHarnessRegistration,
      }),
  });
}

export async function resetPluginChannelSessionEntryLifecycle(params: {
  assertActiveOwner: () => void;
  channelIds: readonly string[];
  pluginId: string;
  request: ChannelResetParams;
  reset: (params: ResetWithOwnerParams) => Promise<SessionEntry | null>;
  resolveLockedSessionHarnessRegistration: (
    sessionKey: string,
    entry: SessionEntry,
    action: string,
  ) => LockedHarnessResolution;
}): Promise<SessionEntry | null> {
  const requestedChannelId = normalizeOptionalLowercaseString(params.request.channelId);
  const ownedChannelIds = new Set(
    params.channelIds.flatMap((channelId) => {
      const normalized = normalizeOptionalLowercaseString(channelId);
      return normalized ? [normalized] : [];
    }),
  );
  if (!requestedChannelId || !ownedChannelIds.has(requestedChannelId)) {
    throw new Error(
      `Plugin "${params.pluginId}" does not own channel "${requestedChannelId ?? params.request.channelId}".`,
    );
  }
  const sessionChannelId = resolveChannelSessionKeyOwner(params.request.sessionKey);
  if (sessionChannelId !== requestedChannelId) {
    throw new Error(
      `Channel "${requestedChannelId}" cannot reset session "${params.request.sessionKey}" owned by channel "${sessionChannelId ?? "unknown"}".`,
    );
  }
  const { channelId: _channelId, ...request } = params.request;
  return await params.reset({
    ...request,
    assertActiveOwner: params.assertActiveOwner,
    releasePhysicalOwner: async (context: ResetContext) =>
      await releaseLockedSessionPhysicalOwner({
        context,
        resolveLockedSessionHarnessRegistration: params.resolveLockedSessionHarnessRegistration,
      }),
  });
}
