import { coerceNativeSetting, normalizeAllowFromList } from "openclaw/plugin-sdk/channel-policy";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/config-runtime";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";

export async function collectSlackSecurityAuditFindings(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedSlackAccount;
}) {
  const findings: Array<{
    checkId: string;
    severity: "info" | "warn" | "critical";
    title: string;
    detail: string;
    remediation?: string;
  }> = [];
  const slackCfg = params.account.config ?? {};
  const accountId = params.accountId?.trim() || params.account.accountId || "default";
  const slashCommandConfigured =
    (slackCfg.slashCommand as { enabled?: unknown } | undefined)?.enabled === true;
  const slashCommandEnabled =
    slashCommandConfigured ||
    resolveNativeCommandsEnabled({
      providerId: "slack",
      providerSetting: coerceNativeSetting(
        (slackCfg.commands as { native?: unknown } | undefined)?.native,
      ),
      globalSetting: params.cfg.commands?.native,
    }) ||
    resolveNativeSkillsEnabled({
      providerId: "slack",
      providerSetting: coerceNativeSetting(
        (slackCfg.commands as { nativeSkills?: unknown } | undefined)?.nativeSkills,
      ),
      globalSetting: params.cfg.commands?.nativeSkills,
    });
  if (!slashCommandEnabled) {
    return findings;
  }

  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  if (!useAccessGroups) {
    findings.push({
      checkId: "channels.slack.commands.slash.useAccessGroups_off",
      severity: "critical",
      title: "Slack slash commands bypass access groups",
      detail:
        "Slack slash/native commands are enabled while commands.useAccessGroups=false; this can allow unrestricted /… command execution from channels/users you didn't explicitly authorize.",
      remediation: "Set commands.useAccessGroups=true (recommended).",
    });
    return findings;
  }

  const allowFromRaw = slackCfg.allowFrom;
  const legacyAllowFromRaw = (params.account as { dm?: { allowFrom?: unknown } }).dm?.allowFrom;
  const allowFrom = Array.isArray(allowFromRaw)
    ? allowFromRaw
    : Array.isArray(legacyAllowFromRaw)
      ? legacyAllowFromRaw
      : [];
  const storeAllowFrom = await readChannelAllowFromStore("slack", process.env, accountId).catch(
    () => [],
  );
  const ownerAllowFromConfigured =
    normalizeAllowFromList([...allowFrom, ...storeAllowFrom]).length > 0;
  const channels = (slackCfg.channels as Record<string, unknown> | undefined) ?? {};
  const hasAnyChannelUsersAllowlist = Object.values(channels).some((value) => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const channel = value as Record<string, unknown>;
    return Array.isArray(channel.users) && channel.users.length > 0;
  });
  if (!ownerAllowFromConfigured && !hasAnyChannelUsersAllowlist) {
    findings.push({
      checkId: "channels.slack.commands.slash.no_allowlists",
      severity: "warn",
      title: "Slack slash commands have no allowlists",
      detail:
        "Slack slash/native commands are enabled, but neither an owner allowFrom list nor any channels.<id>.users allowlist is configured; /… commands will be rejected for everyone.",
      remediation:
        "Approve yourself via pairing (recommended), or set channels.slack.allowFrom and/or channels.slack.channels.<id>.users.",
    });
  }

  return findings;
}
