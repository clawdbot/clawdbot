// Session utility tests cover key parsing, store migration, agent/default rows,
// model identity resolution, title derivation, and byte-capped row payloads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { CronJob } from "../cron/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { registerSessionAutomationSource } from "./session-automation-index.js";
import { buildGatewaySessionEventFields } from "./session-event-payload.js";
import {
  canonicalizeSpawnedByForAgent,
  buildGatewaySessionRow,
  capArrayByJsonBytes,
  classifySessionKey,
  deriveSessionUnread,
  deriveSessionTitle,
  getSessionDefaults,
  listAgentsForGateway,
  listSessionsFromStore,
  listSessionsFromStoreAsync,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  parseGroupKey,
  pruneLegacyStoreKeys,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewayModelSupportsImages,
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
  resolveSessionDisplayModelIdentityRef,
  resolveSessionModelIdentityRef,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "./session-utils.js";

const providerArtifactMocks = vi.hoisted(() => ({
  resolveBundledProviderPolicySurface: vi.fn<
    typeof import("../plugins/provider-public-artifacts.js").resolveBundledProviderPolicySurface
  >(() => null),
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurface: providerArtifactMocks.resolveBundledProviderPolicySurface,
  resolveProviderPolicySurface: providerArtifactMocks.resolveBundledProviderPolicySurface,
}));

function closeSessionSqliteDatabasesForTest(): void {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

async function withStateDirEnv<T>(
  prefix: string,
  fn: (ctx: { tempRoot: string; stateDir: string }) => Promise<T>,
): Promise<T> {
  return withRawStateDirEnv(prefix, async (ctx) => {
    try {
      return await fn(ctx);
    } finally {
      closeSessionSqliteDatabasesForTest();
    }
  });
}

async function seedSessionEntries(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  }
}

function appendTranscriptMessages(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
  messages: unknown[];
  agentId?: string;
}) {
  for (const message of params.messages) {
    appendTranscriptMessageSync(
      {
        agentId: params.agentId ?? "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      { message },
    );
  }
}

function createSymlinkOrSkip(targetPath: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(targetPath, linkPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      return false;
    }
    throw error;
  }
}

function createSingleAgentAvatarConfig(workspace: string): OpenClawConfig {
  return {
    session: { mainKey: "main" },
    agents: {
      list: [{ id: "main", default: true, workspace, identity: { avatar: "avatar-link.png" } }],
    },
  } as OpenClawConfig;
}

function createModelDefaultsConfig(params: {
  primary: string;
  models?: Record<string, { agentRuntime?: { id: string } }>;
  agentRuntime?: { id: string };
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: params.primary },
        models: {
          ...params.models,
          ...(params.agentRuntime
            ? { [params.primary]: { agentRuntime: params.agentRuntime } }
            : {}),
        },
      },
    },
  } as OpenClawConfig;
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("gateway session utils", () => {
  beforeEach(() => {
    // Real artifact loading belongs to its owner tests; session projections only need the contract.
    providerArtifactMocks.resolveBundledProviderPolicySurface.mockReset();
    providerArtifactMocks.resolveBundledProviderPolicySurface.mockReturnValue(null);
  });

  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
    closeSessionSqliteDatabasesForTest();
  });

  test("capArrayByJsonBytes trims from the front", () => {
    const res = capArrayByJsonBytes(["a", "b", "c"], 10);
    expect(res.items).toEqual(["b", "c"]);
  });

  test.each([
    { name: "never read", entry: {}, expected: false },
    {
      name: "interaction after read",
      entry: { lastReadAt: 10, lastInteractionAt: 11 },
      expected: true,
    },
    {
      name: "read after interaction",
      entry: { lastReadAt: 11, lastInteractionAt: 10 },
      expected: false,
    },
    {
      name: "activity after read",
      entry: { lastReadAt: 10, lastActivityAt: 11 },
      expected: true,
    },
    {
      name: "explicitly marked unread",
      entry: { lastReadAt: 20, lastInteractionAt: 10, lastActivityAt: 10, markedUnreadAt: 1 },
      expected: true,
    },
  ])("derives unread state for $name", ({ entry, expected }) => {
    expect(deriveSessionUnread(entry)).toBe(expected);
  });

  test("session lists apply a bounded default and expose truncation metadata", async () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const store = Object.fromEntries(
      Array.from({ length: 101 }, (_value, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: 1_000 - index,
          modelProvider: "openai",
          model: "gpt-5.4",
        } satisfies SessionEntry,
      ]),
    );

    const listed = await listSessionsFromStoreAsync({
      cfg,
      storePath: "",
      store,
      opts: {},
    });

    expect(listed.sessions).toHaveLength(100);
    expect(listed.count).toBe(100);
    expect(listed.totalCount).toBe(101);
    expect(listed.limitApplied).toBe(100);
    expect(listed.nextOffset).toBe(100);
    expect(listed.hasMore).toBe(true);
    expect(listed.sessions[0]?.key).toBe("session-0");
    expect(listed.sessions.at(-1)?.key).toBe("session-99");
  });

  test("session lists honor explicit caller limits", () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const store = Object.fromEntries(
      Array.from({ length: 5 }, (_value, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: 1_000 - index,
        } satisfies SessionEntry,
      ]),
    );

    const listed = listSessionsFromStore({
      cfg,
      storePath: "",
      store,
      opts: { limit: 3 },
    });

    expect(listed.sessions.map((session) => session.key)).toEqual([
      "session-0",
      "session-1",
      "session-2",
    ]);
    expect(listed.count).toBe(3);
    expect(listed.totalCount).toBe(5);
    expect(listed.limitApplied).toBe(3);
    expect(listed.nextOffset).toBe(3);
    expect(listed.hasMore).toBe(true);
  });

  test("session lists separate archived rows and sort pinned sessions first", () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const store = {
      recent: { sessionId: "recent", updatedAt: 30 },
      pinned: { sessionId: "pinned", updatedAt: 10, pinnedAt: 40 },
      archived: { sessionId: "archived", updatedAt: 20, archivedAt: 50 },
    } satisfies Record<string, SessionEntry>;

    const active = listSessionsFromStore({ cfg, storePath: "", store, opts: {} });
    expect(active.sessions.map((session) => session.key)).toEqual(["pinned", "recent"]);
    expect(active.sessions[0]).toMatchObject({ pinned: true, pinnedAt: 40, archived: false });

    const archived = listSessionsFromStore({
      cfg,
      storePath: "",
      store,
      opts: { archived: true },
    });
    expect(archived.sessions).toMatchObject([
      { key: "archived", archived: true, archivedAt: 50, pinned: false },
    ]);
  });

  test("session lists page from an offset after filtering and sorting", () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const store = Object.fromEntries(
      Array.from({ length: 6 }, (_value, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: 1_000 - index,
          displayName: index === 5 ? "Different project" : `Project Alpha ${index}`,
        } satisfies SessionEntry,
      ]),
    );

    const listed = listSessionsFromStore({
      cfg,
      storePath: "",
      store,
      opts: { search: "alpha", limit: 2, offset: 2 },
    });

    expect(listed.sessions.map((session) => session.key)).toEqual(["session-2", "session-3"]);
    expect(listed.count).toBe(2);
    expect(listed.totalCount).toBe(5);
    expect(listed.limitApplied).toBe(2);
    expect(listed.offset).toBe(2);
    expect(listed.nextOffset).toBe(4);
    expect(listed.hasMore).toBe(true);
  });

  test("session list search includes direct-session origin display labels", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const store = {
      "agent:main:telegram:direct:42": {
        chatType: "direct",
        channel: "telegram",
        origin: { label: "openclaw-tui" },
        updatedAt: 2,
      } as SessionEntry,
      "agent:main:telegram:direct:99": {
        chatType: "direct",
        channel: "telegram",
        origin: { label: "other-direct" },
        updatedAt: 1,
      } as SessionEntry,
    };

    const listed = listSessionsFromStore({
      cfg,
      storePath: "",
      store,
      opts: { search: "openclaw-tui" },
    });

    expect(listed.sessions.map((session) => session.key)).toEqual([
      "agent:main:telegram:direct:42",
    ]);
    expect(listed.sessions[0]?.displayName).toBe("openclaw-tui");
  });

  test("session lists mark the final offset page without hasMore", () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const store = Object.fromEntries(
      Array.from({ length: 5 }, (_value, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: 1_000 - index,
        } satisfies SessionEntry,
      ]),
    );

    const listed = listSessionsFromStore({
      cfg,
      storePath: "",
      store,
      opts: { limit: 2, offset: 4 },
    });

    expect(listed.sessions.map((session) => session.key)).toEqual(["session-4"]);
    expect(listed.totalCount).toBe(5);
    expect(listed.offset).toBe(4);
    expect(listed.nextOffset).toBeNull();
    expect(listed.hasMore).toBe(false);
  });

  test("parseGroupKey handles group keys", () => {
    expect(parseGroupKey("discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("agent:ops:discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("foo:bar")).toBeNull();
  });

  test("session defaults include provider-owned thinking options", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test",
      source: "test",
      provider: {
        id: "openai",
        label: "OpenAI Codex",
        auth: [],
        resolveThinkingProfile: ({ modelId }) => ({
          levels: [
            { id: "off" },
            { id: "minimal" },
            { id: "low" },
            { id: "medium" },
            { id: "adaptive" },
            { id: "high" },
            ...(modelId === "gpt-5.5" ? [{ id: "xhigh" as const }] : []),
            { id: "max", label: "maximum" },
          ],
          defaultLevel: "adaptive",
        }),
      },
    });
    setActivePluginRegistry(registry);

    const defaults = getSessionDefaults(createModelDefaultsConfig({ primary: "openai/gpt-5.5" }));

    expectFields(defaults, {
      modelProvider: "openai",
      model: "gpt-5.5",
      thinkingDefault: "adaptive",
    });
    const levelLabels = Object.fromEntries(
      defaults.thinkingLevels?.map((level) => [level.id, level.label]) ?? [],
    );
    expectFields(levelLabels, {
      adaptive: "adaptive",
      xhigh: "xhigh",
      max: "maximum",
    });
    expect(defaults.thinkingOptions).toContain("adaptive");
    expect(defaults.thinkingOptions).toContain("xhigh");
    expect(defaults.thinkingOptions).toContain("maximum");
  });

  test("session defaults and rows use catalog reasoning metadata for provider thinking options", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "ollama",
      source: "test",
      provider: {
        id: "ollama",
        label: "Ollama",
        auth: [],
        resolveThinkingProfile: ({ reasoning }) => ({
          levels:
            reasoning === true
              ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }]
              : [{ id: "off" }],
          defaultLevel: reasoning === true ? "medium" : "off",
        }),
      },
    });
    setActivePluginRegistry(registry);

    const cfg = createModelDefaultsConfig({ primary: "ollama/qwen3:0.6b" });
    const catalog = [
      {
        provider: "ollama",
        id: "qwen3:0.6b",
        name: "qwen3:0.6b",
        reasoning: true,
      },
    ];

    const defaults = getSessionDefaults(cfg, catalog);
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "main",
      modelCatalog: catalog,
    });

    expect(defaults.thinkingLevels?.map((level) => level.id)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(row.thinkingLevels?.map((level) => level.id)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(defaults.thinkingDefault).toBe("medium");
    expect(row.thinkingDefault).toBe("medium");
  });

  test("session rows project automation bindings and event fields forward them", () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    registerSessionAutomationSource({
      getJobs: () => [{ id: "job1", enabled: true, sessionTarget: "isolated" } as CronJob],
      getDefaultAgentId: () => "main",
    });
    try {
      const bound = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:cron:job1",
        lightweightListRow: true,
        skipTranscriptUsageFallback: true,
      });
      expect(bound.hasAutomation).toBe(true);
      expect(buildGatewaySessionEventFields({ sessionRow: bound }).hasAutomation).toBe(true);

      const plain = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:other",
        lightweightListRow: true,
        skipTranscriptUsageFallback: true,
      });
      expect(plain.hasAutomation).toBeUndefined();
      expect(buildGatewaySessionEventFields({ sessionRow: plain }).hasAutomation).toBe(false);
    } finally {
      registerSessionAutomationSource(null);
    }
  });

  test("session rows ignore malformed compaction checkpoints", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "agent:main:main",
      lightweightListRow: true,
      skipTranscriptUsageFallback: true,
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        compactionCheckpoints: [
          {
            checkpointId: "checkpoint-older",
            sessionKey: "agent:main:main",
            sessionId: "session-1",
            createdAt: 10,
            reason: "manual",
            preCompaction: { sessionId: "session-1" },
            postCompaction: { sessionId: "session-1" },
          },
          null,
          {
            checkpointId: "",
            createdAt: 30,
            reason: "manual",
          },
          {
            checkpointId: "checkpoint-bad-reason",
            createdAt: 40,
            reason: "bogus",
          },
          {
            checkpointId: "checkpoint-newer",
            sessionKey: "agent:main:main",
            sessionId: "session-1",
            createdAt: 50,
            reason: "overflow-retry",
            preCompaction: { sessionId: "session-1" },
            postCompaction: { sessionId: "session-1" },
          },
        ],
      } as unknown as SessionEntry,
    });

    expect(row.compactionCheckpointCount).toBe(2);
    expect(row.latestCompactionCheckpoint).toEqual({
      checkpointId: "checkpoint-newer",
      createdAt: 50,
      reason: "overflow-retry",
    });
  });

  test("async session list reuses thinking metadata for lightweight rows", async () => {
    const resolveThinkingProfile = vi.fn(() => ({
      levels: [{ id: "off" as const }, { id: "medium" as const }],
      defaultLevel: "medium" as const,
    }));
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test",
      source: "test",
      provider: {
        id: "openai",
        label: "OpenAI Codex",
        auth: [],
        resolveThinkingProfile,
      },
    });
    setActivePluginRegistry(registry);

    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.5" });
    const store = Object.fromEntries(
      Array.from({ length: 5 }, (_value, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          modelProvider: "openai",
          model: "gpt-5.5",
          updatedAt: Date.now() - index,
        } satisfies SessionEntry,
      ]),
    );

    const result = await listSessionsFromStoreAsync({
      cfg,
      storePath: "",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(5);
    const missingMediumLevelSessionIds = result.sessions
      .filter((session) => !session.thinkingLevels?.some((level) => level.id === "medium"))
      .map((session) => session.sessionId);
    const missingMediumOptionSessionIds = result.sessions
      .filter((session) => !session.thinkingOptions?.includes("medium"))
      .map((session) => session.sessionId);

    expect(missingMediumLevelSessionIds).toStrictEqual([]);
    expect(missingMediumOptionSessionIds).toStrictEqual([]);
    expect(result.sessions.map((session) => session.thinkingDefault)).toEqual(
      Array.from({ length: result.sessions.length }, () => "medium"),
    );
    expect(resolveThinkingProfile).toHaveBeenCalled();
  });

  test("session list thinking cache preserves case-distinct model catalog entries", () => {
    const cfg = createModelDefaultsConfig({ primary: "custom/CaseModel" });
    const modelCatalog = [
      {
        provider: "custom",
        id: "CaseModel",
        name: "CaseModel",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
      {
        provider: "custom",
        id: "casemodel",
        name: "casemodel",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
      },
    ];
    const result = listSessionsFromStore({
      cfg,
      storePath: "",
      modelCatalog,
      store: {
        upper: {
          sessionId: "upper",
          modelProvider: "custom",
          model: "CaseModel",
          updatedAt: 2,
        } satisfies SessionEntry,
        lower: {
          sessionId: "lower",
          modelProvider: "custom",
          model: "casemodel",
          updatedAt: 1,
        } satisfies SessionEntry,
      },
      opts: {},
    });

    const upper = result.sessions.find((session) => session.key === "upper");
    const lower = result.sessions.find((session) => session.key === "lower");
    expect(upper?.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(lower?.thinkingLevels?.map((level) => level.id)).not.toContain("xhigh");
  });

  test("session defaults and rows expose xhigh from configured catalog compat", () => {
    const cfg = createModelDefaultsConfig({ primary: "gmn/gpt-5.4" });
    const catalog = [
      {
        provider: "gmn",
        id: "gpt-5.4",
        name: "GPT 5.4 via GMN",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
    ];

    const defaults = getSessionDefaults(cfg, catalog);
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "main",
      modelCatalog: catalog,
    });

    expect(defaults.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(row.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
  });

  test("session defaults and rows consume provider-policy thinking without catalog", () => {
    providerArtifactMocks.resolveBundledProviderPolicySurface.mockReturnValue({
      resolveThinkingProfile: () => ({
        levels: [
          { id: "off" },
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "xhigh" },
        ],
      }),
    });
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.5" });

    const defaults = getSessionDefaults(cfg);
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "main",
    });

    expect(defaults.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(row.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(providerArtifactMocks.resolveBundledProviderPolicySurface).toHaveBeenCalledWith(
      "openai",
      { manifestRegistry: undefined },
    );
  });

  test("preserves persisted Ultra while projecting picker levels without a catalog", () => {
    providerArtifactMocks.resolveBundledProviderPolicySurface.mockReturnValue({
      resolveThinkingProfile: ({ modelId, agentRuntime }) => ({
        levels: [
          { id: "off" },
          { id: "high" },
          { id: "xhigh" },
          { id: "max" },
          ...(modelId.startsWith("gpt-5.6") &&
          (agentRuntime === "openclaw" || !modelId.startsWith("gpt-5.6-luna"))
            ? [{ id: "ultra" as const }]
            : []),
        ],
      }),
    });
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: {
            "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as OpenClawConfig;
    const defaults = getSessionDefaults(cfg);
    const row = (entry: SessionEntry) =>
      buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry,
      });

    const codex = row({ sessionId: "codex", thinkingLevel: "ultra" } as SessionEntry);
    const openClawOverride = row({
      sessionId: "openclaw",
      thinkingLevel: "ultra",
      agentRuntimeOverride: "openclaw",
    } as SessionEntry);
    const legacyObservedOpenClaw = row({
      sessionId: "legacy-observed-openclaw",
      thinkingLevel: "ultra",
      agentHarnessId: "openclaw",
    } as SessionEntry);
    const lockedCodex = row({
      sessionId: "locked-codex",
      thinkingLevel: "ultra",
      agentHarnessId: "codex",
      agentRuntimeOverride: "openclaw",
      modelSelectionLocked: true,
    } as SessionEntry);

    expect(defaults.agentRuntime?.id).toBe("codex");
    expect(codex.thinkingLevel).toBe("ultra");
    expect(codex.thinkingLevels?.map((level) => level.id)).not.toContain("ultra");
    expect(openClawOverride.thinkingLevel).toBe("ultra");
    expect(openClawOverride.agentRuntime?.id).toBe("openclaw");
    expect(legacyObservedOpenClaw.thinkingLevel).toBe("ultra");
    expect(legacyObservedOpenClaw.agentRuntime?.id).toBe("codex");
    expect(legacyObservedOpenClaw.thinkingLevels?.map((level) => level.id)).not.toContain("ultra");
    expect(lockedCodex.thinkingLevel).toBe("ultra");
    expect(lockedCodex.agentRuntime).toEqual({ id: "codex", source: "session" });
    expect(lockedCodex.thinkingLevels?.map((level) => level.id)).not.toContain("ultra");
  });

  test.each(["xhigh", "max"] as const)(
    "preserves catalog-less persisted %s in session change projections",
    (thinkingLevel) => {
      const row = buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "custom/reasoner" }),
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry: { sessionId: thinkingLevel, thinkingLevel } as SessionEntry,
      });

      expect(row.thinkingLevel).toBe(thinkingLevel);
    },
  );

  test("session defaults use configured thinking default", () => {
    const defaults = getSessionDefaults({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          thinkingDefault: "high",
        },
      },
    } as OpenClawConfig);

    expectFields(defaults, {
      modelProvider: "openai",
      model: "gpt-5.5",
      thinkingDefault: "high",
    });
  });

  test("session rows expose estimated context budget status", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "anthropic/claude-sonnet-4.6" }),
      storePath: "",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session-1",
        sessionFile: "/tmp/openclaw/agents/main/sessions/session-1.jsonl",
        updatedAt: 1,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 2,
          provider: "anthropic",
          model: "claude-sonnet-4.6",
          route: "compact_then_truncate",
          shouldCompact: true,
          estimatedPromptTokens: 640_000,
          contextTokenBudget: 200_000,
          promptBudgetBeforeReserve: 180_000,
          reserveTokens: 20_000,
          effectiveReserveTokens: 20_000,
          remainingPromptBudgetTokens: 0,
          overflowTokens: 460_000,
          toolResultReducibleChars: 12_000,
          messageCount: 42,
          unwindowedMessageCount: 39,
          sessionId: "session-1",
        },
      },
    });

    expect(row.contextBudgetStatus).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      estimatedPromptTokens: 640_000,
      contextTokenBudget: 200_000,
      sessionId: "session-1",
    });
  });

  test("session rows preserve fresh zero-token usage", () => {
    const row = buildGatewaySessionRow({
      cfg: {} as OpenClawConfig,
      storePath: "",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "fresh-zero-token-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    });

    expect(row.totalTokens).toBe(0);
    expect(row.totalTokensFresh).toBe(true);
  });

  test("selected global rows read transcript usage from the selected agent", async () => {
    await withStateDirEnv("session-utils-selected-global-usage-", async ({ stateDir }) => {
      const sessionId = "selected-global-usage";
      for (const [agentId, input] of [
        ["main", 10],
        ["work", 40],
      ] as const) {
        const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
        await seedSessionEntries(storePath, {
          global: { sessionId, updatedAt: 1 },
        });
        appendTranscriptMessages({
          agentId,
          sessionId,
          sessionKey: "global",
          storePath,
          messages: [
            {
              role: "assistant",
              content: "done",
              usage: { input, output: 2 },
            },
          ],
        });
      }

      const row = buildGatewaySessionRow({
        cfg: {
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        } as OpenClawConfig,
        storePath: "",
        store: {},
        key: "global",
        agentId: "work",
        entry: { sessionId, updatedAt: 1 },
      });

      expect(row.totalTokens).toBe(40);
    });
  });

  test("session rows use per-agent thinking default from config", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          thinkingDefault: "low",
          models: {
            "openai/gpt-5.5": {
              params: { thinking: "max" },
            },
          },
        },
        list: [
          {
            id: "alpha",
            default: true,
            thinkingDefault: "high",
          },
        ],
      },
    } as OpenClawConfig;

    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "agent:alpha:main",
    });

    expectFields(row, {
      modelProvider: "openai",
      model: "gpt-5.5",
      thinkingDefault: "high",
    });
  });

  test("session rows prefer per-model thinking over global default", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          thinkingDefault: "low",
          models: {
            "openai/gpt-5.5": {
              params: { thinking: "max" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "main",
    });

    expectFields(row, {
      modelProvider: "openai",
      model: "gpt-5.5",
      thinkingDefault: "max",
    });
  });

  test("classifySessionKey respects chat type + prefixes", () => {
    expect(classifySessionKey("global")).toBe("global");
    expect(classifySessionKey("unknown")).toBe("unknown");
    expect(classifySessionKey("discord:group:dev")).toBe("group");
    expect(classifySessionKey("main")).toBe("direct");
    const entry = { chatType: "group" } as SessionEntry;
    expect(classifySessionKey("main", entry)).toBe("group");
  });

  test("buildGatewaySessionRow displayName falls through to origin label for direct sessions", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry = {
      chatType: "direct",
      channel: "telegram",
      origin: { label: "openclaw-tui" },
    } as SessionEntry;
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:direct:42": entry },
      key: "agent:main:telegram:direct:42",
      entry,
    });
    expect(row.displayName).toBe("openclaw-tui");
  });

  test("buildGatewaySessionRow displayName prefers the human chat title for group sessions", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry = {
      chatType: "group",
      channel: "telegram",
      subject: "Engineering",
      origin: { label: "openclaw-tui" },
    } as SessionEntry;
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:group:99": entry },
      key: "agent:main:telegram:group:99",
      entry,
    });
    expect(row.displayName).toBe("Engineering");
  });

  test("buildGatewaySessionRow group displayName prefers #channel and falls back to the token", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const channelEntry = {
      chatType: "channel",
      channel: "slack",
      groupChannel: "general",
      space: "Acme",
    } as SessionEntry;
    const channelRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:slack:channel:C1": channelEntry },
      key: "agent:main:slack:channel:C1",
      entry: channelEntry,
    });
    expect(channelRow.displayName).toBe("Acme #general");

    const labeled = { ...channelEntry, label: "Team room" } as SessionEntry;
    const labeledRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:slack:channel:C1": labeled },
      key: "agent:main:slack:channel:C1",
      entry: labeled,
    });
    expect(labeledRow.displayName).toBe("Team room");

    const opaque = { chatType: "group", channel: "telegram" } as SessionEntry;
    const opaqueRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:group:99": opaque },
      key: "agent:main:telegram:group:99",
      entry: opaque,
    });
    expect(opaqueRow.displayName).toMatch(/^telegram:/);
  });

  test("buildGatewaySessionRow projects worktree and execNode bindings", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry = {
      sessionId: "s1",
      updatedAt: 1,
      spawnedCwd: "/state/worktrees/abc/wt-1234",
      worktree: { id: "wt-id", branch: "openclaw/wt-1234", repoRoot: "/repo" },
      execNode: "macbook",
    } as SessionEntry;
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:dashboard:x": entry },
      key: "agent:main:dashboard:x",
      entry,
    });
    expect(row.worktree).toEqual({ id: "wt-id", branch: "openclaw/wt-1234", repoRoot: "/repo" });
    expect(row.execNode).toBe("macbook");
  });

  test("buildGatewaySessionRow prefers entry.label over origin.label for direct sessions", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry = {
      chatType: "direct",
      channel: "telegram",
      label: "Alice",
      origin: { label: "openclaw-tui" },
    } as SessionEntry;
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:direct:42": entry },
      key: "agent:main:telegram:direct:42",
      entry,
    });
    expect(row.displayName).toBe("Alice");
  });

  test("buildGatewaySessionRow projects effectiveResponseUsage from a bare config default", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      messages: { responseUsage: "tokens" },
    } as OpenClawConfig;
    const entry = { sessionId: "s1", updatedAt: 1 } as SessionEntry;
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:main": entry },
      key: "agent:main:main",
      entry,
    });
    // Session has no explicit override → inherits the configured default.
    expect(row.responseUsage).toBeUndefined();
    expect(row.effectiveResponseUsage).toBe("tokens");
  });

  test("buildGatewaySessionRow effectiveResponseUsage respects a per-channel responseUsage map", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      messages: {
        responseUsage: { default: "off", discord: "full", telegram: "tokens" },
      },
    } as OpenClawConfig;
    const discordEntry = { sessionId: "d1", updatedAt: 1, channel: "discord" } as SessionEntry;
    const discordRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:discord:direct:1": discordEntry },
      key: "agent:main:discord:direct:1",
      entry: discordEntry,
    });
    expect(discordRow.effectiveResponseUsage).toBe("full");

    const telegramEntry = { sessionId: "t1", updatedAt: 1, channel: "telegram" } as SessionEntry;
    const telegramRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:direct:1": telegramEntry },
      key: "agent:main:telegram:direct:1",
      entry: telegramEntry,
    });
    expect(telegramRow.effectiveResponseUsage).toBe("tokens");

    // A channel with no entry falls back to the config "default" (off).
    const slackEntry = { sessionId: "x1", updatedAt: 1, channel: "slack" } as SessionEntry;
    const slackRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:slack:direct:1": slackEntry },
      key: "agent:main:slack:direct:1",
      entry: slackEntry,
    });
    expect(slackRow.effectiveResponseUsage).toBe("off");
  });

  test("buildGatewaySessionRow effectiveResponseUsage keeps an explicit session off over a channel default", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      messages: { responseUsage: { default: "full", discord: "full" } },
    } as OpenClawConfig;
    const entry = {
      sessionId: "d1",
      updatedAt: 1,
      channel: "discord",
      responseUsage: "off",
    } as SessionEntry;
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:discord:direct:1": entry },
      key: "agent:main:discord:direct:1",
      entry,
    });
    // Explicit off persists and wins over the per-channel default.
    expect(row.responseUsage).toBe("off");
    expect(row.effectiveResponseUsage).toBe("off");
  });

  test("resolveSessionStoreKey maps main aliases to default agent main", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "work" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:MAIN" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:main:work" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "MAIN" })).toBe("agent:ops:work");
  });

  test("resolveSessionStoreKey preserves non-alias agent:main keys for deleted-agent checks", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:main:discord:direct:u1" })).toBe(
      "agent:main:discord:direct:u1",
    );
  });

  test("resolveDeletedAgentIdFromSessionKey rejects non-alias main keys when main is absent", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const legacyMainAlias = resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" });

    expect(legacyMainAlias).toBe("agent:ops:work");
    expect(resolveDeletedAgentIdFromSessionKey(cfg, legacyMainAlias)).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "global")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "unknown")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "main")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:discord:direct:u1")).toBe("main");
  });

  test("resolveDeletedAgentIdFromSessionKey ignores confirmed ACP runtime session keys", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const acpEntry = (agent: string, runtimeSessionName: string) =>
      ({
        acp: {
          backend: "acpx",
          agent,
          runtimeSessionName,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 1,
        },
      }) as SessionEntry;
    const claudeKey = "agent:claude:acp:11111111-1111-4111-8111-111111111111";
    const cursorKey = "agent:cursor:acp:22222222-2222-4222-8222-222222222222";
    expect(
      resolveDeletedAgentIdFromSessionKey(cfg, claudeKey, acpEntry("claude", claudeKey)),
    ).toBeNull();
    expect(
      resolveDeletedAgentIdFromSessionKey(cfg, cursorKey, acpEntry("cursor", cursorKey)),
    ).toBeNull();
  });

  test("resolveDeletedAgentIdFromSessionKey rejects ACP-shaped bridge keys without ACP metadata", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    expect(
      resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:acp:configured-bridge-without-meta", {
        acp: undefined,
        sessionId: "sess-configured-bridge",
        updatedAt: 1,
      }),
    ).toBeNull();

    expect(
      resolveDeletedAgentIdFromSessionKey(
        cfg,
        "agent:deleted-agent:acp:bridge-session-without-runtime-meta",
        { acp: undefined, sessionId: "sess-deleted-bridge", updatedAt: 1 },
      ),
    ).toBe("deleted-agent");
  });

  test("resolveDeletedAgentIdFromSessionKey repairs canonical ACP metadata aliases", async () => {
    await withStateDirEnv("session-utils-acp-deleted-agent-repair-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "claude", "sessions", "sessions.json");
      const acpKey = "agent:claude:acp:55555555-5555-4555-8555-555555555555";
      const legacyAcpKey = "agent:CLAUDE:acp:55555555-5555-4555-8555-555555555555";
      const entry = {
        sessionId: "sess-acp-repair",
        updatedAt: 1,
      } satisfies SessionEntry;
      await seedSessionEntries(storePath, {
        [acpKey]: entry,
      });
      writeAcpSessionMetaForMigration({
        sessionKey: legacyAcpKey,
        sessionId: "sess-acp-repair",
        meta: {
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: legacyAcpKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 1,
        },
      });
      const cfg = {
        session: {
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      expect(
        resolveDeletedAgentIdFromSessionKey(cfg, acpKey, entry, {
          acpMetadataSessionKey: acpKey,
        }),
      ).toBeNull();
    });
  });

  test("resolveDeletedAgentIdFromSessionKey rejects deleted configured ACP binding owners", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    expect(
      resolveDeletedAgentIdFromSessionKey(
        cfg,
        "agent:deleted-agent:acp:binding:discord:default:feedface",
      ),
    ).toBe("deleted-agent");
    expect(
      resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:acp:binding:discord:default:feedface"),
    ).toBeNull();
  });

  test("resolveSessionStoreKey canonicalizes bare keys to default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:main" })).toBe(
      "agent:alpha:main",
    );
  });

  test("resolveSessionStoreKey falls back to first list entry when no agent is marked default", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops" }, { id: "review" }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:main");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
  });

  test("resolveSessionStoreKey falls back to main when agents.list is missing", () => {
    const cfg = {
      session: { mainKey: "work" },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:main:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toBe("agent:main:thread-1");
  });

  test("resolveSessionStoreKey normalizes session key casing", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "CoP" })).toBe(
      resolveSessionStoreKey({ cfg, sessionKey: "cop" }),
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "MySession" })).toBe("agent:ops:mysession");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:CoP" })).toBe("agent:ops:cop");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:MySession" })).toBe(
      "agent:alpha:mysession",
    );
  });

  test("resolveSessionStoreKey preserves Signal group ids", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    expect(resolveSessionStoreKey({ cfg, sessionKey: `Signal:Group:${mixedGroupId}` })).toBe(
      `agent:ops:signal:group:${mixedGroupId}`,
    );
    expect(
      resolveSessionStoreKey({ cfg, sessionKey: `Agent:Alpha:Signal:Group:${mixedGroupId}` }),
    ).toBe(`agent:alpha:signal:group:${mixedGroupId}`);
  });

  test("canonicalizeSpawnedByForAgent preserves Signal group ids", () => {
    const cfg = {
      session: { mainKey: "main" },
    } as OpenClawConfig;
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";

    expect(canonicalizeSpawnedByForAgent(cfg, "ops", `Signal:Group:${mixedGroupId}`)).toBe(
      `agent:ops:signal:group:${mixedGroupId}`,
    );
    expect(
      canonicalizeSpawnedByForAgent(cfg, "ops", `Agent:Main:Signal:Group:${mixedGroupId}`),
    ).toBe(`agent:main:signal:group:${mixedGroupId}`);
  });

  test("resolveSessionStoreKey honors global scope", () => {
    const cfg = {
      session: { scope: "global", mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("global");
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("global");
    expect(target.agentId).toBe("ops");
  });

  test("resolveGatewaySessionStoreTarget uses canonical key for main alias", () => {
    const storeTemplate = path.join(
      os.tmpdir(),
      "openclaw-session-utils",
      "{agentId}",
      "sessions.json",
    );
    const cfg = {
      session: { mainKey: "main", store: storeTemplate },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("agent:ops:main");
    expect(target.storeKeys).toContain("agent:ops:main");
    expect(target.storeKeys).toContain("main");
    expect(target.storePath).toBe(path.resolve(storeTemplate.replace("{agentId}", "ops")));
  });

  test("resolveGatewaySessionStoreTarget resolves a customized main alias to its canonical key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-alias-"));
    const storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({ "agent:ops:main": { sessionId: "s1", updatedAt: 1 } }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "work", store: storePath },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:main" });
    expect(target.canonicalKey).toBe("agent:ops:work");
    expect(target.storeKeys).toContain("agent:ops:main");
  });

  test("resolveGatewaySessionStoreTarget preserves discovered store paths for non-round-tripping agent dirs", async () => {
    await withStateDirEnv("session-utils-discovered-store-", async ({ stateDir }) => {
      const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
      fs.mkdirSync(retiredSessionsDir, { recursive: true });
      const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
      await seedSessionEntries(retiredStorePath, {
        "agent:retired-agent:main": { sessionId: "sess-retired", updatedAt: 1 },
      });

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:retired-agent:main" });

      expect(target.storePath).toBe(path.resolve(retiredStorePath));
    });
  });

  test("loadSessionEntry reads discovered stores from non-round-tripping agent dirs", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-", async ({ stateDir }) => {
        const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
        fs.mkdirSync(retiredSessionsDir, { recursive: true });
        const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
        await seedSessionEntries(retiredStorePath, {
          "agent:retired-agent:main": { sessionId: "sess-retired", updatedAt: 7 },
        });
        const cfg = {
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:retired-agent:main");

        expect(loaded.storePath).toBe(path.resolve(retiredStorePath));
        expect(loaded.entry?.sessionId).toBe("sess-retired");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry can borrow the cached store for read-only hot paths", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-borrowed-", async ({ stateDir }) => {
        const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        const storePath = path.join(sessionsDir, "sessions.json");
        await seedSessionEntries(storePath, {
          "agent:main:main": { sessionId: "sess-main", updatedAt: 7 },
        });
        const cfg = {
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:main:main", { clone: false });

        expect(loaded.entry).toEqual({ sessionId: "sess-main", updatedAt: 7 });
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("resolveGatewaySessionStoreTargetWithStore returns the caller-provided store", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-target-store-", async ({ stateDir }) => {
        const cfg = {
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        const store: Record<string, SessionEntry> = {
          "agent:main:main": { sessionId: "sess-main", updatedAt: 7 },
        };

        const target = resolveGatewaySessionStoreTargetWithStore({
          cfg,
          key: "agent:main:main",
          store,
        });

        expect(target.store).toBe(store);
        expect(target.storeKeys).toContain("agent:main:main");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry preserves a listed deleted main session over the live default main", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-deleted-main-entry-", async ({ stateDir }) => {
        const storeTemplate = path.join(
          stateDir,
          "agents",
          "{agentId}",
          "sessions",
          "sessions.json",
        );
        const liveSessionsDir = path.join(stateDir, "agents", "ops", "sessions");
        const deletedSessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(liveSessionsDir, { recursive: true });
        fs.mkdirSync(deletedSessionsDir, { recursive: true });
        const liveStorePath = path.join(liveSessionsDir, "sessions.json");
        const deletedStorePath = path.join(deletedSessionsDir, "sessions.json");
        await seedSessionEntries(liveStorePath, {
          "agent:ops:main": { sessionId: "sess-live-default", updatedAt: 10 },
        });
        await seedSessionEntries(deletedStorePath, {
          "agent:main:main": { sessionId: "sess-deleted-main", updatedAt: 20 },
        });
        const cfg = {
          session: { mainKey: "main", store: storeTemplate },
          agents: { list: [{ id: "ops", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:main:main" });
        const loaded = loadSessionEntry("agent:main:main");

        expect(target.canonicalKey).toBe("agent:main:main");
        expect(target.agentId).toBe("main");
        expect(target.storePath).toBe(path.resolve(deletedStorePath));
        expect(loaded.canonicalKey).toBe("agent:main:main");
        expect(loaded.storePath).toBe(path.resolve(deletedStorePath));
        expect(loaded.entry?.sessionId).toBe("sess-deleted-main");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry resolves deleted main aliases when mainKey is customized", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-deleted-main-alias-", async ({ stateDir }) => {
        const storeTemplate = path.join(
          stateDir,
          "agents",
          "{agentId}",
          "sessions",
          "sessions.json",
        );
        const liveSessionsDir = path.join(stateDir, "agents", "ops", "sessions");
        const deletedSessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(liveSessionsDir, { recursive: true });
        fs.mkdirSync(deletedSessionsDir, { recursive: true });
        await seedSessionEntries(path.join(liveSessionsDir, "sessions.json"), {
          "agent:ops:work": { sessionId: "sess-live-default", updatedAt: 10 },
        });
        const deletedStorePath = path.join(deletedSessionsDir, "sessions.json");
        await seedSessionEntries(deletedStorePath, {
          "agent:main:main": { sessionId: "sess-deleted-main", updatedAt: 20 },
        });
        const cfg = {
          session: { mainKey: "work", store: storeTemplate },
          agents: { list: [{ id: "ops", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:main:work");

        expect(loaded.canonicalKey).toBe("agent:main:work");
        expect(loaded.storePath).toBe(path.resolve(deletedStorePath));
        expect(loaded.entry?.sessionId).toBe("sess-deleted-main");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry prefers the freshest duplicate row across discovered stores", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-cross-store-", async ({ stateDir }) => {
        const canonicalSessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(canonicalSessionsDir, { recursive: true });
        await seedSessionEntries(path.join(canonicalSessionsDir, "sessions.json"), {
          "agent:main:main": { sessionId: "sess-canonical-fresh", updatedAt: 1000 },
        });

        const discoveredSessionsDir = path.join(stateDir, "agents", "main ", "sessions");
        fs.mkdirSync(discoveredSessionsDir, { recursive: true });
        await seedSessionEntries(path.join(discoveredSessionsDir, "sessions.json"), {
          "agent:main:main": { sessionId: "sess-discovered-mid", updatedAt: 500 },
        });

        const cfg = {
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:main:main");

        expect(loaded.entry?.sessionId).toBe("sess-canonical-fresh");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("pruneLegacyStoreKeys removes alias ghost keys", () => {
    const store: Record<string, unknown> = {
      "agent:ops:work": { sessionId: "canonical", updatedAt: 3 },
      "agent:ops:main": { sessionId: "legacy-alias", updatedAt: 4 },
    };
    pruneLegacyStoreKeys({
      store,
      canonicalKey: "agent:ops:work",
      candidates: ["agent:ops:work", "agent:ops:main"],
    });
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);
  });

  test("migrateAndPruneGatewaySessionStoreKey promotes the freshest alias row to canonical", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      "agent:ops:work": {
        sessionId: "sess-stale",
        updatedAt: 1,
      } as SessionEntry,
      "agent:ops:main": {
        sessionId: "sess-fresh",
        updatedAt: 2,
      } as SessionEntry,
    };

    const result = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: "agent:ops:main",
      store,
    });

    expect(result.primaryKey).toBe("agent:ops:work");
    expect(result.entry?.sessionId).toBe("sess-fresh");
    expect(store["agent:ops:work"]?.sessionId).toBe("sess-fresh");
    expect(store["agent:ops:main"]).toBeUndefined();
  });

  test("listAgentsForGateway rejects avatar symlink escapes outside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-outside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const outsideFile = path.join(root, "outside.txt");
    fs.writeFileSync(outsideFile, "top-secret", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(outsideFile, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBeUndefined();
  });

  test("listAgentsForGateway allows avatar symlinks that stay inside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-inside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "avatars"), { recursive: true });
    const targetPath = path.join(workspace, "avatars", "actual.png");
    fs.writeFileSync(targetPath, "avatar", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(targetPath, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBe(
      `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
    );
  });

  test("listAgentsForGateway falls back to identity.name when name is unset", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true, identity: { name: "开发助手" } }],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);

    expect(result.agents[0]).toMatchObject({
      id: "main",
      name: "开发助手",
      identity: { name: "开发助手" },
    });
  });

  test("listAgentsForGateway prefers explicit name over identity.name", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            name: "Ops",
            identity: { name: "开发助手" },
          },
        ],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);

    expect(result.agents[0]).toMatchObject({
      id: "main",
      name: "Ops",
      identity: { name: "开发助手" },
    });
  });

  test("listAgentsForGateway leaves name unset when both configured and identity names are absent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true, identity: {} }],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);

    expect(result.agents[0]).toMatchObject({
      id: "main",
      name: undefined,
      identity: {},
    });
  });

  test("listAgentsForGateway keeps explicit agents.list scope over disk-only agents (scope boundary)", async () => {
    await withStateDirEnv("openclaw-agent-list-scope-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "codex"), { recursive: true });

      const cfg = {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const { agents } = listAgentsForGateway(cfg);
      expect(agents.map((agent) => agent.id)).toEqual(["main"]);
    });
  });

  test("listAgentsForGateway includes effective workspace + model for default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          workspace: "/tmp/default-workspace",
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    expectFields(result.agents[0], {
      id: "main",
      workspace: "/tmp/default-workspace",
    });
    expect(result.agents[0]?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(result.agents[0]?.agentRuntime).toEqual({
      id: "codex",
      source: "implicit",
    });
  });

  test("listAgentsForGateway reports whether each workspace is a git checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-workspace-git-"));
    const gitWorkspace = path.join(root, "git");
    const plainWorkspace = path.join(root, "plain");
    fs.mkdirSync(path.join(gitWorkspace, ".git"), { recursive: true });
    fs.mkdirSync(plainWorkspace, { recursive: true });
    const cfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: gitWorkspace },
          { id: "plain", workspace: plainWorkspace },
        ],
      },
    } as OpenClawConfig;
    try {
      const result = listAgentsForGateway(cfg);

      expect(result.agents.map(({ id, workspaceGit }) => ({ id, workspaceGit }))).toEqual([
        { id: "main", workspaceGit: true },
        { id: "plain", workspaceGit: false },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("listAgentsForGateway reports explicit plugin runtime metadata", () => {
    const cfg = {
      session: { mainKey: "main" },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "codex" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    expectFields(result.agents[0], {
      id: "main",
    });
    expect(result.agents[0]?.agentRuntime).toEqual({
      id: "codex",
      source: "provider",
    });
  });

  test("listAgentsForGateway respects per-agent fallback override (including explicit empty list)", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [
          { id: "main", default: true },
          {
            id: "ops",
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: [],
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    const ops = result.agents.find((agent) => agent.id === "ops");
    expect(ops?.model).toEqual({ primary: "anthropic/claude-opus-4-6" });
  });

  test("listAgentsForGateway reports per-agent thinking defaults from the agent model", () => {
    const resolveDeepSeekThinkingProfile = vi.fn(() => ({
      levels: [
        { id: "off" as const },
        { id: "minimal" as const },
        { id: "low" as const },
        { id: "medium" as const },
        { id: "high" as const },
        { id: "xhigh" as const },
      ],
      defaultLevel: "medium" as const,
    }));
    const registry = createEmptyPluginRegistry();
    registry.providers.push(
      {
        pluginId: "test-minimax",
        source: "test",
        provider: {
          id: "minimax",
          label: "MiniMax",
          auth: [],
          resolveThinkingProfile: () => ({
            levels: [{ id: "off" }],
            defaultLevel: "off",
          }),
        },
      },
      {
        pluginId: "test-deepseek",
        source: "test",
        provider: {
          id: "deepseek",
          label: "DeepSeek",
          auth: [],
          resolveThinkingProfile: resolveDeepSeekThinkingProfile,
        },
      },
    );
    setActivePluginRegistry(registry);

    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          model: { primary: "minimax/MiniMax-M2.7" },
          thinkingDefault: "off",
        },
        list: [
          { id: "main", default: true },
          {
            id: "investment-master",
            model: { primary: "deepseek/deepseek-v4-flash" },
            thinkingDefault: "xhigh",
          },
        ],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    const agent = result.agents.find((row) => row.id === "investment-master");

    expect(agent?.model).toEqual({ primary: "deepseek/deepseek-v4-flash" });
    expect(resolveDeepSeekThinkingProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      }),
    );
    expect(agent?.thinkingDefault).toBe("xhigh");
    expect(agent?.thinkingLevels?.map((level) => level.id)).toEqual(
      expect.arrayContaining(["off", "minimal", "low", "medium", "high", "xhigh"]),
    );
    expect(agent?.thinkingOptions).toEqual(agent?.thinkingLevels?.map((level) => level.label));
  });

  test("listAgentsForGateway uses the model catalog for per-agent thinking metadata", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          model: { primary: "local/custom-reasoner" },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg, [
      { provider: "local", id: "custom-reasoner", name: "Custom Reasoner", reasoning: true },
    ]);
    const agent = result.agents.find((row) => row.id === "main");

    expect(agent?.thinkingDefault).toBe("medium");
    expect(agent?.thinkingLevels?.map((level) => level.id)).toContain("medium");
  });
});

describe("resolveSessionModelRef", () => {
  test("prefers explicit session overrides ahead of runtime model fields", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s1",
      updatedAt: Date.now(),
      modelProvider: "openai",
      model: "gpt-5.4",
      modelOverride: "claude-opus-4-6",
      providerOverride: "anthropic",
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });

  test("preserves openrouter provider when model contains vendor prefix", () => {
    const cfg = createModelDefaultsConfig({
      primary: "openrouter/minimax/minimax-m2.7",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-or",
      updatedAt: Date.now(),
      modelProvider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });

    expect(resolved).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  test("falls back to override when runtime model is not recorded yet", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s2",
      updatedAt: Date.now(),
      modelOverride: "openai/gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  test("keeps nested model ids under the stored provider override", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-nested",
      updatedAt: Date.now(),
      providerOverride: "nvidia",
      modelOverride: "moonshotai/kimi-k2.5",
    });

    expect(resolved).toEqual({ provider: "nvidia", model: "moonshotai/kimi-k2.5" });
  });

  test("preserves explicit wrapper providers for vendor-prefixed override models", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-openrouter-override",
      updatedAt: Date.now(),
      providerOverride: "openrouter",
      modelOverride: "anthropic/claude-haiku-4.5",
      modelProvider: "openrouter",
      model: "openrouter/free",
    });

    expect(resolved).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  test("strips a duplicated provider prefix from stored overrides", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-qualified-override",
      updatedAt: Date.now(),
      providerOverride: "openai",
      modelOverride: "openai/gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  test("falls back to resolved provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3.1-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({
      provider: "google-gemini-cli",
      model: "claude-sonnet-4-6",
    });
  });

  test("preserves provider from slash-prefixed model when modelProvider is missing", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3.1-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });
});

describe("listSessionsFromStore selected model display", () => {
  test("async list yields during bulk transcript title and last-message hydration", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-list-yield-"));
    try {
      const storePath = path.join(tmpDir, "sessions.json");
      const store: Record<string, SessionEntry> = {};
      const now = Date.now();
      for (let i = 0; i < 11; i += 1) {
        const sessionId = `sess-yield-${i}`;
        const sessionKey = `agent:main:${sessionId}`;
        const entry = {
          sessionId,
          updatedAt: now - i,
          modelProvider: "openai",
          model: "gpt-5.4",
          totalTokens: 1,
          totalTokensFresh: true,
          contextTokens: 1,
          estimatedCostUsd: 0,
        } as SessionEntry;
        store[sessionKey] = entry;
        await seedSessionEntries(storePath, {
          [sessionKey]: entry,
        });
        appendTranscriptMessages({
          sessionId,
          sessionKey,
          storePath,
          messages: [
            { role: "user", content: `title ${i}` },
            { role: "assistant", content: `last ${i}` },
          ],
        });
      }

      const params = {
        cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
        storePath,
        store,
        opts: { includeDerivedTitles: true, includeLastMessage: true, limit: 11 },
      };
      const expected = listSessionsFromStore(params);
      const listedPromise = listSessionsFromStoreAsync(params);
      let settled = false;
      void listedPromise.then(() => {
        settled = true;
      });

      await Promise.resolve();

      expect(settled).toBe(false);
      const listed = await listedPromise;
      expect(listed.path).toBe(expected.path);
      expect(listed.count).toBe(expected.count);
      expect(listed.defaults).toEqual(expected.defaults);
      expect(listed.sessions).toHaveLength(expected.sessions.length);
      expectFields(listed.sessions[0], {
        key: "agent:main:sess-yield-0",
        derivedTitle: "title 0",
        lastMessagePreview: "last 0",
      });
      expect(listed.sessions[0]?.agentRuntime).toEqual({ id: "codex", source: "implicit" });
      expect(listed.sessions[0]?.thinkingLevel).toBeUndefined();
      expect(listed.sessions[0]?.thinkingLevels?.length).toBeGreaterThan(0);
      expect(listed.sessions[0]?.thinkingOptions?.length).toBeGreaterThan(0);
      expect(listed.sessions[0]?.thinkingDefault).toBe("off");
    } finally {
      closeSessionSqliteDatabasesForTest();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("caps transcript title and last-message hydration for bulk list responses", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-list-cap-"));
    try {
      const storePath = path.join(tmpDir, "sessions.json");
      const store: Record<string, SessionEntry> = {};
      const now = Date.now();
      for (let i = 0; i < 101; i += 1) {
        const sessionId = `sess-${i}`;
        const sessionKey = `agent:main:${sessionId}`;
        const entry = {
          sessionId,
          updatedAt: now - i,
          modelProvider: "openai",
          model: "gpt-5.4",
        } as SessionEntry;
        store[sessionKey] = entry;
        await seedSessionEntries(storePath, {
          [sessionKey]: entry,
        });
        if (i === 0 || i === 99 || i === 100) {
          appendTranscriptMessages({
            sessionId,
            sessionKey,
            storePath,
            messages: [
              { role: "user", content: `title ${i}` },
              { role: "assistant", content: `last ${i}` },
            ],
          });
        }
      }

      const result = await listSessionsFromStoreAsync({
        cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
        storePath,
        store,
        opts: { includeDerivedTitles: true, includeLastMessage: true, limit: 101 },
      });

      expect(result.sessions).toHaveLength(101);
      expect(result.sessions[0]?.derivedTitle).toBe("title 0");
      expect(result.sessions[0]?.lastMessagePreview).toBe("last 0");
      expect(result.sessions[99]?.derivedTitle).toBe("title 99");
      expect(result.sessions[99]?.lastMessagePreview).toBe("last 99");
      expect(result.sessions[100]?.derivedTitle).toBeUndefined();
      expect(result.sessions[100]?.lastMessagePreview).toBeUndefined();
    } finally {
      closeSessionSqliteDatabasesForTest();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("uses bounded top-N selection for small limited lists", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:old": { sessionId: "old", updatedAt: now - 10_000 } as SessionEntry,
      "agent:main:newest": { sessionId: "newest", updatedAt: now } as SessionEntry,
      "agent:main:middle-a": { sessionId: "middle-a", updatedAt: now - 5_000 } as SessionEntry,
      "agent:main:middle-b": { sessionId: "middle-b", updatedAt: now - 5_000 } as SessionEntry,
      "agent:main:newer": { sessionId: "newer", updatedAt: now - 1_000 } as SessionEntry,
    };
    const result = listSessionsFromStore({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "/tmp/sessions.json",
      store,
      opts: { limit: 4 },
    });

    expect(result.sessions.map((session) => session.key)).toEqual([
      "agent:main:newest",
      "agent:main:newer",
      "agent:main:middle-a",
      "agent:main:middle-b",
    ]);
  });

  test("keeps the scoped global row when filtering by agent", () => {
    const now = Date.now();
    const result = listSessionsFromStore({
      cfg: {
        ...createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4" } },
          list: [
            { id: "main", default: true, model: { primary: "openai/gpt-5.4" } },
            { id: "work", model: { primary: "anthropic/claude-opus-4-6" } },
          ],
        },
      } as OpenClawConfig,
      storePath: "/tmp/sessions.json",
      store: {
        global: { sessionId: "global", updatedAt: now } as SessionEntry,
        "agent:main:main": { sessionId: "main", updatedAt: now - 1 } as SessionEntry,
        "agent:work:main": { sessionId: "work", updatedAt: now - 2 } as SessionEntry,
      },
      opts: { agentId: "work", includeGlobal: true, search: "global" },
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["global"]);
    expect(result.sessions[0]).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  test("filters phantom agent store placeholder rows from session lists", () => {
    const now = Date.now();
    const result = listSessionsFromStore({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:sessions": {} as SessionEntry,
        "agent:main:main": { sessionId: "sess-main", updatedAt: now } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:main"]);
  });

  test("shows the selected override model even when a fallback runtime model exists", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelProvider: "openai",
          model: "gpt-5.4",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-opus-4-6");
  });

  test("separates Claude CLI runtime metadata from canonical model identity", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-7",
      agentRuntime: { id: "claude-cli" },
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "claude-cli",
          model: "claude-opus-4-7",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-opus-4-7");
    expect(result.sessions[0]?.agentRuntime).toEqual({
      id: "claude-cli",
      source: "model",
    });
  });

  test("infers canonical provider for bare CLI models before default-provider fallback", () => {
    const cfg = createModelDefaultsConfig({
      primary: "openai/gpt-5.4",
      models: {
        "anthropic/claude-opus-4-7": {},
      },
      agentRuntime: { id: "claude-cli" },
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "claude-cli",
          model: "claude-opus-4-7",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-opus-4-7");
  });

  test("uses qualified selected defaults for rows without runtime model metadata", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
        },
        list: [
          { id: "main", model: { primary: "anthropic/claude-sonnet-4-6" } },
          {
            id: "review",
            model: { primary: "vercel-ai-gateway/anthropic/claude-haiku-4-5" },
          },
          { id: "alias", model: { primary: "anthropic/sonnet-4.6" } },
        ],
      },
    } as OpenClawConfig;

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: 2,
        } as SessionEntry,
        "agent:review:review": {
          sessionId: "sess-review",
          updatedAt: 1,
        } as SessionEntry,
        "agent:alias:alias": {
          sessionId: "sess-alias",
          updatedAt: 0,
        } as SessionEntry,
      },
      opts: {},
    });

    expect(
      result.sessions.map((session) => [session.key, session.modelProvider, session.model]),
    ).toEqual([
      ["agent:main:main", "anthropic", "claude-sonnet-4-6"],
      ["agent:review:review", "vercel-ai-gateway", "anthropic/claude-haiku-4-5"],
      ["agent:alias:alias", "anthropic", "claude-sonnet-4-6"],
    ]);
  });

  test("uses persisted runtime model metadata before selected defaults", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [{ id: "main", model: { primary: "anthropic/claude-sonnet-4-6" } }],
      },
    } as OpenClawConfig;

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("openai");
    expect(result.sessions[0]?.model).toBe("gpt-5.5");
  });

  test("uses complete model overrides without default-model fallback", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [{ id: "main", model: { primary: "anthropic/claude-sonnet-4-6" } }],
      },
    } as OpenClawConfig;

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "sonnet-4.6",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-sonnet-4-6");
  });
});

describe("resolveSessionModelIdentityRef", () => {
  const resolveLegacyIdentityRef = (cfg: OpenClawConfig, modelProvider?: string) =>
    resolveSessionModelIdentityRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider,
    });

  test("does not inherit default provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3.1-pro-preview",
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured model allowlist when unambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3.1-pro-preview",
      models: {
        "anthropic/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured provider catalogs when allowlist is absent", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3.1-pro-preview",
    });
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "custom-provider-runtime-model",
      updatedAt: Date.now(),
      model: "qwen-max",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "qwen-dashscope", model: "qwen-max" });
  });

  test("keeps provider unknown when configured models are ambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3.1-pro-preview",
      models: {
        "anthropic/claude-sonnet-4-6": {},
        "minimax/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("keeps provider unknown when configured provider catalog matches are ambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3.1-pro-preview",
    });
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
        qwen: {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "ambiguous-custom-provider-runtime-model",
      updatedAt: Date.now(),
      model: "qwen-max",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ model: "qwen-max" });
  });

  test("preserves provider from slash-prefixed runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3.1-pro-preview",
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("infers wrapper provider for slash-prefixed runtime model when allowlist match is unique", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3.1-pro-preview",
      models: {
        "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4-6",
    });
  });
});

describe("resolveSessionDisplayModelIdentityRef", () => {
  test("canonicalizes CLI runtime provider to the selected model provider", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-7",
      agentRuntime: { id: "claude-cli" },
    });

    expect(
      resolveSessionDisplayModelIdentityRef({
        cfg,
        agentId: "main",
        provider: "claude-cli",
        model: "claude-opus-4-7",
      }),
    ).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
  });

  test("prefers configured provider inference over default-provider parsing for bare CLI models", () => {
    const cfg = createModelDefaultsConfig({
      primary: "openai/gpt-5.4",
      models: {
        "anthropic/claude-opus-4-7": {},
      },
      agentRuntime: { id: "claude-cli" },
    });

    expect(
      resolveSessionDisplayModelIdentityRef({
        cfg,
        agentId: "main",
        provider: "claude-cli",
        model: "claude-opus-4-7",
      }),
    ).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
  });
});

describe("deriveSessionTitle", () => {
  test("returns undefined for undefined entry", () => {
    expect(deriveSessionTitle(undefined)).toBeUndefined();
  });

  test("prefers displayName when set", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "My Custom Session",
      subject: "Group Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("My Custom Session");
  });

  test("falls back to subject when displayName is missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      subject: "Dev Team Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Dev Team Chat");
  });

  test("uses first user message when displayName and subject missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry, "Hello, how are you?")).toBe("Hello, how are you?");
  });

  test("truncates long first user message to 60 chars with ellipsis", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg =
      "This is a very long message that exceeds sixty characters and should be truncated appropriately";
    const result = requireString(deriveSessionTitle(entry, longMsg), "truncated session title");
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith("…")).toBe(true);
  });

  test("keeps a derived title valid when the limit bisects an emoji", () => {
    const entry = { sessionId: "abc123", updatedAt: Date.now() } as SessionEntry;
    expect(deriveSessionTitle(entry, `${"t".repeat(58)}🚀 extra`)).toBe(`${"t".repeat(58)}…`);
  });

  test("truncates at word boundary when possible", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg = "This message has many words and should be truncated at a word boundary nicely";
    const result = requireString(deriveSessionTitle(entry, longMsg), "word-boundary session title");
    expect(result.endsWith("…")).toBe(true);
    expect(result.includes("  ")).toBe(false);
  });

  test("falls back to sessionId prefix with date", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: new Date("2024-03-15T10:30:00Z").getTime(),
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234 (2024-03-15)");
  });

  test("falls back to sessionId prefix without date when updatedAt missing", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: 0,
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234");
  });

  test("trims whitespace from displayName", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "  Padded Name  ",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Padded Name");
  });

  test("ignores empty displayName and falls through", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "   ",
      subject: "Actual Subject",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Actual Subject");
  });

  test.each([
    {
      name: "uses a label before the first user message",
      fields: { label: "Label via /name" },
      firstUserMessage: "Hello, what can you do?",
      expected: "Label via /name",
    },
    {
      name: "prefers an explicit label over display and group metadata",
      fields: {
        displayName: "Display Name",
        subject: "Group Subject",
        label: "Label via /name",
      },
      firstUserMessage: undefined,
      expected: "Label via /name",
    },
    {
      name: "ignores a blank label",
      fields: { label: "   " },
      firstUserMessage: "Hello!",
      expected: "Hello!",
    },
  ])("$name", ({ fields, firstUserMessage, expected }) => {
    const entry = { sessionId: "abc123", updatedAt: Date.now(), ...fields } as SessionEntry;
    expect(deriveSessionTitle(entry, firstUserMessage)).toBe(expected);
  });
});

describe("resolveGatewayModelSupportsImages", () => {
  test("keeps Foundry GPT deployments image-capable even when stale catalog metadata says text-only", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "microsoft-foundry",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", name: "GPT-5.4", provider: "microsoft-foundry", input: ["text"] },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("uses the preserved Foundry model name hint for alias deployments with stale text-only input metadata", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "deployment-gpt5",
        provider: "microsoft-foundry",
        loadGatewayModelCatalog: async () => [
          {
            id: "deployment-gpt5",
            name: "gpt-5.4",
            provider: "microsoft-foundry",
            input: ["text"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("treats claude-cli Claude models as image-capable even when catalog metadata is stale or missing", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "claude-sonnet-4-6",
        provider: "claude-cli",
        loadGatewayModelCatalog: async () => [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            provider: "claude-cli",
            input: ["text"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("matches catalog model ids case-insensitively for explicit providers", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "Qwen/Qwen3.5-35B-A3B",
        provider: "modelscope",
        loadGatewayModelCatalog: async () => [
          {
            id: "qwen/qwen3.5-35b-a3b",
            name: "Qwen3.5 35B",
            provider: "modelscope",
            input: ["text", "image"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("does not borrow image support from another provider when provider is explicit", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-4", name: "GPT-4", provider: "other", input: ["text", "image"] },
        ],
      }),
    ).resolves.toBe(false);
  });

  test("uses a unique providerless catalog match", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "Qwen/Qwen3.5-35B-A3B",
        loadGatewayModelCatalog: async () => [
          {
            id: "qwen/qwen3.5-35b-a3b",
            name: "Qwen3.5 35B",
            provider: "modelscope",
            input: ["text", "image"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("fails closed on ambiguous providerless catalog matches", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "shared-vision",
        loadGatewayModelCatalog: async () => [
          { id: "shared-vision", name: "Shared Vision", provider: "first", input: ["text"] },
          {
            id: "shared-vision",
            name: "Shared Vision",
            provider: "second",
            input: ["text", "image"],
          },
        ],
      }),
    ).resolves.toBe(false);
  });
});
