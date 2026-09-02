// Implements the session-scoped preview streaming command.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { StreamingMode } from "../../config/types.base.js";
import { isSessionDefaultDirectiveValue } from "../thinking.js";
import { resolveChannelAccountId, resolveCommandSurfaceChannel } from "./channel-context.js";
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import {
  persistCommandSession,
  sessionEntryPersistenceConflictReply,
} from "./commands-session-store.js";
import type { HandleCommandsParams } from "./commands-types.js";

const STREAM_COMMAND_PREFIXES = ["/stream", "/streaming"] as const;

type StreamCommandContract = {
  plugin: NonNullable<ReturnType<typeof getChannelPlugin>>;
  resolveSessionMode: NonNullable<
    NonNullable<NonNullable<ReturnType<typeof getChannelPlugin>>["streaming"]>["resolveSessionMode"]
  >;
};

function matchStreamCommand(normalized: string): string | null {
  for (const prefix of STREAM_COMMAND_PREFIXES) {
    const args = matchCommandPrefix(normalized, prefix);
    if (args !== null) {
      return args;
    }
  }
  return null;
}

function normalizeStreamCommandMode(raw: string): StreamingMode | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (normalized === "final") {
    return "off";
  }
  return parseStreamCommandMode(normalized);
}

function parseStreamCommandMode(value: unknown): StreamingMode | undefined {
  const normalized = typeof value === "string" ? normalizeLowercaseStringOrEmpty(value) : "";
  if (
    normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
  ) {
    return normalized;
  }
  return undefined;
}

function formatStreamModeLabel(mode: StreamingMode): string {
  return mode === "off" ? "off (preview disabled)" : mode;
}

function resolveStreamCommandContract(params: HandleCommandsParams): StreamCommandContract | null {
  const channelId = normalizeChannelId(
    params.command.channelId ?? resolveCommandSurfaceChannel(params),
  );
  if (!channelId) {
    return null;
  }
  const plugin = getChannelPlugin(channelId);
  const streaming = plugin?.streaming;
  if (!plugin || !streaming?.sessionModeDefault || !streaming.resolveSessionMode) {
    return null;
  }
  return { plugin, resolveSessionMode: streaming.resolveSessionMode };
}

function resolveStreamCommandMode(
  params: HandleCommandsParams,
  contract: StreamCommandContract,
  sessionMode?: unknown,
) {
  const account = contract.plugin.config.resolveAccount(
    params.cfg,
    params.command.accountId ?? resolveChannelAccountId(params),
  );
  return contract.resolveSessionMode({
    account,
    sessionMode: parseStreamCommandMode(sessionMode) ?? undefined,
  });
}

export const handleStreamCommand = defineAuthorizedTextCommand(
  {
    label: "/stream",
    match: matchStreamCommand,
    silentUnauthorized: true,
  },
  async (params, rawArgs) => {
    const contract = resolveStreamCommandContract(params);
    if (!contract) {
      return commandReply("⚙️ /stream isn't supported on this channel yet.");
    }

    const rawMode = normalizeLowercaseStringOrEmpty(rawArgs);
    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    if (!rawMode || rawMode === "status") {
      const resolved = resolveStreamCommandMode(
        params,
        contract,
        targetSessionEntry?.streamingMode,
      );
      return commandReply(
        `⚙️ Current stream mode: ${formatStreamModeLabel(resolved.mode)} (${resolved.source}).`,
      );
    }

    const resetsToDefault = isSessionDefaultDirectiveValue(rawMode);
    const nextMode = resetsToDefault ? undefined : normalizeStreamCommandMode(rawMode);
    if (nextMode === undefined) {
      if (resetsToDefault) {
        if (targetSessionEntry && params.sessionStore && params.sessionKey) {
          delete targetSessionEntry.streamingMode;
          if (
            !(await persistCommandSession({
              ...params,
              sessionEntry: targetSessionEntry,
              touchedFields: ["streamingMode"],
            }))
          ) {
            return sessionEntryPersistenceConflictReply();
          }
        }
        const inherited = resolveStreamCommandMode(params, contract);
        return commandReply(
          `⚙️ Stream mode reset to ${formatStreamModeLabel(inherited.mode)} (${inherited.source}).`,
        );
      }
      return commandReply("⚙️ Usage: /stream status|off|partial|block|progress|default");
    }

    if (targetSessionEntry && params.sessionStore && params.sessionKey) {
      targetSessionEntry.streamingMode = nextMode;
      if (
        !(await persistCommandSession({
          ...params,
          sessionEntry: targetSessionEntry,
          touchedFields: ["streamingMode"],
        }))
      ) {
        return sessionEntryPersistenceConflictReply();
      }
    }

    return commandReply(`⚙️ Stream mode set to ${formatStreamModeLabel(nextMode)}.`);
  },
);
