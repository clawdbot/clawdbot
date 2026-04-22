import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import {
  getDoctorConfigInputForTest,
  runDoctorConfigWithInput,
} from "./doctor-config-flow.test-utils.js";

type TerminalNote = (message: string, title?: string) => void;

const terminalNoteMock = vi.hoisted(() => vi.fn<TerminalNote>());
const legacyConfigMigrationForTest = vi.hoisted(() => {
  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
    const current = asRecord(parent[key]);
    if (current) {
      return current;
    }
    const next: Record<string, unknown> = {};
    parent[key] = next;
    return next;
  }

  function migrateThreadBinding(value: unknown, changes: string[], pathLabel: string): void {
    const record = asRecord(value);
    const bindings = asRecord(record?.threadBindings);
    if (!bindings || !("ttlHours" in bindings)) {
      return;
    }
    if (!("idleHours" in bindings)) {
      bindings.idleHours = bindings.ttlHours;
    }
    delete bindings.ttlHours;
    changes.push(`Moved ${pathLabel}.threadBindings.ttlHours to idleHours.`);
  }

  function migrateStreamingAlias(channel: Record<string, unknown>, channelId: string): boolean {
    if (
      !("streamMode" in channel) &&
      typeof channel.streaming !== "boolean" &&
      typeof channel.streaming !== "string"
    ) {
      return false;
    }
    if (channelId === "googlechat") {
      delete channel.streamMode;
      return true;
    }
    const streaming = asRecord(channel.streaming) ?? {};
    if (!("mode" in streaming)) {
      streaming.mode =
        channel.streamMode === "block"
          ? "partial"
          : channel.streaming === false
            ? "off"
            : "partial";
    }
    delete channel.streamMode;
    channel.streaming = streaming;
    return true;
  }

  function migrateNestedAllowAliases(channel: Record<string, unknown>, channelId: string): boolean {
    let changed = false;
    if (channelId === "slack") {
      for (const room of Object.values(asRecord(channel.channels) ?? {})) {
        const roomRecord = asRecord(room);
        if (roomRecord && "allow" in roomRecord) {
          roomRecord.enabled = roomRecord.allow;
          delete roomRecord.allow;
          changed = true;
        }
      }
    }
    if (channelId === "googlechat") {
      for (const group of Object.values(asRecord(channel.groups) ?? {})) {
        const groupRecord = asRecord(group);
        if (groupRecord && "allow" in groupRecord) {
          groupRecord.enabled = groupRecord.allow;
          delete groupRecord.allow;
          changed = true;
        }
      }
    }
    if (channelId === "discord") {
      for (const guild of Object.values(asRecord(channel.guilds) ?? {})) {
        for (const room of Object.values(asRecord(asRecord(guild)?.channels) ?? {})) {
          const roomRecord = asRecord(room);
          if (roomRecord && "allow" in roomRecord) {
            roomRecord.enabled = roomRecord.allow;
            delete roomRecord.allow;
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  function migrate(raw: unknown): { next: Record<string, unknown> | null; changes: string[] } {
    const root = asRecord(raw);
    if (!root) {
      return { next: null, changes: [] };
    }
    const next = structuredClone(root);
    const changes: string[] = [];

    const heartbeat = asRecord(next.heartbeat);
    if (heartbeat) {
      const agents = ensureRecord(next, "agents");
      const agentDefaults = ensureRecord(agents, "defaults");
      const channels = ensureRecord(next, "channels");
      const channelDefaults = ensureRecord(channels, "defaults");
      const agentHeartbeat: Record<string, unknown> = {};
      const channelHeartbeat: Record<string, unknown> = {};
      for (const key of ["model", "every"]) {
        if (key in heartbeat) {
          agentHeartbeat[key] = heartbeat[key];
        }
      }
      for (const key of ["showOk", "showAlerts", "useIndicator"]) {
        if (key in heartbeat) {
          channelHeartbeat[key] = heartbeat[key];
        }
      }
      if (Object.keys(agentHeartbeat).length > 0) {
        agentDefaults.heartbeat = {
          ...asRecord(agentDefaults.heartbeat),
          ...agentHeartbeat,
        };
      }
      if (Object.keys(channelHeartbeat).length > 0) {
        channelDefaults.heartbeat = {
          ...asRecord(channelDefaults.heartbeat),
          ...channelHeartbeat,
        };
      }
      delete next.heartbeat;
      changes.push("Moved heartbeat to agents.defaults.heartbeat and channels.defaults.heartbeat.");
    }

    const gateway = asRecord(next.gateway);
    if (gateway?.bind === "0.0.0.0") {
      gateway.bind = "lan";
      changes.push("Normalized gateway.bind host alias.");
    } else if (gateway?.bind === "localhost" || gateway?.bind === "127.0.0.1") {
      gateway.bind = "loopback";
      changes.push("Normalized gateway.bind host alias.");
    }

    migrateThreadBinding(next.session, changes, "session");
    const channels = asRecord(next.channels);
    for (const [channelId, channelRaw] of Object.entries(channels ?? {})) {
      if (channelId === "defaults") {
        continue;
      }
      const channel = asRecord(channelRaw);
      if (!channel) {
        continue;
      }
      migrateThreadBinding(channel, changes, `channels.${channelId}`);
      if (migrateStreamingAlias(channel, channelId)) {
        changes.push(`Normalized channels.${channelId} streaming aliases.`);
      }
      if (migrateNestedAllowAliases(channel, channelId)) {
        changes.push(`Normalized channels.${channelId} nested allow aliases.`);
      }
      for (const [accountId, accountRaw] of Object.entries(asRecord(channel.accounts) ?? {})) {
        const account = asRecord(accountRaw);
        migrateThreadBinding(account, changes, `channels.${channelId}.accounts.${accountId}`);
        if (account && migrateStreamingAlias(account, channelId)) {
          changes.push(`Normalized channels.${channelId}.accounts.${accountId} streaming aliases.`);
        }
      }
    }

    const sandbox = asRecord(asRecord(asRecord(next.agents)?.defaults)?.sandbox);
    if (sandbox && "perSession" in sandbox) {
      sandbox.scope = sandbox.perSession === true ? "session" : "workspace";
      delete sandbox.perSession;
      changes.push("Moved agents.defaults.sandbox.perSession to scope.");
    }

    return changes.length > 0 ? { next, changes } : { next: null, changes: [] };
  }

  return {
    migrate,
    migrateLegacyConfig: (raw: unknown) => {
      const { next, changes } = migrate(raw);
      return { config: next, changes };
    },
  };
});

vi.mock("../terminal/note.js", () => ({
  note: terminalNoteMock,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: vi.fn(
    ({
      config,
    }: {
      config: {
        plugins?: { allow?: string[]; entries?: Record<string, unknown> };
        tools?: { alsoAllow?: string[] };
      };
    }) => {
      if (!config.tools?.alsoAllow?.includes("browser")) {
        return { config, changes: [], autoEnabledReasons: {} };
      }
      const allow = config.plugins?.allow ?? [];
      if (allow.includes("browser")) {
        return { config, changes: [], autoEnabledReasons: {} };
      }
      return {
        config: {
          ...config,
          plugins: {
            ...config.plugins,
            allow: [...allow, "browser"],
            entries: {
              ...config.plugins?.entries,
              browser: {
                ...(config.plugins?.entries?.browser as Record<string, unknown> | undefined),
                enabled: true,
              },
            },
          },
        },
        changes: ["browser referenced by tools.alsoAllow, enabled automatically."],
        autoEnabledReasons: { browser: ["tools.alsoAllow"] },
      };
    },
  ),
}));

vi.mock("../config/validation.js", () => ({
  validateConfigObjectWithPlugins: vi.fn((config: unknown) => ({ ok: true, config })),
}));

vi.mock("../config/legacy.js", () => {
  type LegacyRule = {
    path: string[];
    message: string;
    match?: (value: unknown, root: Record<string, unknown>) => boolean;
    requireSourceLiteral?: boolean;
  };

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  function getPathValue(root: Record<string, unknown>, pathParts: readonly string[]): unknown {
    let cursor: unknown = root;
    for (const part of pathParts) {
      const record = asRecord(cursor);
      if (!record) {
        return undefined;
      }
      cursor = record[part];
    }
    return cursor;
  }

  function addIssue(
    issues: Array<{ path: string; message: string }>,
    pathParts: readonly string[],
    message: string,
  ) {
    issues.push({ path: pathParts.join("."), message });
  }

  function hasLegacyStreamingAlias(channel: Record<string, unknown>): boolean {
    return (
      "streamMode" in channel ||
      "chunkMode" in channel ||
      "blockStreaming" in channel ||
      "draftChunk" in channel ||
      "blockStreamingCoalesce" in channel ||
      "nativeStreaming" in channel ||
      typeof channel.streaming === "boolean" ||
      typeof channel.streaming === "string"
    );
  }

  return {
    findLegacyConfigIssues: (raw: unknown, sourceRaw?: unknown, extraRules: LegacyRule[] = []) => {
      const root = asRecord(raw);
      if (!root) {
        return [];
      }
      const sourceRoot = asRecord(sourceRaw) ?? root;
      const issues: Array<{ path: string; message: string }> = [];

      if ("heartbeat" in root) {
        addIssue(
          issues,
          ["heartbeat"],
          'heartbeat is legacy; use agents.defaults.heartbeat and channels.defaults.heartbeat. Run "openclaw doctor --fix".',
        );
      }
      if ("memorySearch" in root) {
        addIssue(
          issues,
          ["memorySearch"],
          'memorySearch is legacy; use agents.defaults.memorySearch. Run "openclaw doctor --fix".',
        );
      }
      const gateway = asRecord(root.gateway);
      if (gateway && "bind" in gateway) {
        addIssue(
          issues,
          ["gateway", "bind"],
          'gateway.bind host aliases are legacy; use the canonical bind mode. Run "openclaw doctor --fix".',
        );
      }
      const sessionThreadBindings = asRecord(asRecord(root.session)?.threadBindings);
      if (sessionThreadBindings && "ttlHours" in sessionThreadBindings) {
        addIssue(
          issues,
          ["session", "threadBindings", "ttlHours"],
          'session.threadBindings.ttlHours is legacy; use session.threadBindings.idleHours. Run "openclaw doctor --fix".',
        );
      }
      const xSearch = asRecord(asRecord(asRecord(root.tools)?.web)?.x_search);
      if (xSearch && "apiKey" in xSearch) {
        addIssue(
          issues,
          ["tools", "web", "x_search", "apiKey"],
          'tools.web.x_search.apiKey is legacy; use plugins.entries.xai.config.webSearch.apiKey. Run "openclaw doctor --fix".',
        );
      }
      const sandbox = asRecord(asRecord(asRecord(root.agents)?.defaults)?.sandbox);
      if (sandbox && "perSession" in sandbox) {
        addIssue(
          issues,
          ["agents", "defaults", "sandbox"],
          'agents.defaults.sandbox.perSession is legacy; use agents.defaults.sandbox.scope. Run "openclaw doctor --fix".',
        );
      }

      const channels = asRecord(root.channels);
      for (const [channelId, channelRaw] of Object.entries(channels ?? {})) {
        if (channelId === "defaults") {
          continue;
        }
        const channel = asRecord(channelRaw);
        if (!channel) {
          continue;
        }
        if (hasLegacyStreamingAlias(channel)) {
          addIssue(
            issues,
            ["channels", channelId],
            channelId === "googlechat"
              ? `channels.${channelId}.streamMode is legacy and no longer used. Run "openclaw doctor --fix".`
              : `channels.${channelId}.streamMode, channels.${channelId}.streaming aliases are legacy. Run "openclaw doctor --fix".`,
          );
        }
        const threadBindings = asRecord(channel.threadBindings);
        if (threadBindings && "ttlHours" in threadBindings) {
          addIssue(
            issues,
            ["channels", channelId, "threadBindings", "ttlHours"],
            'channels.<id>.threadBindings.ttlHours is legacy; use channels.<id>.threadBindings.idleHours. Run "openclaw doctor --fix".',
          );
        }
        if (channelId === "slack") {
          for (const roomRaw of Object.values(asRecord(channel.channels) ?? {})) {
            if ("allow" in (asRecord(roomRaw) ?? {})) {
              addIssue(
                issues,
                ["channels", "slack"],
                'channels.slack.channels.<id>.allow is legacy; use enabled. Run "openclaw doctor --fix".',
              );
            }
          }
        }
        if (channelId === "googlechat") {
          for (const spaceRaw of Object.values(asRecord(channel.groups) ?? {})) {
            if ("allow" in (asRecord(spaceRaw) ?? {})) {
              addIssue(
                issues,
                ["channels", "googlechat"],
                'channels.googlechat.groups.<id>.allow is legacy; use enabled. Run "openclaw doctor --fix".',
              );
            }
          }
        }
        if (channelId === "discord") {
          for (const guildRaw of Object.values(asRecord(channel.guilds) ?? {})) {
            const guild = asRecord(guildRaw);
            for (const roomRaw of Object.values(asRecord(guild?.channels) ?? {})) {
              if ("allow" in (asRecord(roomRaw) ?? {})) {
                addIssue(
                  issues,
                  ["channels", "discord"],
                  'channels.discord.guilds.<id>.channels.<id>.allow is legacy; use enabled. Run "openclaw doctor --fix".',
                );
              }
            }
          }
        }
        for (const [accountId, accountRaw] of Object.entries(asRecord(channel.accounts) ?? {})) {
          const account = asRecord(accountRaw);
          const accountThreadBindings = asRecord(account?.threadBindings);
          if (accountThreadBindings && "ttlHours" in accountThreadBindings) {
            addIssue(
              issues,
              ["channels", channelId, "accounts", accountId, "threadBindings", "ttlHours"],
              'channels.<id>.threadBindings.ttlHours is legacy; use channels.<id>.threadBindings.idleHours. Run "openclaw doctor --fix".',
            );
          }
        }
      }

      for (const rule of extraRules) {
        const value = getPathValue(root, rule.path);
        if (value === undefined || (rule.match && !rule.match(value, root))) {
          continue;
        }
        if (rule.requireSourceLiteral) {
          const sourceValue = getPathValue(sourceRoot, rule.path);
          if (sourceValue === undefined || (rule.match && !rule.match(sourceValue, sourceRoot))) {
            continue;
          }
        }
        addIssue(issues, rule.path, rule.message);
      }
      return issues;
    },
  };
});

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: vi.fn((channelId: string) => {
    if (channelId !== "discord") {
      return undefined;
    }
    return {
      doctor: {
        normalizeCompatibilityConfig: ({
          cfg,
        }: {
          cfg: { channels?: { discord?: Record<string, unknown> } };
        }) => {
          const discord = cfg.channels?.discord;
          if (!discord) {
            return { config: cfg, changes: [] };
          }
          if (
            !("streamMode" in discord) &&
            typeof discord.streaming !== "boolean" &&
            typeof discord.streaming !== "string"
          ) {
            return { config: cfg, changes: [] };
          }
          const next = structuredClone(cfg);
          const nextDiscord = next.channels?.discord;
          if (!nextDiscord) {
            return { config: cfg, changes: [] };
          }
          const nextStreaming =
            nextDiscord.streaming && typeof nextDiscord.streaming === "object"
              ? { ...(nextDiscord.streaming as Record<string, unknown>) }
              : {};
          if (!("mode" in nextStreaming)) {
            nextStreaming.mode =
              nextDiscord.streamMode === "block"
                ? "partial"
                : nextDiscord.streaming === false
                  ? "off"
                  : "partial";
          }
          delete nextDiscord.streamMode;
          nextDiscord.streaming = nextStreaming;
          return {
            config: next,
            changes: ["Discord allowlist ids normalized to strings."],
          };
        },
      },
    };
  }),
}));

vi.mock("../channels/plugins/doctor-contract-api.js", () => ({
  loadBundledChannelDoctorContractApi: vi.fn(() => undefined),
}));

vi.mock("../channels/plugins/setup-promotion-helpers.js", () => {
  const commonSingleAccountKeys = new Set([
    "name",
    "token",
    "tokenFile",
    "botToken",
    "appToken",
    "account",
    "signalNumber",
    "authDir",
    "cliPath",
    "dbPath",
    "httpUrl",
    "httpHost",
    "httpPort",
    "webhookPath",
    "webhookUrl",
    "webhookSecret",
    "service",
    "region",
    "homeserver",
    "userId",
    "accessToken",
    "password",
    "deviceName",
    "url",
    "code",
    "dmPolicy",
    "allowFrom",
    "groupPolicy",
    "groupAllowFrom",
    "defaultTo",
  ]);
  const fallbackSingleAccountKeys: Record<string, readonly string[]> = {
    telegram: ["streaming"],
  };
  const namedAccountPromotionKeys: Record<string, readonly string[]> = {
    telegram: ["botToken", "tokenFile"],
  };

  return {
    resolveSingleAccountKeysToMove: ({
      channelKey,
      channel,
    }: {
      channelKey: string;
      channel: Record<string, unknown>;
    }) => {
      const accounts =
        channel.accounts && typeof channel.accounts === "object" && !Array.isArray(channel.accounts)
          ? (channel.accounts as Record<string, unknown>)
          : {};
      const hasNamedAccounts = Object.keys(accounts).filter(Boolean).length > 0;
      const allowedNamedKeys = namedAccountPromotionKeys[channelKey];
      return Object.entries(channel)
        .filter(([key, value]) => {
          if (key === "accounts" || key === "enabled" || value === undefined) {
            return false;
          }
          const isKnownKey =
            commonSingleAccountKeys.has(key) ||
            (fallbackSingleAccountKeys[channelKey]?.includes(key) ?? false);
          if (!isKnownKey) {
            return false;
          }
          if (hasNamedAccounts && allowedNamedKeys && !allowedNamedKeys.includes(key)) {
            return false;
          }
          return true;
        })
        .map(([key]) => key);
    },
  };
});

vi.mock("./doctor/shared/channel-legacy-config-migrate.js", () => ({
  applyChannelDoctorCompatibilityMigrations: (cfg: Record<string, unknown>) => ({
    next: cfg,
    changes: [],
  }),
}));

vi.mock("./doctor/shared/legacy-config-migrate.js", () => ({
  migrateLegacyConfig: legacyConfigMigrationForTest.migrateLegacyConfig,
}));

vi.mock("./doctor/shared/bundled-plugin-load-paths.js", () => ({
  maybeRepairBundledPluginLoadPaths: vi.fn((cfg: Record<string, unknown>) => ({
    config: cfg,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/exec-safe-bins.js", () => ({
  maybeRepairExecSafeBinProfiles: vi.fn((cfg: Record<string, unknown>) => ({
    config: cfg,
    changes: [],
    warnings: [],
  })),
}));

vi.mock("./doctor/shared/stale-plugin-config.js", () => ({
  maybeRepairStalePluginConfig: vi.fn((cfg: Record<string, unknown>) => ({
    config: cfg,
    changes: [],
  })),
}));

vi.mock("./doctor/channel-capabilities.js", () => {
  const byChannel = {
    googlechat: {
      dmAllowFromMode: "nestedOnly",
      groupModel: "route",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    },
    matrix: {
      dmAllowFromMode: "nestedOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    },
    msteams: {
      dmAllowFromMode: "topOnly",
      groupModel: "hybrid",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    },
    zalouser: {
      dmAllowFromMode: "topOnly",
      groupModel: "hybrid",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    },
  } as const;
  const fallback = {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: true,
    warnOnEmptyGroupSenderAllowlist: true,
  };
  return {
    getDoctorChannelCapabilities: (channelName?: string) =>
      channelName && channelName in byChannel
        ? byChannel[channelName as keyof typeof byChannel]
        : fallback,
  };
});

vi.mock("../plugins/doctor-contract-registry.js", () => {
  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  function hasLegacyTalkFields(value: unknown): boolean {
    const talk = asRecord(value);
    return Boolean(
      talk &&
      ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"].some((key) =>
        Object.prototype.hasOwnProperty.call(talk, key),
      ),
    );
  }

  function resolveDiscordStreamMode(entry: Record<string, unknown>): string {
    if (
      entry.streamMode === "block" ||
      entry.streamMode === "partial" ||
      entry.streamMode === "off"
    ) {
      return entry.streamMode;
    }
    if (entry.streaming === true) {
      return "partial";
    }
    if (entry.streaming === false) {
      return "off";
    }
    return "off";
  }

  function normalizeDiscordStreamingEntry(
    entry: Record<string, unknown>,
    pathPrefix: string,
    changes: string[],
  ): boolean {
    const hasLegacyStreaming =
      "streamMode" in entry ||
      typeof entry.streaming === "boolean" ||
      typeof entry.streaming === "string" ||
      "chunkMode" in entry ||
      "blockStreaming" in entry ||
      "draftChunk" in entry ||
      "blockStreamingCoalesce" in entry;
    if (!hasLegacyStreaming) {
      return false;
    }

    let changed = false;
    const streaming = asRecord(entry.streaming) ?? {};
    if (!("mode" in streaming) && ("streamMode" in entry || typeof entry.streaming !== "object")) {
      const mode = resolveDiscordStreamMode(entry);
      streaming.mode = mode;
      changes.push(
        "streamMode" in entry
          ? `Moved ${pathPrefix}.streamMode → ${pathPrefix}.streaming.mode (${mode}).`
          : `Moved ${pathPrefix}.streaming (boolean) → ${pathPrefix}.streaming.mode (${mode}).`,
      );
      changed = true;
    }
    if ("streamMode" in entry) {
      delete entry.streamMode;
      changed = true;
    }
    if ("chunkMode" in entry && !("chunkMode" in streaming)) {
      streaming.chunkMode = entry.chunkMode;
      delete entry.chunkMode;
      changes.push(`Moved ${pathPrefix}.chunkMode → ${pathPrefix}.streaming.chunkMode.`);
      changed = true;
    }
    const block = asRecord(streaming.block) ?? {};
    if ("blockStreaming" in entry && !("enabled" in block)) {
      block.enabled = entry.blockStreaming;
      delete entry.blockStreaming;
      changes.push(`Moved ${pathPrefix}.blockStreaming → ${pathPrefix}.streaming.block.enabled.`);
      changed = true;
    }
    if ("blockStreamingCoalesce" in entry && !("coalesce" in block)) {
      block.coalesce = entry.blockStreamingCoalesce;
      delete entry.blockStreamingCoalesce;
      changes.push(
        `Moved ${pathPrefix}.blockStreamingCoalesce → ${pathPrefix}.streaming.block.coalesce.`,
      );
      changed = true;
    }
    if (Object.keys(block).length > 0) {
      streaming.block = block;
    }
    const preview = asRecord(streaming.preview) ?? {};
    if ("draftChunk" in entry && !("chunk" in preview)) {
      preview.chunk = entry.draftChunk;
      delete entry.draftChunk;
      changes.push(`Moved ${pathPrefix}.draftChunk → ${pathPrefix}.streaming.preview.chunk.`);
      changed = true;
    }
    if (Object.keys(preview).length > 0) {
      streaming.preview = preview;
    }
    entry.streaming = streaming;
    return changed;
  }

  function normalizeDiscordStreamingAliasesForTest(cfg: unknown): {
    config: unknown;
    changes: string[];
  } {
    const root = asRecord(cfg);
    const discord = asRecord(asRecord(root?.channels)?.discord);
    if (!root || !discord) {
      return { config: cfg, changes: [] };
    }

    const next = structuredClone(root);
    const nextDiscord = asRecord(asRecord(next.channels)?.discord);
    if (!nextDiscord) {
      return { config: cfg, changes: [] };
    }

    const changes: string[] = [];
    normalizeDiscordStreamingEntry(nextDiscord, "channels.discord", changes);
    const accounts = asRecord(nextDiscord.accounts);
    for (const [accountId, accountRaw] of Object.entries(accounts ?? {})) {
      const account = asRecord(accountRaw);
      if (account) {
        normalizeDiscordStreamingEntry(account, `channels.discord.accounts.${accountId}`, changes);
      }
    }
    return changes.length > 0 ? { config: next, changes } : { config: cfg, changes: [] };
  }

  return {
    collectRelevantDoctorPluginIds: (raw: unknown): string[] => {
      const ids = new Set<string>();
      const root = asRecord(raw);
      const channels = asRecord(root?.channels);
      for (const channelId of Object.keys(channels ?? {})) {
        if (channelId !== "defaults") {
          ids.add(channelId);
        }
      }
      if (hasLegacyTalkFields(root?.talk)) {
        ids.add("elevenlabs");
      }
      return [...ids].toSorted();
    },
    applyPluginDoctorCompatibilityMigrations: normalizeDiscordStreamingAliasesForTest,
    listPluginDoctorLegacyConfigRules: () => [
      {
        path: ["channels", "telegram", "groupMentionsOnly"],
        message:
          'channels.telegram.groupMentionsOnly was removed; use channels.telegram.groups."*".requireMention instead. Run "openclaw doctor --fix".',
      },
      {
        path: ["talk"],
        message:
          "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey are legacy; use talk.providers.<provider> and run openclaw doctor --fix.",
        match: hasLegacyTalkFields,
      },
    ],
  };
});

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupAutoEnableReasons: vi.fn(() => []),
  runPluginSetupConfigMigrations: vi.fn(({ config }: { config: unknown }) => ({
    config,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/channel-doctor.js", () => {
  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  function hasOwnStringArray(value: unknown): boolean {
    return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry);
  }

  function stringifySelectedArrays(root: Record<string, unknown>): boolean {
    let changed = false;
    const keysToNormalize = new Set([
      "allowFrom",
      "groupAllowFrom",
      "groupChannels",
      "approvers",
      "users",
      "roles",
    ]);
    const visit = (value: unknown) => {
      const record = asRecord(value);
      if (!record) {
        return;
      }
      for (const [key, entry] of Object.entries(record)) {
        if (keysToNormalize.has(key) && Array.isArray(entry)) {
          const next = entry.map((item) =>
            typeof item === "number" || typeof item === "string" ? String(item) : item,
          );
          if (next.some((item, index) => item !== entry[index])) {
            record[key] = next;
            changed = true;
          }
          continue;
        }
        if (entry && typeof entry === "object") {
          visit(entry);
        }
      }
    };
    visit(root);
    return changed;
  }

  function collectCompatibilityMutations(cfg: { channels?: Record<string, unknown> }) {
    const next = structuredClone(cfg);
    const changes: string[] = [];
    const telegram = asRecord(next.channels?.telegram);
    if (telegram && "groupMentionsOnly" in telegram) {
      const groups = asRecord(telegram.groups) ?? {};
      const defaultGroup = asRecord(groups["*"]) ?? {};
      if (defaultGroup.requireMention === undefined) {
        defaultGroup.requireMention = telegram.groupMentionsOnly;
      }
      groups["*"] = defaultGroup;
      telegram.groups = groups;
      delete telegram.groupMentionsOnly;
      changes.push(
        'Moved channels.telegram.groupMentionsOnly → channels.telegram.groups."*".requireMention.',
      );
    }
    return changes.length > 0 ? [{ config: next, changes }] : [];
  }

  function collectInactiveTelegramWarnings(cfg: { channels?: Record<string, unknown> }): string[] {
    const telegram = asRecord(cfg.channels?.telegram);
    if (!telegram) {
      return [];
    }
    const accounts = asRecord(telegram.accounts);
    if (!accounts) {
      return [];
    }
    return Object.entries(accounts).flatMap(([accountId, accountRaw]) => {
      const account = asRecord(accountRaw);
      if (
        !account ||
        account.enabled !== false ||
        !asRecord(account.botToken) ||
        !hasOwnStringArray(account.allowFrom)
      ) {
        return [];
      }
      return [
        `- Telegram account ${accountId}: failed to inspect bot token because the account is disabled.`,
        "- Telegram allowFrom contains @username entries, but configured Telegram bot credentials are unavailable in this command path.",
      ];
    });
  }

  function isTelegramFirstTimeAccount(params: {
    account: Record<string, unknown>;
    parent?: Record<string, unknown>;
  }): boolean {
    const groupPolicy =
      typeof params.account.groupPolicy === "string"
        ? params.account.groupPolicy
        : typeof params.parent?.groupPolicy === "string"
          ? params.parent.groupPolicy
          : undefined;
    if (groupPolicy !== "allowlist") {
      return false;
    }
    const botToken = params.account.botToken ?? params.parent?.botToken;
    if (!botToken) {
      return false;
    }
    const groups = asRecord(params.account.groups) ?? asRecord(params.parent?.groups);
    const groupAllowFrom = params.account.groupAllowFrom ?? params.parent?.groupAllowFrom;
    return !groups && !hasOwnStringArray(groupAllowFrom);
  }

  function collectTelegramFirstTimeExtraWarnings(params: {
    account: Record<string, unknown>;
    channelName: string;
    parent?: Record<string, unknown>;
    prefix: string;
  }): string[] {
    if (
      params.channelName !== "telegram" ||
      !isTelegramFirstTimeAccount({ account: params.account, parent: params.parent })
    ) {
      return [];
    }
    return [
      `- ${params.prefix}: Telegram is in first-time setup mode. DMs use pairing mode. Group messages stay blocked until you add allowed chats under ${params.prefix}.groups (and optional sender IDs under ${params.prefix}.groupAllowFrom), or set ${params.prefix}.groupPolicy to "open" if you want broad group access.`,
    ];
  }

  return {
    collectChannelDoctorCompatibilityMutations: vi.fn(collectCompatibilityMutations),
    collectChannelDoctorEmptyAllowlistExtraWarnings: vi.fn(collectTelegramFirstTimeExtraWarnings),
    collectChannelDoctorMutableAllowlistWarnings: vi.fn(
      ({ cfg }: { cfg: { channels?: Record<string, unknown> } }) => {
        const zalouser = asRecord(cfg.channels?.zalouser);
        if (!zalouser || zalouser.dangerouslyAllowNameMatching === true) {
          return [];
        }
        const groups = asRecord(zalouser.groups);
        if (!groups) {
          return [];
        }
        return Object.entries(groups).flatMap(([name, group]) =>
          asRecord(group)?.allow === true
            ? [
                `- Found mutable allowlist entry across zalouser while name matching is disabled by default: channels.zalouser.groups: ${name}.`,
              ]
            : [],
        );
      },
    ),
    collectChannelDoctorPreviewWarnings: vi.fn(async () => []),
    collectChannelDoctorRepairMutations: vi.fn(
      async ({ cfg }: { cfg: { channels?: Record<string, unknown> } }) => {
        const mutations: Array<{ config: unknown; changes: string[]; warnings?: string[] }> = [];
        const discord = asRecord(cfg.channels?.discord);
        if (discord) {
          const next = structuredClone(cfg);
          const nextDiscord = asRecord(next.channels?.discord);
          if (nextDiscord && stringifySelectedArrays(nextDiscord)) {
            mutations.push({
              config: next,
              changes: ["Discord allowlist ids normalized to strings."],
            });
          }
        }
        const telegramWarnings = collectInactiveTelegramWarnings(cfg);
        if (telegramWarnings.length > 0) {
          mutations.push({ config: cfg, changes: [], warnings: telegramWarnings });
        }
        return mutations;
      },
    ),
    collectChannelDoctorStaleConfigMutations: vi.fn(async () => []),
    createChannelDoctorEmptyAllowlistPolicyHooks: vi.fn(() => ({
      extraWarningsForAccount: collectTelegramFirstTimeExtraWarnings,
      shouldSkipDefaultEmptyGroupAllowlistWarning: ({ channelName }: { channelName: string }) =>
        channelName === "googlechat" || channelName === "telegram",
    })),
    runChannelDoctorConfigSequences: vi.fn(async () => ({ changeNotes: [], warningNotes: [] })),
    shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning: vi.fn(
      ({ channelName }: { channelName: string }) =>
        channelName === "googlechat" || channelName === "telegram",
    ),
  };
});

vi.mock("./doctor/shared/preview-warnings.js", () => {
  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  function hasStringEntries(value: unknown): boolean {
    return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry);
  }

  function telegramFirstTimeWarnings(params: {
    account: Record<string, unknown>;
    parent?: Record<string, unknown>;
    prefix: string;
  }): string[] {
    const groupPolicy =
      typeof params.account.groupPolicy === "string"
        ? params.account.groupPolicy
        : typeof params.parent?.groupPolicy === "string"
          ? params.parent.groupPolicy
          : undefined;
    if (groupPolicy !== "allowlist") {
      return [];
    }
    const botToken = params.account.botToken ?? params.parent?.botToken;
    if (!botToken || asRecord(params.account.groups) || asRecord(params.parent?.groups)) {
      return [];
    }
    if (hasStringEntries(params.account.groupAllowFrom ?? params.parent?.groupAllowFrom)) {
      return [];
    }
    return [
      `- ${params.prefix}: Telegram is in first-time setup mode. DMs use pairing mode. Group messages stay blocked until you add allowed chats under ${params.prefix}.groups (and optional sender IDs under ${params.prefix}.groupAllowFrom), or set ${params.prefix}.groupPolicy to "open" if you want broad group access.`,
    ];
  }

  return {
    collectDoctorPreviewWarnings: vi.fn(
      async ({
        cfg,
      }: {
        cfg: {
          channels?: Record<string, unknown>;
          plugins?: { enabled?: boolean; entries?: Record<string, { enabled?: boolean }> };
        };
        doctorFixCommand: string;
      }) => {
        const warnings: string[] = [];
        const telegram = asRecord(cfg.channels?.telegram);
        if (telegram) {
          const telegramBlocked =
            cfg.plugins?.enabled === false || cfg.plugins?.entries?.telegram?.enabled === false;
          if (telegramBlocked) {
            warnings.push(
              cfg.plugins?.enabled === false
                ? "- channels.telegram: channel is configured, but plugins.enabled=false blocks channel plugins globally. Fix plugin enablement before relying on setup guidance for this channel."
                : '- channels.telegram: channel is configured, but plugin "telegram" is disabled by plugins.entries.telegram.enabled=false. Fix plugin enablement before relying on setup guidance for this channel.',
            );
          } else {
            warnings.push(
              ...telegramFirstTimeWarnings({
                account: telegram,
                prefix: "channels.telegram",
              }),
            );
            const accounts = asRecord(telegram.accounts);
            for (const [accountId, accountRaw] of Object.entries(accounts ?? {})) {
              const account = asRecord(accountRaw);
              if (account) {
                warnings.push(
                  ...telegramFirstTimeWarnings({
                    account,
                    parent: telegram,
                    prefix: `channels.telegram.accounts.${accountId}`,
                  }),
                );
              }
            }
          }
        }
        const imessage = asRecord(cfg.channels?.imessage);
        if (imessage?.groupPolicy === "allowlist" && !hasStringEntries(imessage.groupAllowFrom)) {
          warnings.push(
            '- channels.imessage.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped.',
          );
        }
        return warnings;
      },
    ),
  };
});

vi.mock("./doctor-config-preflight.js", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const {
    collectRelevantDoctorPluginIds,
    listPluginDoctorLegacyConfigRules,
  }: typeof import("../plugins/doctor-contract-registry.js") =
    await import("../plugins/doctor-contract-registry.js");
  const { findLegacyConfigIssues }: typeof import("../config/legacy.js") =
    await import("../config/legacy.js");

  function resolveConfigPath() {
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ||
      (process.env.HOME ? path.join(process.env.HOME, ".openclaw") : "");
    return process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
  }

  function normalizeDiscordStreamingCompat(cfg: Record<string, unknown>): Record<string, unknown> {
    const channels =
      cfg.channels && typeof cfg.channels === "object" && !Array.isArray(cfg.channels)
        ? (cfg.channels as Record<string, unknown>)
        : null;
    const discord =
      channels?.discord && typeof channels.discord === "object" && !Array.isArray(channels.discord)
        ? (channels.discord as Record<string, unknown>)
        : null;
    if (
      !discord ||
      (!("streamMode" in discord) &&
        typeof discord.streaming !== "boolean" &&
        typeof discord.streaming !== "string")
    ) {
      return cfg;
    }
    const next = structuredClone(cfg);
    const nextDiscord = ((next.channels as Record<string, unknown> | undefined)?.discord ??
      {}) as Record<string, unknown>;
    const nextStreaming =
      nextDiscord.streaming && typeof nextDiscord.streaming === "object"
        ? { ...(nextDiscord.streaming as Record<string, unknown>) }
        : {};
    if (!("mode" in nextStreaming)) {
      nextStreaming.mode =
        nextDiscord.streamMode === "block"
          ? "partial"
          : nextDiscord.streaming === false
            ? "off"
            : "partial";
    }
    delete nextDiscord.streamMode;
    nextDiscord.streaming = nextStreaming;
    return next;
  }

  return {
    runDoctorConfigPreflight: vi.fn(async () => {
      const injected = getDoctorConfigInputForTest();
      const configPath = injected?.path ?? resolveConfigPath();
      let parsed: Record<string, unknown> = injected?.config
        ? structuredClone(injected.config)
        : {};
      let exists = injected?.exists ?? false;
      if (!injected) {
        try {
          parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
          exists = true;
        } catch {
          parsed = {};
        }
      }
      if (injected?.preflightMode === "fast") {
        return {
          snapshot: {
            exists,
            path: configPath,
            parsed,
            config: parsed,
            sourceConfig: parsed,
            valid: true,
            warnings: [],
            legacyIssues: [],
          },
          baseConfig: parsed,
        };
      }
      if (injected?.preflightMode === "issues") {
        const legacyIssues = findLegacyConfigIssues(
          parsed,
          parsed,
          listPluginDoctorLegacyConfigRules({
            pluginIds: collectRelevantDoctorPluginIds(parsed),
          }),
        );
        return {
          snapshot: {
            exists,
            path: configPath,
            parsed,
            config: parsed,
            sourceConfig: parsed,
            valid: legacyIssues.length === 0,
            warnings: [],
            legacyIssues,
          },
          baseConfig: parsed,
        };
      }
      const legacyIssues = findLegacyConfigIssues(
        parsed,
        parsed,
        listPluginDoctorLegacyConfigRules({
          pluginIds: collectRelevantDoctorPluginIds(parsed),
        }),
      );
      const compat = legacyConfigMigrationForTest.migrate(parsed);
      const effectiveConfig = normalizeDiscordStreamingCompat(compat.next ?? parsed);
      return {
        snapshot: {
          exists,
          path: configPath,
          parsed,
          config: effectiveConfig,
          sourceConfig: effectiveConfig,
          valid: legacyIssues.length === 0,
          warnings: [],
          legacyIssues,
        },
        baseConfig: effectiveConfig,
      };
    }),
  };
});

vi.mock("./doctor-config-analysis.js", () => {
  function formatConfigPath(parts: Array<string | number>): string {
    if (parts.length === 0) {
      return "<root>";
    }
    let out = "";
    for (const part of parts) {
      if (typeof part === "number") {
        out += `[${part}]`;
      } else {
        out = out ? `${out}.${part}` : part;
      }
    }
    return out || "<root>";
  }

  function resolveConfigPathTarget(root: unknown, pathParts: Array<string | number>): unknown {
    let current: unknown = root;
    for (const part of pathParts) {
      if (typeof part === "number") {
        if (!Array.isArray(current)) {
          return null;
        }
        current = current[part];
        continue;
      }
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return null;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  return {
    formatConfigPath,
    noteIncludeConfinementWarning: vi.fn(),
    noteOpencodeProviderOverrides: vi.fn(),
    resolveConfigPathTarget,
    stripUnknownConfigKeys: vi.fn((config: Record<string, unknown>) => {
      const next = structuredClone(config);
      const removed: string[] = [];
      if ("bridge" in next) {
        delete next.bridge;
        removed.push("bridge");
      }
      const gatewayAuth = resolveConfigPathTarget(next, ["gateway", "auth"]);
      if (
        gatewayAuth &&
        typeof gatewayAuth === "object" &&
        !Array.isArray(gatewayAuth) &&
        "extra" in gatewayAuth
      ) {
        delete (gatewayAuth as Record<string, unknown>).extra;
        removed.push("gateway.auth.extra");
      }
      return { config: next, removed };
    }),
  };
});

vi.mock("./doctor-state-migrations.js", () => ({
  autoMigrateLegacyStateDir: vi.fn(async () => ({ changes: [], warnings: [] })),
}));

function resetTerminalNoteMock() {
  terminalNoteMock.mockClear();
  return terminalNoteMock;
}

async function collectDoctorWarnings(config: Record<string, unknown>): Promise<string[]> {
  const noteSpy = resetTerminalNoteMock();
  await runDoctorConfigWithInput({
    config,
    run: loadAndMaybeMigrateDoctorConfig,
  });
  return noteSpy.mock.calls.filter((call) => call[1] === "Doctor warnings").map((call) => call[0]);
}

type DiscordGuildRule = {
  users: string[];
  roles: string[];
  channels: Record<string, { users: string[]; roles: string[] }>;
};

type DiscordAccountRule = {
  allowFrom?: string[];
  dm?: { allowFrom: string[]; groupChannels: string[] };
  execApprovals?: { approvers: string[] };
  guilds?: Record<string, DiscordGuildRule>;
};

type RepairedDiscordPolicy = {
  allowFrom?: string[];
  dm: { allowFrom: string[]; groupChannels: string[] };
  execApprovals: { approvers: string[] };
  guilds: Record<string, DiscordGuildRule>;
  accounts: Record<string, DiscordAccountRule>;
};

describe("doctor config flow", () => {
  beforeEach(() => {
    terminalNoteMock.mockClear();
  });

  it("preserves invalid config for doctor repairs", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        gateway: { auth: { mode: "token", token: 123 } },
        agents: { list: [{ id: "pi" }] },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect((result.cfg as Record<string, unknown>).gateway).toEqual({
      auth: { mode: "token", token: 123 },
    });
  });

  it("does not warn on mutable account allowlists when dangerous name matching is inherited", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        slack: {
          dangerouslyAllowNameMatching: true,
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
        },
      },
    });
    expect(doctorWarnings.some((line) => line.includes("mutable allowlist"))).toBe(false);
  });

  it("does not warn about sender-based group allowlist for googlechat", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        googlechat: {
          groupPolicy: "allowlist",
          accounts: {
            work: {
              groupPolicy: "allowlist",
            },
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) => line.includes('groupPolicy is "allowlist"') && line.includes("groupAllowFrom"),
      ),
    ).toBe(false);
  });

  it("shows first-time Telegram guidance without the old groupAllowFrom warning", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          botToken: "123:abc",
          groupPolicy: "allowlist",
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes('channels.telegram.groupPolicy is "allowlist"') &&
          line.includes("groupAllowFrom"),
      ),
    ).toBe(false);
    expect(
      doctorWarnings.some(
        (line) =>
          line.includes("channels.telegram: Telegram is in first-time setup mode.") &&
          line.includes("DMs use pairing mode") &&
          line.includes("channels.telegram.groups"),
      ),
    ).toBe(true);
  });

  it("shows account-scoped first-time Telegram guidance without the old groupAllowFrom warning", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "123:abc",
              groupPolicy: "allowlist",
            },
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes('channels.telegram.accounts.default.groupPolicy is "allowlist"') &&
          line.includes("groupAllowFrom"),
      ),
    ).toBe(false);
    expect(
      doctorWarnings.some(
        (line) =>
          line.includes(
            "channels.telegram.accounts.default: Telegram is in first-time setup mode.",
          ) &&
          line.includes("DMs use pairing mode") &&
          line.includes("channels.telegram.accounts.default.groups"),
      ),
    ).toBe(true);
  });

  it("shows plugin-blocked guidance instead of first-time Telegram guidance when telegram is explicitly disabled", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          botToken: "123:abc",
          groupPolicy: "allowlist",
        },
      },
      plugins: {
        entries: {
          telegram: {
            enabled: false,
          },
        },
      },
    });

    expect(
      doctorWarnings.some((line) =>
        line.includes(
          'channels.telegram: channel is configured, but plugin "telegram" is disabled by plugins.entries.telegram.enabled=false.',
        ),
      ),
    ).toBe(true);
    expect(doctorWarnings.some((line) => line.includes("first-time setup mode"))).toBe(false);
  });

  it("shows plugin-blocked guidance instead of first-time Telegram guidance when plugins are disabled globally", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          botToken: "123:abc",
          groupPolicy: "allowlist",
        },
      },
      plugins: {
        enabled: false,
      },
    });

    expect(
      doctorWarnings.some((line) =>
        line.includes(
          "channels.telegram: channel is configured, but plugins.enabled=false blocks channel plugins globally.",
        ),
      ),
    ).toBe(true);
    expect(doctorWarnings.some((line) => line.includes("first-time setup mode"))).toBe(false);
  });

  it("warns on mutable Zalouser group entries when dangerous name matching is disabled", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        zalouser: {
          groups: {
            "Ops Room": { allow: true },
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes("mutable allowlist") && line.includes("channels.zalouser.groups: Ops Room"),
      ),
    ).toBe(true);
  });

  it("does not warn on mutable Zalouser group entries when dangerous name matching is enabled", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        zalouser: {
          dangerouslyAllowNameMatching: true,
          groups: {
            "Ops Room": { allow: true },
          },
        },
      },
    });

    expect(doctorWarnings.some((line) => line.includes("channels.zalouser.groups"))).toBe(false);
  });

  it("warns when imessage group allowlist is empty even if allowFrom is set", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        imessage: {
          groupPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes('channels.imessage.groupPolicy is "allowlist"') &&
          line.includes("does not fall back to allowFrom"),
      ),
    ).toBe(true);
  });

  it("repairs generic legacy config surfaces in one pass", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        bridge: { bind: "auto" },
        gateway: { auth: { mode: "token", token: "ok", extra: true } },
        agents: { list: [{ id: "pi" }] },
        browser: {
          relayBindHost: "0.0.0.0",
          profiles: {
            chromeLive: {
              driver: "extension",
              color: "#00AA00",
            },
          },
        },
        tools: {
          alsoAllow: ["browser"],
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as Record<string, unknown>;
    expect(cfg.bridge).toBeUndefined();
    expect((cfg.gateway as Record<string, unknown>)?.auth).toEqual({
      mode: "token",
      token: "ok",
    });
    const browser = (result.cfg as { browser?: Record<string, unknown> }).browser ?? {};
    expect(browser.relayBindHost).toBeUndefined();
    expect(
      ((browser.profiles as Record<string, { driver?: string }>)?.chromeLive ?? {}).driver,
    ).toBe("existing-session");
    expect(result.cfg.plugins?.allow).toEqual(["telegram", "browser"]);
    expect(result.cfg.plugins?.entries?.browser?.enabled).toBe(true);
  });

  it("preserves discord streaming intent while stripping unsupported keys on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            streaming: true,
            lifecycle: {
              enabled: true,
              reactions: {
                queued: "⏳",
                thinking: "🧠",
                tool: "🔧",
                done: "✅",
                error: "❌",
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      channels: {
        discord: {
          streamMode?: string;
          streaming?:
            | {
                mode?: string;
              }
            | boolean;
          lifecycle?: unknown;
        };
      };
    };
    expect(cfg.channels.discord.streaming).toEqual({ mode: "partial" });
    expect(cfg.channels.discord.streamMode).toBeUndefined();
    expect(cfg.channels.discord.lifecycle).toEqual({
      enabled: true,
      reactions: {
        queued: "⏳",
        thinking: "🧠",
        tool: "🔧",
        done: "✅",
        error: "❌",
      },
    });
  });

  it("warns clearly about legacy channel streaming aliases and points to doctor --fix", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      await runDoctorConfigWithInput({
        config: {
          channels: {
            telegram: {
              streamMode: "block",
            },
            discord: {
              streaming: false,
            },
            googlechat: {
              streamMode: "append",
            },
            slack: {
              streaming: true,
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            message.includes("channels.telegram:") &&
            message.includes("channels.telegram.streamMode, channels.telegram.streaming"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            message.includes("channels.googlechat:") &&
            message.includes("channels.googlechat.streamMode is legacy and no longer used"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            message.includes("channels.slack:") &&
            message.includes("channels.slack.streamMode, channels.slack.streaming"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockClear();
    }
  });

  it("keeps discord streaming aliases on disk during repair so downgrades stay recoverable", async () => {
    await withTempHome(
      async (home) => {
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify(
            {
              channels: {
                discord: {
                  streaming: false,
                  chunkMode: "newline",
                  blockStreaming: true,
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );

        await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true, repair: true },
          confirm: async () => false,
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          channels?: {
            discord?: {
              streaming?: unknown;
              chunkMode?: unknown;
              blockStreaming?: unknown;
            };
          };
        };

        expect(persisted.channels?.discord).toEqual({
          streaming: false,
          chunkMode: "newline",
          blockStreaming: true,
        });
      },
      { skipSessionCleanup: true },
    );
  });

  it("repairs legacy googlechat streamMode by removing it", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          googlechat: {
            streamMode: "append",
            accounts: {
              work: {
                streamMode: "replace",
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      channels: {
        googlechat: {
          accounts?: {
            work?: Record<string, unknown>;
          };
        } & Record<string, unknown>;
      };
    };
    expect(cfg.channels.googlechat.streamMode).toBeUndefined();
    expect(cfg.channels.googlechat.accounts?.work?.streamMode).toBeUndefined();
  });

  it("warns clearly about legacy nested channel allow aliases and points to doctor --fix", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      await runDoctorConfigWithInput({
        config: {
          channels: {
            slack: {
              channels: {
                ops: {
                  allow: false,
                },
              },
            },
            googlechat: {
              groups: {
                "spaces/aaa": {
                  allow: false,
                },
              },
            },
            discord: {
              guilds: {
                "100": {
                  channels: {
                    general: {
                      allow: false,
                    },
                  },
                },
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            message.includes("channels.slack:") &&
            message.includes("channels.slack.channels.<id>.allow is legacy"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            message.includes("channels.googlechat:") &&
            message.includes("channels.googlechat.groups.<id>.allow is legacy"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            message.includes("channels.discord:") &&
            message.includes("channels.discord.guilds.<id>.channels.<id>.allow is legacy"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockClear();
    }
  });

  it("repairs legacy nested channel allow aliases on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          slack: {
            channels: {
              ops: {
                allow: false,
              },
            },
          },
          googlechat: {
            groups: {
              "spaces/aaa": {
                allow: false,
              },
            },
          },
          discord: {
            guilds: {
              "100": {
                channels: {
                  general: {
                    allow: false,
                  },
                },
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.cfg.channels?.slack?.channels?.ops).toEqual({
      enabled: false,
    });
    expect(result.cfg.channels?.googlechat?.groups?.["spaces/aaa"]).toEqual({
      enabled: false,
    });
    expect(result.cfg.channels?.discord?.guilds?.["100"]?.channels?.general).toEqual({
      enabled: false,
    });
  });

  it("sanitizes config-derived doctor warnings and changes before logging", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      await runDoctorConfigWithInput({
        repair: true,
        config: {
          channels: {
            telegram: {
              accounts: {
                work: {
                  botToken: "tok",
                  allowFrom: ["@\u001b[31mtestuser"],
                },
              },
            },
            slack: {
              accounts: {
                work: {
                  allowFrom: ["alice\u001b[31m\nforged"],
                },
                "ops\u001b[31m\nopen": {
                  dmPolicy: "open",
                },
              },
            },
            whatsapp: {
              accounts: {
                "ops\u001b[31m\nempty": {
                  groupPolicy: "allowlist",
                },
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      const outputs = noteSpy.mock.calls
        .filter((call) => call[1] === "Doctor warnings" || call[1] === "Doctor changes")
        .map((call) => call[0]);
      const joinedOutputs = outputs.join("\n");
      expect(outputs.filter((line) => line.includes("\u001b"))).toEqual([]);
      expect(outputs.filter((line) => line.includes("\nforged"))).toEqual([]);
      expect(joinedOutputs).toContain('channels.slack.accounts.opsopen.allowFrom: set to ["*"]');
      expect(joinedOutputs).toContain('required by dmPolicy="open"');
      expect(
        outputs.some(
          (line) =>
            line.includes('channels.whatsapp.accounts.opsempty.groupPolicy is "allowlist"') &&
            line.includes("groupAllowFrom"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockClear();
    }
  });

  it("warns and continues when Telegram account inspection hits inactive SecretRef surfaces", async () => {
    const noteSpy = resetTerminalNoteMock();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await runDoctorConfigWithInput({
        repair: true,
        config: {
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          channels: {
            telegram: {
              accounts: {
                inactive: {
                  enabled: false,
                  botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
                  allowFrom: ["@testuser"],
                },
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      const cfg = result.cfg as {
        channels?: {
          telegram?: {
            accounts?: Record<string, { allowFrom?: string[] }>;
          };
        };
      };
      expect(cfg.channels?.telegram?.accounts?.inactive?.allowFrom).toEqual(["@testuser"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        noteSpy.mock.calls.some((call) =>
          call[0].includes("Telegram account inactive: failed to inspect bot token"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some((call) =>
          call[0].includes(
            "Telegram allowFrom contains @username entries, but configured Telegram bot credentials are unavailable in this command path",
          ),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockClear();
      vi.unstubAllGlobals();
    }
  });

  it("converts numeric discord ids to strings on repair", async () => {
    await withTempHome(
      async (home) => {
        const configDir = path.join(home, ".openclaw");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify(
            {
              channels: {
                discord: {
                  allowFrom: [123],
                  dm: { allowFrom: [456], groupChannels: [789] },
                  execApprovals: { approvers: [321] },
                  guilds: {
                    "100": {
                      users: [111],
                      roles: [222],
                      channels: {
                        general: { users: [333], roles: [444] },
                      },
                    },
                  },
                  accounts: {
                    work: {
                      allowFrom: [555],
                      dm: { allowFrom: [666], groupChannels: [777] },
                      execApprovals: { approvers: [888] },
                      guilds: {
                        "200": {
                          users: [999],
                          roles: [1010],
                          channels: {
                            help: { users: [1111], roles: [1212] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );

        const result = await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true, repair: true },
          confirm: async () => false,
        });

        const cfg = result.cfg as unknown as {
          channels: {
            discord: Omit<RepairedDiscordPolicy, "allowFrom"> & {
              allowFrom?: string[];
              accounts: Record<string, DiscordAccountRule> & {
                default: { allowFrom: string[] };
                work: {
                  allowFrom: string[];
                  dm: { allowFrom: string[]; groupChannels: string[] };
                  execApprovals: { approvers: string[] };
                  guilds: Record<string, DiscordGuildRule>;
                };
              };
            };
          };
        };

        expect(cfg.channels.discord.allowFrom).toBeUndefined();
        expect(cfg.channels.discord.dm.allowFrom).toEqual(["456"]);
        expect(cfg.channels.discord.dm.groupChannels).toEqual(["789"]);
        expect(cfg.channels.discord.execApprovals.approvers).toEqual(["321"]);
        expect(cfg.channels.discord.guilds["100"].users).toEqual(["111"]);
        expect(cfg.channels.discord.guilds["100"].roles).toEqual(["222"]);
        expect(cfg.channels.discord.guilds["100"].channels.general.users).toEqual(["333"]);
        expect(cfg.channels.discord.guilds["100"].channels.general.roles).toEqual(["444"]);
        expect(cfg.channels.discord.accounts.default.allowFrom).toEqual(["123"]);
        expect(cfg.channels.discord.accounts.work.allowFrom).toEqual(["555"]);
        expect(cfg.channels.discord.accounts.work.dm.allowFrom).toEqual(["666"]);
        expect(cfg.channels.discord.accounts.work.dm.groupChannels).toEqual(["777"]);
        expect(cfg.channels.discord.accounts.work.execApprovals.approvers).toEqual(["888"]);
        expect(cfg.channels.discord.accounts.work.guilds["200"].users).toEqual(["999"]);
        expect(cfg.channels.discord.accounts.work.guilds["200"].roles).toEqual(["1010"]);
        expect(cfg.channels.discord.accounts.work.guilds["200"].channels.help.users).toEqual([
          "1111",
        ]);
        expect(cfg.channels.discord.accounts.work.guilds["200"].channels.help.roles).toEqual([
          "1212",
        ]);
      },
      { skipSessionCleanup: true },
    );
  });

  it("does not restore top-level allowFrom when config is intentionally default-account scoped", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            accounts: {
              default: { token: "discord-default-token", allowFrom: ["123"] },
              work: { token: "discord-work-token" },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      channels: {
        discord: {
          allowFrom?: string[];
          accounts: Record<string, { allowFrom?: string[] }>;
        };
      };
    };

    expect(cfg.channels.discord.allowFrom).toBeUndefined();
    expect(cfg.channels.discord.accounts.default.allowFrom).toEqual(["123"]);
  });

  it('repairs open dmPolicy allowFrom variants with ["*"] in one pass', async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            token: "test-token",
            dmPolicy: "open",
            groupPolicy: "open",
          },
          googlechat: {
            accounts: {
              work: {
                dm: {
                  policy: "open",
                },
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        discord: { allowFrom: string[]; dmPolicy: string };
        googlechat: {
          accounts: {
            work: {
              dm: {
                policy: string;
                allowFrom: string[];
              };
              allowFrom?: string[];
            };
          };
        };
      };
    };
    expect(cfg.channels.discord.allowFrom).toEqual(["*"]);
    expect(cfg.channels.discord.dmPolicy).toBe("open");
    expect(cfg.channels.googlechat.accounts.work.dm.allowFrom).toEqual(["*"]);
    expect(cfg.channels.googlechat.accounts.work.allowFrom).toBeUndefined();
  });

  it('repairs dmPolicy="allowlist" by restoring allowFrom from pairing store on repair', async () => {
    const result = await withTempHome(
      async (home) => {
        const configDir = path.join(home, ".openclaw");
        const credentialsDir = path.join(configDir, "credentials");
        await fs.mkdir(credentialsDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify(
            {
              channels: {
                telegram: {
                  botToken: "fake-token",
                  dmPolicy: "allowlist",
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );
        await fs.writeFile(
          path.join(credentialsDir, "telegram-allowFrom.json"),
          JSON.stringify({ version: 1, allowFrom: ["12345"] }, null, 2),
          "utf-8",
        );
        return await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true, repair: true },
          confirm: async () => false,
        });
      },
      { skipSessionCleanup: true },
    );

    const cfg = result.cfg as {
      channels: {
        telegram: {
          dmPolicy: string;
          allowFrom: string[];
        };
      };
    };
    expect(cfg.channels.telegram.dmPolicy).toBe("allowlist");
    expect(cfg.channels.telegram.allowFrom).toEqual(["12345"]);
  });

  it("migrates legacy toolsBySender keys to typed id entries on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          whatsapp: {
            groups: {
              "123@g.us": {
                toolsBySender: {
                  owner: { allow: ["exec"] },
                  alice: { deny: ["exec"] },
                  "id:owner": { deny: ["exec"] },
                  "username:@ops-bot": { allow: ["fs.read"] },
                  "*": { deny: ["exec"] },
                },
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: Record<string, { allow?: string[]; deny?: string[] }>;
            };
          };
        };
      };
    };
    const toolsBySender = cfg.channels.whatsapp.groups["123@g.us"].toolsBySender;
    expect(toolsBySender.owner).toBeUndefined();
    expect(toolsBySender.alice).toBeUndefined();
    expect(toolsBySender["id:owner"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["id:alice"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["username:@ops-bot"]).toEqual({ allow: ["fs.read"] });
    expect(toolsBySender["*"]).toEqual({ deny: ["exec"] });
  });

  it("repairs legacy root runtime config surfaces in one pass", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        heartbeat: {
          model: "anthropic/claude-3-5-haiku-20241022",
          every: "30m",
          showOk: true,
          showAlerts: false,
        },
        gateway: {
          bind: "0.0.0.0",
        },
        session: {
          threadBindings: {
            ttlHours: 24,
          },
        },
        channels: {
          discord: {
            threadBindings: {
              ttlHours: 12,
            },
            accounts: {
              alpha: {
                threadBindings: {
                  ttlHours: 6,
                },
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      heartbeat?: unknown;
      gateway?: {
        bind?: string;
      };
      session?: {
        threadBindings?: {
          idleHours?: number;
          ttlHours?: number;
        };
      };
      agents?: {
        defaults?: {
          heartbeat?: {
            model?: string;
            every?: string;
          };
        };
      };
      channels?: {
        defaults?: {
          heartbeat?: {
            showOk?: boolean;
            showAlerts?: boolean;
            useIndicator?: boolean;
          };
        };
        discord?: {
          threadBindings?: {
            idleHours?: number;
            ttlHours?: number;
          };
          accounts?: Record<
            string,
            {
              threadBindings?: {
                idleHours?: number;
                ttlHours?: number;
              };
            }
          >;
        };
      };
    };
    expect(cfg.heartbeat).toBeUndefined();
    expect(cfg.agents?.defaults?.heartbeat).toMatchObject({
      model: "anthropic/claude-3-5-haiku-20241022",
      every: "30m",
    });
    expect(cfg.gateway?.bind).toBe("lan");
    expect(cfg.session?.threadBindings).toMatchObject({
      idleHours: 24,
    });
    expect(cfg.channels?.discord?.threadBindings).toMatchObject({
      idleHours: 12,
    });
    expect(cfg.channels?.discord?.accounts?.alpha?.threadBindings).toMatchObject({
      idleHours: 6,
    });
    expect(cfg.session?.threadBindings?.ttlHours).toBeUndefined();
    expect(cfg.channels?.discord?.threadBindings?.ttlHours).toBeUndefined();
    expect(cfg.channels?.discord?.accounts?.alpha?.threadBindings?.ttlHours).toBeUndefined();
    expect(cfg.channels?.defaults?.heartbeat).toMatchObject({
      showOk: true,
      showAlerts: false,
    });
  });

  it("warns clearly about legacy config surfaces and points to doctor --fix", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      await runDoctorConfigWithInput({
        config: {
          heartbeat: {
            model: "anthropic/claude-3-5-haiku-20241022",
            every: "30m",
            showOk: true,
            showAlerts: false,
          },
          memorySearch: {
            provider: "local",
            fallback: "none",
          },
          gateway: {
            bind: "localhost",
          },
          channels: {
            telegram: {
              groupMentionsOnly: true,
            },
            discord: {
              threadBindings: {
                ttlHours: 12,
              },
              accounts: {
                alpha: {
                  threadBindings: {
                    ttlHours: 6,
                  },
                },
              },
            },
          },
          tools: {
            web: {
              x_search: {
                apiKey: "test-key",
              },
            },
          },
          hooks: {
            internal: {
              handlers: [{ event: "command:new", module: "hooks/legacy-handler.js" }],
            },
          },
          session: {
            threadBindings: {
              ttlHours: 24,
            },
          },
          talk: {
            voiceId: "voice-1",
            modelId: "eleven_v3",
          },
          agents: {
            defaults: {
              sandbox: {
                perSession: true,
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      const legacyMessages = noteSpy.mock.calls
        .filter(([, title]) => title === "Legacy config keys detected")
        .map(([message]) => message)
        .join("\n");

      expect(legacyMessages).toContain("heartbeat:");
      expect(legacyMessages).toContain("agents.defaults.heartbeat");
      expect(legacyMessages).toContain("channels.defaults.heartbeat");
      expect(legacyMessages).toContain("memorySearch:");
      expect(legacyMessages).toContain("agents.defaults.memorySearch");
      expect(legacyMessages).toContain("gateway.bind:");
      expect(legacyMessages).toContain("gateway.bind host aliases");
      expect(legacyMessages).toContain("channels.telegram.groupMentionsOnly:");
      expect(legacyMessages).toContain("channels.telegram.groups");
      expect(legacyMessages).toContain("tools.web.x_search.apiKey:");
      expect(legacyMessages).toContain("plugins.entries.xai.config.webSearch.apiKey");
      expect(legacyMessages).toContain("hooks.internal.handlers:");
      expect(legacyMessages).toContain("HOOK.md + handler.js");
      expect(legacyMessages).toContain("does not rewrite this shape automatically");
      expect(legacyMessages).toContain("session.threadBindings.ttlHours");
      expect(legacyMessages).toContain("session.threadBindings.idleHours");
      expect(legacyMessages).toContain("channels.<id>.threadBindings.ttlHours");
      expect(legacyMessages).toContain("channels.<id>.threadBindings.idleHours");
      expect(legacyMessages).toContain("talk:");
      expect(legacyMessages).toContain(
        "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey",
      );
      expect(legacyMessages).toContain("agents.defaults.sandbox:");
      expect(legacyMessages).toContain("agents.defaults.sandbox.perSession is legacy");
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Doctor" &&
            message.includes('Run "openclaw doctor --fix" to migrate legacy config keys.'),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockClear();
    }
  });

  it("recovers from stale googlechat top-level allowFrom by repairing dm.allowFrom", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          googlechat: {
            allowFrom: ["*"],
            dm: {
              policy: "open",
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const cfg = result.cfg as {
      channels: {
        googlechat: {
          dm: { allowFrom: string[] };
          allowFrom?: string[];
        };
      };
    };
    expect(cfg.channels.googlechat.dm.allowFrom).toEqual(["*"]);
    expect(cfg.channels.googlechat.allowFrom).toEqual(["*"]);
  });

  it("does not report repeat talk provider normalization on consecutive repair runs", async () => {
    await withTempHome(
      async (home) => {
        const providerId = "acme-speech";
        const configDir = path.join(home, ".openclaw");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify(
            {
              talk: {
                interruptOnSpeech: true,
                silenceTimeoutMs: 1500,
                provider: providerId,
                providers: {
                  [providerId]: {
                    apiKey: "secret-key",
                    voiceId: "voice-123",
                    modelId: "eleven_v3",
                  },
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );

        const noteSpy = resetTerminalNoteMock();
        try {
          await loadAndMaybeMigrateDoctorConfig({
            options: { nonInteractive: true, repair: true },
            confirm: async () => false,
          });
          noteSpy.mockClear();

          await loadAndMaybeMigrateDoctorConfig({
            options: { nonInteractive: true, repair: true },
            confirm: async () => false,
          });
          const secondRunTalkNormalizationLines = noteSpy.mock.calls
            .filter((call) => call[1] === "Doctor changes")
            .map((call) => call[0])
            .filter((line) => line.includes("Normalized talk.provider/providers shape"));
          expect(secondRunTalkNormalizationLines).toEqual([]);
        } finally {
          noteSpy.mockClear();
        }
      },
      { skipSessionCleanup: true },
    );
  });
});
