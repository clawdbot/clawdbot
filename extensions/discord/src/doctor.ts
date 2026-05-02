import { type ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { collectProviderDangerousNameMatchingScopes } from "openclaw/plugin-sdk/runtime-doctor";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { inspectDiscordAccount } from "./account-inspect.js";
import { resolveDefaultDiscordAccountId } from "./accounts.js";
import { normalizeCompatibilityConfig as normalizeDiscordCompatibilityConfig } from "./doctor-contract.js";
import { DISCORD_LEGACY_CONFIG_RULES } from "./doctor-shared.js";
import { isDiscordMutableAllowEntry } from "./security-doctor.js";

type DiscordNumericIdHit = { path: string; entry: number; safe: boolean };

type DiscordIdListRef = {
  pathLabel: string;
  holder: Record<string, unknown>;
  key: string;
};

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizeForLog(value: string): string {
  return value.replace(/\p{Cc}+/gu, " ").trim();
}

function collectDiscordAccountScopes(
  cfg: OpenClawConfig,
): Array<{ prefix: string; account: Record<string, unknown> }> {
  const scopes: Array<{ prefix: string; account: Record<string, unknown> }> = [];
  const discord = asObjectRecord(cfg.channels?.discord);
  if (!discord) {
    return scopes;
  }

  scopes.push({ prefix: "channels.discord", account: discord });
  const accounts = asObjectRecord(discord.accounts);
  if (!accounts) {
    return scopes;
  }
  for (const key of Object.keys(accounts)) {
    const account = asObjectRecord(accounts[key]);
    if (account) {
      scopes.push({ prefix: `channels.discord.accounts.${key}`, account });
    }
  }
  return scopes;
}

function collectDiscordIdLists(
  prefix: string,
  account: Record<string, unknown>,
): DiscordIdListRef[] {
  const refs: DiscordIdListRef[] = [
    { pathLabel: `${prefix}.allowFrom`, holder: account, key: "allowFrom" },
  ];
  const dm = asObjectRecord(account.dm);
  if (dm) {
    refs.push({ pathLabel: `${prefix}.dm.allowFrom`, holder: dm, key: "allowFrom" });
    refs.push({ pathLabel: `${prefix}.dm.groupChannels`, holder: dm, key: "groupChannels" });
  }
  const execApprovals = asObjectRecord(account.execApprovals);
  if (execApprovals) {
    refs.push({
      pathLabel: `${prefix}.execApprovals.approvers`,
      holder: execApprovals,
      key: "approvers",
    });
  }
  const guilds = asObjectRecord(account.guilds);
  if (!guilds) {
    return refs;
  }
  for (const guildId of Object.keys(guilds)) {
    const guild = asObjectRecord(guilds[guildId]);
    if (!guild) {
      continue;
    }
    refs.push({ pathLabel: `${prefix}.guilds.${guildId}.users`, holder: guild, key: "users" });
    refs.push({ pathLabel: `${prefix}.guilds.${guildId}.roles`, holder: guild, key: "roles" });
    const channels = asObjectRecord(guild.channels);
    if (!channels) {
      continue;
    }
    for (const channelId of Object.keys(channels)) {
      const channel = asObjectRecord(channels[channelId]);
      if (!channel) {
        continue;
      }
      refs.push({
        pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.users`,
        holder: channel,
        key: "users",
      });
      refs.push({
        pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.roles`,
        holder: channel,
        key: "roles",
      });
    }
  }
  return refs;
}

export function scanDiscordNumericIdEntries(cfg: OpenClawConfig): DiscordNumericIdHit[] {
  const hits: DiscordNumericIdHit[] = [];
  const scanList = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const [index, entry] of list.entries()) {
      if (typeof entry !== "number") {
        continue;
      }
      hits.push({
        path: `${pathLabel}[${index}]`,
        entry,
        safe: Number.isSafeInteger(entry) && entry >= 0,
      });
    }
  };

  for (const scope of collectDiscordAccountScopes(cfg)) {
    for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) {
      scanList(ref.pathLabel, ref.holder[ref.key]);
    }
  }
  return hits;
}

export function collectDiscordNumericIdWarnings(params: {
  hits: DiscordNumericIdHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const hitsByListPath = new Map<string, DiscordNumericIdHit[]>();
  for (const hit of params.hits) {
    const listPath = hit.path.replace(/\[\d+\]$/, "");
    const existing = hitsByListPath.get(listPath);
    if (existing) {
      existing.push(hit);
    } else {
      hitsByListPath.set(listPath, [hit]);
    }
  }

  const repairableHits: DiscordNumericIdHit[] = [];
  const blockedHits: DiscordNumericIdHit[] = [];
  for (const hits of hitsByListPath.values()) {
    if (hits.some((hit) => !hit.safe)) {
      blockedHits.push(...hits);
    } else {
      repairableHits.push(...hits);
    }
  }

  const lines: string[] = [];
  if (repairableHits.length > 0) {
    const sample = repairableHits[0];
    lines.push(
      `- Discord allowlists contain ${repairableHits.length} numeric ${repairableHits.length === 1 ? "entry" : "entries"} (e.g. ${sanitizeForLog(sample.path)}=${sanitizeForLog(String(sample.entry))}).`,
      `- Discord IDs must be strings; run "${params.doctorFixCommand}" to convert numeric IDs to quoted strings.`,
    );
  }
  if (blockedHits.length > 0) {
    const sample = blockedHits[0];
    lines.push(
      `- Discord allowlists contain ${blockedHits.length} numeric ${blockedHits.length === 1 ? "entry" : "entries"} in lists that cannot be auto-repaired (e.g. ${sanitizeForLog(sample.path)}).`,
      `- These lists include invalid or precision-losing numeric IDs; manually quote the original values in your config file, then rerun "${params.doctorFixCommand}".`,
    );
  }
  return lines;
}

export function maybeRepairDiscordNumericIds(
  cfg: OpenClawConfig,
  doctorFixCommand: string,
): { config: OpenClawConfig; changes: string[]; warnings?: string[] } {
  const hits = scanDiscordNumericIdEntries(cfg);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];

  const repairList = (pathLabel: string, holder: Record<string, unknown>, key: string) => {
    const raw = holder[key];
    if (!Array.isArray(raw)) {
      return;
    }
    const hasUnsafe = raw.some(
      (entry) => typeof entry === "number" && (!Number.isSafeInteger(entry) || entry < 0),
    );
    if (hasUnsafe) {
      return;
    }
    let converted = 0;
    holder[key] = raw.map((entry) => {
      if (typeof entry === "number") {
        converted += 1;
        return String(entry);
      }
      return entry;
    });
    if (converted > 0) {
      changes.push(
        `- ${sanitizeForLog(pathLabel)}: converted ${converted} numeric ${converted === 1 ? "ID" : "IDs"} to strings`,
      );
    }
  };

  for (const scope of collectDiscordAccountScopes(next)) {
    for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) {
      repairList(ref.pathLabel, ref.holder, ref.key);
    }
  }

  if (changes.length === 0) {
    return {
      config: cfg,
      changes: [],
      warnings: collectDiscordNumericIdWarnings({ hits, doctorFixCommand }),
    };
  }
  return {
    config: next,
    changes,
    warnings: collectDiscordNumericIdWarnings({
      hits: hits.filter((hit) => !hit.safe),
      doctorFixCommand,
    }),
  };
}

export function collectDiscordMissingEnvTokenWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  if (resolveDefaultDiscordAccountId(params.cfg) !== "default") {
    return [];
  }
  const account = inspectDiscordAccount({
    cfg: params.cfg,
    accountId: "default",
    envToken: params.env?.DISCORD_BOT_TOKEN ?? "",
  });
  if (!account.enabled || account.tokenStatus !== "missing" || account.tokenSource !== "none") {
    return [];
  }
  return [
    "- channels.discord: default account has no available bot token, and DISCORD_BOT_TOKEN is absent in this doctor environment. After migration, verify DISCORD_BOT_TOKEN is present in the state-dir .env or configure channels.discord.token / channels.discord.accounts.default.token as a SecretRef.",
  ];
}

function collectDiscordMutableAllowlistWarnings(cfg: OpenClawConfig): string[] {
  const hits: Array<{ path: string; entry: string }> = [];
  const addHits = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const entry of list) {
      const text = normalizeOptionalString(String(entry)) ?? "";
      if (!text || text === "*" || !isDiscordMutableAllowEntry(text)) {
        continue;
      }
      hits.push({ path: pathLabel, entry: text });
    }
  };

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "discord")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addHits(`${scope.prefix}.allowFrom`, scope.account.allowFrom);
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addHits(`${scope.prefix}.dm.allowFrom`, dm.allowFrom);
    }
    const guilds = asObjectRecord(scope.account.guilds);
    if (!guilds) {
      continue;
    }
    for (const [guildId, guildRaw] of Object.entries(guilds)) {
      const guild = asObjectRecord(guildRaw);
      if (!guild) {
        continue;
      }
      addHits(`${scope.prefix}.guilds.${guildId}.users`, guild.users);
      const channels = asObjectRecord(guild.channels);
      if (!channels) {
        continue;
      }
      for (const [channelId, channelRaw] of Object.entries(channels)) {
        const channel = asObjectRecord(channelRaw);
        if (channel) {
          addHits(`${scope.prefix}.guilds.${guildId}.channels.${channelId}.users`, channel.users);
        }
      }
    }
  }

  if (hits.length === 0) {
    return [];
  }
  const exampleLines = hits
    .slice(0, 8)
    .map((hit) => `- ${sanitizeForLog(hit.path)}: ${sanitizeForLog(hit.entry)}`);
  const remaining =
    hits.length > 8 ? `- +${hits.length - 8} more mutable allowlist entries.` : null;
  return [
    `- Found ${hits.length} mutable allowlist ${hits.length === 1 ? "entry" : "entries"} across discord while name matching is disabled by default.`,
    ...exampleLines,
    ...(remaining ? [remaining] : []),
    `- Option A (break-glass): enable channels.discord.dangerousNameMatching=true for the affected scope.`,
    `- Option B (recommended): resolve names to stable Discord IDs and rewrite the allowlist entries.`,
  ];
}

export const discordDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOnly",
  groupModel: "route",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules: DISCORD_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeDiscordCompatibilityConfig,
  collectPreviewWarnings: ({ cfg, doctorFixCommand, env }) => [
    ...collectDiscordMissingEnvTokenWarnings({ cfg, env }),
    ...collectDiscordNumericIdWarnings({
      hits: scanDiscordNumericIdEntries(cfg),
      doctorFixCommand,
    }),
  ],
  collectMutableAllowlistWarnings: ({ cfg }) => collectDiscordMutableAllowlistWarnings(cfg),
  repairConfig: ({ cfg, doctorFixCommand }) => maybeRepairDiscordNumericIds(cfg, doctorFixCommand),
};
