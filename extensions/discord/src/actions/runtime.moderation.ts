import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ActionGate,
  jsonResult,
  readStringParam,
  type DiscordActionConfig,
  type OpenClawConfig,
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
import { createDiscordActionOptions } from "./runtime.shared.js";

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
  cfg: OpenClawConfig;
}) {
  // CLI/manual flows may not have sender context; enforce only when present.
  if (!params.senderUserId) {
    return;
  }
  const hasPermission = await discordModerationActionRuntime.hasAnyGuildPermissionDiscord(
    params.guildId,
    params.senderUserId,
    [params.requiredPermission],
    createDiscordActionOptions({ cfg: params.cfg, accountId: params.accountId }),
  );
  if (!hasPermission) {
    throw new Error("Sender does not have required permissions for this moderation action.");
  }
}

export async function handleDiscordModerationAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  if (!isDiscordModerationAction(action)) {
    throw new Error(`Unknown action: ${action}`);
  }
  if (!isActionEnabled("moderation", false)) {
    throw new Error("Discord moderation is disabled.");
  }
  if (!cfg) {
    throw new Error("Discord moderation actions require a resolved runtime config.");
  }
  const accountId = readStringParam(params, "accountId");
  const command = readDiscordModerationCommand(action, params);
  const senderUserId = readStringParam(params, "senderUserId");
  const withOpts = () => createDiscordActionOptions({ cfg, accountId });
  await verifySenderModerationPermission({
    guildId: command.guildId,
    senderUserId,
    requiredPermission: requiredGuildPermissionForModerationAction(command.action),
    accountId,
    cfg,
  });
  switch (command.action) {
    case "timeout": {
      const member = await discordModerationActionRuntime.timeoutMemberDiscord(
        {
          guildId: command.guildId,
          userId: command.userId,
          durationMinutes: command.durationMinutes,
          until: command.until,
          reason: command.reason,
        },
        withOpts(),
      );
      return jsonResult({ ok: true, member });
    }
    case "kick": {
      await discordModerationActionRuntime.kickMemberDiscord(
        {
          guildId: command.guildId,
          userId: command.userId,
          reason: command.reason,
        },
        withOpts(),
      );
      return jsonResult({ ok: true });
    }
    case "ban": {
      await discordModerationActionRuntime.banMemberDiscord(
        {
          guildId: command.guildId,
          userId: command.userId,
          reason: command.reason,
          deleteMessageDays: command.deleteMessageDays,
        },
        withOpts(),
      );
      return jsonResult({ ok: true });
    }
  }
  throw new Error("Unsupported Discord moderation action");
}
