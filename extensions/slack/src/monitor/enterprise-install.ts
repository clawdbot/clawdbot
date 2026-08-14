// Slack plugin module implements detected Enterprise Grid installation policy.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig, SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultSlackAccountId } from "../accounts.js";
import { parseSlackTarget } from "../target-parsing.js";

export type SlackInstallationIdentity =
  | {
      kind: "workspace";
      apiAppId?: string;
      teamId: string;
      teamName?: string;
      enterpriseId?: string;
    }
  | {
      kind: "enterprise";
      apiAppId?: string;
      enterpriseId: string;
    }
  | {
      kind: "degraded";
      reason: "auth_test_failed";
    };

export type SlackIdentityHealth =
  | {
      lifecycle: "ready";
      lastError: null;
    }
  | {
      lifecycle: "blocked";
      lastError: string;
    };

export type SlackAuthTestIdentity = {
  app_id?: unknown;
  team?: unknown;
  team_id?: unknown;
  enterprise_id?: unknown;
  is_enterprise_install?: unknown;
};

const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]{8,}$/;
const SLACK_USER_ID_RE = /^[BUW][A-Z0-9]{8,}$/;

function isWorkspaceScopedSlackChannelEntry(
  value: unknown,
  options?: { allowWildcard?: boolean },
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  if (normalized === "*") {
    return options?.allowWildcard === true;
  }
  return isWorkspaceQualifiedSlackTarget(normalized, "channel");
}

function isStableSlackAllowlistUserEntry(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  if (normalized === "*") {
    return true;
  }
  if (isWorkspaceQualifiedSlackTarget(normalized, "user")) {
    return true;
  }
  const prefixed = /^(?:slack|user):([BUW][A-Z0-9]{8,})$/.exec(normalized);
  return Boolean(prefixed?.[1]) || SLACK_USER_ID_RE.test(normalized);
}

function isStableSlackToolsBySenderEntry(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  if (normalized === "*") {
    return true;
  }
  const prefixed = /^(?:id:|channel:slack:)([UW][A-Z0-9]{8,})$/.exec(normalized);
  return Boolean(prefixed?.[1]) || SLACK_USER_ID_RE.test(normalized);
}

function assertStableEntries(params: {
  values: readonly unknown[] | undefined;
  path: string;
  predicate: (value: unknown) => boolean;
}) {
  const invalid = params.values?.find((value) => !params.predicate(value));
  if (invalid !== undefined) {
    throw new Error(
      `Slack Enterprise Grid org installs require stable Slack IDs in ${params.path}; invalid entry ${JSON.stringify(invalid)}`,
    );
  }
}

function isWorkspaceQualifiedSlackTarget(value: unknown, kind: "channel" | "user"): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const target = parseSlackTarget(value);
    const idPattern = kind === "channel" ? SLACK_CHANNEL_ID_RE : SLACK_USER_ID_RE;
    return (
      target?.kind === kind &&
      /^T[A-Z0-9]{8,}$/.test(target.teamId ?? "") &&
      idPattern.test(target.id)
    );
  } catch {
    return false;
  }
}

/** Validate every policy surface that would otherwise require name resolution. */
export function assertEnterpriseSlackPolicyConfig(params: {
  config: SlackAccountConfig;
  accountId: string;
}) {
  const { config, accountId } = params;
  if (config.dangerouslyAllowNameMatching === true) {
    throw new Error(
      `Slack Enterprise Grid org account "${accountId}" cannot use dangerouslyAllowNameMatching`,
    );
  }
  assertStableEntries({
    values: config.mentionPatterns?.allowIn,
    path: `channels.slack.accounts.${accountId}.mentionPatterns.allowIn`,
    predicate: (value) => isWorkspaceQualifiedSlackTarget(value, "channel"),
  });
  assertStableEntries({
    values: config.mentionPatterns?.denyIn,
    path: `channels.slack.accounts.${accountId}.mentionPatterns.denyIn`,
    predicate: (value) => isWorkspaceQualifiedSlackTarget(value, "channel"),
  });
  assertStableEntries({
    values: config.allowFrom,
    path: `channels.slack.accounts.${accountId}.allowFrom`,
    predicate: isStableSlackAllowlistUserEntry,
  });
  assertStableEntries({
    values: config.dm?.groupChannels,
    path: `channels.slack.accounts.${accountId}.dm.groupChannels`,
    predicate: (value) => isWorkspaceScopedSlackChannelEntry(value),
  });
  if (config.reactionNotifications === "allowlist") {
    assertStableEntries({
      values: config.reactionAllowlist,
      path: `channels.slack.accounts.${accountId}.reactionAllowlist`,
      predicate: isStableSlackAllowlistUserEntry,
    });
  }
  for (const [channelKey, channel] of Object.entries(config.channels ?? {})) {
    if (!isWorkspaceScopedSlackChannelEntry(channelKey, { allowWildcard: true })) {
      throw new Error(
        `Slack Enterprise Grid org installs require stable Slack channel IDs with workspace scope; invalid channels key ${JSON.stringify(channelKey)}`,
      );
    }
    assertStableEntries({
      values: channel?.users,
      path: `channels.slack.accounts.${accountId}.channels.${channelKey}.users`,
      predicate: isStableSlackAllowlistUserEntry,
    });
    assertStableEntries({
      values: Object.keys(channel?.toolsBySender ?? {}),
      path: `channels.slack.accounts.${accountId}.channels.${channelKey}.toolsBySender`,
      predicate: isStableSlackToolsBySenderEntry,
    });
  }
}

export function assertEnterpriseSlackBindingsAreWorkspaceQualified(params: {
  cfg: OpenClawConfig;
  accountId: string;
}) {
  const accountId = normalizeAccountId(params.accountId);
  const defaultAccountId = normalizeAccountId(resolveDefaultSlackAccountId(params.cfg));
  const configured = params.cfg.bindings?.filter((binding) => {
    if (binding.match.channel.trim().toLowerCase() !== "slack") {
      return false;
    }
    const bindingAccountId = binding.match.accountId?.trim();
    return (
      bindingAccountId === "*" ||
      (bindingAccountId
        ? normalizeAccountId(bindingAccountId) === accountId
        : accountId === defaultAccountId)
    );
  });
  for (const binding of configured ?? []) {
    if (binding.type === "acp") {
      throw new Error(
        `Slack Enterprise Grid org account "${params.accountId}" cannot use configured ACP bindings because current-conversation bindings are not workspace-qualified`,
      );
    }
    const peerId = binding.match.peer?.id.trim();
    if (!peerId || peerId === "*") {
      if (/^T[A-Z0-9]{8,}$/.test(binding.match.teamId?.trim() ?? "")) {
        continue;
      }
      throw new Error(
        `Slack Enterprise Grid org account "${params.accountId}" requires match.teamId on configured Slack bindings without a workspace-qualified peer`,
      );
    }
    let target: ReturnType<typeof parseSlackTarget>;
    try {
      target = parseSlackTarget(peerId);
    } catch {
      target = undefined;
    }
    const expectedKind = binding.match.peer?.kind === "direct" ? "user" : "channel";
    if (!target?.teamId || !isWorkspaceQualifiedSlackTarget(peerId, expectedKind)) {
      throw new Error(
        `Slack Enterprise Grid org account "${params.accountId}" requires configured Slack binding peers to use team:<team-id>:channel:<channel-id> or team:<team-id>:user:<user-id>`,
      );
    }
    const matchTeamId = binding.match.teamId?.trim();
    if (matchTeamId && matchTeamId.toLowerCase() !== target.teamId.toLowerCase()) {
      throw new Error(
        `Slack Enterprise Grid org account "${params.accountId}" has conflicting workspace IDs in configured Slack binding match.teamId and peer.id`,
      );
    }
  }
}

export function resolveSlackInstallationIdentity(params: {
  auth?: SlackAuthTestIdentity;
  transportApiAppId?: string;
}): SlackInstallationIdentity {
  const auth = params.auth;
  if (!auth) {
    return { kind: "degraded", reason: "auth_test_failed" };
  }
  const isEnterpriseInstall = auth.is_enterprise_install === true;
  const apiAppId = normalizeOptionalString(auth.app_id);
  const enterpriseId = normalizeOptionalString(auth.enterprise_id);
  if (isEnterpriseInstall) {
    if (!enterpriseId) {
      throw new Error("Slack org-wide auth.test returned no enterprise_id");
    }
    // Slack auth.test does not guarantee app_id. Socket Mode can derive it from the
    // app token; HTTP authenticates the signed event that carries api_app_id.
    const transportApiAppId = normalizeOptionalString(params.transportApiAppId);
    if (apiAppId && transportApiAppId && apiAppId !== transportApiAppId) {
      throw new Error(
        `Slack token mismatch: bot token app_id=${apiAppId} but transport app_id=${transportApiAppId}`,
      );
    }
    const effectiveApiAppId = apiAppId ?? transportApiAppId;
    return {
      kind: "enterprise",
      ...(effectiveApiAppId ? { apiAppId: effectiveApiAppId } : {}),
      enterpriseId,
    };
  }
  const teamId = normalizeOptionalString(auth.team_id);
  if (!teamId) {
    throw new Error("Slack workspace auth.test returned no team_id");
  }
  const teamName = normalizeOptionalString(auth.team);
  return {
    kind: "workspace",
    teamId,
    ...(teamName ? { teamName } : {}),
    ...(apiAppId ? { apiAppId } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
  };
}

export function resolveSlackIdentityHealth(params: {
  installationIdentity: SlackInstallationIdentity;
  botUserId: string;
  authTestError?: string;
  authIdentityWarning?: string;
}): SlackIdentityHealth {
  const lastError =
    normalizeOptionalString(params.authTestError) ??
    normalizeOptionalString(params.authIdentityWarning) ??
    (params.installationIdentity.kind === "degraded" || !params.botUserId.trim()
      ? "slack bot identity unavailable"
      : undefined);
  return lastError ? { lifecycle: "blocked", lastError } : { lifecycle: "ready", lastError: null };
}
