// Implements dock commands that bind sessions to local workspaces.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import {
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { resolveTextCommand } from "../commands-registry.js";
import { resolveCommandSurfaceChannel } from "./channel-context.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const DOCK_KEY_PREFIX = "dock:";

type LinkedDockTarget = {
  peerId: string;
};

function resolveDockCommandTarget(params: HandleCommandsParams): string | null {
  const resolved = resolveTextCommand(params.command.commandBodyNormalized, params.cfg);
  if (!resolved?.command.key.startsWith(DOCK_KEY_PREFIX)) {
    return null;
  }
  if (resolved.command.category !== "docks") {
    return null;
  }
  const target = normalizeLowercaseStringOrEmpty(
    resolved.command.key.slice(DOCK_KEY_PREFIX.length),
  );
  return target || null;
}

function resolveTargetChannelAccountId(
  params: HandleCommandsParams,
  targetChannel: string,
): string {
  const plugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.plugin.id) === targetChannel,
  )?.plugin;
  return normalizeOptionalString(plugin?.config.defaultAccountId?.(params.cfg)) || "default";
}

function isDirectDockSource(params: HandleCommandsParams): boolean {
  return normalizeLowercaseStringOrEmpty(params.ctx.ChatType) === "direct";
}

function collectSourcePeerCandidates(params: HandleCommandsParams): string[] {
  return [
    params.ctx.NativeDirectUserId,
    params.ctx.SenderId,
    params.command.senderId,
    params.ctx.SenderE164,
    params.ctx.SenderUsername,
    params.ctx.From,
    params.command.from,
    params.ctx.OriginatingTo,
    params.ctx.To,
  ]
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => Boolean(value));
}

function buildSourceIdentityCandidates(
  params: HandleCommandsParams,
  sourceChannel: string,
): Set<string> {
  const candidates = new Set<string>();
  for (const peerId of collectSourcePeerCandidates(params)) {
    const raw = normalizeLowercaseStringOrEmpty(peerId);
    if (raw) {
      candidates.add(raw);
    }
    if (sourceChannel) {
      const scoped = normalizeLowercaseStringOrEmpty(`${sourceChannel}:${peerId}`);
      if (scoped) {
        candidates.add(scoped);
      }
    }
  }
  return candidates;
}

function resolveLinkedDockTarget(params: {
  identityLinks: Record<string, string[]> | undefined;
  sourceCandidates: Set<string>;
  targetChannel: string;
}): LinkedDockTarget | null {
  if (!params.identityLinks || params.sourceCandidates.size === 0) {
    return null;
  }
  const targetPrefix = `${params.targetChannel}:`;
  for (const ids of Object.values(params.identityLinks)) {
    if (!Array.isArray(ids)) {
      continue;
    }
    const normalizedIds = normalizeTrimmedStringList(ids).map((id) => id.toLowerCase());
    if (!normalizedIds.some((id) => params.sourceCandidates.has(id))) {
      continue;
    }
    for (const id of ids) {
      const trimmed = normalizeOptionalString(id);
      if (!trimmed) {
        continue;
      }
      if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith(targetPrefix)) {
        continue;
      }
      return {
        peerId: trimmed.slice(targetPrefix.length).trim(),
      };
    }
  }
  return null;
}

export const handleDockCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/dock",
    match: (_body, params) => resolveDockCommandTarget(params),
    silentUnauthorized: true,
  },
  async (params, targetChannel) => {
    const sourceChannel = resolveCommandSurfaceChannel(params);
    if (sourceChannel === targetChannel) {
      return commandReply(`Already docked to ${targetChannel}.`);
    }
    if (!isDirectDockSource(params)) {
      return commandReply(
        `Cannot dock to ${targetChannel}: docking is only available from direct chats.`,
      );
    }

    const sourceCandidates = buildSourceIdentityCandidates(params, sourceChannel);
    if (sourceCandidates.size === 0) {
      return commandReply(`Cannot dock to ${targetChannel}: sender id is unavailable.`);
    }

    const target = resolveLinkedDockTarget({
      identityLinks: params.cfg.session?.identityLinks,
      sourceCandidates,
      targetChannel,
    });
    if (!target?.peerId) {
      return commandReply(
        `Cannot dock to ${targetChannel}: add this sender and a ${targetChannel}:... peer to session.identityLinks.`,
      );
    }

    const sessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    if (!sessionEntry || !params.sessionStore || !params.sessionKey) {
      return commandReply(`Cannot dock to ${targetChannel}: no active session entry was found.`);
    }

    sessionEntry.delivery = normalizeSessionDeliveryState({
      context: {
        channel: targetChannel,
        to: target.peerId,
        accountId: resolveTargetChannelAccountId(params, targetChannel),
      },
      origin: sessionDeliveryOrigin(sessionEntry),
    });
    params.sessionEntry = sessionEntry;
    const persisted = await persistSessionEntry({
      ...params,
      touchedFields: ["delivery"],
    });
    if (!persisted) {
      return commandReply(`Cannot dock to ${targetChannel}: session route could not be saved.`);
    }

    return commandReply(`Docked replies to ${targetChannel}.`);
  },
);
