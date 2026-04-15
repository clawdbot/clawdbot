import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ActionGate,
  jsonResult,
  readStringParam,
  type DiscordActionConfig,
} from "../runtime-api.js";
import {
  banMemberDiscord,
  hasAnyGuildPermissionDiscord,
  kickMemberDiscord,
  timeoutMemberDiscord,
} from "../send.js";
import {
  isDiscordModerationAction,
  readDiscordModerationCommand,
  requiredGuildPermissionForModerationAction,
} from "./runtime.moderation-shared.js";

export const discordModerationActionRuntime = {
  banMemberDiscord,
  hasAnyGuildPermissionDiscord,
  kickMemberDiscord,
  timeoutMemberDiscord,
};

async function verifySenderModerationPermission(params: {
  guildId: string;
  senderUserId?: string;
  requiredPermission: bigint;
  accountId?: string;
}) {
  // CLI/manual flows may not have sender context; enforce only when present.
  if (!params.senderUserId) {
    return;
  }
  const hasPermission = await discordModerationActionRuntime.hasAnyGuildPermissionDiscord(
    params.guildId,
    params.senderUserId,
    [params.requiredPermission],
    params.accountId ? { accountId: params.accountId } : undefined,
  );
  if (!hasPermission) {
    throw new Error("Sender does not have required permissions for this moderation action.");
  }
}

export async function handleDiscordModerationAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
): Promise<AgentToolResult<unknown>> {
  if (!isDiscordModerationAction(action)) {
    throw new Error(`Unknown action: ${action}`);
  }
  if (!isActionEnabled("moderation", false)) {
    throw new Error("Discord moderation is disabled.");
  }
  const command = readDiscordModerationCommand(action, params);
  const accountId = readStringParam(params, "accountId");
  const senderUserId = readStringParam(params, "senderUserId");
  await verifySenderModerationPermission({
    guildId: command.guildId,
    senderUserId,
    requiredPermission: requiredGuildPermissionForModerationAction(command.action),
    accountId,
  });
  switch (command.action) {
    case "timeout": {
      const member = accountId
        ? await discordModerationActionRuntime.timeoutMemberDiscord(
            {
              guildId: command.guildId,
              userId: command.userId,
              durationMinutes: command.durationMinutes,
              until: command.until,
              reason: command.reason,
            },
            { accountId },
          )
        : await discordModerationActionRuntime.timeoutMemberDiscord({
            guildId: command.guildId,
            userId: command.userId,
            durationMinutes: command.durationMinutes,
            until: command.until,
            reason: command.reason,
          });
      return jsonResult({ ok: true, member });
    }
    case "kick": {
      if (accountId) {
        await discordModerationActionRuntime.kickMemberDiscord(
          {
            guildId: command.guildId,
            userId: command.userId,
            reason: command.reason,
          },
          { accountId },
        );
      } else {
        await discordModerationActionRuntime.kickMemberDiscord({
          guildId: command.guildId,
          userId: command.userId,
          reason: command.reason,
        });
      }
      return jsonResult({ ok: true });
    }
    case "ban": {
      if (accountId) {
        await discordModerationActionRuntime.banMemberDiscord(
          {
            guildId: command.guildId,
            userId: command.userId,
            reason: command.reason,
            deleteMessageDays: command.deleteMessageDays,
          },
          { accountId },
        );
      } else {
        await discordModerationActionRuntime.banMemberDiscord({
          guildId: command.guildId,
          userId: command.userId,
          reason: command.reason,
          deleteMessageDays: command.deleteMessageDays,
        });
      }
      return jsonResult({ ok: true });
    }
  }
  throw new Error("Unsupported Discord moderation action");
}
