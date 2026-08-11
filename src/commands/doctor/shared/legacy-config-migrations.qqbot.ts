// One-time QQBot migrations for the Tencent 2.0 external plugin boundary.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import {
  hasOwnKey,
  listQQBotConfigEntries,
  migrateClientSecretFile,
  migrateDefaultAccount,
  shouldCreateEnvironmentOnlyQQBotConfig,
} from "./legacy-config-migrations.qqbot-account.js";

const APPROVALS_DISABLED_SENTINEL = "openclaw:approval-disabled";

function hasQQBotEntryMatching(
  value: unknown,
  predicate: (entry: Record<string, unknown>, inheritedEntry?: Record<string, unknown>) => boolean,
): boolean {
  const qqbot = getRecord(value);
  return Boolean(
    qqbot &&
    listQQBotConfigEntries(qqbot).some(({ entry, inheritedEntry }) =>
      predicate(entry, inheritedEntry),
    ),
  );
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((item): item is string | number => ["string", "number"].includes(typeof item))
        .map((item) => String(item).trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeLegacyAllowFrom(value: unknown): string[] {
  return [
    ...new Set(
      normalizeIds(value).map((id) => {
        const unprefixed = id.replace(/^qqbot:/i, "");
        if (unprefixed === "*" || unprefixed === APPROVALS_DISABLED_SENTINEL) {
          return unprefixed;
        }
        // The bundled plugin compared QQ OpenIDs case-insensitively, while Tencent
        // 2.0 expects its canonical uppercase form for runtime allowlist checks.
        return unprefixed.toUpperCase();
      }),
    ),
  ];
}

function resolveLegacyQQBotCommandsAllowFrom(raw: Record<string, unknown>): string[] | undefined {
  const commands = getRecord(raw.commands);
  const allowFrom = getRecord(commands?.allowFrom);
  if (!allowFrom) {
    return undefined;
  }
  if (Array.isArray(allowFrom.qqbot)) {
    return normalizeLegacyAllowFrom(allowFrom.qqbot);
  }
  return Array.isArray(allowFrom["*"]) ? normalizeLegacyAllowFrom(allowFrom["*"]) : undefined;
}

function hasConfiguredFilter(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined;
}

function migrateExecApprovals(params: {
  entry: Record<string, unknown>;
  path: string;
  changes: string[];
  inheritedEntry?: Record<string, unknown>;
  commandsAllowFrom?: string[];
}): void {
  const hasOwnLegacyConfig = hasOwnKey(params.entry, "execApprovals");
  const hasLegacyConfig = hasOwnLegacyConfig || params.inheritedEntry?.execApprovals !== undefined;
  const hasOwnPolicyOverride =
    hasOwnLegacyConfig ||
    hasOwnKey(params.entry, "allowFrom") ||
    hasOwnKey(params.entry, "dmPolicy");
  if (params.inheritedEntry && !hasOwnPolicyOverride) {
    return;
  }
  const legacy = getRecord(
    hasOwnLegacyConfig ? params.entry.execApprovals : params.inheritedEntry?.execApprovals,
  );
  const allowFromValue = hasOwnKey(params.entry, "allowFrom")
    ? params.entry.allowFrom
    : params.inheritedEntry?.allowFrom;
  const dmPolicy = hasOwnKey(params.entry, "dmPolicy")
    ? params.entry.dmPolicy
    : params.inheritedEntry?.dmPolicy;
  const existingAllowFrom = normalizeLegacyAllowFrom(allowFromValue);
  const explicitApprovers = normalizeLegacyAllowFrom(legacy?.approvers);
  const allowFromWasOpen = existingAllowFrom.length === 0 || existingAllowFrom.includes("*");
  const preserveOpenDm =
    dmPolicy === "open" ||
    (dmPolicy === undefined && allowFromWasOpen) ||
    (dmPolicy === "allowlist" && existingAllowFrom.includes("*"));
  if (!hasLegacyConfig) {
    if (params.commandsAllowFrom !== undefined) {
      const commandApprovers = params.commandsAllowFrom.filter((id) => id !== "*");
      const restrictiveChatAllowFrom = new Set(existingAllowFrom.filter((id) => id !== "*"));
      const safeApprovers =
        existingAllowFrom.length > 0 && !existingAllowFrom.includes("*")
          ? commandApprovers.filter((id) => restrictiveChatAllowFrom.has(id))
          : commandApprovers;
      const nextAllowFrom =
        safeApprovers.length > 0 ? safeApprovers : [APPROVALS_DISABLED_SENTINEL];
      const needsOpenDm = preserveOpenDm && dmPolicy !== "open";
      if (
        existingAllowFrom.length === nextAllowFrom.length &&
        existingAllowFrom.every((id, index) => id === nextAllowFrom[index]) &&
        !needsOpenDm
      ) {
        return;
      }
      params.entry.allowFrom = nextAllowFrom;
      if (needsOpenDm) {
        params.entry.dmPolicy = "open";
      }
      params.changes.push(
        `Secured ${params.path}.allowFrom for Tencent QQBot 2.0 native approvals using the previous commands.allowFrom operator list${safeApprovers.length > 0 ? " intersected with restrictive chat access" : "; no safely representable operator remained, so approvals were locked"}.`,
      );
      return;
    }
    if (!allowFromWasOpen) {
      return;
    }
    const explicitAllowFrom = existingAllowFrom.filter((id) => id !== "*");
    params.entry.allowFrom =
      explicitAllowFrom.length > 0 ? explicitAllowFrom : [APPROVALS_DISABLED_SENTINEL];
    if (preserveOpenDm) {
      params.entry.dmPolicy = "open";
    }
    params.changes.push(
      `Secured ${params.path}.allowFrom for Tencent QQBot 2.0 native approvals; wildcard/empty approval access was replaced with ${explicitAllowFrom.length > 0 ? "the existing explicit IDs" : "a non-matching marker"} while preserving open DM access separately.`,
    );
    return;
  }
  const hasUnsupportedPolicy =
    !legacy ||
    legacy.enabled === false ||
    hasConfiguredFilter(legacy.agentFilter) ||
    hasConfiguredFilter(legacy.sessionFilter) ||
    legacy.target !== undefined;
  let nextAllowFrom: string[];
  let reason: string;
  if (hasUnsupportedPolicy || explicitApprovers.includes("*")) {
    nextAllowFrom = [APPROVALS_DISABLED_SENTINEL];
    reason =
      "the Tencent 2.0 plugin cannot represent the previous approval policy, so native approval actions were locked";
  } else if (explicitApprovers.length > 0) {
    const restrictiveAllowFrom = new Set(existingAllowFrom.filter((id) => id !== "*"));
    nextAllowFrom =
      dmPolicy === "allowlist" && existingAllowFrom.length === 0
        ? []
        : existingAllowFrom.length > 0 && !existingAllowFrom.includes("*")
          ? explicitApprovers.filter((id) => restrictiveAllowFrom.has(id))
          : explicitApprovers;
    if (nextAllowFrom.length === 0) {
      nextAllowFrom = [APPROVALS_DISABLED_SENTINEL];
      reason =
        "the approval and chat allowlists did not overlap, so native approval actions were locked";
    } else {
      reason = "approval access was intersected with the existing chat allowlist";
    }
  } else if (existingAllowFrom.length > 0 && !existingAllowFrom.includes("*")) {
    // A configured execApprovals object fell back directly to channel allowFrom;
    // commands.allowFrom applied only to the unconfigured same-chat path above.
    nextAllowFrom = existingAllowFrom;
    reason = "the existing restrictive chat allowlist remains the approval allowlist";
  } else {
    nextAllowFrom = [APPROVALS_DISABLED_SENTINEL];
    reason =
      "the previous same-chat or wildcard policy has no safe Tencent 2.0 representation, so native approval actions were locked";
  }
  // Tencent uses allowFrom for both chat and approval actions. Keep an already
  // open DM surface open when approval-only policy must become restrictive.
  if (preserveOpenDm && !nextAllowFrom.includes("*")) {
    params.entry.dmPolicy = "open";
  }
  params.entry.allowFrom = nextAllowFrom;
  delete params.entry.execApprovals;
  params.changes.push(
    `Moved ${params.path}.execApprovals → ${params.path}.allowFrom; ${reason}. Review chat access before re-enabling broader approval access.`,
  );
}

function migrateAllowFrom(params: {
  entry: Record<string, unknown>;
  path: string;
  changes: string[];
}): void {
  const current = normalizeIds(params.entry.allowFrom);
  const normalized = normalizeLegacyAllowFrom(params.entry.allowFrom);
  if (current.every((id, index) => id === normalized[index])) {
    return;
  }
  params.entry.allowFrom = normalized;
  params.changes.push(
    `Normalized ${params.path}.allowFrom QQBot-prefixed IDs for Tencent QQBot 2.0.`,
  );
}

function hasLegacyStreamingTransport(entry: Record<string, unknown>): boolean {
  const streaming = getRecord(entry.streaming);
  return Boolean(
    streaming && (hasOwnKey(streaming, "nativeTransport") || hasOwnKey(streaming, "c2cStreamApi")),
  );
}

function migrateStreamingTransport(params: {
  entry: Record<string, unknown>;
  path: string;
  changes: string[];
}): void {
  const streaming = getRecord(params.entry.streaming);
  if (!streaming || !hasLegacyStreamingTransport(params.entry)) {
    return;
  }
  const transport =
    typeof streaming.nativeTransport === "boolean"
      ? streaming.nativeTransport
      : typeof streaming.c2cStreamApi === "boolean"
        ? streaming.c2cStreamApi
        : undefined;
  delete streaming.nativeTransport;
  delete streaming.c2cStreamApi;
  if (transport !== undefined) {
    // The bundled runtime evaluated nativeTransport independently of mode, so
    // true still streamed with mode=off. Preserve the effective wire behavior.
    streaming.mode = transport ? "partial" : "off";
  }
  params.changes.push(
    `Removed unsupported ${params.path}.streaming native transport keys for Tencent QQBot 2.0${transport === undefined ? "" : ` and set mode=${String(streaming.mode)}`}.`,
  );
}

function mapTencentToolPolicy(value: unknown): "full" | "restricted" | "none" {
  const policy = getRecord(value);
  const allow = Array.isArray(policy?.allow) ? policy.allow.map(String) : undefined;
  const deny = Array.isArray(policy?.deny) ? policy.deny.map(String) : undefined;
  const allowsAll = !allow || allow.length === 0 || allow.includes("*");
  if (allowsAll && (!deny || deny.length === 0)) {
    // The old runtime expands alsoAllow without an explicit allowlist to an
    // implicit wildcard, so this group layer did not restrict the tool set.
    return "full";
  }
  if (deny?.length === 1 && deny[0] === "*") {
    return "none";
  }
  if (
    allowsAll &&
    deny?.length === 3 &&
    ["exec", "read", "write"].every((tool) => deny.includes(tool))
  ) {
    return "restricted";
  }
  return "none";
}

function mostRestrictiveTencentToolPolicy(
  first: unknown,
  second: "full" | "restricted" | "none",
): "full" | "restricted" | "none" {
  const rank = { none: 0, restricted: 1, full: 2 } as const;
  const normalizedFirst =
    first === "full" || first === "restricted" || first === "none" ? first : "none";
  return rank[normalizedFirst] <= rank[second] ? normalizedFirst : second;
}

function migrateGroupTools(params: {
  entry: Record<string, unknown>;
  path: string;
  changes: string[];
}): void {
  const groups = getRecord(params.entry.groups);
  if (!groups) {
    return;
  }
  for (const [groupId, groupValue] of Object.entries(groups)) {
    const group = getRecord(groupValue);
    if (!group || (!hasOwnKey(group, "tools") && !hasOwnKey(group, "toolsBySender"))) {
      continue;
    }
    const groupPath = `${params.path}.groups.${groupId}`;
    const migratedPolicy = hasOwnKey(group, "toolsBySender")
      ? "none"
      : mapTencentToolPolicy(group.tools);
    group.toolPolicy =
      group.toolPolicy === undefined
        ? migratedPolicy
        : mostRestrictiveTencentToolPolicy(group.toolPolicy, migratedPolicy);
    params.changes.push(
      `Moved ${groupPath}.tools policy → ${groupPath}.toolPolicy=${String(group.toolPolicy)} for Tencent QQBot 2.0, preserving the most restrictive configured policy.`,
    );
    delete group.tools;
    if (hasOwnKey(group, "toolsBySender")) {
      delete group.toolsBySender;
      params.changes.push(
        `Removed ${groupPath}.toolsBySender; Tencent QQBot 2.0 cannot represent sender-specific tool policy, so the group policy was not broadened.`,
      );
    }
  }
}

function hasLegacyGroupCommandLevel(entry: Record<string, unknown>): boolean {
  const groups = getRecord(entry.groups);
  return Boolean(
    groups &&
    Object.values(groups).some((groupValue) => {
      const group = getRecord(groupValue);
      return Boolean(group && hasOwnKey(group, "commandLevel"));
    }),
  );
}

function migrateGroupCommandLevels(params: {
  entry: Record<string, unknown>;
  path: string;
  changes: string[];
  inheritedEntry?: Record<string, unknown>;
}): void {
  const groups = getRecord(params.entry.groups);
  if (!groups) {
    const inheritedGroups = getRecord(params.inheritedEntry?.groups);
    const inheritsRestrictiveCommandLevel = Boolean(
      inheritedGroups &&
      Object.values(inheritedGroups).some((groupValue) => {
        const group = getRecord(groupValue);
        return Boolean(group && hasOwnKey(group, "commandLevel") && group.commandLevel !== "all");
      }),
    );
    if (
      inheritsRestrictiveCommandLevel &&
      params.entry.groupPolicy !== undefined &&
      params.entry.groupPolicy !== "disabled"
    ) {
      // accounts.default inherits the root groups map but can override the
      // root groupPolicy. Carry the fail-closed lock into that override.
      params.entry.groupPolicy = "disabled";
      params.changes.push(
        `Set ${params.path}.groupPolicy=disabled because this default account overrides the root lock while inheriting a safety/strict group command policy that Tencent QQBot 2.0 cannot represent.`,
      );
    }
    return;
  }
  let requiresLock = false;
  for (const [groupId, groupValue] of Object.entries(groups)) {
    const group = getRecord(groupValue);
    if (!group || !hasOwnKey(group, "commandLevel")) {
      continue;
    }
    const commandLevel = group.commandLevel;
    if (commandLevel !== "all") {
      requiresLock = true;
    }
    delete group.commandLevel;
    params.changes.push(
      `Removed unsupported ${params.path}.groups.${groupId}.commandLevel=${String(commandLevel)} for Tencent QQBot 2.0.`,
    );
  }
  if (!requiresLock) {
    return;
  }
  // Tencent has no per-group command restriction. Disable this account's group
  // surface so a former safety/strict policy cannot silently become all-access.
  params.entry.groupPolicy = "disabled";
  params.changes.push(
    `Set ${params.path}.groupPolicy=disabled because Tencent QQBot 2.0 cannot represent a previous safety/strict group command policy. Review the account before re-enabling group access.`,
  );
}

const QQBOT_EXTERNALIZATION_RULES: LegacyConfigRule[] = [
  {
    path: [],
    message:
      'Environment-only QQBot credentials need a safe Tencent QQBot 2.0 config shell. Run "openclaw doctor --fix".',
    match: (_value, root) => shouldCreateEnvironmentOnlyQQBotConfig(root),
  },
  {
    path: ["channels", "qqbot"],
    message:
      'QQBot defaultAccount/accounts.default must migrate to Tencent QQBot 2.0 account selection. Run "openclaw doctor --fix".',
    match: (value) => {
      const qqbot = getRecord(value);
      return Boolean(
        qqbot &&
        (hasOwnKey(qqbot, "defaultAccount") || getRecord(getRecord(qqbot.accounts)?.default)),
      );
    },
  },
  {
    path: ["channels", "qqbot"],
    message:
      'QQBot clientSecretFile must migrate to a file-backed SecretRef for Tencent QQBot 2.0. Run "openclaw doctor --fix".',
    match: (value) => hasQQBotEntryMatching(value, (entry) => hasOwnKey(entry, "clientSecretFile")),
  },
  {
    path: ["channels", "qqbot"],
    message:
      'QQBot wildcard/empty allowFrom must be separated from Tencent QQBot 2.0 native approval access. Run "openclaw doctor --fix".',
    match: (value) =>
      hasQQBotEntryMatching(value, (entry, inheritedEntry) => {
        if (hasOwnKey(entry, "execApprovals")) {
          return false;
        }
        const allowFrom = normalizeLegacyAllowFrom(
          hasOwnKey(entry, "allowFrom") ? entry.allowFrom : inheritedEntry?.allowFrom,
        );
        return allowFrom.length === 0 || allowFrom.includes("*");
      }),
  },
  {
    path: ["channels", "qqbot"],
    message:
      'QQBot chat allowFrom must be reconciled with the previous commands.allowFrom approval operators for Tencent QQBot 2.0. Run "openclaw doctor --fix".',
    match: (value, root) => {
      const commandsAllowFrom = resolveLegacyQQBotCommandsAllowFrom(root);
      if (commandsAllowFrom === undefined) {
        return false;
      }
      const commandApprovers = new Set(commandsAllowFrom.filter((id) => id !== "*"));
      return hasQQBotEntryMatching(value, (entry, inheritedEntry) => {
        if (
          hasOwnKey(entry, "execApprovals") ||
          (!hasOwnKey(entry, "allowFrom") && inheritedEntry?.execApprovals !== undefined)
        ) {
          return false;
        }
        const allowFrom = normalizeLegacyAllowFrom(
          hasOwnKey(entry, "allowFrom") ? entry.allowFrom : inheritedEntry?.allowFrom,
        ).filter((id) => id !== "*" && id !== APPROVALS_DISABLED_SENTINEL);
        return allowFrom.some((id) => !commandApprovers.has(id));
      });
    },
  },
  {
    path: ["channels", "qqbot"],
    message:
      'QQBot groups.*.commandLevel must migrate before Tencent QQBot 2.0 can safely handle group commands. Run "openclaw doctor --fix".',
    match: (value) => hasQQBotEntryMatching(value, hasLegacyGroupCommandLevel),
  },
  {
    path: ["channels", "qqbot"],
    message:
      'QQBot streaming.nativeTransport/c2cStreamApi must migrate to Tencent QQBot 2.0 streaming.mode. Run "openclaw doctor --fix".',
    match: (value) => hasQQBotEntryMatching(value, hasLegacyStreamingTransport),
  },
  {
    path: ["channels", "qqbot"],
    message:
      'QQBot allowFrom IDs must migrate to Tencent QQBot 2.0 canonical uppercase OpenIDs. Run "openclaw doctor --fix".',
    match: (value) =>
      hasQQBotEntryMatching(value, (entry) => {
        const current = normalizeIds(entry.allowFrom);
        const normalized = normalizeLegacyAllowFrom(entry.allowFrom);
        return (
          current.length !== normalized.length ||
          current.some((id, index) => id !== normalized[index])
        );
      }),
  },
  {
    path: ["channels", "qqbot"],
    message:
      'QQBot execApprovals must migrate to Tencent QQBot 2.0 allowFrom semantics. Run "openclaw doctor --fix".',
    match: (value) => hasQQBotEntryMatching(value, (entry) => hasOwnKey(entry, "execApprovals")),
  },
  {
    path: ["channels", "qqbot"],
    message:
      'QQBot group tools policies must migrate to Tencent QQBot 2.0 toolPolicy. Run "openclaw doctor --fix".',
    match: (value) =>
      hasQQBotEntryMatching(value, (entry) => {
        const groups = getRecord(entry.groups);
        return Boolean(
          groups &&
          Object.values(groups).some((groupValue) => {
            const group = getRecord(groupValue);
            return Boolean(
              group && (hasOwnKey(group, "tools") || hasOwnKey(group, "toolsBySender")),
            );
          }),
        );
      }),
  },
];

export const LEGACY_CONFIG_MIGRATIONS_QQBOT: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "qqbot.tencent-2.0-compatibility",
    describe: "Migrate bundled QQBot config to Tencent QQBot 2.0 canonical fields",
    legacyRules: QQBOT_EXTERNALIZATION_RULES,
    apply: (raw, changes) => {
      let channels = getRecord(raw.channels);
      let qqbot = getRecord(channels?.qqbot);
      if (!qqbot && shouldCreateEnvironmentOnlyQQBotConfig(raw)) {
        channels ??= {};
        raw.channels = channels;
        qqbot = {
          enabled: true,
          dmPolicy: "open",
          allowFrom: [APPROVALS_DISABLED_SENTINEL],
        };
        channels.qqbot = qqbot;
        changes.push(
          "Created channels.qqbot for environment-only Tencent QQBot 2.0 credentials with native approvals locked; no credential value was copied into config.",
        );
      }
      if (!qqbot) {
        return;
      }
      migrateDefaultAccount(qqbot, changes);
      const commandsAllowFrom = resolveLegacyQQBotCommandsAllowFrom(raw);
      for (const item of listQQBotConfigEntries(qqbot)) {
        migrateClientSecretFile({ raw, changes, ...item });
        migrateExecApprovals({ changes, commandsAllowFrom, ...item });
        migrateAllowFrom({ changes, ...item });
        migrateStreamingTransport({ changes, ...item });
        migrateGroupTools({ changes, ...item });
        migrateGroupCommandLevels({ changes, ...item });
      }
    },
  }),
];
