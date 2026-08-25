// Session utility tests cover key parsing, store migration, agent/default rows,
// model identity resolution, title derivation, and byte-capped row payloads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { resolveLegacyInheritedAuthAgentId } from "../agents/legacy-inherited-auth-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import {
  appendTranscriptMessageSync,
  listSessionChildEntriesReadOnly,
  listSessionEntriesReadOnly,
  recordInboundSessionMeta,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { CronJob } from "../cron/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";
import { registerSessionAutomationSource } from "./session-automation-index.js";
import { buildGatewaySessionEventFields } from "./session-event-payload.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";
import { deriveSessionTitle } from "./session-utils-core.js";
import { listSessionsFromStore, listSessionsFromStoreAsync } from "./session-utils-list.js";
import {
  getSessionDefaults,
  projectSessionPatchResult,
  resolveGatewayModelSupportsImages,
} from "./session-utils-model.js";
import {
  buildSessionListRowContext,
  buildSingleRowStoreChildSessionsByKey,
} from "./session-utils-projection.js";
import {
  buildGatewaySessionRow as buildGatewaySessionRowOwner,
  projectSessionActor,
} from "./session-utils-row.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils-store-lookup.js";
import {
  listAgentsForGateway,
  loadGatewaySessionEntryReadOnly,
  loadGatewaySessionEntry as loadSessionEntry,
  resolveCanonicalGatewaySessionStoreKey,
  resolveDeletedAgentIdFromSessionKey,
} from "./session-utils-store.js";

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

test("resolves fixed-store and auth compatibility owners", () => {
  const cfg = retainLegacyDefaultAgentId(
    {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "   " } },
        entries: { ops: {}, research: {} },
      },
      session: { mainKey: "work", store: "/tmp/openclaw-fixed-sessions.json" },
    },
    "ops",
  );
  expect(resolveSessionStoreKey({ cfg, sessionKey: "incident-42" })).toBe("agent:ops:incident-42");
  const explicit = { agents: { ownership: "explicit" as const, entries: { a: {}, b: {} } } };
  expect(
    resolveLegacyInheritedAuthAgentId({
      ...explicit,
      agents: { ...explicit.agents, defaults: { authInheritance: { agentId: "saved" } } },
    }),
  ).toBe("saved");
  expect(resolveLegacyInheritedAuthAgentId(explicit)).toBe("main");
  expect(resolveLegacyInheritedAuthAgentId(retainLegacyDefaultAgentId(explicit, "a"))).toBe("a");
  expect(resolveLegacyInheritedAuthAgentId({ agents: { entries: { solo: {} } } })).toBe("solo");
});

test("projects a channel avatar route without exposing its media-store reference", () => {
  const key = "agent:main:discord:direct:user-1";
  const localReference = "/private/state/media/inbound/avatar.png";
  const cfg = {
    gateway: { controlUi: { basePath: "/control" } },
  } as OpenClawConfig;
  const entry = {
    sessionId: "avatar-session",
    updatedAt: 1,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "discord", to: "user:user-1" },
      origin: {
        provider: "discord",
        to: "user:user-1",
        avatar: localReference,
      },
    }),
  } satisfies SessionEntry;

  const row = buildGatewaySessionRowOwner({
    cfg,
    storePath: "",
    store: { [key]: entry },
    key,
    entry,
  });

  expect(row.channelAvatarUrl).toMatch(
    /^\/control\/__openclaw__\/channel-avatar\/agent%3Amain%3Adiscord%3Adirect%3Auser-1\?v=[A-Za-z0-9_-]{12}$/,
  );
  expect(row.origin).toEqual({ provider: "discord", to: "user:user-1" });
  expect(JSON.stringify(row)).not.toContain(localReference);
  expect(buildGatewaySessionEventFields({ sessionRow: row })).toMatchObject({
    channelAvatarUrl: row.channelAvatarUrl,
  });

  // A replaced backing image (new media reference) must change the URL, or
  // client-side blob/404 caches keyed by URL keep serving the stale avatar.
  const replacedEntry = {
    ...entry,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "discord", to: "user:user-1" },
      origin: {
        provider: "discord",
        to: "user:user-1",
        avatar: "/private/state/media/inbound/avatar-2.png",
      },
    }),
  } satisfies SessionEntry;
  const replacedRow = buildGatewaySessionRowOwner({
    cfg,
    storePath: "",
    store: { [key]: replacedEntry },
    key,
    entry: replacedEntry,
  });
  expect(replacedRow.channelAvatarUrl).toBeDefined();
  expect(replacedRow.channelAvatarUrl).not.toBe(row.channelAvatarUrl);
});

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

function buildGatewaySessionRow(
  params: Parameters<typeof buildGatewaySessionRowOwner>[0],
): ReturnType<typeof buildGatewaySessionRowOwner> {
  const entry = params.entry ?? ({} as SessionEntry);
  const rowContext = buildSessionListRowContext({
    store: params.store,
    now: params.now ?? Date.now(),
  });
  // Row projection tests do not own ACP persistence. Mark the supplied fixture
  // as already checked so each assertion does not open the ambient state DB.
  rowContext.acpSessionMetaByEntry.set(entry, undefined);
  return buildGatewaySessionRowOwner({
    ...params,
    entry,
    rowContext,
    lightweightListRow: params.lightweightListRow ?? true,
  });
}

function setTestActivePluginRegistry(
  registry: Parameters<typeof setActivePluginRegistry>[0],
): void {
  setActivePluginRegistry(registry);
  onTestFinished(resetPluginRuntimeStateForTest);
}

describe("gateway session utils", () => {
  test("projects configured agent identity while tolerating legacy session-key actor ids", () => {
    const cfg = {
      agents: {
        list: [{ id: "roboclaw", identity: { name: "Roboclaw", avatar: "avatar.png" } }],
      },
      gateway: { controlUi: { basePath: "/control" } },
    } as OpenClawConfig;

    expect(projectSessionActor({ type: "agent", id: "roboclaw" }, new Map(), cfg)).toEqual({
      type: "agent",
      id: "roboclaw",
      label: "Roboclaw",
      avatarUrl: "/control/avatar/roboclaw",
    });
    expect(
      projectSessionActor(
        { type: "agent", id: "agent:roboclaw:discord:channel:123" },
        new Map(),
        cfg,
      ),
    ).toEqual({ type: "agent", id: "agent:roboclaw:discord:channel:123" });
  });

  beforeEach(() => {
    // Real artifact loading belongs to its owner tests; session projections only need the contract.
    providerArtifactMocks.resolveBundledProviderPolicySurface.mockReset();
    providerArtifactMocks.resolveBundledProviderPolicySurface.mockReturnValue(null);
  });

  afterAll(closeSessionSqliteDatabasesForTest);

  test.each([
    { name: "never read", entry: {}, expected: false },
    {
      name: "legacy activity without creation provenance",
      entry: { lastActivityAt: 11 },
      expected: false,
    },
    {
      name: "activity after creation before first read",
      entry: { createdAt: 10, lastActivityAt: 11 },
      expected: true,
    },
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
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "main",
      entry: entry as SessionEntry,
    });
    expect(row.unread).toBe(expected);
  });

  test("projects swarm collector group ids to list and live session payloads", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "agent:main:child",
      entry: {
        swarmGroupId: "swarm:agent:main:parent:turn-42",
      } as SessionEntry,
    });

    expect(row.swarmGroupId).toBe("swarm:agent:main:parent:turn-42");
    expect(buildGatewaySessionEventFields({ sessionRow: row }).swarmGroupId).toBe(
      "swarm:agent:main:parent:turn-42",
    );
  });

  test("projects stored session tool overrides to list and live payloads", () => {
    const toolOverrides = { mcpServers: { docs: false }, webSearch: false };
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "agent:main:main",
      entry: { sessionId: "session-tools", updatedAt: 1, toolOverrides },
    });

    expect(row.toolOverrides).toEqual(toolOverrides);
    expect(buildGatewaySessionEventFields({ sessionRow: row }).toolOverrides).toEqual(
      toolOverrides,
    );
  });

  test("projects restart recovery tombstones", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "agent:main:dashboard:tombstoned",
      entry: {
        sessionId: "session-tombstoned",
        updatedAt: 1,
        mainRestartRecovery: {
          cycleId: "cycle-tombstoned",
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      } as SessionEntry,
    });

    expect(row.restartRecoveryStatus).toBe("tombstoned");
    expect(buildGatewaySessionEventFields({ sessionRow: row }).restartRecoveryStatus).toBe(
      "tombstoned",
    );
  });

  test("emits a tombstone when a session has no current control owner", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "agent:main:child-without-owner",
      entry: {} as SessionEntry,
    });

    expect(buildGatewaySessionEventFields({ sessionRow: row }).controlOwnerSessionKey).toBeNull();
  });

  test("projects only unexpired agent status", () => {
    const entry = {
      sessionId: "session",
      updatedAt: 1,
      agentStatus: { note: "Need a key", attention: "key", expiresAt: 1_001 },
    } satisfies SessionEntry;
    const params = {
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "main",
      entry,
    };
    expect(buildGatewaySessionRow({ ...params, now: 1_000 }).agentStatus).toEqual(
      entry.agentStatus,
    );
    expect(buildGatewaySessionRow({ ...params, now: 1_001 }).agentStatus).toBeUndefined();
  });

  test("projects the compact persisted observer digest", () => {
    const observerDigest = {
      sessionKey: "agent:main:main",
      runId: "run-1",
      revision: 3,
      updatedAt: 2_000,
      headline: "Wrapping up the implementation",
      assessment: "The focused tests pass.",
      health: "wrapping-up" as const,
      planProgress: { completed: 3, total: 4 },
    };
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "agent:main:main",
      entry: { sessionId: "session", updatedAt: 1, observerDigest },
    });

    expect(row.observerDigest).toEqual({
      runId: observerDigest.runId,
      headline: observerDigest.headline,
      health: observerDigest.health,
      updatedAt: observerDigest.updatedAt,
      revision: observerDigest.revision,
    });
    expect(buildGatewaySessionEventFields({ sessionRow: row }).observerDigest).toEqual(
      row.observerDigest,
    );
  });

  test("does not project an observer digest older than the latest run", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session",
        updatedAt: 3_000,
        startedAt: 3_000,
        observerDigest: {
          sessionKey: "agent:main:main",
          runId: "previous-run",
          revision: 2,
          updatedAt: 2_000,
          headline: "Previous run failed",
          health: "failed",
        },
      },
    });

    expect(row.observerDigest).toBeUndefined();
    expect(buildGatewaySessionEventFields({ sessionRow: row }).observerDigest).toBeNull();
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
    const store: Record<string, SessionEntry> = {
      recent: { sessionId: "recent", updatedAt: 30 },
      pinned: { sessionId: "pinned", updatedAt: 10, pinnedAt: 40 },
      archived: { sessionId: "archived", updatedAt: 20, archivedAt: 50 },
    } satisfies Record<string, SessionEntry>;

    const active = listSessionsFromStore({ cfg, storePath: "", store, opts: {} });
    expect(active.sessions.map((session) => session.key)).toEqual(["pinned", "recent"]);
    expect(active.sessions[0]).toMatchObject({
      pinned: true,
      pinnedAt: 40,
      archived: false,
    });

    const archived = listSessionsFromStore({
      cfg,
      storePath: "",
      store,
      opts: { archived: true },
    });
    expect(archived.sessions).toMatchObject([
      { key: "archived", archived: true, archivedAt: 50, pinned: false },
    ]);

    const all = listSessionsFromStore({
      cfg,
      storePath: "",
      store,
      opts: { archived: "all" },
    });
    expect(all.sessions.map((session) => session.key)).toEqual(["pinned", "recent", "archived"]);
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
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:direct:42": {
        sessionId: "direct-42",
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: "42" },
          origin: { label: "openclaw-tui" },
        }),
        updatedAt: 2,
      },
      "agent:main:telegram:direct:99": {
        sessionId: "direct-99",
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: "99" },
          origin: { label: "other-direct" },
        }),
        updatedAt: 1,
      },
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

  test.each(["discord:group:dev", "agent:ops:discord:group:dev"])(
    "projects group metadata from %s",
    (key) => {
      const row = buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
        storePath: "",
        store: {},
        key,
      });
      expect(row).toMatchObject({
        kind: "group",
        channel: "discord",
      });
      expect(row.displayName).toContain("dev");
    },
  );

  test("does not project group metadata from unrelated keys", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "foo:bar",
    });
    expect(row).toMatchObject({
      kind: "direct",
      channel: undefined,
      displayName: undefined,
    });
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
    setTestActivePluginRegistry(registry);

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
    setTestActivePluginRegistry(registry);

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

  test("session defaults and rows use the concrete runtime thinking policy", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push(
      {
        pluginId: "anthropic",
        source: "test",
        provider: {
          id: "anthropic",
          label: "Anthropic",
          auth: [],
          resolveThinkingProfile: () => ({
            levels: [{ id: "minimal" }, { id: "medium" }, { id: "adaptive" }],
            defaultLevel: "adaptive",
            preserveWhenCatalogReasoningFalse: true,
          }),
        },
      },
      {
        pluginId: "anthropic",
        source: "test",
        provider: {
          id: "claude-cli",
          label: "Claude CLI",
          auth: [],
          resolveThinkingProfile: () => ({
            levels: [{ id: "off" }],
            defaultLevel: "off",
          }),
        },
      },
    );
    setTestActivePluginRegistry(registry);

    const cfg = createModelDefaultsConfig({ primary: "anthropic/claude-mythos-5" });
    const catalog = [
      {
        provider: "anthropic",
        id: "claude-mythos-5",
        name: "Claude Mythos 5",
        reasoning: false,
        thinkingPolicyProvider: "claude-cli",
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

    expect(defaults.thinkingLevels?.map((level) => level.id)).toEqual(["off"]);
    expect(row.thinkingLevels?.map((level) => level.id)).toEqual(["off"]);
    expect(defaults.thinkingDefault).toBe("off");
    expect(row.thinkingDefault).toBe("off");
  });

  test("session defaults and rows use dynamic catalog context limits with authored caps", () => {
    const catalog = [
      {
        provider: "dynamic-router",
        id: "reasoner",
        name: "Reasoner",
        contextWindow: 256_000,
        contextTokens: 200_000,
      },
    ];
    const cfg = createModelDefaultsConfig({ primary: "dynamic-router/reasoner" });

    expect(getSessionDefaults(cfg, catalog).contextTokens).toBe(200_000);
    expect(
      buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:main",
        modelCatalog: catalog,
      }).contextTokens,
    ).toBe(200_000);

    const capped = {
      ...cfg,
      models: {
        providers: {
          "dynamic-router": {
            models: [{ id: "reasoner", contextWindow: 128_000 }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(getSessionDefaults(capped, catalog).contextTokens).toBe(128_000);
    expect(
      buildGatewaySessionRow({
        cfg: capped,
        storePath: "",
        store: {},
        key: "agent:main:main",
        modelCatalog: catalog,
      }).contextTokens,
    ).toBe(128_000);
  });

  test("session rows project the selected catalog context window", () => {
    const catalog = [
      {
        provider: "claude-cli",
        id: "claude-fable-5",
        name: "Claude Fable 5",
        contextWindow: 1_000_000,
        contextWindows: [
          { id: "200k", label: "200K", contextWindow: 200_000 },
          { id: "1m", label: "1M", contextWindow: 1_000_000 },
        ],
        contextWindowDefault: "1m",
      },
    ];
    const cfg = createModelDefaultsConfig({ primary: "claude-cli/claude-fable-5" });

    const defaults = getSessionDefaults(cfg, catalog);
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "agent:main:main",
      entry: { sessionId: "ctx", contextWindow: "200k" } as SessionEntry,
      modelCatalog: catalog,
    });

    expect(defaults).toMatchObject({ contextWindow: "1m", contextTokens: 1_000_000 });
    expect(row).toMatchObject({ contextWindow: "200k", contextTokens: 200_000 });
    expect(row.contextWindows).toEqual(catalog[0]?.contextWindows);
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

  test("session rows and update events project the latest run failure reason", () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const failed = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "agent:main:failed",
      lightweightListRow: true,
      skipTranscriptUsageFallback: true,
      entry: {
        sessionId: "session-failed",
        updatedAt: 1,
        status: "failed",
        lastRunError: "Provider credits exhausted",
      },
    });

    expect(failed.lastRunError).toBe("Provider credits exhausted");
    expect(buildGatewaySessionEventFields({ sessionRow: failed }).lastRunError).toBe(
      "Provider credits exhausted",
    );

    const cleared = { ...failed, status: "running" as const, lastRunError: undefined };
    expect(buildGatewaySessionEventFields({ sessionRow: cleared }).lastRunError).toBeNull();
  });

  test("session rows and update events project the exact settled run identity", () => {
    const settled = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "",
      store: {},
      key: "agent:main:settled",
      lightweightListRow: true,
      skipTranscriptUsageFallback: true,
      entry: {
        sessionId: "session-settled",
        updatedAt: 1,
        status: "done",
        lastRunId: "run-settled",
      },
    });

    expect(settled.lastRunId).toBe("run-settled");
    expect(buildGatewaySessionEventFields({ sessionRow: settled }).lastRunId).toBe("run-settled");

    const running = { ...settled, status: "running" as const, lastRunId: undefined };
    expect(buildGatewaySessionEventFields({ sessionRow: running }).lastRunId).toBeNull();
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
    setTestActivePluginRegistry(registry);

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
          providerOverride: "custom",
          modelOverride: "CaseModel",
          modelProvider: "custom",
          model: "CaseModel",
          updatedAt: 2,
        } satisfies SessionEntry,
        lower: {
          sessionId: "lower",
          providerOverride: "custom",
          modelOverride: "casemodel",
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
      lightweightListRow: false,
    });

    expect(defaults.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(row.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(providerArtifactMocks.resolveBundledProviderPolicySurface).toHaveBeenCalledWith(
      "openai",
      { manifestRegistry: undefined },
    );
  });

  test("keeps stored thinking text without a catalog and clamps it when one is present", () => {
    providerArtifactMocks.resolveBundledProviderPolicySurface.mockReturnValue({
      resolveThinkingProfile: () => ({
        levels: [{ id: "off" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
      }),
    });
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as OpenClawConfig;
    const row = (entry: SessionEntry, withCatalog: boolean) =>
      buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry,
        ...(withCatalog
          ? {
              modelCatalog: [
                {
                  provider: "openai",
                  id: "gpt-5.6-sol",
                  name: "GPT-5.6 Sol (API route)",
                },
              ],
            }
          : {}),
      });

    const stored = { sessionId: "stored", thinkingLevel: "ultra" } as SessionEntry;

    expect(row(stored, false).thinkingLevel).toBe("ultra");
    expect(row(stored, true).thinkingLevel).toBe("high");
  });

  test("strips retired thinking provenance from Gateway patch results", async () => {
    const entry = {
      sessionId: "private-fallback",
      updatedAt: 1,
      thinkingLevelSelection: { retired: true },
      modelFallback: {
        prevModel: "gpt-5.6-sol",
        prevProvider: "openai",
        prevThinkingLevelSelection: { retired: true },
        source: "agent-patch",
        ts: 1,
      },
    } as unknown as InternalSessionEntry;
    const result = await projectSessionPatchResult({
      canonicalKey: "agent:main:main",
      cfg: {
        agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
      } as OpenClawConfig,
      entry,
      modelCatalogByAgent: new Map([
        [
          "main",
          Promise.resolve([
            {
              provider: "openai",
              id: "gpt-5.6-sol",
              name: "GPT 5.6 Sol",
              reasoning: true,
            },
          ]),
        ],
      ]),
      storePath: "/tmp/openclaw-sessions.json",
      targetAgentId: "main",
    });

    expect(result.entry.modelFallback).toEqual({
      prevModel: "gpt-5.6-sol",
      prevProvider: "openai",
      source: "agent-patch",
      ts: 1,
    });
    expect(JSON.stringify(result.entry)).not.toContain("thinkingLevelSelection");
  });

  test("reports observed locked runtime from agentHarnessId instead of configured intent", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    } as OpenClawConfig;

    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "observed-codex",
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      } as SessionEntry,
    });

    expect(row.agentRuntime).toEqual({
      id: "codex",
      cloudPlacementSupported: false,
      devicePlacementSupported: false,
      source: "session",
    });
  });

  test.each([true, false])(
    "projects current context for a stale different-runtime producer (lightweight=%s)",
    (lightweightListRow) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.6-sol", contextTokens: 1_000_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const row = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry: {
          sessionId: "stale-openclaw",
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        } as SessionEntry,
        lightweightListRow,
      });

      expect(row.agentRuntime?.id).toBe("codex");
      expect(row.contextTokens).toBe(1_000_000);
    },
  );

  test.each([true, false])(
    "projects current Codex context when producer provenance is missing (lightweight=%s)",
    (lightweightListRow) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.6-sol", contextTokens: 1_000_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const row = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry: {
          sessionId: "missing-provenance",
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          contextTokens: 272_000,
        } as SessionEntry,
        lightweightListRow,
      });

      expect(row.agentRuntime?.id).toBe("codex");
      expect(row.contextTokens).toBe(1_000_000);
    },
  );

  test.each([true, false])(
    "projects a changed explicit cap for the same runtime and model (lightweight=%s)",
    (lightweightListRow) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.6-sol", contextTokens: 1_000_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const row = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry: {
          sessionId: "stale-cap",
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "codex",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        } as SessionEntry,
        lightweightListRow,
      });

      expect(row.contextTokens).toBe(1_000_000);
    },
  );

  test.each([true, false])(
    "projects an authored contextWindow cap below matching runtime telemetry (lightweight=%s)",
    (lightweightListRow) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.6-sol", contextWindow: 128_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const row = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry: {
          sessionId: "authored-window-cap",
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "codex",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        } as SessionEntry,
        lightweightListRow,
      });

      expect(row.agentRuntime?.id).toBe("codex");
      expect(row.contextTokens).toBe(128_000);
    },
  );

  test.each([true, false])(
    "clamps an authored effective cap to a smaller authored contextWindow (lightweight=%s)",
    (lightweightListRow) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-5.6-sol",
                  contextTokens: 1_000_000,
                  contextWindow: 128_000,
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const row = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry: {
          sessionId: "authored-effective-above-native",
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          contextTokens: 272_000,
        } as SessionEntry,
        lightweightListRow,
      });

      expect(row.contextTokens).toBe(128_000);
    },
  );

  test.each([true, false])(
    "keeps matching runtime telemetry below a higher authored contextWindow (lightweight=%s)",
    (lightweightListRow) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.6-sol", contextWindow: 1_000_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const row = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry: {
          sessionId: "runtime-window-below-native-cap",
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "codex",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        } as SessionEntry,
        lightweightListRow,
      });

      expect(row.agentRuntime?.id).toBe("codex");
      expect(row.contextTokens).toBe(272_000);
    },
  );

  test.each([
    {
      name: "a locked Codex session under OpenClaw config",
      configuredRuntime: "openclaw",
      expectedRuntime: "codex",
      entry: {
        agentHarnessId: "codex",
        contextTokens: 1_000_000,
        modelSelectionLocked: true,
      },
    },
    {
      name: "locked legacy telemetry without harness provenance",
      configuredRuntime: "openclaw",
      expectedRuntime: "openclaw",
      entry: {
        contextTokens: 1_000_000,
        modelSelectionLocked: true,
      },
    },
  ])("preserves $name", ({ configuredRuntime, entry, expectedRuntime }) => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: configuredRuntime } },
          },
        },
      },
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.6-sol", contextWindow: 272_000 }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "native-window",
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        ...entry,
      } as SessionEntry,
    });

    expect(row.agentRuntime?.id).toBe(expectedRuntime);
    expect(row.contextTokens).toBe(1_000_000);
  });

  test.each([true, false])(
    "does not reuse stale transcript context after an OpenClaw to Codex change (lightweight=%s)",
    async (lightweightListRow) => {
      await withStateDirEnv("session-utils-stale-transcript-context-", async ({ stateDir }) => {
        const sessionId = "stale-transcript-context";
        const sessionKey = "agent:main:main";
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const entry = {
          sessionId,
          updatedAt: 1,
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "openclaw",
        } as SessionEntry;
        await seedSessionEntries(storePath, { [sessionKey]: entry });
        appendTranscriptMessages({
          sessionId,
          sessionKey,
          storePath,
          messages: [
            {
              role: "assistant",
              content: "old OpenClaw turn",
              provider: "openai",
              model: "gpt-5.5",
              usage: { input: 1, output: 1 },
            },
          ],
        });
        const cfg = {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.6-sol" },
              models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
            },
          },
          models: {
            providers: {
              openai: {
                models: [
                  { id: "gpt-5.5", contextWindow: 272_000 },
                  { id: "gpt-5.6-sol", contextWindow: 1_000_000 },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const row = buildGatewaySessionRow({
          cfg,
          storePath,
          store: { [sessionKey]: entry },
          key: sessionKey,
          entry,
          lightweightListRow,
        });

        expect(row.agentRuntime?.id).toBe("codex");
        expect(row.model).toBe("gpt-5.6-sol");
        expect(row.contextTokens).toBe(1_000_000);
      });
    },
  );

  test.each(["resolved", "runtime-configured"] as const)(
    "invalidates a persisted %s cap after the cap is removed",
    (contextTokensSource) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.6-sol", contextWindow: 1_000_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      for (const lightweightListRow of [true, false]) {
        const row = buildGatewaySessionRow({
          cfg,
          storePath: "",
          store: {},
          key: "agent:main:main",
          entry: {
            sessionId: "removed-cap",
            modelProvider: "openai",
            model: "gpt-5.6-sol",
            agentHarnessId: "codex",
            contextTokens: 272_000,
            contextTokensSource,
          } as SessionEntry,
          lightweightListRow,
        });

        expect(row.contextTokens).toBe(1_000_000);
      }
    },
  );

  test.each([true, false])(
    "projects a matching persisted resolved cap when catalog resolution is unavailable (lightweight=%s)",
    (lightweightListRow) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
      } as unknown as OpenClawConfig;
      const entry = {
        sessionId: "matching-resolved-cap",
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        agentHarnessId: "codex",
        contextTokens: 272_000,
        contextTokensSource: "resolved-v1",
      } as SessionEntry;

      const row = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: { "agent:main:main": entry },
        key: "agent:main:main",
        entry,
        lightweightListRow,
      });

      expect(row.agentRuntime?.id).toBe("codex");
      expect(row.contextTokens).toBe(272_000);
    },
  );

  test.each([true, false])(
    "rejects an unresolved fallback even after persistence records the current tuple (lightweight=%s)",
    (lightweightListRow) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
      } as unknown as OpenClawConfig;
      const entry = {
        sessionId: "unresolved-fallback",
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        agentHarnessId: "codex",
        contextTokens: 272_000,
        contextTokensSource: undefined,
      } as SessionEntry;

      const row = buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: { "agent:main:main": entry },
        key: "agent:main:main",
        entry,
        lightweightListRow,
      });

      expect(row.agentRuntime?.id).toBe("codex");
      expect(row.contextTokens).toBeUndefined();
    },
  );

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
        totalTokensVersion: 1,
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

  test("SQLite unavailable context blocks old totals until a later valid snapshot", async () => {
    await withStateDirEnv("session-utils-unavailable-usage-", async ({ stateDir }) => {
      const sessionId = "unavailable-usage";
      const sessionKey = "agent:main:main";
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const entry: SessionEntry = {
        sessionId,
        updatedAt: 1,
        totalTokens: 1_124_767,
        totalTokensFresh: false,
      };
      await seedSessionEntries(storePath, { [sessionKey]: entry });
      appendTranscriptMessages({
        sessionId,
        sessionKey,
        storePath,
        messages: [
          {
            role: "assistant",
            api: "cli",
            content: "old cumulative turn",
            usage: {
              input: 128_814,
              output: 3_000,
              cacheRead: 992_953,
              totalTokens: 1_124_767,
            },
          },
        ],
      });

      const legacyRow = buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "anthropic/claude-opus-4-7" }),
        storePath,
        store: { [sessionKey]: entry },
        key: sessionKey,
        entry,
      });
      expect(legacyRow.totalTokens).toBeUndefined();
      expect(legacyRow.totalTokensFresh).toBe(false);

      appendTranscriptMessages({
        sessionId,
        sessionKey,
        storePath,
        messages: [
          {
            role: "assistant",
            api: "cli",
            content: "usage unavailable",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              contextUsage: { state: "unavailable" },
            },
          },
        ],
      });

      const unavailableRow = buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "anthropic/claude-opus-4-7" }),
        storePath,
        store: { [sessionKey]: entry },
        key: sessionKey,
        entry,
      });
      expect(unavailableRow.totalTokens).toBeUndefined();
      expect(unavailableRow.totalTokensFresh).toBe(false);

      appendTranscriptMessages({
        sessionId,
        sessionKey,
        storePath,
        messages: [
          {
            role: "assistant",
            api: "cli",
            content: "valid later turn",
            usage: {
              input: 67_932,
              output: 2_000,
              cacheRead: 18_944,
              totalTokens: 88_876,
              contextUsage: {
                state: "available",
                promptTokens: 86_876,
                totalTokens: 88_876,
              },
            },
          },
        ],
      });
      const validRow = buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "anthropic/claude-opus-4-7" }),
        storePath,
        store: { [sessionKey]: entry },
        key: sessionKey,
        entry,
      });
      expect(validRow.totalTokens).toBe(86_876);
      expect(validRow.totalTokensFresh).toBe(true);
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

  test("buildGatewaySessionRow classifies session keys and chat types", () => {
    const projectKind = (key: string, entry?: SessionEntry) =>
      buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
        storePath: "",
        store: {},
        key,
        entry,
      }).kind;
    expect(projectKind("global")).toBe("global");
    expect(projectKind("unknown")).toBe("unknown");
    expect(projectKind("discord:group:dev")).toBe("group");
    expect(projectKind("main")).toBe("direct");
    const entry = { chatType: "group" } as SessionEntry;
    expect(projectKind("main", entry)).toBe("group");
  });

  test("buildGatewaySessionRow displayName falls through to origin label for direct sessions", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "direct-42",
      updatedAt: 1,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "42" },
        origin: { label: "openclaw-tui" },
      }),
    };
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:direct:42": entry },
      key: "agent:main:telegram:direct:42",
      entry,
    });
    expect(row.displayName).toBe("openclaw-tui");
  });

  test("buildGatewaySessionRow keeps dashboard sender identity out of the session title", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "dashboard-1",
      updatedAt: 1,
      chatType: "direct",
      delivery: { kind: "internal" as const },
    };
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:dashboard:chat-1": entry },
      key: "agent:main:dashboard:chat-1",
      entry,
    });
    expect(row.displayName).toBeUndefined();

    const titledEntry = { ...entry, displayName: "Release Planning" } as SessionEntry;
    const titledRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:dashboard:chat-1": titledEntry },
      key: "agent:main:dashboard:chat-1",
      entry: titledEntry,
    });
    expect(titledRow.displayName).toBe("Release Planning");
  });

  test("buildGatewaySessionRow displayName prefers the human chat title for group sessions", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "group-99",
      updatedAt: 1,
      chatType: "group",
      subject: "Engineering",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "group:99" },
        origin: { label: "openclaw-tui" },
      }),
    };
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:group:99": entry },
      key: "agent:main:telegram:group:99",
      entry,
    });
    expect(row.displayName).toBe("Engineering");
  });

  test("refreshes a legacy Buzz UUID title from inbound room metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-buzz-session-title-"));
    const storePath = path.join(dir, "sessions.json");
    const roomId = "b25b8e40-eb1a-43a4-b56b-30a4e16df586";
    const key = `agent:main:buzz:group:${roomId}`;
    try {
      await replaceSessionEntry(
        { sessionKey: key, storePath },
        {
          sessionId: "legacy-buzz-room",
          updatedAt: 1,
          chatType: "group",
          groupId: roomId,
          groupChannel: roomId,
          displayName: "buzz:g-b25b8e40-eb1a-43a4-b56b-30a4e16df586",
        },
      );

      const entry = await recordInboundSessionMeta({
        storePath,
        sessionKey: key,
        ctx: {
          Provider: "buzz",
          Surface: "buzz",
          ChatType: "group",
          From: `buzz:group:${roomId}`,
          To: `buzz:${roomId}`,
          OriginatingTo: `buzz:${roomId}`,
          NativeChannelId: roomId,
          GroupSubject: "Engineering",
        },
      });

      expect(entry).toMatchObject({
        groupId: roomId,
        subject: "Engineering",
      });
      expect(entry?.groupChannel).toBeUndefined();
      const row = buildGatewaySessionRow({
        cfg: { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig,
        storePath,
        store: { [key]: entry as SessionEntry },
        key,
        entry: entry as SessionEntry,
      });
      expect(row.displayName).toBe("Engineering");
      expect(row.origin?.nativeChannelId).toBe(roomId);
    } finally {
      closeSessionSqliteDatabasesForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "resolved human names",
      subject: "Local Claw #channel-name",
    },
    {
      name: "explicit stable-id fallback",
      subject: "Slack Channel (Workspace ID: T0BDK6HMPS7, Channel ID: C0BDN50FL2Z)",
    },
  ])("refreshes a legacy Slack id title with $name", async ({ subject }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-session-title-"));
    const storePath = path.join(dir, "sessions.json");
    const channelId = "C0BDN50FL2Z";
    const key = `agent:main:slack:channel:${channelId.toLowerCase()}`;
    try {
      await replaceSessionEntry(
        { sessionKey: key, storePath },
        {
          sessionId: "legacy-slack-channel",
          updatedAt: 1,
          chatType: "channel",
          groupId: channelId.toLowerCase(),
          groupChannel: `#${channelId}`,
          space: "T0BDK6HMPS7",
          displayName: `slack:#${channelId}`,
        },
      );

      const entry = await recordInboundSessionMeta({
        storePath,
        sessionKey: key,
        ctx: {
          Provider: "slack",
          Surface: "slack",
          ChatType: "channel",
          From: `slack:channel:${channelId}`,
          To: `channel:${channelId}`,
          OriginatingTo: `channel:${channelId}`,
          NativeChannelId: channelId,
          GroupSubject: subject,
          GroupSpace: "T0BDK6HMPS7",
        },
      });

      expect(entry).toMatchObject({
        groupId: channelId.toLowerCase(),
        subject,
      });
      expect(entry?.groupChannel).toBeUndefined();
      const row = buildGatewaySessionRow({
        cfg: { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig,
        storePath,
        store: { [key]: entry as SessionEntry },
        key,
        entry: entry as SessionEntry,
      });
      expect(row.displayName).toBe(subject);
      expect(row.origin?.nativeChannelId).toBe(channelId);
    } finally {
      closeSessionSqliteDatabasesForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildGatewaySessionRow group displayName prefers #channel and falls back to the token", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const channelEntry: SessionEntry = {
      sessionId: "channel-C1",
      updatedAt: 1,
      chatType: "channel",
      delivery: normalizeSessionDeliveryState({ context: { channel: "slack", to: "channel:C1" } }),
      groupChannel: "general",
      space: "Acme",
    };
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

    const opaque: SessionEntry = {
      sessionId: "group-opaque",
      updatedAt: 1,
      chatType: "group",
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram", to: "group:99" } }),
    };
    const opaqueRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:group:99": opaque },
      key: "agent:main:telegram:group:99",
      entry: opaque,
    });
    expect(opaqueRow.displayName).toMatch(/^telegram:/);
  });

  test("buildGatewaySessionRow projects flat classification facts without group tokens", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const subagentEntry = {
      displayName: "Research",
    } as SessionEntry;
    const subagentRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:subagent:one": subagentEntry },
      key: "agent:main:subagent:one",
      entry: subagentEntry,
    });
    expect(subagentRow).toMatchObject({
      classification: "subagent",
      agentId: "main",
      isBackground: true,
    });

    const groupEntry = {
      chatType: "group",
      displayName: "telegram:g-private-token",
    } as SessionEntry;
    const groupRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:group:99": groupEntry },
      key: "agent:main:telegram:group:99",
      entry: groupEntry,
    });
    expect(groupRow).toMatchObject({
      classification: "group",
      peerKind: "group",
    });
    expect(
      JSON.stringify({
        classification: groupRow.classification,
        agentId: groupRow.agentId,
        accountId: groupRow.accountId,
        peerKind: groupRow.peerKind,
        isMain: groupRow.isMain,
        isBackground: groupRow.isBackground,
      }),
    ).not.toContain("private-token");
  });

  test("buildGatewaySessionRow projects worktree and execNode bindings", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      spawnedCwd: "/state/worktrees/abc/wt-1234",
      worktree: { id: "wt-id", branch: "openclaw/wt-1234", repoRoot: "/repo" },
      execNode: "macbook",
      execCwd: "/Users/peter/Projects/openclaw",
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
    expect(row.execCwd).toBe("/Users/peter/Projects/openclaw");
  });

  test("buildGatewaySessionRow projects the session root only for an explicit permission mode", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const ordinaryEntry: SessionEntry = {
      sessionId: "ordinary",
      sessionRoot: "/workspace/private",
      updatedAt: 1,
    };
    const ordinaryRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:ordinary": ordinaryEntry },
      key: "agent:main:ordinary",
      entry: ordinaryEntry,
    });
    expect(ordinaryRow).not.toHaveProperty("sessionRoot");

    const permissionEntry: SessionEntry = {
      ...ordinaryEntry,
      permissionMode: "workspace",
      sessionId: "permission",
    };
    const permissionRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:permission": permissionEntry },
      key: "agent:main:permission",
      entry: permissionEntry,
    });
    expect(permissionRow).toMatchObject({
      permissionMode: "workspace",
      sessionRoot: "/workspace/private",
    });
  });

  test("buildGatewaySessionRow prefers entry.label over origin.label for direct sessions", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "direct-labeled",
      updatedAt: 1,
      chatType: "direct",
      label: "Alice",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "42" },
        origin: { label: "openclaw-tui" },
      }),
    };
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
    const discordEntry: SessionEntry = {
      sessionId: "d1",
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({ context: { channel: "discord" } }),
    };
    const discordRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:discord:direct:1": discordEntry },
      key: "agent:main:discord:direct:1",
      entry: discordEntry,
    });
    expect(discordRow.effectiveResponseUsage).toBe("full");

    const telegramEntry: SessionEntry = {
      sessionId: "t1",
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
    };
    const telegramRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:telegram:direct:1": telegramEntry },
      key: "agent:main:telegram:direct:1",
      entry: telegramEntry,
    });
    expect(telegramRow.effectiveResponseUsage).toBe("tokens");

    // A channel with no entry falls back to the config "default" (off).
    const slackEntry: SessionEntry = {
      sessionId: "x1",
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({ context: { channel: "slack" } }),
    };
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

  test("buildGatewaySessionRow projects the effective Control UI queue mode", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      messages: { queue: { mode: "interrupt", byChannel: { webchat: "collect" } } },
    } as OpenClawConfig;
    const inheritedEntry = { sessionId: "s1", updatedAt: 1 } as SessionEntry;
    const inheritedRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:main": inheritedEntry },
      key: "agent:main:main",
      entry: inheritedEntry,
    });
    expect(inheritedRow.queueMode).toBeUndefined();
    expect(inheritedRow.effectiveQueueMode).toBe("collect");

    const overriddenEntry = {
      sessionId: "s2",
      updatedAt: 1,
      queueMode: "followup",
    } as SessionEntry;
    const overriddenRow = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { "agent:main:other": overriddenEntry },
      key: "agent:main:other",
      entry: overriddenEntry,
    });
    expect(overriddenRow.queueMode).toBe("followup");
    expect(overriddenRow.effectiveQueueMode).toBe("followup");
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

  test("resolveSessionStoreKey preserves an explicit retired store's non-main key", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    } as OpenClawConfig;

    expect(
      resolveSessionStoreKey({
        cfg,
        sessionKey: "agent:main:history",
        storeAgentId: "main",
      }),
    ).toBe("agent:main:history");
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
        lifecycleRevision: undefined,
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

  test("resolveSessionStoreKey rejects ownerless bare keys without a compatibility owner", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops" }, { id: "review" }] },
    } as OpenClawConfig;
    expect(() => resolveSessionStoreKey({ cfg, sessionKey: "main" })).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
    expect(() => resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
  });

  test("resolveSessionStoreKey uses configured fixed-store ownership for bare keys", () => {
    const cfg = {
      session: { mainKey: "main", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:main");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toBe("agent:ops:thread-1");
    expect(resolveSessionStoreAgentId(cfg, "global")).toBe("ops");
  });

  test("session-store key ownership rejects a retired fixed-store owner", () => {
    const cfg = {
      session: { mainKey: "main", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "retired" } },
        entries: { ops: {}, research: {} },
      },
    } as OpenClawConfig;
    expect(() => resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
    expect(() => resolveSessionStoreAgentId(cfg, "global")).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
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

  test("resolveGatewaySessionStoreTarget keeps a fixed configured store authoritative", async () => {
    await withStateDirEnv("session-utils-fixed-store-", async ({ stateDir }) => {
      const fixedStorePath = path.join(stateDir, "configured", "sessions.json");
      const staleStorePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
      await seedSessionEntries(fixedStorePath, {
        "agent:ops:main": { sessionId: "sess-fixed", updatedAt: 1 },
      });
      await seedSessionEntries(staleStorePath, {
        "agent:ops:main": { sessionId: "sess-stale", updatedAt: 99 },
      });
      const cfg = {
        session: { mainKey: "main", store: fixedStorePath },
        agents: { list: [{ id: "ops", default: true }] },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:ops:main",
      });

      expect(target.storePath).toBe(path.resolve(fixedStorePath));
      expect(target.store["agent:ops:main"]?.sessionId).toBe("sess-fixed");
    });
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

  test("resolveGatewaySessionStoreTarget keeps discovered contents paired with their path", async () => {
    await withStateDirEnv("session-utils-discovered-contents-", async ({ stateDir }) => {
      const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
      fs.mkdirSync(retiredSessionsDir, { recursive: true });
      const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
      await seedSessionEntries(retiredStorePath, {
        "agent:retired-agent:other": { sessionId: "sess-discovered-other", updatedAt: 1 },
      });
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      const fallbackStore = {
        "agent:retired-agent:main": { sessionId: "sess-fallback", updatedAt: 99 },
      };

      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:retired-agent:main",
        store: fallbackStore,
      });

      expect(target.storePath).toBe(path.resolve(retiredStorePath));
      expect(target.store).toHaveProperty("agent:retired-agent:other");
      expect(target.store).not.toHaveProperty("agent:retired-agent:main");
    });
  });

  test("resolveGatewaySessionStoreTarget finds a retired agent's row under another configured agent's template root", async () => {
    await withStateDirEnv("session-utils-retired-cross-root-", async ({ tempRoot }) => {
      const storesRoot = path.join(tempRoot, "stores");
      const retiredStorePath = path.join(
        storesRoot,
        "work",
        "agents",
        "old",
        "sessions",
        "sessions.json",
      );
      await seedSessionEntries(retiredStorePath, {
        "agent:old:main": { sessionId: "sess-retired-cross-root", updatedAt: 1 },
      });
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(
            storesRoot,
            "{agentId}",
            "agents",
            "{agentId}",
            "sessions",
            "sessions.json",
          ),
        },
        agents: { list: [{ id: "ops", default: true }, { id: "work" }] },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:old:main",
      });

      expect(target.storePath).toBe(path.resolve(retiredStorePath));
      expect(target.store["agent:old:main"]?.sessionId).toBe("sess-retired-cross-root");
    });
  });

  test("resolveGatewaySessionStoreTarget ignores a retired legacy store without provisioning SQLite", async () => {
    await withStateDirEnv("session-utils-retired-legacy-", async ({ stateDir }) => {
      const retiredSessionsDir = path.join(stateDir, "agents", "retired", "sessions");
      const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
      fs.mkdirSync(retiredSessionsDir, { recursive: true });
      fs.writeFileSync(
        retiredStorePath,
        JSON.stringify({
          "agent:retired:main": { sessionId: "sess-retired-legacy", updatedAt: 1 },
        }),
        "utf8",
      );
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:retired:main",
      });

      expect(target.storePath).toBe(retiredStorePath);
      expect(target.store).toEqual({});
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(retiredStorePath, {
        agentId: "retired",
      }).path;
      expect(sqlitePath).toBeDefined();
      expect(fs.existsSync(sqlitePath!)).toBe(false);
      expect(fs.readdirSync(retiredSessionsDir)).toEqual(["sessions.json"]);
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

        expect(loaded.entry).toEqual({
          sessionId: "sess-main",
          updatedAt: 7,
          delivery: { kind: "none" },
        });
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadGatewaySessionEntryReadOnly does not materialize a missing configured agent", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-read-only-", async ({ stateDir }) => {
        const cfg = {
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }, { id: "missing" }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadGatewaySessionEntryReadOnly("agent:missing:main");

        expect(loaded.entry).toBeUndefined();
        expect(fs.existsSync(path.join(stateDir, "agents", "missing"))).toBe(false);
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadGatewaySessionEntryReadOnly clones only the selected row and direct children", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-exact-read-only-", async ({ stateDir }) => {
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const cfg = {
          session: { mainKey: "main", store: storePath },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        const parentKey = "agent:main:main";
        const childKey = "agent:main:child";
        const now = Date.now();
        await seedSessionEntries(storePath, {
          [parentKey]: { sessionId: "parent", updatedAt: now },
          [childKey]: { sessionId: "child", spawnedBy: parentKey, updatedAt: now + 1 },
          ...Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [
              `agent:main:unrelated-${index}`,
              { sessionId: `unrelated-${index}`, updatedAt: now + index + 2 },
            ]),
          ),
        });
        setRuntimeConfigSnapshot(cfg, cfg);
        expect(
          listSessionEntriesReadOnly({ agentId: "main", storePath }).map((item) => item.sessionKey),
        ).toContain(childKey);
        const cloneSpy = vi.spyOn(globalThis, "structuredClone");
        try {
          expect(loadGatewaySessionEntryReadOnly(childKey, { clone: false }).entry).toMatchObject({
            sessionId: "child",
            spawnedBy: parentKey,
          });
          expect(
            listSessionChildEntriesReadOnly({
              agentId: "main",
              clone: false,
              sessionKey: parentKey,
              storePath,
            }).map((item) => item.sessionKey),
          ).toEqual([childKey]);
          const loaded = loadGatewaySessionEntryReadOnly("main", {
            includeStoreChildEntries: true,
          });

          expect(loaded.entry?.sessionId).toBe("parent");
          expect(Object.keys(loaded.store).toSorted()).toEqual([childKey, parentKey]);
          expect(loaded.entry).not.toBe(loaded.store[parentKey]);
          expect(cloneSpy).toHaveBeenCalledTimes(1);
        } finally {
          cloneSpy.mockRestore();
        }
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("single-row child candidates reuse stable entry identities across sparse stores", () => {
    const parentKey = "agent:main:main";
    let spawnedByReads = 0;
    const parent = { sessionId: "parent", updatedAt: 1 } as SessionEntry;
    const child = {
      sessionId: "child",
      updatedAt: Date.now(),
      get spawnedBy() {
        spawnedByReads += 1;
        return parentKey;
      },
    } as SessionEntry;
    const storePath = "/tmp/openclaw-single-row-child-cache";

    const first = buildSingleRowStoreChildSessionsByKey({
      store: { [parentKey]: parent, "agent:main:child": child },
      storePath,
      key: parentKey,
      now: Date.now(),
    });
    const second = buildSingleRowStoreChildSessionsByKey({
      store: { [parentKey]: parent, "agent:main:child": child },
      storePath,
      key: parentKey,
      now: Date.now(),
    });

    expect(first.get(parentKey)).toEqual(["agent:main:child"]);
    expect(second.get(parentKey)).toEqual(["agent:main:child"]);
    expect(spawnedByReads).toBe(1);
  });

  test("loadGatewaySessionEntryReadOnly rejects a persisted main alias", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-exact-alias-children-", async ({ stateDir }) => {
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const cfg = {
          session: { mainKey: "work", store: storePath },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        const legacyParentKey = "agent:main:main";
        const childKey = "agent:main:child";
        const now = Date.now();
        await seedSessionEntries(storePath, {
          [legacyParentKey]: { sessionId: "parent", updatedAt: now },
          [childKey]: {
            sessionId: "child",
            spawnedBy: legacyParentKey,
            updatedAt: now + 1,
          },
        });
        setRuntimeConfigSnapshot(cfg, cfg);

        expect(() =>
          loadGatewaySessionEntryReadOnly("main", {
            clone: false,
            includeStoreChildEntries: true,
          }),
        ).toThrow("openclaw doctor --fix");
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

  test("loadSessionEntry rejects deleted main aliases when mainKey is customized", async () => {
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

        expect(() => loadSessionEntry("agent:main:work")).toThrow("openclaw doctor --fix");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry keeps the configured canonical store authoritative", async () => {
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

  test("resolveCanonicalGatewaySessionStoreKey rejects legacy aliases", () => {
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

    expect(() =>
      resolveCanonicalGatewaySessionStoreKey({
        cfg,
        key: "agent:ops:main",
        store,
      }),
    ).toThrow("openclaw doctor --fix");
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

  test("listAgentsForGateway preserves canonical roster kinds", async () => {
    await withStateDirEnv("openclaw-agent-list-kinds-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "openclaw"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "research"), { recursive: true });

      const result = listAgentsForGateway({}, undefined, { includeSystem: true });

      expect(result.agents.map(({ id, kind }) => ({ id, kind }))).toEqual([
        { id: "main", kind: "agent" },
        { id: "openclaw", kind: "system" },
        { id: "research", kind: "agent" },
      ]);
    });
  });

  test("listAgentsForGateway keeps system agents out of the legacy response", async () => {
    await withStateDirEnv("openclaw-agent-list-legacy-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "openclaw"), { recursive: true });

      const agents = listAgentsForGateway({}).agents;
      expect(agents.map((agent) => agent.id)).toEqual(["main"]);
      expect(agents[0]).not.toHaveProperty("kind");
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
      cloudPlacementSupported: false,
      devicePlacementSupported: false,
      source: "implicit",
    });
  });

  test("listAgentsForGateway projects a profile-qualified default as canonical model identity", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.6-sol@openai:setup-fake",
            fallbacks: ["anthropic/claude-sonnet-4-6@anthropic:backup"],
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const catalog = [
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        reasoning: true,
      },
    ];

    const result = listAgentsForGateway(cfg, catalog);
    const defaults = getSessionDefaults(cfg, catalog);

    expect(result.agents[0]?.model).toEqual({
      primary: "openai/gpt-5.6-sol",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(result.agents[0]?.thinkingLevels).toEqual(defaults.thinkingLevels);
    expect(result.agents[0]?.thinkingDefault).toBe(defaults.thinkingDefault);
  });

  test.each([
    ["custom/vertex-ai_claude-haiku-4-5@20251001", "custom/vertex-ai_claude-haiku-4-5@20251001"],
    [
      "custom/vertex-ai_claude-haiku-4-5@20251001@custom:setup-fake",
      "custom/vertex-ai_claude-haiku-4-5@20251001",
    ],
    ["lmstudio/gemma-4-31b-it@q8_0", "lmstudio/gemma-4-31b-it@q8_0"],
    ["lmstudio/gemma-4-31b-it@q8_0@lmstudio:setup-fake", "lmstudio/gemma-4-31b-it@q8_0"],
  ])("listAgentsForGateway preserves model-owned @ suffixes in %s", (primary, expected) => {
    const cfg = {
      agents: {
        defaults: { model: { primary } },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    expect(listAgentsForGateway(cfg).agents[0]?.model?.primary).toBe(expected);
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
      cloudPlacementSupported: false,
      devicePlacementSupported: false,
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
    setTestActivePluginRegistry(registry);

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
        list: [{ id: "main", default: true }, { id: "work" }, { id: "missing" }],
      },
    } as OpenClawConfig;
    const catalogEntry = {
      provider: "local",
      id: "custom-reasoner",
      name: "Custom Reasoner",
    };
    const disabledCatalog = [{ ...catalogEntry, reasoning: false }];
    const enabledCatalog = [{ ...catalogEntry, reasoning: true }];

    const result = listAgentsForGateway(cfg, disabledCatalog, {
      modelCatalogByAgentId: new Map([
        ["main", disabledCatalog],
        ["work", enabledCatalog],
        ["missing", undefined],
      ]),
    });
    const agentsById = new Map(result.agents.map((agent) => [agent.id, agent]));

    expect(agentsById.get("main")?.thinkingLevels?.map((level) => level.id)).toEqual(["off"]);
    expect(agentsById.get("work")?.thinkingDefault).toBe("medium");
    expect(agentsById.get("work")?.thinkingLevels?.map((level) => level.id)).toContain("medium");
    expect(agentsById.get("missing")?.thinkingLevels?.map((level) => level.id)).toContain("high");
  });

  describe("listAgentsForGateway resolved model projection", () => {
    test("publishes one resolved identity for model, runtime, and thinking capabilities", () => {
      const cfg = {
        agents: {
          defaults: {
            model: {
              primary: "clawrouter/openai/gpt-5.6",
              fallbacks: ["openai/gpt-5.6-luna"],
            },
            models: {
              "openai/gpt-5.6-sol": {
                alias: "clawrouter/openai/gpt-5.6",
                agentRuntime: { id: "codex" },
              },
            },
          },
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;
      const catalog = [
        {
          provider: "openai",
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          reasoning: true,
        },
      ];

      const agent = listAgentsForGateway(cfg, catalog).agents[0];

      expect(agent).toMatchObject({
        model: {
          primary: "openai/gpt-5.6-sol",
          fallbacks: ["openai/gpt-5.6-luna"],
        },
        agentRuntime: { id: "codex", source: "model" },
        thinkingDefault: "medium",
      });
      expect(agent?.thinkingLevels?.map((level) => level.id)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
      ]);
      expect(agent?.thinkingOptions).toEqual(agent?.thinkingLevels?.map((level) => level.label));
    });
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
          totalTokensVersion: 1,
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
      expect(listed.sessions[0]?.agentRuntime).toEqual({
        id: "codex",
        cloudPlacementSupported: false,
        devicePlacementSupported: false,
        source: "implicit",
      });
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

  test("searches a selected agent's global row in an ownerless explicit fleet", () => {
    const now = Date.now();
    const result = listSessionsFromStore({
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { model: { primary: "openai/gpt-5.4" } },
          entries: {
            main: { model: { primary: "openai/gpt-5.4" } },
            work: { model: { primary: "anthropic/claude-opus-4-6" } },
          },
        },
      } as OpenClawConfig,
      storePath: "/tmp/sessions.json",
      store: {
        global: { sessionId: "global", updatedAt: now } as SessionEntry,
      },
      opts: { agentId: "work", includeGlobal: true, search: "claude-opus" },
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: "global",
      agentId: "work",
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
      cloudPlacementSupported: false,
      devicePlacementSupported: false,
      source: "model",
    });
  });

  test("ignores bare CLI runtime metadata when the selected default differs", () => {
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

    expect(result.sessions[0]?.modelProvider).toBe("openai");
    expect(result.sessions[0]?.model).toBe("gpt-5.4");
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

  test("uses selected defaults before persisted runtime model metadata", () => {
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

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-sonnet-4-6");
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

  test("leaves a failed dashboard thread untitled so the UI can render New thread", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: new Date("2024-03-15T10:30:00Z").getTime(),
    } as SessionEntry;

    expect(deriveSessionTitle(entry)).toBeUndefined();
    expect(deriveSessionTitle(entry, "")).toBeUndefined();
    expect(deriveSessionTitle(entry, "   ")).toBeUndefined();
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
  const createModelCatalogSnapshot = (params: {
    agentId?: string;
    catalogComplete?: boolean;
    config?: OpenClawConfig;
    entries?: GatewayModelCatalogSnapshot["entries"];
    staticEntries?: GatewayModelCatalogSnapshot["staticEntries"];
  }): GatewayModelCatalogSnapshot => ({
    agentId: params.agentId ?? "main",
    agentDir: "/tmp/gateway-model-capability-agent",
    workspaceDir: "/tmp/gateway-model-capability-workspace",
    catalogComplete: params.catalogComplete ?? false,
    config: params.config ?? {},
    entries: params.entries ?? [],
    routeVariants: [],
    ...(params.staticEntries ? { staticEntries: params.staticEntries } : {}),
  });

  test("uses prepared Sol capabilities without starting full catalog discovery", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => []);
    const preparedSnapshot = createModelCatalogSnapshot({
      agentId: "qa",
      staticEntries: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          input: ["text", "image"],
        },
      ],
    });
    const loadGatewayModelCatalogSnapshot = vi.fn(async (params?: { readOnly?: boolean }) => {
      if (params?.readOnly !== true) {
        throw new Error("full catalog discovery must not start during attachment admission");
      }
      return preparedSnapshot;
    });

    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.6-sol",
        provider: "openai",
        loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot,
      }),
    ).resolves.toBe(true);
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({
      agentId: "qa",
      readOnly: true,
    });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  test("falls back to live discovery for models absent from the prepared catalog", async () => {
    const loadGatewayModelCatalogSnapshot = vi.fn(async (params?: { readOnly?: boolean }) =>
      createModelCatalogSnapshot({
        agentId: "qa",
        entries: params?.readOnly
          ? []
          : [
              {
                id: "vendor/runtime-vision-model",
                name: "Runtime Vision Model",
                provider: "openrouter",
                input: ["text", "image"],
              },
            ],
      }),
    );

    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "vendor/runtime-vision-model",
        provider: "openrouter",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot,
      }),
    ).resolves.toBe(true);
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(1, {
      agentId: "qa",
      readOnly: true,
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(2, {
      agentId: "qa",
      readOnly: false,
    });
  });

  test("falls back to live discovery for provisional prepared text-only metadata", async () => {
    const loadGatewayModelCatalogSnapshot = vi.fn(async (params?: { readOnly?: boolean }) =>
      createModelCatalogSnapshot({
        agentId: "qa",
        entries: [
          {
            id: "vendor/runtime-vision-model",
            name: "Runtime Vision Model",
            provider: "openrouter",
            input: params?.readOnly ? ["text"] : ["text", "image"],
          },
        ],
      }),
    );

    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "vendor/runtime-vision-model",
        provider: "openrouter",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot,
      }),
    ).resolves.toBe(true);
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(1, {
      agentId: "qa",
      readOnly: true,
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(2, {
      agentId: "qa",
      readOnly: false,
    });
  });

  test("does not restart discovery for authoritative text-only metadata from a full owner", async () => {
    const catalogReadModes: Array<boolean | undefined> = [];
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "vendor/runtime-text-model",
        provider: "openrouter",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async (params) => {
          catalogReadModes.push(params?.readOnly);
          if (params?.readOnly !== true) {
            throw new Error("full catalog discovery must not restart for a complete owner");
          }
          return createModelCatalogSnapshot({
            agentId: "qa",
            catalogComplete: true,
            entries: [
              {
                id: "vendor/runtime-text-model",
                name: "Runtime Text Model",
                provider: "openrouter",
                input: ["text"],
              },
            ],
          });
        },
      }),
    ).resolves.toBe(false);
    expect(catalogReadModes).toEqual([true]);
  });

  test("does not restart discovery when a full owner authoritatively omits the model", async () => {
    const catalogReadModes: Array<boolean | undefined> = [];
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "vendor/missing-model",
        provider: "openrouter",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async (params) => {
          catalogReadModes.push(params?.readOnly);
          if (params?.readOnly !== true) {
            throw new Error("full catalog discovery must not restart for a complete owner");
          }
          return createModelCatalogSnapshot({
            agentId: "qa",
            catalogComplete: true,
            entries: [],
          });
        },
      }),
    ).resolves.toBe(false);
    expect(catalogReadModes).toEqual([true]);
  });

  test("repairs a stale visible text-only row with same-agent provider-static vision", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            entries: [{ id: "gpt-5.4", name: "Text only", provider: "openai", input: ["text"] }],
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(true);
  });

  test("repairs missing visible input metadata with same-agent provider-static vision", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            entries: [{ id: "gpt-5.4", name: "Stale model", provider: "openai" }],
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(true);
  });

  test("does not borrow another agent's provider-static image capabilities", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "other",
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test("does not override an explicitly configured text-only model with provider-static vision", async () => {
    const catalogReadModes: Array<boolean | undefined> = [];
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async (params) => {
          catalogReadModes.push(params?.readOnly);
          return createModelCatalogSnapshot({
            agentId: "qa",
            config: {
              models: {
                providers: {
                  openai: {
                    baseUrl: "https://api.openai.com/v1",
                    models: [
                      {
                        id: "gpt-5.4",
                        name: "Text only",
                        reasoning: false,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 128_000,
                        maxTokens: 4_096,
                      },
                    ],
                  },
                },
              },
            },
            entries: [
              {
                id: "gpt-5.4",
                name: "Configured text only",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
                input: ["text"],
              },
            ],
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
                input: ["text", "image"],
              },
            ],
          });
        },
      }),
    ).resolves.toBe(false);
    expect(catalogReadModes).toEqual([true]);
  });

  test("does not borrow provider-static image capabilities across configured routes", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            config: {
              models: {
                providers: {
                  openai: {
                    baseUrl: "https://custom.example.test/v1",
                    models: [],
                  },
                },
              },
            },
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test.each([
    {
      route: "API",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      route: "base URL",
      api: "openai-responses",
      baseUrl: "https://custom.example.test/v1",
    },
  ] as const)(
    "does not borrow provider-static vision across a mismatched visible $route",
    async ({ api, baseUrl }) => {
      await expect(
        resolveGatewayModelSupportsImages({
          agentId: "qa",
          model: "gpt-5.4",
          provider: "openai",
          loadGatewayModelCatalog: async () => [],
          loadGatewayModelCatalogSnapshot: async () =>
            createModelCatalogSnapshot({
              agentId: "qa",
              entries: [
                {
                  id: "gpt-5.4",
                  name: "Custom route",
                  provider: "openai",
                  api,
                  baseUrl,
                  input: ["text"],
                },
              ],
              staticEntries: [
                {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  provider: "openai",
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  input: ["text", "image"],
                },
              ],
            }),
        }),
      ).resolves.toBe(false);
    },
  );

  test.each([
    {
      route: "visible API",
      visibleRoute: {
        api: "openai-completions" as const,
        baseUrl: "https://api.openai.com/v1",
      },
      configuredRoute: undefined,
      staticRoute: { baseUrl: "https://api.openai.com/v1" },
    },
    {
      route: "visible base URL",
      visibleRoute: {
        api: "openai-responses" as const,
        baseUrl: "https://custom.example.test/v1",
      },
      configuredRoute: undefined,
      staticRoute: { api: "openai-responses" as const },
    },
    {
      route: "configured API",
      visibleRoute: undefined,
      configuredRoute: {
        api: "openai-completions" as const,
        baseUrl: "https://api.openai.com/v1",
      },
      staticRoute: { baseUrl: "https://api.openai.com/v1" },
    },
    {
      route: "configured base URL",
      visibleRoute: undefined,
      configuredRoute: { baseUrl: "https://custom.example.test/v1" },
      staticRoute: { api: "openai-responses" as const },
    },
  ])(
    "does not borrow provider-static vision when its $route provenance is missing",
    async ({ visibleRoute, configuredRoute, staticRoute }) => {
      await expect(
        resolveGatewayModelSupportsImages({
          agentId: "qa",
          model: "gpt-5.4",
          provider: "openai",
          loadGatewayModelCatalog: async () => [],
          loadGatewayModelCatalogSnapshot: async () =>
            createModelCatalogSnapshot({
              ...(configuredRoute
                ? {
                    config: {
                      models: {
                        providers: {
                          openai: {
                            baseUrl: configuredRoute.baseUrl,
                            ...("api" in configuredRoute ? { api: configuredRoute.api } : {}),
                            models: [],
                          },
                        },
                      },
                    },
                  }
                : {}),
              agentId: "qa",
              entries: visibleRoute
                ? [
                    {
                      id: "gpt-5.4",
                      name: "Text only",
                      provider: "openai",
                      input: ["text"],
                      ...visibleRoute,
                    },
                  ]
                : [],
              staticEntries: [
                {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  provider: "openai",
                  input: ["text", "image"],
                  ...staticRoute,
                },
              ],
            }),
        }),
      ).resolves.toBe(false);
    },
  );

  test("does not borrow provider-static image capabilities from another provider", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "Other provider vision",
                provider: "other",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test("fails closed on providerless provider-static image capabilities", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "shared-vision",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            staticEntries: [
              {
                id: "shared-vision",
                name: "First provider vision",
                provider: "first",
                input: ["text", "image"],
              },
              {
                id: "shared-vision",
                name: "Second provider vision",
                provider: "second",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test("fails closed without using a stale catalog when the prepared snapshot fails", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        input: ["text", "image"] as ("text" | "image")[],
      },
    ]);

    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot: async () => {
          throw new Error("prepared catalog unavailable");
        },
      }),
    ).resolves.toBe(false);
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
