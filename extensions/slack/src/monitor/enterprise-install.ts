// Slack plugin module implements explicit Enterprise Grid installation policy.
import type { OpenClawConfig, SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultSlackAccountId } from "../accounts.js";
import { formatSlackError } from "../errors.js";

export type SlackInstallationIdentity =
  | {
      kind: "workspace";
      apiAppId?: string;
      teamId: string;
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
      healthState: "healthy";
      lastError: null;
    }
  | {
      healthState: "degraded";
      lastError: string;
    };

export type SlackAuthTestIdentity = {
  app_id?: unknown;
  team_id?: unknown;
  enterprise_id?: unknown;
  is_enterprise_install?: unknown;
};

const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]{8,}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{8,}$/;

function isStableSlackChannelEntry(value: unknown, options?: { allowWildcard?: boolean }): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  if (normalized === "*") {
    return options?.allowWildcard === true;
  }
  const prefixed = /^channel:([CDG][A-Z0-9]{8,})$/.exec(normalized);
  if (prefixed?.[1]) {
    return true;
  }
  return SLACK_CHANNEL_ID_RE.test(normalized);
}

function isStableSlackAllowlistUserEntry(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  if (normalized === "*") {
    return true;
  }
  const prefixed = /^(?:slack|user):([UW][A-Z0-9]{8,})$/.exec(normalized);
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
  if (
    config.mentionPatterns?.allowIn !== undefined ||
    config.mentionPatterns?.denyIn !== undefined
  ) {
    throw new Error(
      `Slack Enterprise Grid org account "${accountId}" cannot use mentionPatterns.allowIn or mentionPatterns.denyIn because Slack channel IDs are not workspace-qualified`,
    );
  }
  assertStableEntries({
    values: config.allowFrom,
    path: `channels.slack.accounts.${accountId}.allowFrom`,
    predicate: isStableSlackAllowlistUserEntry,
  });
  assertStableEntries({
    values: config.dm?.allowFrom,
    path: `channels.slack.accounts.${accountId}.dm.allowFrom`,
    predicate: isStableSlackAllowlistUserEntry,
  });
  assertStableEntries({
    values: config.dm?.groupChannels,
    path: `channels.slack.accounts.${accountId}.dm.groupChannels`,
    predicate: (value) => isStableSlackChannelEntry(value),
  });
  if (config.reactionNotifications === "allowlist") {
    assertStableEntries({
      values: config.reactionAllowlist,
      path: `channels.slack.accounts.${accountId}.reactionAllowlist`,
      predicate: isStableSlackAllowlistUserEntry,
    });
  }
  for (const [channelKey, channel] of Object.entries(config.channels ?? {})) {
    if (!isStableSlackChannelEntry(channelKey, { allowWildcard: true })) {
      throw new Error(
        `Slack Enterprise Grid org installs require stable Slack channel IDs; invalid channels key ${JSON.stringify(channelKey)}`,
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

/** Prevent account-wide user authorization state from crossing workspace boundaries. */
export function assertEnterpriseSlackDmPolicy(params: {
  accountId: string;
  dmEnabled: boolean;
  dmPolicy: string;
  allowFrom: readonly string[] | undefined;
}) {
  if (!params.dmEnabled || params.dmPolicy === "disabled") {
    return;
  }
  if (params.dmPolicy === "open" && params.allowFrom?.includes("*")) {
    return;
  }
  throw new Error(
    `Slack Enterprise Grid org account "${params.accountId}" supports DMs only with dm.enabled=false, dmPolicy="disabled", or dmPolicy="open" with effective allowFrom containing "*"; dmPolicy=${JSON.stringify(params.dmPolicy)} and allowFrom=${JSON.stringify(params.allowFrom ?? [])} would share per-user authorization across workspaces`,
  );
}

export function assertNoEnterpriseSlackBindings(params: {
  cfg: OpenClawConfig;
  accountId: string;
}) {
  const defaultAccountId = resolveDefaultSlackAccountId(params.cfg);
  const configured = params.cfg.bindings?.find((binding) => {
    if (binding.match.channel.trim().toLowerCase() !== "slack") {
      return false;
    }
    const accountId = binding.match.accountId?.trim();
    return (
      accountId === "*" ||
      accountId === params.accountId ||
      (!accountId && params.accountId === defaultAccountId)
    );
  });
  if (configured) {
    throw new Error(
      `Slack Enterprise Grid org account "${params.accountId}" cannot use configured Slack bindings`,
    );
  }
}

export function resolveSlackInstallationIdentity(params: {
  enterpriseOrgInstall: boolean;
  auth?: SlackAuthTestIdentity;
  authError?: unknown;
  transportApiAppId?: string;
}): SlackInstallationIdentity {
  const auth = params.auth;
  if (!auth) {
    if (params.enterpriseOrgInstall) {
      throw new Error(
        `Slack enterpriseOrgInstall=true requires a successful auth.test (${formatSlackError(params.authError)})`,
      );
    }
    return { kind: "degraded", reason: "auth_test_failed" };
  }

  const isEnterpriseInstall = auth.is_enterprise_install === true;
  if (isEnterpriseInstall !== params.enterpriseOrgInstall) {
    throw new Error(
      isEnterpriseInstall
        ? "Slack auth.test detected an org-wide installation; set enterpriseOrgInstall=true"
        : "Slack enterpriseOrgInstall=true requires an org-wide bot installation",
    );
  }

  const apiAppId = normalizeOptionalString(auth.app_id);
  const enterpriseId = normalizeOptionalString(auth.enterprise_id);
  if (params.enterpriseOrgInstall) {
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
  return {
    kind: "workspace",
    teamId,
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
  // Org-wide installs intentionally have no single workspace bot user. Their
  // enterprise identity is sufficient; applying the workspace gate would
  // report every healthy org install as degraded.
  if (params.installationIdentity.kind === "enterprise") {
    return { healthState: "healthy", lastError: null };
  }

  const lastError =
    normalizeOptionalString(params.authTestError) ??
    normalizeOptionalString(params.authIdentityWarning) ??
    (params.installationIdentity.kind === "degraded" || !params.botUserId.trim()
      ? "slack bot identity unavailable"
      : undefined);
  return lastError
    ? { healthState: "degraded", lastError }
    : { healthState: "healthy", lastError: null };
}
