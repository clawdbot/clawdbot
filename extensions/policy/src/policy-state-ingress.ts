// Policy plugin ingress evidence.
import {
  isRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { configuredChannels } from "./policy-state-core.js";
import { ocPathSegment } from "./policy-state-helpers.js";
import { IMPLICIT_DEFAULT_ACCOUNT_FIELDS } from "./policy-state-tool-posture.js";
import { RESERVED_CHANNEL_CONFIG_KEYS } from "./policy-state-types.js";
import type { PolicyIngressEvidence } from "./policy-state-types.js";

const ALLOWLIST_DEFAULT_INGRESS_GROUP_POLICY_CHANNELS = new Set([
  "googlechat",
  "irc",
  "line",
  "mattermost",
  "matrix",
  "msteams",
  "nextcloud-talk",
  "signal",
]);

const OPEN_GROUPS_DEFAULT_TO_NO_MENTION_CHANNELS = new Set(["feishu", "qa-channel"]);

export function scanPolicyIngress(cfg: Record<string, unknown>): readonly PolicyIngressEvidence[] {
  const channels = configuredChannels(cfg);
  const channelDefaults = isRecord(channels.defaults) ? channels.defaults : {};
  const inheritedChannelDefaults = pickSupportedIngressDefaults(channelDefaults);
  const channelDefaultsSource = "oc://openclaw.config/channels/defaults";
  const entries: PolicyIngressEvidence[] = [];
  const session = isRecord(cfg.session) ? cfg.session : {};
  const dmScope = readString(session.dmScope)?.toLowerCase();
  entries.push({
    id: "session-dm-scope",
    kind: "sessionDmScope",
    source: "oc://openclaw.config/session/dmScope",
    value: dmScope ?? "main",
    explicit: dmScope !== undefined,
  });

  for (const [channel, value] of Object.entries(channels)) {
    if (RESERVED_CHANNEL_CONFIG_KEYS.has(channel) || !isRecord(value) || value.enabled === false) {
      continue;
    }
    const channelSource = `oc://openclaw.config/channels/${ocPathSegment(channel)}`;
    const accounts = isRecord(value.accounts) ? value.accounts : {};
    const configuredAccounts = Object.entries(accounts).filter(
      (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
    );
    const activeAccounts = configuredAccounts.filter(([, account]) => account.enabled !== false);
    if (configuredAccounts.length === 0 || hasImplicitDefaultAccountConfig(channel, value)) {
      pushChannelIngress(entries, {
        channel,
        config: value,
        inheritedConfig: inheritedChannelDefaults,
        sourceBase: channelSource,
        inheritedSourceBase: channelDefaultsSource,
        fallbackSourceBase: channelSource,
      });
    }
    for (const [accountId, account] of activeAccounts) {
      const inheritsNestedContainers = channel !== "telegram" || configuredAccounts.length <= 1;
      pushChannelIngress(entries, {
        channel,
        accountId,
        config: account,
        inheritedConfig: value,
        inheritNestedContainers: inheritsNestedContainers,
        sourceBase: `${channelSource}/accounts/${ocPathSegment(accountId)}`,
        inheritedSourceBase: channelSource,
        fallbackConfig: inheritedChannelDefaults,
        fallbackSourceBase: channelDefaultsSource,
      });
    }
  }
  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

function pickSupportedIngressDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (config.groupPolicy !== undefined) {
    result.groupPolicy = config.groupPolicy;
  }
  return result;
}

function hasImplicitDefaultAccountConfig(
  channel: string,
  config: Record<string, unknown>,
): boolean {
  switch (channel) {
    case "clickclack":
      return (
        hasConfiguredAccountValue(config.baseUrl) &&
        hasConfiguredAccountValue(config.workspace) &&
        hasConfiguredAccountValue(config.token)
      );
    case "feishu":
      return hasConfiguredAccountValue(config.appId) && hasConfiguredAccountValue(config.appSecret);
    case "irc":
      return hasConfiguredAccountValue(config.host) && hasConfiguredAccountValue(config.nick);
    case "line":
      return (
        hasConfiguredAccountValue(config.channelAccessToken) ||
        hasConfiguredAccountValue(config.tokenFile)
      );
    case "matrix":
      return (
        hasConfiguredAccountValue(config.homeserver) &&
        (hasConfiguredAccountValue(config.accessToken) ||
          (hasConfiguredAccountValue(config.userId) && hasConfiguredAccountValue(config.password)))
      );
    case "mattermost":
      return (
        hasConfiguredAccountValue(config.baseUrl) && hasConfiguredAccountValue(config.botToken)
      );
    case "nextcloud-talk":
      return (
        hasConfiguredAccountValue(config.baseUrl) &&
        (hasConfiguredAccountValue(config.botSecret) ||
          hasConfiguredAccountValue(config.botSecretFile))
      );
    default:
      return (IMPLICIT_DEFAULT_ACCOUNT_FIELDS[channel] ?? []).some((field) =>
        hasConfiguredAccountValue(config[field]),
      );
  }
}

function hasConfiguredAccountValue(value: unknown): boolean {
  return typeof value === "string"
    ? value.trim().length > 0
    : value !== undefined && value !== null;
}

type ChannelIngressParams = {
  readonly channel: string;
  readonly accountId?: string;
  readonly config: Record<string, unknown>;
  readonly inheritedConfig: Record<string, unknown>;
  readonly inheritNestedContainers?: boolean;
  readonly sourceBase: string;
  readonly inheritedSourceBase: string;
  readonly fallbackConfig?: Record<string, unknown>;
  readonly fallbackSourceBase: string;
};

function pushChannelIngress(entries: PolicyIngressEvidence[], params: ChannelIngressParams): void {
  const localDmPolicy = channelDmPolicy(params.config);
  const inheritedDmPolicy = channelDmPolicy(params.inheritedConfig);
  const fallbackDmPolicy = channelDmPolicy(params.fallbackConfig ?? {});
  const effectiveDmPolicy =
    localDmPolicy.disabledByEnabled === true
      ? localDmPolicy
      : localDmPolicy.value !== undefined
        ? localDmPolicy
        : inheritedDmPolicy.disabledByEnabled === true
          ? inheritedDmPolicy
          : inheritedDmPolicy.value !== undefined
            ? inheritedDmPolicy
            : fallbackDmPolicy.disabledByEnabled === true || fallbackDmPolicy.value !== undefined
              ? fallbackDmPolicy
              : undefined;
  const dmPolicySource =
    effectiveDmPolicy?.sourceSuffix === undefined
      ? `${params.fallbackSourceBase}/dmPolicy`
      : effectiveDmPolicy === localDmPolicy
        ? `${params.sourceBase}/${effectiveDmPolicy.sourceSuffix}`
        : effectiveDmPolicy === inheritedDmPolicy
          ? `${params.inheritedSourceBase}/${effectiveDmPolicy.sourceSuffix}`
          : `${params.fallbackSourceBase}/${effectiveDmPolicy.sourceSuffix}`;
  entries.push({
    id: channelIngressId(params, "dm-policy"),
    kind: "channelDmPolicy",
    source: dmPolicySource,
    channel: params.channel,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    value: effectiveDmPolicy?.value ?? "pairing",
    explicit: effectiveDmPolicy !== undefined,
  });

  const localGroupPolicy = readString(params.config.groupPolicy);
  const inheritedGroupPolicy = readString(params.inheritedConfig.groupPolicy);
  const fallbackGroupPolicy = readString(params.fallbackConfig?.groupPolicy);
  const implicitGroupPolicy = channelImplicitGroupPolicy(params);
  entries.push({
    id: channelIngressId(params, "group-policy"),
    kind: "channelGroupPolicy",
    source:
      localGroupPolicy !== undefined
        ? `${params.sourceBase}/groupPolicy`
        : inheritedGroupPolicy !== undefined
          ? `${params.inheritedSourceBase}/groupPolicy`
          : fallbackGroupPolicy !== undefined
            ? `${params.fallbackSourceBase}/groupPolicy`
            : implicitGroupPolicy.source,
    channel: params.channel,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    value:
      localGroupPolicy ?? inheritedGroupPolicy ?? fallbackGroupPolicy ?? implicitGroupPolicy.value,
    explicit:
      localGroupPolicy !== undefined ||
      inheritedGroupPolicy !== undefined ||
      fallbackGroupPolicy !== undefined,
  });

  pushChannelRequireMentionIngress(entries, params);
}

function channelImplicitGroupPolicy(params: ChannelIngressParams): {
  readonly source: string;
  readonly value: "allowlist" | "open";
} {
  for (const [config, sourceBase] of [
    [params.config, params.sourceBase],
    ...(params.inheritNestedContainers === true
      ? ([[params.inheritedConfig, params.inheritedSourceBase]] as const)
      : []),
    [params.fallbackConfig, params.fallbackSourceBase],
  ] as const) {
    if (config === undefined || sourceBase === undefined) {
      continue;
    }
    for (const key of ["groups"] as const) {
      const container = isRecord(config[key]) ? config[key] : undefined;
      if (container !== undefined && Object.keys(container).length > 0) {
        return { source: `${sourceBase}/${key}`, value: "allowlist" };
      }
    }
  }
  return {
    source: `${params.sourceBase}/groupPolicy`,
    value: ALLOWLIST_DEFAULT_INGRESS_GROUP_POLICY_CHANNELS.has(params.channel)
      ? "allowlist"
      : "open",
  };
}

function pushChannelRequireMentionIngress(
  entries: PolicyIngressEvidence[],
  params: ChannelIngressParams,
): void {
  const localRequireMention = readBoolean(params.config.requireMention);
  const inheritedRequireMention = readBoolean(params.inheritedConfig.requireMention);
  const fallbackRequireMention = readBoolean(params.fallbackConfig?.requireMention);
  const wildcardRequireMention = channelWildcardRequireMention(params);
  const defaultRequireMention = channelDefaultRequireMention(params);
  entries.push({
    id: channelIngressId(params, "require-mention"),
    kind: "channelRequireMention",
    source:
      wildcardRequireMention !== undefined
        ? wildcardRequireMention.source
        : localRequireMention !== undefined
          ? `${params.sourceBase}/requireMention`
          : inheritedRequireMention !== undefined
            ? `${params.inheritedSourceBase}/requireMention`
            : fallbackRequireMention !== undefined
              ? `${params.fallbackSourceBase}/requireMention`
              : `${params.sourceBase}/requireMention`,
    channel: params.channel,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    value:
      wildcardRequireMention?.value ??
      localRequireMention ??
      inheritedRequireMention ??
      fallbackRequireMention ??
      defaultRequireMention,
    explicit:
      wildcardRequireMention !== undefined ||
      localRequireMention !== undefined ||
      inheritedRequireMention !== undefined ||
      fallbackRequireMention !== undefined,
  });

  const containers = nestedIngressContainers(params);
  for (const { containerKey, container, sourceBase } of containers) {
    for (const [groupId, groupConfig] of Object.entries(container)) {
      if (!isRecord(groupConfig)) {
        continue;
      }
      pushNestedRequireMentionIngress(
        entries,
        params,
        containerKey,
        groupId,
        groupConfig,
        sourceBase,
      );
    }
  }
}

function channelDefaultRequireMention(params: ChannelIngressParams): boolean {
  const groupPolicy =
    readString(params.config.groupPolicy) ??
    readString(params.inheritedConfig.groupPolicy) ??
    readString(params.fallbackConfig?.groupPolicy) ??
    channelImplicitGroupPolicy(params).value;
  return !(
    groupPolicy === "open" && OPEN_GROUPS_DEFAULT_TO_NO_MENTION_CHANNELS.has(params.channel)
  );
}

function channelWildcardRequireMention(
  params: ChannelIngressParams,
): { readonly source: string; readonly value: boolean } | undefined {
  for (const [config, sourceBase] of [
    [params.config, params.sourceBase],
    [params.inheritedConfig, params.inheritedSourceBase],
    [params.fallbackConfig, params.fallbackSourceBase],
  ] as const) {
    if (config === undefined || sourceBase === undefined) {
      continue;
    }
    for (const key of ["groups", "guilds", "channels", "rooms", "teams"] as const) {
      const container = isRecord(config[key]) ? config[key] : undefined;
      const wildcard = isRecord(container?.["*"]) ? container["*"] : undefined;
      const requireMention = readBoolean(wildcard?.requireMention);
      if (wildcard?.enabled !== false && requireMention !== undefined) {
        return {
          source: `${sourceBase}/${key}/${ocPathSegment("*")}/requireMention`,
          value: requireMention,
        };
      }
    }
  }
  return undefined;
}

function nestedIngressContainers(params: ChannelIngressParams): readonly {
  readonly containerKey: string;
  readonly container: Record<string, unknown>;
  readonly sourceBase: string;
}[] {
  const containers: {
    readonly containerKey: string;
    readonly container: Record<string, unknown>;
    readonly sourceBase: string;
  }[] = [];
  for (const key of ["groups", "guilds", "channels", "rooms", "teams"] as const) {
    const local = isRecord(params.config[key]) ? params.config[key] : undefined;
    const inherited = isRecord(params.inheritedConfig[key])
      ? params.inheritedConfig[key]
      : undefined;
    if (local !== undefined) {
      if (Object.keys(local).length > 0) {
        containers.push({ containerKey: key, container: local, sourceBase: params.sourceBase });
      }
    } else if (params.inheritNestedContainers === true && inherited !== undefined) {
      containers.push({
        containerKey: key,
        container: inherited,
        sourceBase: params.inheritedSourceBase,
      });
    }
  }
  return containers;
}

function pushNestedRequireMentionIngress(
  entries: PolicyIngressEvidence[],
  params: ChannelIngressParams,
  containerKey: string,
  groupId: string,
  config: Record<string, unknown>,
  parentSourceBase: string,
): void {
  if (config.enabled === false) {
    return;
  }
  const sourceBase = `${parentSourceBase}/${containerKey}/${ocPathSegment(groupId)}`;
  const requireMention = readBoolean(config.requireMention);
  if (requireMention !== undefined) {
    entries.push({
      id: `${channelIngressId(params, `${containerKey}-${ocPathSegment(groupId)}`)}-require-mention`,
      kind: "channelRequireMention",
      source: `${sourceBase}/requireMention`,
      channel: params.channel,
      ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
      groupId,
      value: requireMention ?? true,
      explicit: requireMention !== undefined,
    });
  }
  for (const nestedKey of ["channels", "topics"] as const) {
    const nested = config[nestedKey];
    if (!isRecord(nested)) {
      continue;
    }
    for (const [nestedId, nestedConfig] of Object.entries(nested)) {
      if (isRecord(nestedConfig)) {
        pushNestedRequireMentionIngress(
          entries,
          params,
          `${containerKey}/${ocPathSegment(groupId)}/${nestedKey}`,
          nestedId,
          nestedConfig,
          parentSourceBase,
        );
      }
    }
  }
}

function channelDmPolicy(config: Record<string, unknown>): {
  readonly value?: string;
  readonly sourceSuffix?: string;
  readonly disabledByEnabled?: boolean;
} {
  const dm = isRecord(config.dm) ? config.dm : {};
  if (dm.enabled === false) {
    return { value: "disabled", sourceSuffix: "dm/enabled", disabledByEnabled: true };
  }
  const direct = readString(config.dmPolicy);
  if (direct !== undefined) {
    return { value: direct, sourceSuffix: "dmPolicy" };
  }
  const legacy = readString(dm.policy);
  return legacy === undefined ? {} : { value: legacy, sourceSuffix: "dm/policy" };
}

function channelIngressId(params: ChannelIngressParams, suffix: string): string {
  return params.accountId === undefined
    ? `${params.channel}-${suffix}`
    : `${params.channel}-${params.accountId}-${suffix}`;
}
