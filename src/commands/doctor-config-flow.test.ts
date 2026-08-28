// Doctor config-flow tests cover config repair, migration, stripping, and validation orchestration.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeChannelPairingStateSnapshot } from "../pairing/pairing-store-sqlite.test-helpers.js";
import {
  buildPluginCapabilityConsentReview,
  type PluginCapabilityConsentHandler,
} from "../plugins/capability-consent.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import {
  getDoctorConfigInputForTest,
  runDoctorConfigWithInput,
} from "./doctor-config-flow.test-utils.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

type TerminalNote = (message: string, title?: string) => void;

const terminalNoteMock = vi.hoisted(() => vi.fn<TerminalNote>());
const callGatewayMock = vi.hoisted(() => vi.fn());
const runDoctorRepairSequenceMock = vi.hoisted(() => vi.fn());
const createDoctorPluginMetadataSnapshotScopeParamsMock = vi.hoisted(() => vi.fn());
const runDoctorConfigPreflightOptionsMock = vi.hoisted(() => vi.fn());
const collectDoctorPreviewNotesParamsMock = vi.hoisted(() => vi.fn());
const prepareTailscaleConfigMigrationMock = vi.hoisted(() =>
  vi.fn(({ cfg }: { cfg: OpenClawConfig }) => ({
    config: cfg,
    changes: [] as string[],
    warnings: [] as string[],
  })),
);
const collectImplicitFallbackClobberWarningsMock = vi.hoisted(() =>
  vi.fn<(cfg: unknown) => string[]>(() => []),
);
const noteImplicitFallbackClobberWarningsMock = vi.hoisted(() =>
  vi.fn<(cfg: unknown) => void>((cfg) => {
    const warnings = collectImplicitFallbackClobberWarningsMock(cfg);
    if (warnings.length > 0) {
      terminalNoteMock(warnings.join("\n"), "Doctor warnings");
    }
  }),
);
const legacyConfigMigrationForTest = await vi.hoisted(async () => {
  const { asNullableRecord: readNullableRecord } =
    await import("@openclaw/normalization-core/record-coerce");

  function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
    const current = readNullableRecord(parent[key]);
    if (current) {
      return current;
    }
    const next: Record<string, unknown> = {};
    parent[key] = next;
    return next;
  }

  function migrateThreadBinding(value: unknown, changes: string[], pathLabel: string): void {
    const record = readNullableRecord(value);
    const bindings = readNullableRecord(record?.threadBindings);
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
    const streaming = readNullableRecord(channel.streaming) ?? {};
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
      for (const room of Object.values(readNullableRecord(channel.channels) ?? {})) {
        const roomRecord = readNullableRecord(room);
        if (roomRecord && "allow" in roomRecord) {
          roomRecord.enabled = roomRecord.allow;
          delete roomRecord.allow;
          changed = true;
        }
      }
    }
    if (channelId === "googlechat") {
      for (const group of Object.values(readNullableRecord(channel.groups) ?? {})) {
        const groupRecord = readNullableRecord(group);
        if (groupRecord && "allow" in groupRecord) {
          groupRecord.enabled = groupRecord.allow;
          delete groupRecord.allow;
          changed = true;
        }
      }
    }
    if (channelId === "discord") {
      for (const guild of Object.values(readNullableRecord(channel.guilds) ?? {})) {
        for (const room of Object.values(
          readNullableRecord(readNullableRecord(guild)?.channels) ?? {},
        )) {
          const roomRecord = readNullableRecord(room);
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
    const root = readNullableRecord(raw);
    if (!root) {
      return { next: null, changes: [] };
    }
    const next = structuredClone(root);
    const changes: string[] = [];

    const heartbeat = readNullableRecord(next.heartbeat);
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
          ...readNullableRecord(agentDefaults.heartbeat),
          ...agentHeartbeat,
        };
      }
      if (Object.keys(channelHeartbeat).length > 0) {
        channelDefaults.heartbeat = {
          ...readNullableRecord(channelDefaults.heartbeat),
          ...channelHeartbeat,
        };
      }
      delete next.heartbeat;
      changes.push("Moved heartbeat to agents.defaults.heartbeat and channels.defaults.heartbeat.");
    }

    const internalHooks = readNullableRecord(readNullableRecord(next.hooks)?.internal);
    if (internalHooks && "handlers" in internalHooks) {
      delete internalHooks.handlers;
      changes.push(
        "Removed retired hooks.internal.handlers registrations; hook files must be migrated separately.",
      );
      const entries = readNullableRecord(internalHooks.entries);
      const extraDirs = readNullableRecord(internalHooks.load)?.extraDirs;
      const hasNamedEntries = Boolean(entries && Object.keys(entries).length > 0);
      const hasExtraDirs =
        Array.isArray(extraDirs) &&
        extraDirs.some((dir) => typeof dir === "string" && dir.trim().length > 0);
      if (internalHooks.enabled === true && !hasNamedEntries && !hasExtraDirs) {
        delete internalHooks.enabled;
        changes.push(
          "Removed legacy-only hooks.internal.enabled to avoid enabling broad hook discovery.",
        );
      }
    }

    const gateway = readNullableRecord(next.gateway);
    if (gateway?.bind === "0.0.0.0") {
      gateway.bind = "lan";
      changes.push("Normalized gateway.bind host alias.");
    } else if (gateway?.bind === "localhost" || gateway?.bind === "127.0.0.1") {
      gateway.bind = "loopback";
      changes.push("Normalized gateway.bind host alias.");
    }

    migrateThreadBinding(next.session, changes, "session");
    const sessionMaintenance = readNullableRecord(readNullableRecord(next.session)?.maintenance);
    if (sessionMaintenance && "rotateBytes" in sessionMaintenance) {
      delete sessionMaintenance.rotateBytes;
      changes.push("Removed deprecated session.maintenance.rotateBytes.");
    }
    const channels = readNullableRecord(next.channels);
    for (const [channelId, channelRaw] of Object.entries(channels ?? {})) {
      if (channelId === "defaults") {
        continue;
      }
      const channel = readNullableRecord(channelRaw);
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
      for (const [accountId, accountRaw] of Object.entries(
        readNullableRecord(channel.accounts) ?? {},
      )) {
        const account = readNullableRecord(accountRaw);
        migrateThreadBinding(account, changes, `channels.${channelId}.accounts.${accountId}`);
        if (account && migrateStreamingAlias(account, channelId)) {
          changes.push(`Normalized channels.${channelId}.accounts.${accountId} streaming aliases.`);
        }
      }
    }

    const sandbox = readNullableRecord(
      readNullableRecord(readNullableRecord(next.agents)?.defaults)?.sandbox,
    );
    if (sandbox && "perSession" in sandbox) {
      sandbox.scope = sandbox.perSession === true ? "session" : "workspace";
      delete sandbox.perSession;
      changes.push("Moved agents.defaults.sandbox.perSession to scope.");
    }

    return changes.length > 0 ? { next, changes } : { next: null, changes: [] };
  }

  let partiallyValidOverride: boolean | undefined;

  return {
    migrateLegacyConfig: (raw: unknown) => {
      const { next, changes } = migrate(raw);
      const partiallyValid = partiallyValidOverride;
      return { config: next, changes, ...(partiallyValid ? { partiallyValid } : {}) };
    },
    setPartiallyValidOverride(value: boolean | undefined) {
      partiallyValidOverride = value;
    },
  };
});

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: terminalNoteMock,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./doctor-tailscale.js", () => ({
  prepareTailscaleConfigMigration: prepareTailscaleConfigMigrationMock,
}));

vi.mock("./doctor/repair-sequencing.js", async () => {
  const actual = await vi.importActual<typeof import("./doctor/repair-sequencing.js")>(
    "./doctor/repair-sequencing.js",
  );
  return {
    ...actual,
    runDoctorRepairSequence: (params: unknown) => {
      if (runDoctorRepairSequenceMock.getMockImplementation()) {
        return runDoctorRepairSequenceMock(params);
      }
      return actual.runDoctorRepairSequence(
        params as Parameters<typeof actual.runDoctorRepairSequence>[0],
      );
    },
  };
});

vi.mock("./doctor/shared/plugin-metadata-snapshot-scope.js", async () => {
  const actual = await vi.importActual<
    typeof import("./doctor/shared/plugin-metadata-snapshot-scope.js")
  >("./doctor/shared/plugin-metadata-snapshot-scope.js");
  return {
    ...actual,
    createDoctorPluginMetadataSnapshotScope: (
      params: Parameters<typeof actual.createDoctorPluginMetadataSnapshotScope>[0],
    ) => {
      createDoctorPluginMetadataSnapshotScopeParamsMock(params);
      return actual.createDoctorPluginMetadataSnapshotScope(params);
    },
  };
});

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

vi.mock("../config/legacy.js", async () => {
  const { asNullableRecord: readNullableRecord } =
    await import("@openclaw/normalization-core/record-coerce");
  type LegacyRule = {
    path: string[];
    message: string;
    match?: (value: unknown, root: Record<string, unknown>) => boolean;
    requireSourceLiteral?: boolean;
  };

  function getPathValue(root: Record<string, unknown>, pathParts: readonly string[]): unknown {
    let cursor: unknown = root;
    for (const part of pathParts) {
      const record = readNullableRecord(cursor);
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
      const root = readNullableRecord(raw);
      if (!root) {
        return [];
      }
      const sourceRoot = readNullableRecord(sourceRaw) ?? root;
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
          'memorySearch is legacy; use memory.search. Run "openclaw doctor --fix".',
        );
      }
      const gateway = readNullableRecord(root.gateway);
      if (gateway && "bind" in gateway) {
        addIssue(
          issues,
          ["gateway", "bind"],
          'gateway.bind host aliases are legacy; use the canonical bind mode. Run "openclaw doctor --fix".',
        );
      }
      const sessionThreadBindings = readNullableRecord(
        readNullableRecord(root.session)?.threadBindings,
      );
      if (sessionThreadBindings && "ttlHours" in sessionThreadBindings) {
        addIssue(
          issues,
          ["session", "threadBindings", "ttlHours"],
          'session.threadBindings.ttlHours is legacy; use session.threadBindings.idleHours. Run "openclaw doctor --fix".',
        );
      }
      const sessionMaintenance = readNullableRecord(readNullableRecord(root.session)?.maintenance);
      if (sessionMaintenance && "rotateBytes" in sessionMaintenance) {
        addIssue(
          issues,
          ["session", "maintenance"],
          'session.maintenance.rotateBytes is deprecated and ignored; run "openclaw doctor --fix" to remove it.',
        );
      }
      const xSearch = readNullableRecord(
        readNullableRecord(readNullableRecord(root.tools)?.web)?.x_search,
      );
      if (xSearch && "apiKey" in xSearch) {
        addIssue(
          issues,
          ["tools", "web", "x_search", "apiKey"],
          'tools.web.x_search.apiKey is legacy; use plugins.entries.xai.config.webSearch.apiKey. Run "openclaw doctor --fix".',
        );
      }
      const sandbox = readNullableRecord(
        readNullableRecord(readNullableRecord(root.agents)?.defaults)?.sandbox,
      );
      if (sandbox && "perSession" in sandbox) {
        addIssue(
          issues,
          ["agents", "defaults", "sandbox"],
          'agents.defaults.sandbox.perSession is legacy; use agents.defaults.sandbox.scope. Run "openclaw doctor --fix".',
        );
      }
      const internalHooks = readNullableRecord(readNullableRecord(root.hooks)?.internal);
      if (internalHooks && "handlers" in internalHooks) {
        addIssue(
          issues,
          ["hooks", "internal", "handlers"],
          'hooks.internal.handlers is retired. Move each module to a managed/workspace hook directory with HOOK.md + handler file before running "openclaw doctor --fix"; the fix removes retired registrations and does not materialize executable files.',
        );
      }

      const channels = readNullableRecord(root.channels);
      for (const [channelId, channelRaw] of Object.entries(channels ?? {})) {
        if (channelId === "defaults") {
          continue;
        }
        const channel = readNullableRecord(channelRaw);
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
        const threadBindings = readNullableRecord(channel.threadBindings);
        if (threadBindings && "ttlHours" in threadBindings) {
          addIssue(
            issues,
            ["channels", channelId, "threadBindings", "ttlHours"],
            'channels.<id>.threadBindings.ttlHours is legacy; use channels.<id>.threadBindings.idleHours. Run "openclaw doctor --fix".',
          );
        }
        if (channelId === "slack") {
          for (const roomRaw of Object.values(readNullableRecord(channel.channels) ?? {})) {
            if ("allow" in (readNullableRecord(roomRaw) ?? {})) {
              addIssue(
                issues,
                ["channels", "slack"],
                'channels.slack.channels.<id>.allow is legacy; use enabled. Run "openclaw doctor --fix".',
              );
            }
          }
        }
        if (channelId === "googlechat") {
          for (const spaceRaw of Object.values(readNullableRecord(channel.groups) ?? {})) {
            if ("allow" in (readNullableRecord(spaceRaw) ?? {})) {
              addIssue(
                issues,
                ["channels", "googlechat"],
                'channels.googlechat.groups.<id>.allow is legacy; use enabled. Run "openclaw doctor --fix".',
              );
            }
          }
        }
        if (channelId === "discord") {
          for (const guildRaw of Object.values(readNullableRecord(channel.guilds) ?? {})) {
            const guild = readNullableRecord(guildRaw);
            for (const roomRaw of Object.values(readNullableRecord(guild?.channels) ?? {})) {
              if ("allow" in (readNullableRecord(roomRaw) ?? {})) {
                addIssue(
                  issues,
                  ["channels", "discord"],
                  'channels.discord.guilds.<id>.channels.<id>.allow is legacy; use enabled. Run "openclaw doctor --fix".',
                );
              }
            }
          }
        }
        for (const [accountId, accountRaw] of Object.entries(
          readNullableRecord(channel.accounts) ?? {},
        )) {
          const account = readNullableRecord(accountRaw);
          const accountThreadBindings = readNullableRecord(account?.threadBindings);
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
    "botId",
    "secret",
    "botToken",
    "webhookPath",
    "webhookUrl",
    "dmPolicy",
    "allowFrom",
    "groupPolicy",
    "groupAllowFrom",
    "defaultTo",
  ]);
  const legacyCommonSingleAccountKeys = new Set([
    "accessToken",
    "appToken",
    "httpUrl",
    "password",
    "userId",
    "webhookSecret",
  ]);
  const declaredSingleAccountKeys: Record<string, readonly string[]> = {
    discord: [],
    imessage: ["cliPath", "dbPath", "service", "region"],
    irc: ["password"],
    matrix: [
      "homeserver",
      "userId",
      "accessToken",
      "password",
      "deviceId",
      "deviceName",
      "avatarUrl",
      "initialSyncLimit",
      "encryption",
    ],
    mattermost: [],
    "nextcloud-talk": ["rooms"],
    signal: ["signalNumber", "account", "cliPath", "httpUrl", "httpHost", "httpPort"],
    slack: ["appToken"],
    telegram: ["streaming", "webhookSecret"],
    tlon: ["url", "code"],
    twitch: ["accessToken"],
    whatsapp: ["authDir"],
    zalo: ["webhookSecret", "tokenFile"],
  };
  const namedAccountPromotionKeys: Record<string, readonly string[]> = {
    matrix: [
      "name",
      "homeserver",
      "userId",
      "accessToken",
      "password",
      "deviceId",
      "deviceName",
      "avatarUrl",
      "initialSyncLimit",
      "encryption",
    ],
    telegram: ["botToken", "tokenFile"],
  };

  const resolveKeys = ({
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
    const hasNamedAccounts = Object.keys(accounts).some(Boolean);
    const allowedNamedKeys = namedAccountPromotionKeys[channelKey];
    const hasDeclarations = Object.hasOwn(declaredSingleAccountKeys, channelKey);
    const declaredKeys = declaredSingleAccountKeys[channelKey];
    return Object.entries(channel)
      .filter(([key, value]) => {
        if (key === "accounts" || key === "enabled" || value === undefined) {
          return false;
        }
        const isKnownKey =
          commonSingleAccountKeys.has(key) ||
          (hasDeclarations
            ? (declaredKeys?.includes(key) ?? false)
            : legacyCommonSingleAccountKeys.has(key));
        if (!isKnownKey) {
          return false;
        }
        if (hasNamedAccounts && allowedNamedKeys && !allowedNamedKeys.includes(key)) {
          return false;
        }
        return true;
      })
      .map(([key]) => key);
  };

  return {
    resolveSingleAccountKeysToMove: resolveKeys,
    resolveSingleAccountPromotion: (params: {
      channelKey: string;
      channel: Record<string, unknown>;
    }) => ({
      keysToMove: resolveKeys(params),
      shouldDeferPromotion:
        !Object.hasOwn(declaredSingleAccountKeys, params.channelKey) &&
        Object.keys(params.channel).some(
          (key) =>
            !commonSingleAccountKeys.has(key) &&
            !legacyCommonSingleAccountKeys.has(key) &&
            !["accounts", "defaultAccount", "enabled"].includes(key),
        ),
    }),
  };
});

vi.mock("./doctor/shared/channel-legacy-config-migrate.js", () => ({
  applyChannelDoctorCompatibilityMigrations: (cfg: Record<string, unknown>) => ({
    next: cfg,
    changes: [],
  }),
}));

vi.mock("./doctor/shared/legacy-config-migrate.js", () => ({
  migrateLegacyConfig: (raw: unknown) => legacyConfigMigrationForTest.migrateLegacyConfig(raw),
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

vi.mock("./doctor/shared/plugin-tool-allowlist-warnings.js", () => ({
  collectBundledProviderAllowlistPolicyWarnings: vi.fn(() => []),
  collectPluginToolAllowlistWarnings: vi.fn(() => []),
}));

vi.mock("../doctor-plugin-host-links.js", () => ({
  maybeRepairPluginOpenClawHostLinks: vi.fn(async () => undefined),
}));

vi.mock("../doctor-plugin-registry.js", () => ({
  maybeRepairStaleManagedNpmBundledPlugins: vi.fn(() => undefined),
}));

vi.mock("../doctor-auth-oauth-sidecar.js", () => ({
  maybeRepairLegacyOAuthSidecarProfiles: vi.fn(async () => ({
    detected: [],
    changes: [],
    warnings: [],
  })),
}));

vi.mock("./doctor/shared/context-engine-host-compat.js", () => ({
  maybeRepairContextEngineHostCompatibility: vi.fn(async ({ cfg }) => ({
    config: cfg,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: vi.fn(async ({ cfg }) => ({
    config: cfg,
    changes: [],
    warnings: [],
    failedPluginIds: [],
  })),
}));

vi.mock("./doctor/shared/active-tool-schema-warnings.js", () => ({
  collectActiveToolSchemaProjectionWarnings: vi.fn(async () => []),
}));

vi.mock("./doctor/shared/plugin-dependency-cleanup.js", () => ({
  cleanupLegacyPluginDependencyState: vi.fn(async () => ({
    changes: [],
    warnings: [],
  })),
}));

vi.mock("./doctor/shared/stale-oauth-profile-shadows.js", () => ({
  repairStaleOAuthProfileShadows: vi.fn(async () => ({
    changes: [],
    warnings: [],
  })),
}));

vi.mock("./doctor/channel-capabilities.js", () => {
  const byChannel = {
    googlechat: {
      dmAllowFromMode: "topOnly",
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
      groupAllowFromFallbackToAllowFrom: true,
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
    resolveDoctorChannelAccountIds: () => undefined,
  };
});

vi.mock("../plugins/doctor-contract-registry.js", async () => {
  const { asNullableRecord: readNullableRecord } =
    await import("@openclaw/normalization-core/record-coerce");

  function hasLegacyTalkFields(value: unknown): boolean {
    const talk = readNullableRecord(value);
    return Boolean(
      talk &&
      ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"].some((key) =>
        Object.hasOwn(talk, key),
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
    const streaming = readNullableRecord(entry.streaming) ?? {};
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
    const block = readNullableRecord(streaming.block) ?? {};
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
    const preview = readNullableRecord(streaming.preview) ?? {};
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
    const root = readNullableRecord(cfg);
    const discord = readNullableRecord(readNullableRecord(root?.channels)?.discord);
    if (!root || !discord) {
      return { config: cfg, changes: [] };
    }

    const next = structuredClone(root);
    const nextDiscord = readNullableRecord(readNullableRecord(next.channels)?.discord);
    if (!nextDiscord) {
      return { config: cfg, changes: [] };
    }

    const changes: string[] = [];
    normalizeDiscordStreamingEntry(nextDiscord, "channels.discord", changes);
    const accounts = readNullableRecord(nextDiscord.accounts);
    for (const [accountId, accountRaw] of Object.entries(accounts ?? {})) {
      const account = readNullableRecord(accountRaw);
      if (account) {
        normalizeDiscordStreamingEntry(account, `channels.discord.accounts.${accountId}`, changes);
      }
    }
    return changes.length > 0 ? { config: next, changes } : { config: cfg, changes: [] };
  }

  const collectRelevantDoctorPluginIds = (raw: unknown): string[] => {
    const ids = new Set<string>();
    const root = readNullableRecord(raw);
    const channels = readNullableRecord(root?.channels);
    for (const channelId of Object.keys(channels ?? {})) {
      if (channelId !== "defaults") {
        ids.add(channelId);
      }
    }
    if (hasLegacyTalkFields(root?.talk)) {
      ids.add("elevenlabs");
    }
    return [...ids].toSorted();
  };
  return {
    collectRelevantDoctorPluginIds,
    collectDoctorConfigRepairPluginIds: collectRelevantDoctorPluginIds,
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

vi.mock("./doctor/shared/legacy-config-issues.js", async () => {
  const {
    collectRelevantDoctorPluginIds,
    listPluginDoctorLegacyConfigRules,
  }: typeof import("../plugins/doctor-contract-registry.js") =
    await import("../plugins/doctor-contract-registry.js");
  const { findLegacyConfigIssues }: typeof import("../config/legacy.js") =
    await import("../config/legacy.js");
  return {
    findDoctorLegacyConfigIssues: (raw: unknown, sourceRaw?: unknown) =>
      findLegacyConfigIssues(
        raw,
        sourceRaw,
        listPluginDoctorLegacyConfigRules({
          pluginIds: collectRelevantDoctorPluginIds(raw),
        }),
      ),
  };
});

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupCliBackend: vi.fn(() => undefined),
  resolvePluginSetupRegistry: vi.fn(() => ({
    providers: [],
    cliBackends: [],
    configMigrations: [],
    autoEnableProbes: [],
    diagnostics: [],
  })),
  resolvePluginSetupAutoEnableReasons: vi.fn(() => []),
  runPluginSetupConfigMigrations: vi.fn(({ config }: { config: unknown }) => ({
    config,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/channel-doctor.js", async () => {
  const { asNullableRecord: readNullableRecord } =
    await import("@openclaw/normalization-core/record-coerce");

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
      const record = readNullableRecord(value);
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
    const telegram = readNullableRecord(next.channels?.telegram);
    if (telegram && "groupMentionsOnly" in telegram) {
      const groups = readNullableRecord(telegram.groups) ?? {};
      const defaultGroup = readNullableRecord(groups["*"]) ?? {};
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
    const telegram = readNullableRecord(cfg.channels?.telegram);
    if (!telegram) {
      return [];
    }
    const accounts = readNullableRecord(telegram.accounts);
    if (!accounts) {
      return [];
    }
    return Object.entries(accounts).flatMap(([accountId, accountRaw]) => {
      const account = readNullableRecord(accountRaw);
      if (
        !account ||
        account.enabled !== false ||
        !readNullableRecord(account.botToken) ||
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
    const groups =
      readNullableRecord(params.account.groups) ?? readNullableRecord(params.parent?.groups);
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
        const zalouser = readNullableRecord(cfg.channels?.zalouser);
        if (!zalouser || zalouser.dangerouslyAllowNameMatching === true) {
          return [];
        }
        const groups = readNullableRecord(zalouser.groups);
        if (!groups) {
          return [];
        }
        return Object.entries(groups).flatMap(([name, group]) =>
          readNullableRecord(group)?.allow === true
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
        const discord = readNullableRecord(cfg.channels?.discord);
        if (discord) {
          const next = structuredClone(cfg);
          const nextDiscord = readNullableRecord(next.channels?.discord);
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

vi.mock("./doctor/shared/preview-warnings.js", async () => {
  const { asNullableRecord: readNullableRecord } =
    await import("@openclaw/normalization-core/record-coerce");

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
    if (
      !botToken ||
      readNullableRecord(params.account.groups) ||
      readNullableRecord(params.parent?.groups)
    ) {
      return [];
    }
    if (hasStringEntries(params.account.groupAllowFrom ?? params.parent?.groupAllowFrom)) {
      return [];
    }
    return [
      `- ${params.prefix}: Telegram is in first-time setup mode. DMs use pairing mode. Group messages stay blocked until you add allowed chats under ${params.prefix}.groups (and optional sender IDs under ${params.prefix}.groupAllowFrom), or set ${params.prefix}.groupPolicy to "open" if you want broad group access.`,
    ];
  }

  async function collectWarnings({
    cfg,
  }: {
    cfg: {
      channels?: Record<string, unknown>;
      plugins?: { enabled?: boolean; entries?: Record<string, { enabled?: boolean }> };
    };
    doctorFixCommand: string;
  }): Promise<string[]> {
    const warnings: string[] = [];
    const telegram = readNullableRecord(cfg.channels?.telegram);
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
        const accounts = readNullableRecord(telegram.accounts);
        for (const [accountId, accountRaw] of Object.entries(accounts ?? {})) {
          const account = readNullableRecord(accountRaw);
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
    const imessage = readNullableRecord(cfg.channels?.imessage);
    if (imessage?.groupPolicy === "allowlist" && !hasStringEntries(imessage.groupAllowFrom)) {
      warnings.push(
        '- channels.imessage.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped.',
      );
    }
    return warnings;
  }

  return {
    collectDoctorPreviewNotes: vi.fn(async (params) => {
      collectDoctorPreviewNotesParamsMock(params);
      return {
        infoNotes: [],
        warningNotes: await collectWarnings(params),
      };
    }),
  };
});

vi.mock("./doctor-config-preflight.js", async () => {
  const fsLocal = await import("node:fs/promises");
  const pathLocal = await import("node:path");
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
      (process.env.HOME ? pathLocal.join(process.env.HOME, ".openclaw") : "");
    return process.env.OPENCLAW_CONFIG_PATH || pathLocal.join(stateDir, "openclaw.json");
  }

  return {
    runDoctorConfigPreflight: vi.fn(async (options: unknown) => {
      runDoctorConfigPreflightOptionsMock(options);
      const injected = getDoctorConfigInputForTest();
      const configPath = injected?.path ?? resolveConfigPath();
      let parsed: Record<string, unknown> = injected?.parsed
        ? structuredClone(injected.parsed)
        : injected?.config
          ? structuredClone(injected.config)
          : {};
      let injectedEffectiveConfig = injected?.config ? structuredClone(injected.config) : parsed;
      let exists = injected?.exists ?? false;
      if (!injected) {
        try {
          parsed = JSON.parse(await fsLocal.readFile(configPath, "utf-8")) as Record<
            string,
            unknown
          >;
          exists = true;
          injectedEffectiveConfig = parsed;
        } catch {
          parsed = {};
          injectedEffectiveConfig = parsed;
        }
      }
      const sourceConfigBeforeMigrations = injected?.sourceConfigBeforeMigrations
        ? structuredClone(injected.sourceConfigBeforeMigrations)
        : injectedEffectiveConfig;
      if (injected?.preflightMode === "fast") {
        return {
          snapshot: {
            exists,
            path: configPath,
            parsed,
            agentRosterIncludeOwned: injected?.agentRosterIncludeOwned === true,
            sourceConfigBeforeMigrations,
            config: injectedEffectiveConfig,
            sourceConfig: injectedEffectiveConfig,
            valid: true,
            warnings: [],
            legacyIssues: [],
          },
          baseConfig: injectedEffectiveConfig,
        };
      }
      const legacyIssues = findLegacyConfigIssues(
        parsed,
        parsed,
        listPluginDoctorLegacyConfigRules({
          pluginIds: collectRelevantDoctorPluginIds(parsed),
        }),
      );
      // The read path does not apply Doctor-only repairs before the migration owner runs.
      return {
        snapshot: {
          exists,
          path: configPath,
          parsed,
          agentRosterIncludeOwned: injected?.agentRosterIncludeOwned === true,
          sourceConfigBeforeMigrations,
          config: injectedEffectiveConfig,
          sourceConfig: injectedEffectiveConfig,
          valid: legacyIssues.length === 0,
          warnings: [],
          legacyIssues,
        },
        baseConfig: injectedEffectiveConfig,
      };
    }),
  };
});

vi.mock("./doctor-config-analysis.js", () => {
  function formatConfigKeyPath(parts: Array<string | number>): string {
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
    collectImplicitFallbackClobberWarnings: collectImplicitFallbackClobberWarningsMock,
    formatConfigKeyPath,
    noteImplicitFallbackClobberWarnings: noteImplicitFallbackClobberWarningsMock,
    noteIncludeConfinementWarning: vi.fn(),
    noteOpencodeProviderOverrides: vi.fn(),
    noteMcpOriginWarning: vi.fn(),
    noteSandboxOriginProxyWarning: vi.fn(),
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
  autoMigrateLegacyState: vi.fn(async () => ({ changes: [], warnings: [] })),
  autoMigrateLegacyStateDir: vi.fn(async () => ({ changes: [], warnings: [] })),
  autoMigrateLegacyTaskStateSidecars: vi.fn(async () => ({ changes: [], warnings: [] })),
  migrateLegacyMediaPersistence: vi.fn(() => ({ changes: [], warnings: [] })),
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
  const warnings: string[] = [];
  for (const [message, title] of noteSpy.mock.calls) {
    if (title === "Doctor warnings") {
      warnings.push(message);
    }
  }
  return warnings;
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
  beforeAll(async () => {
    await Promise.all([
      import("../config/plugin-auto-enable.js"),
      import("./doctor/repair-sequencing.js"),
      import("./doctor/shared/channel-doctor.js"),
      import("./doctor/shared/legacy-config-issues.js"),
      import("./doctor/shared/plugin-tool-allowlist-warnings.js"),
      import("./doctor/shared/preview-warnings.js"),
      import("./doctor/shared/hooks-token-reuse-repair.js"),
    ]);
    await collectDoctorWarnings({
      channels: {
        slack: {
          dangerouslyAllowNameMatching: true,
          accounts: { work: { allowFrom: ["alice"] } },
        },
      },
    });
    await collectDoctorWarnings({
      channels: {
        googlechat: {
          groupPolicy: "allowlist",
          accounts: { work: { groupPolicy: "allowlist" } },
        },
      },
    });
  });

  beforeEach(() => {
    terminalNoteMock.mockClear();
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({});
    runDoctorRepairSequenceMock.mockReset();
    createDoctorPluginMetadataSnapshotScopeParamsMock.mockClear();
    collectDoctorPreviewNotesParamsMock.mockClear();
    prepareTailscaleConfigMigrationMock.mockClear();
    prepareTailscaleConfigMigrationMock.mockImplementation(({ cfg }) => ({
      config: cfg,
      changes: [],
      warnings: [],
    }));
    collectImplicitFallbackClobberWarningsMock.mockClear();
    collectImplicitFallbackClobberWarningsMock.mockReturnValue([]);
    noteImplicitFallbackClobberWarningsMock.mockClear();
    runDoctorConfigPreflightOptionsMock.mockClear();
  });

  it("preserves invalid config for doctor repairs", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        gateway: { auth: { mode: "token", token: 123 } },
        agents: { entries: { openclaw: {} } },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect((result.cfg as Record<string, unknown>).gateway).toEqual({
      auth: { mode: "token", token: 123 },
    });
  });

  it("previews and applies the legacy Tailscale Serve migration through Doctor", async () => {
    const config: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "secret" },
        tailscale: { mode: "off" },
      },
    };
    prepareTailscaleConfigMigrationMock.mockImplementation(({ cfg }) => ({
      config: {
        ...cfg,
        gateway: {
          ...cfg.gateway,
          bind: "loopback" as const,
          tailscale: { ...cfg.gateway?.tailscale, mode: "serve" as const },
        },
      },
      changes: ["Migrated legacy Tailscale Serve to managed ingress."],
      warnings: [],
    }));

    const preview = await runDoctorConfigWithInput({
      config,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const repair = await runDoctorConfigWithInput({
      config,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(preview.shouldWriteConfig).toBe(false);
    expect(preview.cfg.gateway?.bind).toBe("lan");
    expect(repair.shouldWriteConfig).toBe(true);
    expect(repair.cfg.gateway?.bind).toBe("loopback");
    expect(repair.cfg.gateway?.tailscale?.mode).toBe("serve");
    expect(prepareTailscaleConfigMigrationMock).toHaveBeenCalledTimes(2);
  });

  it("plans persistence of the injected main roster during doctor repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: {
          entries: { main: { workspace: "/tmp/migrated-main" } },
        },
        gateway: { mode: "local" },
      },
      parsedConfig: { gateway: { mode: "local" } },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.explicitSetPaths).toEqual([["agents", "entries"]]);
    expect(result.cfg.agents?.entries).toEqual({
      main: { workspace: "/tmp/migrated-main" },
    });
    // Repair panels defer to the atomic write runner; the flow itself must not
    // claim the roster change happened before anything reached disk.
    expect(result.pendingChangePanels).toContain(
      "Prepared the canonical agent roster without retired default markers for persistence.",
    );
    expect(terminalNoteMock.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
    expect(terminalNoteMock.mock.calls.some(([message]) => message.includes("Persisted"))).toBe(
      false,
    );
  });

  it("previews and persists pre-parse context-budget cleanup with every path reported", async () => {
    const canonical = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                contextTokens: 64_000,
                contextWindow: 128_000,
              },
            ],
          },
        },
      },
      agents: { defaults: {}, entries: { ops: {} } },
    };
    const legacy = {
      models: {
        providers: {
          openai: {
            contextTokens: 64_000,
            contextWindow: 128_000,
            models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
          },
        },
      },
      agents: { defaults: { contextTokens: 48_000 }, entries: { ops: { contextTokens: 32_000 } } },
    };

    await runDoctorConfigWithInput({
      config: canonical,
      parsedConfig: legacy,
      sourceConfigBeforeMigrations: legacy,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const previewText = terminalNoteMock.mock.calls.map(([message]) => message).join("\n");
    expect(previewText).toContain(
      "models.providers.openai.contextTokens → models.providers.openai.models[0].contextTokens",
    );
    expect(previewText).toContain("Removed agents.defaults.contextTokens");
    expect(previewText).toContain("Removed agents.entries.ops.contextTokens");
    expect(previewText).toContain("models.providers.<provider>.models[].contextTokens");

    terminalNoteMock.mockClear();
    const repaired = await runDoctorConfigWithInput({
      config: canonical,
      parsedConfig: legacy,
      sourceConfigBeforeMigrations: legacy,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(repaired.shouldWriteConfig).toBe(true);
    expect(repaired.cfg).toMatchObject(canonical);
    expect(repaired.pendingChangePanels?.join("\n")).toContain(
      "Removed models.providers.openai.contextWindow after baking it into explicit model entries.",
    );
    expect(terminalNoteMock.mock.calls.map(([message]) => message).join("\n")).toContain(
      "agents.entries.ops.contextTokens cannot be represented per model",
    );
  });

  it("drops roster write intent when a preview repair is declined", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { main: { default: true } } } },
      parsedConfig: {},
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.explicitSetPaths).toBeUndefined();
  });

  it("removes a legacy list when Doctor persists keyed roster entries", async () => {
    const rawConfig = {
      agents: {
        list: [
          { id: "ops", default: true, workspace: "/srv/ops" },
          { id: "research", model: "openai/research" },
        ],
      },
    };
    const result = await runDoctorConfigWithInput({
      config: migratePersistedImplicitMainRoster(rawConfig).config as OpenClawConfig,
      parsedConfig: rawConfig,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.explicitSetPaths).toEqual([
      ["agents", "entries"],
      ["agents", "ownership"],
    ]);
    expect(result.cfg.agents?.entries).toEqual({
      ops: { workspace: "/srv/ops" },
      research: { model: "openai/research" },
    });
    expect(result.cfg.agents?.ownership).toBe("explicit");
    expect(result.cfg.agents?.entries?.ops).not.toHaveProperty("default");
    expect(result.cfg.agents).not.toHaveProperty("list");
  });

  it("stamps explicit ownership when Doctor migrates a markerless multi-agent list", async () => {
    const rawConfig = {
      agents: {
        list: [{ id: "ops" }, { id: "research", model: "openai/research" }],
      },
    };
    const result = await runDoctorConfigWithInput({
      config: migratePersistedImplicitMainRoster(rawConfig).config as OpenClawConfig,
      parsedConfig: rawConfig,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.explicitSetPaths).toEqual([
      ["agents", "entries"],
      ["agents", "ownership"],
    ]);
    expect(result.cfg.agents).toEqual({
      ownership: "explicit",
      entries: {
        ops: {},
        research: { model: "openai/research" },
      },
    });
  });

  it("materializes ambient roles for a multi-agent configured default", async () => {
    const rawConfig = {
      agents: {
        entries: {
          ops: { default: true },
          research: {},
        },
      },
      channels: { telegram: { enabled: true } },
      talk: { provider: "test" },
    };
    const config = migratePersistedImplicitMainRoster(rawConfig).config as OpenClawConfig;
    const result = await runDoctorConfigWithInput({
      config,
      parsedConfig: rawConfig,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.bindings).toEqual([
      { agentId: "ops", match: { channel: "telegram", accountId: "*" } },
    ]);
    expect(result.cfg.agents?.defaults).toMatchObject({
      heartbeat: { agentId: "ops" },
      systemAgent: { agentId: "ops" },
      authInheritance: { agentId: "ops" },
    });
    expect(result.cfg.talk).toMatchObject({ provider: "test", agentId: "ops" });
    expect(result.cfg.agents?.entries?.ops).not.toHaveProperty("default");
    expect(result.cfg.agents?.ownership).toBe("explicit");
  });

  it("preserves shared all-agent heartbeat enrollment during materialization", async () => {
    const rawConfig = {
      agents: {
        defaults: { heartbeat: { every: "1h" } },
        entries: { ops: { default: true }, research: {} },
      },
      channels: { telegram: { enabled: true } },
      talk: { provider: "test" },
    };
    const config = migratePersistedImplicitMainRoster(rawConfig).config as OpenClawConfig;
    const result = await runDoctorConfigWithInput({
      config,
      parsedConfig: rawConfig,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents?.defaults?.heartbeat).toEqual({ every: "1h" });
    expect(result.cfg.agents?.defaults?.heartbeat).not.toHaveProperty("agentId");
    expect(result.cfg.agents?.defaults?.systemAgent).toEqual({ agentId: "ops" });
  });

  it("does not rematerialize explicit roles or touch single-agent configs", async () => {
    const materialized = {
      agents: {
        ownership: "explicit" as const,
        defaults: {
          heartbeat: { agentId: "ops" },
          systemAgent: { agentId: "ops" },
        },
        entries: { ops: { workspace: "/srv/ops" }, research: {} },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "*" } }],
      channels: { telegram: { enabled: true } },
      talk: { provider: "test", agentId: "ops" },
    };
    const secondRun = await runDoctorConfigWithInput({
      config: materialized,
      parsedConfig: materialized,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const singleAgent = await runDoctorConfigWithInput({
      config: {
        agents: { entries: { ops: {} } },
        channels: { telegram: { enabled: true } },
        talk: { provider: "test" },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(secondRun.shouldWriteConfig).toBe(false);
    expect(singleAgent.shouldWriteConfig).toBe(false);
  });

  it("preserves malformed keyed entries for schema validation during repair", async () => {
    const agents = { entries: { main: {}, broken: null as never } };
    const result = await runDoctorConfigWithInput({
      config: { agents },
      parsedConfig: { agents },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.cfg.agents?.entries).toEqual({
      main: {},
      broken: null,
    });
  });

  it("detects a legacy roster after environment resolution", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { ops: {} } } },
      parsedConfig: { agents: { list: [{ id: "${AGENT_ID}", default: true }] } },
      sourceConfigBeforeMigrations: {
        agents: { list: [{ id: "ops", default: true }] },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents).toEqual({ entries: { ops: {} } });
  });

  it("preserves a roster supplied by an included config during repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { ops: {} } } },
      parsedConfig: { $include: "./agents.json" },
      agentRosterIncludeOwned: true,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.explicitSetPaths).toBeUndefined();
    expect(result.cfg.agents?.entries).toEqual({ ops: {} });
  });

  it("preserves ownership of an explicitly empty included roster", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { main: {} } } },
      parsedConfig: { $include: "./agents.json" },
      sourceConfigBeforeMigrations: { agents: { entries: {} } },
      agentRosterIncludeOwned: true,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("persists an injected roster when a root include contributes only channels", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: { entries: { main: {} } },
        channels: { telegram: { enabled: true } },
      },
      parsedConfig: { $include: "./channels.json" },
      sourceConfigBeforeMigrations: { channels: { telegram: { enabled: true } } },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("repairs a locally authored roster when unrelated includes exist", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: {
          defaults: { workspace: "/tmp/ops" },
          entries: { main: {} },
        },
      },
      parsedConfig: { $include: "./channels.json", agents: { entries: {} } },
      sourceConfigBeforeMigrations: {
        channels: { telegram: { enabled: true } },
        agents: { entries: {} },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents).toEqual({
      defaults: { workspace: "/tmp/ops" },
      entries: { main: {} },
    });
  });

  it("repairs a missing roster when only a nested channel include exists", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { main: {} } } },
      parsedConfig: { channels: { $include: "./channels.json" } },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("does not persist an implicit roster when no config file exists", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { main: {} } } },
      exists: false,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("enables Doctor-only state migrations only for explicit repair", async () => {
    await runDoctorConfigWithInput({
      config: {},
      run: loadAndMaybeMigrateDoctorConfig,
    });
    expect(runDoctorConfigPreflightOptionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ doctorOnlyStateMigrations: false }),
    );

    await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    expect(runDoctorConfigPreflightOptionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ doctorOnlyStateMigrations: true }),
    );
  });

  it("prepares plugin metadata for the complete Doctor lifecycle", async () => {
    const result = await runDoctorConfigWithInput({
      config: {},
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(runDoctorConfigPreflightOptionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ preparePluginMetadataSnapshot: true }),
    );
    expect(result.runWithPluginMetadataSnapshot).toEqual(expect.any(Function));
    expect(result.invalidatePluginMetadataSnapshot).toEqual(expect.any(Function));
    expect(collectDoctorPreviewNotesParamsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runWithPluginMetadataSnapshot: result.runWithPluginMetadataSnapshot,
      }),
    );
  });

  it("exposes cleanup-refreshed plugin metadata to later Doctor scopes", async () => {
    const refreshedSnapshot = {
      plugins: [],
      index: { installRecords: {} },
    } as unknown as PluginMetadataSnapshot;
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: ['Removed stale managed install record for bundled plugin "google-meet".'],
      warningNotes: [],
      authProfilesRepaired: false,
      pluginMetadataSnapshot: refreshedSnapshot,
    }));

    const result = await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.pluginMetadataSnapshot).toBe(refreshedSnapshot);
    const scopeParams = createDoctorPluginMetadataSnapshotScopeParamsMock.mock.lastCall?.[0] as {
      getBaseSnapshot: () => PluginMetadataSnapshot | undefined;
    };
    expect(scopeParams.getBaseSnapshot()).toBe(refreshedSnapshot);
    expect(scopeParams.getBaseSnapshot()?.index.installRecords).not.toHaveProperty("google-meet");
    result.invalidatePluginMetadataSnapshot();
    expect(scopeParams.getBaseSnapshot()).toBeUndefined();
  });

  it("does not treat noninteractive doctor fix as plugin capability consent", async () => {
    const review = buildPluginCapabilityConsentReview({
      pluginId: "demo",
      manifest: { name: "Demo", contracts: { tools: ["demo.write"] } },
      record: { source: "npm", spec: "@example/demo" },
      config: {},
    });
    let acknowledgment: unknown = "not reviewed";
    runDoctorRepairSequenceMock.mockImplementation(
      async (params: { state: unknown; onCapabilityConsent?: PluginCapabilityConsentHandler }) => {
        acknowledgment = await expectDefined(
          params.onCapabilityConsent,
          "doctor capability handler",
        )(review);
        return {
          state: params.state,
          changeNotes: [],
          warningNotes: [],
          authProfilesRepaired: false,
        };
      },
    );
    const prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { repair: true, yes: true, nonInteractive: true },
    });
    const confirm = vi.spyOn(prompter, "confirmRuntimeRepair");
    await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: (params) => loadAndMaybeMigrateDoctorConfig({ ...params, prompter }),
    });

    expect(acknowledgment).toBeUndefined();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ requiresInteractiveConfirmation: true, initialValue: false }),
    );
    expect(terminalNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("demo.write"),
      "Plugin capabilities",
    );
  });

  it("collects plugin blocker previews from the pre-auto-enable config", async () => {
    await runDoctorConfigWithInput({
      config: {
        plugins: {
          allow: ["existing-plugin"],
        },
        tools: {
          alsoAllow: ["browser"],
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(collectDoctorPreviewNotesParamsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["existing-plugin", "browser"],
          }),
        }),
        activationSourceConfig: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["existing-plugin"],
          }),
        }),
      }),
    );
  });

  it("reloads gateway secrets and refreshes auth status after auth profile repairs", async () => {
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: ["Migrated 1 sidecar-backed Codex OAuth profile."],
      warningNotes: [],
      authProfilesRepaired: true,
    }));

    await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "secrets.reload",
      params: {},
      timeoutMs: 3000,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "models.authStatus",
      params: { refresh: true },
      timeoutMs: 3000,
    });
  });

  it("keeps the Codex session auth migration plan outside persisted config", async () => {
    const openAICodexAuthProfileIdMap = new Map([
      ["openai-codex:default", "openai:chatgpt-default"],
    ]);
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: [],
      warningNotes: [],
      authProfilesRepaired: false,
      openAICodexAuthProfileIdMap,
    }));

    const result = await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.openAICodexAuthProfileIdMap).toBe(openAICodexAuthProfileIdMap);
    expect(result.cfg).not.toHaveProperty("openAICodexAuthProfileIdMap");
  });

  it("does not refresh gateway before writing a config-only auth repair", async () => {
    runDoctorRepairSequenceMock.mockImplementation(
      async (params: {
        state: { cfg: Record<string, unknown>; candidate: Record<string, unknown> };
      }) => {
        const repaired = { ...params.state.candidate, auth: { order: {} } };
        return {
          state: {
            ...params.state,
            cfg: repaired,
            candidate: repaired,
            pendingChanges: true,
          },
          changeNotes: ["Removed a stale configured auth order."],
          warningNotes: [],
          authProfilesRepaired: false,
        };
      },
    );

    const result = await runDoctorConfigWithInput({
      config: { auth: { order: { anthropic: ["anthropic:missing"] } } },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.auth?.order).toEqual({});
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("keeps doctor repair silent when gateway secrets reload fails", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: ["Removed stale OAuth auth profile shadow openai-codex."],
      warningNotes: [],
      authProfilesRepaired: true,
    }));

    await expect(
      runDoctorConfigWithInput({
        config: {},
        repair: true,
        run: loadAndMaybeMigrateDoctorConfig,
      }),
    ).resolves.toBeTruthy();

    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "secrets.reload",
      params: {},
      timeoutMs: 3000,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "models.authStatus",
      params: { refresh: true },
      timeoutMs: 3000,
    });
  });

  it("emits warning-only stale channel cleanup without changing config", async () => {
    const input = {
      agents: { entries: { ops: {} } },
      channels: { matrix: { enabled: true } },
    };
    const channelDoctor = await import("./doctor/shared/channel-doctor.js");
    vi.mocked(channelDoctor.collectChannelDoctorStaleConfigMutations).mockResolvedValueOnce([
      {
        config: { ...input, channels: { matrix: { enabled: false } } },
        changes: [],
        warnings: ["- matrix stale cleanup warning"],
      },
    ]);
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: [],
      warningNotes: [],
      authProfilesRepaired: false,
    }));

    const result = await runDoctorConfigWithInput({
      config: input,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(terminalNoteMock).toHaveBeenCalledWith(
      "- matrix stale cleanup warning",
      "Doctor warnings",
    );
    expect(result.cfg).toEqual(input);
    expect(result.shouldWriteConfig).toBe(false);
  });

  it("previews and repairs hooks token reuse of gateway auth", async () => {
    const config = {
      gateway: {
        auth: {
          mode: "token",
          token: "shared-gateway-token-1234567890",
        },
      },
      hooks: {
        enabled: true,
        token: "shared-gateway-token-1234567890",
      },
    };
    const previewNotes = resetTerminalNoteMock();
    const preview = await runDoctorConfigWithInput({
      config,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(preview.shouldWriteConfig).toBe(false);
    expect(preview.cfg.hooks?.token).toBe("shared-gateway-token-1234567890");
    expect(
      previewNotes.mock.calls.some(
        ([message, title]) =>
          title === "Doctor changes preview" &&
          message.includes("Rotated hooks.token because it reused active Gateway"),
      ),
    ).toBe(true);
    expect(
      previewNotes.mock.calls.some(
        ([message, title]) =>
          title === "Doctor" &&
          message.includes("openclaw doctor --fix") &&
          message.includes("rotate hooks.token"),
      ),
    ).toBe(true);

    const repair = await runDoctorConfigWithInput({
      config,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(repair.shouldWriteConfig).toBe(true);
    expect(repair.cfg.hooks?.token).toMatch(/^[0-9a-f]{48}$/);
    expect(repair.cfg.hooks?.token).not.toBe("shared-gateway-token-1234567890");
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

  it("emits implicit fallback clobber warnings from the loaded config", async () => {
    collectImplicitFallbackClobberWarningsMock.mockReturnValueOnce([
      '- agents.list[0].model (id=ops) is "openai/gpt-5.3", a bare string with no fallbacks. At runtime this clobbers agents.defaults.model.fallbacks (openai/gpt-5.4), leaving the agent with no fallbacks.',
    ]);
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        entries: { ops: { default: true, model: "openai/gpt-5.3" } },
      },
    };

    await runDoctorConfigWithInput({
      config,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(noteImplicitFallbackClobberWarningsMock).toHaveBeenCalledTimes(1);
    const [warningParams] = expectDefined(
      (
        noteImplicitFallbackClobberWarningsMock.mock.calls as unknown as Array<
          [{ agents?: unknown }]
        >
      )[0],
      "(noteImplicitFallbackClobberWarningsMock.mock.calls as unknown as Array<\n        [{ agents?: unknown }]\n      >)[0] test invariant",
    );
    expect(warningParams.agents).toStrictEqual(config.agents);
    const doctorWarnings = terminalNoteMock.mock.calls
      .filter(([, title]) => title === "Doctor warnings")
      .map(([message]) => message);
    expect(doctorWarnings.join("\n")).toContain("clobbers agents.defaults.model.fallbacks");
  });

  it("warns when hooks transformsDir points outside the hook transforms root", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      hooks: {
        enabled: true,
        token: "hook-secret",
        transformsDir: "/virtual/.openclaw/workspace/skills/linear-webhook",
        mappings: [
          {
            match: { path: "linear" },
            action: "agent",
            messageTemplate: "Linear event",
            transform: { module: "./openclaw-linear-transform.js" },
          },
        ],
      },
    });

    const warning = doctorWarnings.join("\n");
    expect(warning).toContain("hooks.transformsDir:");
    expect(warning).toContain("/virtual/.openclaw/workspace/skills/linear-webhook");
    expect(warning).toContain("/virtual/.openclaw/hooks/transforms");
    expect(warning).toContain("move custom transforms there or remove hooks.transformsDir");
  });

  it("warns when internal hook entries include unsupported loader keys", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      hooks: {
        internal: {
          entries: {
            "custom-hook": {
              enabled: true,
              handler: "./hooks/custom.ts",
              extraDirs: ["./hooks"],
              env: { OPENCLAW_CUSTOM_HOOK: "1" },
            },
            "valid-hook": {
              enabled: true,
              paths: ["./tracked"],
            },
            "null-hook": null,
          },
        },
      },
    });

    const warning = doctorWarnings.join("\n");
    expect(warning).toContain("hooks.internal.entries.custom-hook:");
    expect(warning).toContain(
      "unsupported loader keys handler, extraDirs will not load hook modules",
    );
    expect(warning).toContain("bootstrap-extra-files for session bootstrap content");
    expect(warning).toContain("Doctor cannot rewrite this automatically");
    expect(warning).not.toContain("hooks.internal.entries.valid-hook");
    expect(warning).not.toContain("hooks.internal.entries.null-hook");
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
        agents: { entries: { openclaw: { default: true } } },
        session: {
          maintenance: {
            rotateBytes: "10mb",
          },
        },
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
    // driver "extension" is the live Chrome extension relay driver; repair keeps it.
    expect(
      ((browser.profiles as Record<string, { driver?: string }>)?.chromeLive ?? {}).driver,
    ).toBe("extension");
    expect(result.cfg.plugins?.allow).toEqual(["telegram", "browser", "codex"]);
    expect(result.cfg.plugins?.entries?.browser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("removes retired commitments config on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        commitments: {
          enabled: true,
          maxPerDay: 2,
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.cfg).not.toHaveProperty("commitments");
  }, 300_000);

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
      const result = await runDoctorConfigWithInput({
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

      // Repair-mode change panels defer to the write runner; sanitized change
      // text travels through pendingChangePanels instead of immediate notes.
      const outputs = [
        ...noteSpy.mock.calls
          .filter((call) => call[1] === "Doctor warnings" || call[1] === "Doctor changes")
          .map((call) => call[0]),
        ...(result.pendingChangePanels ?? []),
      ];
      const joinedOutputs = outputs.join("\n");
      expect(outputs.some((line) => line.includes("\u001b"))).toBe(false);
      expect(outputs.some((line) => line.includes("\nforged"))).toBe(false);
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
        expect(
          expectDefined(
            cfg.channels.discord.guilds["100"],
            'cfg.channels.discord.guilds["100"] test invariant',
          ).users,
        ).toEqual(["111"]);
        expect(
          expectDefined(
            cfg.channels.discord.guilds["100"],
            'cfg.channels.discord.guilds["100"] test invariant',
          ).roles,
        ).toEqual(["222"]);
        const defaultGuild = expectDefined(
          cfg.channels.discord.guilds["100"],
          "default Discord guild",
        );
        const generalChannel = expectDefined(
          defaultGuild.channels.general,
          "general Discord channel",
        );
        expect(generalChannel.users).toEqual(["333"]);
        expect(generalChannel.roles).toEqual(["444"]);
        expect(cfg.channels.discord.accounts.default.allowFrom).toEqual(["123"]);
        expect(cfg.channels.discord.accounts.work.allowFrom).toEqual(["555"]);
        expect(cfg.channels.discord.accounts.work.dm.allowFrom).toEqual(["666"]);
        expect(cfg.channels.discord.accounts.work.dm.groupChannels).toEqual(["777"]);
        expect(cfg.channels.discord.accounts.work.execApprovals.approvers).toEqual(["888"]);
        expect(
          expectDefined(
            cfg.channels.discord.accounts.work.guilds["200"],
            'cfg.channels.discord.accounts.work.guilds["200"] test invariant',
          ).users,
        ).toEqual(["999"]);
        expect(
          expectDefined(
            cfg.channels.discord.accounts.work.guilds["200"],
            'cfg.channels.discord.accounts.work.guilds["200"] test invariant',
          ).roles,
        ).toEqual(["1010"]);
        const workGuild = expectDefined(
          cfg.channels.discord.accounts.work.guilds["200"],
          "work Discord guild",
        );
        const helpChannel = expectDefined(workGuild.channels.help, "help Discord channel");
        expect(helpChannel.users).toEqual(["1111"]);
        expect(helpChannel.roles).toEqual(["1212"]);
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
    expect(
      expectDefined(
        cfg.channels.discord.accounts.default,
        "cfg.channels.discord.accounts.default test invariant",
      ).allowFrom,
    ).toEqual(["123"]);
  });

  it("defers absent-plugin promotion instead of creating a partial default account", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          "uninstalled-demo": {
            dmPolicy: "allowlist",
            appToken: "covered-legacy-key",
            customAuth: "plugin-owned",
            accounts: {
              work: { enabled: true },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const channel = (
      result.cfg as unknown as {
        channels: Record<
          string,
          {
            dmPolicy?: string;
            appToken?: string;
            customAuth?: string;
            accounts?: Record<string, unknown>;
          }
        >;
      }
    ).channels["uninstalled-demo"];
    expect(channel?.dmPolicy).toBe("allowlist");
    expect(channel?.appToken).toBe("covered-legacy-key");
    expect(channel?.customAuth).toBe("plugin-owned");
    expect(channel?.accounts).toEqual({ work: { enabled: true } });
  });

  it("promotes covered legacy keys when an absent plugin has no declarations", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          "legacy-demo": {
            dmPolicy: "allowlist",
            appToken: "legacy-app-token",
            accounts: {
              work: { enabled: true },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const channel = (
      result.cfg as unknown as {
        channels: Record<
          string,
          { dmPolicy?: string; appToken?: string; accounts?: Record<string, unknown> }
        >;
      }
    ).channels["legacy-demo"];
    expect(channel?.dmPolicy).toBeUndefined();
    expect(channel?.appToken).toBeUndefined();
    expect(channel?.accounts?.default).toEqual({
      dmPolicy: "allowlist",
      appToken: "legacy-app-token",
    });
    expect(channel?.accounts?.work).toEqual({ enabled: true, dmPolicy: "allowlist" });
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
                dmPolicy: "open",
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
              dmPolicy: string;
              allowFrom: string[];
              dm?: unknown;
            };
          };
        };
      };
    };
    expect(cfg.channels.discord.allowFrom).toEqual(["*"]);
    expect(cfg.channels.discord.dmPolicy).toBe("open");
    expect(cfg.channels.googlechat.accounts.work.dmPolicy).toBe("open");
    expect(cfg.channels.googlechat.accounts.work.allowFrom).toEqual(["*"]);
    expect(cfg.channels.googlechat.accounts.work.dm).toBeUndefined();
  });

  it('repairs dmPolicy="allowlist" by restoring allowFrom from pairing store on repair', async () => {
    const result = await withTempHome(
      async (home) => {
        const configDir = path.join(home, ".openclaw");
        await fs.mkdir(configDir, { recursive: true });
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
        writeChannelPairingStateSnapshot("telegram", {
          version: 1,
          requests: [],
          allowFrom: { default: ["12345"] },
        });
        return await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true, repair: true },
          confirm: async () => false,
        });
      },
      { skipSessionCleanup: true },
    );
    closeOpenClawStateDatabaseForTest();

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
        maintenance?: {
          rotateBytes?: unknown;
        };
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
    expect(cfg.agents?.defaults?.heartbeat?.model).toBe("anthropic/claude-3-5-haiku-20241022");
    expect(cfg.agents?.defaults?.heartbeat?.every).toBe("30m");
    expect(cfg.gateway?.bind).toBe("lan");
    expect(cfg.session?.maintenance?.rotateBytes).toBeUndefined();
    expect(cfg.session?.threadBindings?.idleHours).toBe(24);
    expect(cfg.channels?.discord?.threadBindings?.idleHours).toBe(12);
    expect(cfg.channels?.discord?.accounts?.alpha?.threadBindings?.idleHours).toBe(6);
    expect(cfg.session?.threadBindings?.ttlHours).toBeUndefined();
    expect(cfg.channels?.discord?.threadBindings?.ttlHours).toBeUndefined();
    expect(cfg.channels?.discord?.accounts?.alpha?.threadBindings?.ttlHours).toBeUndefined();
    expect(cfg.channels?.defaults?.heartbeat?.showOk).toBe(true);
    expect(cfg.channels?.defaults?.heartbeat?.showAlerts).toBe(false);
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
            maintenance: {
              rotateBytes: "10mb",
            },
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
      expect(legacyMessages).toContain("use memory.search");
      expect(legacyMessages).toContain("gateway.bind:");
      expect(legacyMessages).toContain("gateway.bind host aliases");
      expect(legacyMessages).toContain("channels.telegram.groupMentionsOnly:");
      expect(legacyMessages).toContain("channels.telegram.groups");
      expect(legacyMessages).toContain("tools.web.x_search.apiKey:");
      expect(legacyMessages).toContain("plugins.entries.xai.config.webSearch.apiKey");
      expect(legacyMessages).toContain("hooks.internal.handlers:");
      expect(legacyMessages).toContain("HOOK.md + handler file");
      expect(legacyMessages).toContain("before running");
      expect(legacyMessages).toContain("does not materialize executable files");
      expect(legacyMessages).toContain("session.threadBindings.ttlHours");
      expect(legacyMessages).toContain("session.threadBindings.idleHours");
      expect(legacyMessages).toContain("session.maintenance.rotateBytes");
      expect(legacyMessages).toContain("deprecated and ignored");
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

  it.each([
    [false, false],
    [true, true],
  ] as const)(
    "previews and repairs retired internal hook registrations (repair=%s)",
    async (repair, shouldWriteConfig) => {
      const noteSpy = resetTerminalNoteMock();
      try {
        const result = await runDoctorConfigWithInput({
          config: {
            hooks: {
              internal: {
                enabled: true,
                handlers: [{ event: "command:new", module: "hooks/legacy-handler.js" }],
              },
            },
          },
          repair,
          run: loadAndMaybeMigrateDoctorConfig,
        });

        expect(
          (result.cfg.hooks?.internal as Record<string, unknown> | undefined)?.handlers,
        ).toBeUndefined();
        expect(result.cfg.hooks?.internal?.enabled).toBeUndefined();
        expect(result.shouldWriteConfig).toBe(shouldWriteConfig);
        const removalLine = "Removed retired hooks.internal.handlers registrations";
        if (repair) {
          // Repair panels defer until the atomic write commits.
          expect(
            (result.pendingChangePanels ?? []).some((panel) => panel.includes(removalLine)),
          ).toBe(true);
          expect(noteSpy.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
        } else {
          expect(
            noteSpy.mock.calls.some(
              ([message, title]) =>
                title === "Doctor changes preview" && message.includes(removalLine),
            ),
          ).toBe(true);
        }
      } finally {
        noteSpy.mockClear();
      }
    },
  );

  it("titles the legacy migration panel as a preview when --fix is not passed (#80817)", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      await runDoctorConfigWithInput({
        config: {
          heartbeat: {
            model: "anthropic/claude-3-5-haiku-20241022",
            every: "30m",
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });
      const changeTitles = noteSpy.mock.calls.map(([, title]) => title);
      expect(changeTitles).toContain("Doctor changes preview");
      expect(changeTitles).not.toContain("Doctor changes");
      const previewPanel = noteSpy.mock.calls.find(
        ([message, title]) =>
          title === "Doctor changes preview" && message.includes("Moved heartbeat to"),
      );
      expect(previewPanel).toBeDefined();
    } finally {
      noteSpy.mockClear();
    }
  });

  it("defers the applied panel to the config write when --fix is passed (#80817)", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      const result = await runDoctorConfigWithInput({
        repair: true,
        config: {
          heartbeat: {
            model: "anthropic/claude-3-5-haiku-20241022",
            every: "30m",
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });
      const changeTitles = noteSpy.mock.calls.map(([, title]) => title);
      // The flow itself prints nothing as applied; the write runner reports
      // "Doctor changes" only after the atomic write commits.
      expect(changeTitles).not.toContain("Doctor changes");
      expect(changeTitles).not.toContain("Doctor changes preview");
      expect(result.pendingChangePanels?.length).toBeGreaterThan(0);
    } finally {
      noteSpy.mockClear();
    }
  });

  it("preserves valid googlechat top-level DM policy and allowFrom", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          googlechat: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const cfg = result.cfg as {
      channels: {
        googlechat: {
          dmPolicy: string;
          allowFrom: string[];
          dm?: unknown;
        };
      };
    };
    expect(cfg.channels.googlechat.dmPolicy).toBe("open");
    expect(cfg.channels.googlechat.allowFrom).toEqual(["*"]);
    expect(cfg.channels.googlechat.dm).toBeUndefined();
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
                realtime: {
                  provider: "openai",
                  providers: {
                    openai: {
                      model: "gpt-realtime",
                    },
                  },
                  model: "gpt-realtime",
                  speakerVoice: "cedar",
                  mode: "realtime",
                  transport: "gateway-relay",
                  brain: "agent-consult",
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

          const secondRun = await loadAndMaybeMigrateDoctorConfig({
            options: { nonInteractive: true, repair: true },
            confirm: async () => false,
          });
          const secondRunTalkNormalizationLines = [
            ...noteSpy.mock.calls
              .filter((call) => call[1] === "Doctor changes")
              .map((call) => call[0]),
            ...(secondRun.pendingChangePanels ?? []),
          ].filter((line) => line.includes("Normalized talk.provider/providers shape"));
          expect(secondRunTalkNormalizationLines).toStrictEqual([]);
        } finally {
          noteSpy.mockClear();
        }
      },
      { skipSessionCleanup: true },
    );
  });

  it("sets skipPluginValidationOnWrite when legacy migration is only partially valid (#76800)", async () => {
    legacyConfigMigrationForTest.setPartiallyValidOverride(true);
    try {
      const result = await runDoctorConfigWithInput({
        config: {
          heartbeat: { model: "openai/gpt-4o", every: 60 },
          tools: { web: { search: { provider: "brave" } } },
        },
        repair: true,
        preflightMode: "compat",
        run: ({ options, confirm }) =>
          loadAndMaybeMigrateDoctorConfig({ options, confirm: async () => confirm() }),
      });
      expect(result.skipPluginValidationOnWrite).toBe(true);
    } finally {
      legacyConfigMigrationForTest.setPartiallyValidOverride(undefined);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
