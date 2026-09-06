/**
 * Tests fresh child state in exact session-row Gateway projections.
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";

const subagentRegistryReadMock = vi.hoisted(() => {
  let runsByChildSessionKey = new Map<string, Record<string, unknown>>();
  const buildSubagentSessionListReadIndex = vi.fn(() => {
    const runsByControllerSessionKey = new Map<string, Record<string, unknown>[]>();
    for (const entry of runsByChildSessionKey.values()) {
      const controllerSessionKey =
        typeof entry.controllerSessionKey === "string"
          ? entry.controllerSessionKey
          : typeof entry.requesterSessionKey === "string"
            ? entry.requesterSessionKey
            : undefined;
      if (!controllerSessionKey) {
        continue;
      }
      const runs = runsByControllerSessionKey.get(controllerSessionKey) ?? [];
      runs.push(entry);
      runsByControllerSessionKey.set(controllerSessionKey, runs);
    }
    return {
      runsByControllerSessionKey,
      swarmRunsByRequesterSessionKey: new Map(),
      getDisplaySubagentRun: vi.fn(
        (childSessionKey: string) => runsByChildSessionKey.get(childSessionKey) ?? null,
      ),
      countActiveDescendantRuns: vi.fn(() => 0),
    };
  });
  return {
    buildSubagentSessionListReadIndex,
    countActiveDescendantRuns: vi.fn(() => 0),
    getSessionDisplaySubagentRunByChildSessionKey: vi.fn(
      (childSessionKey: string) => runsByChildSessionKey.get(childSessionKey) ?? null,
    ),
    getSubagentSessionRuntimeMs: vi.fn(() => undefined),
    getSubagentSessionStartedAt: vi.fn(() => undefined),
    isSubagentRunLive: vi.fn(() => false),
    isSubagentRunQueued: vi.fn(() => false),
    listSubagentRunsForController: vi.fn((controllerSessionKey: string) =>
      [...runsByChildSessionKey.values()].filter((entry) => {
        const controller =
          typeof entry.controllerSessionKey === "string"
            ? entry.controllerSessionKey
            : typeof entry.requesterSessionKey === "string"
              ? entry.requesterSessionKey
              : undefined;
        return controller === controllerSessionKey;
      }),
    ),
    resolveSubagentSessionStatus: vi.fn(() => undefined),
    setSubagentRunsForTest: (runs: Record<string, unknown>[]) => {
      runsByChildSessionKey = new Map(
        runs
          .filter((entry) => typeof entry.childSessionKey === "string")
          .map((entry) => [entry.childSessionKey as string, entry]),
      );
    },
  };
});

vi.mock("../agents/subagents/registry/subagent-registry-read.js", () => subagentRegistryReadMock);

import { listSessionFixture } from "./session-list.test-support.js";
import {
  buildGatewaySessionInfo,
  loadGatewaySessionEntryReadOnly,
  loadGatewaySessionLifecycleSnapshot,
  loadGatewaySessionRow,
  loadSessionEntry,
} from "./session-utils.js";

const MAIN_AGENT_ID = "main";
const TEST_MODEL = "openai/gpt-5.4";

type SingleRowCacheContext = {
  now: number;
  storePath: string;
};

type MovingChildFixture = {
  oldParent: string;
  newParent: string;
  child: string;
  store: Record<string, SessionEntry>;
};

async function withSingleRowCacheStore(
  statePrefix: string,
  workspace: string,
  run: (context: SingleRowCacheContext) => Promise<void>,
): Promise<void> {
  await withStateDirEnv(statePrefix, async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: MAIN_AGENT_ID,
            default: true,
            workspace,
          },
        ],
        defaults: { model: { primary: TEST_MODEL } },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    await run({
      now: Math.floor(Date.now() / 1_000) * 1_000 + 100,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: MAIN_AGENT_ID }),
    });
  });
}

function parentSession(sessionId: string, now: number): SessionEntry {
  return {
    sessionId,
    updatedAt: now,
  };
}

function runningChildSession(
  sessionId: string,
  parentSessionKey: string,
  now: number,
): SessionEntry {
  return {
    sessionId,
    parentSessionKey,
    updatedAt: now,
    status: "running",
  };
}

function runningControlledChildSession(
  sessionId: string,
  spawnedBy: string,
  now: number,
  parentSessionKey?: string,
): SessionEntry {
  return {
    sessionId,
    spawnedBy,
    ...(parentSessionKey ? { parentSessionKey } : {}),
    updatedAt: now,
    status: "running",
  };
}

async function seedSessionEntries(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(store)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  }
}

function setSubagentControllerRun(
  childSessionKey: string,
  controllerSessionKey: string,
  createdAt: number,
): void {
  subagentRegistryReadMock.setSubagentRunsForTest([
    {
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      createdAt,
      execution: { status: "running", startedAt: createdAt },
    },
  ]);
}

function createMovingChildFixture(now: number): MovingChildFixture {
  const oldParent = "agent:main:subagent:parent-old";
  const newParent = "agent:main:subagent:parent-new";
  const child = "agent:main:subagent:child";
  return {
    oldParent,
    newParent,
    child,
    store: {
      [oldParent]: parentSession("parent-old", now),
      [newParent]: parentSession("parent-new", now),
      [child]: runningChildSession("child", oldParent, now),
    },
  };
}

function expectChildMovedToNewParent(fixture: MovingChildFixture, now: number): void {
  expect(
    loadGatewaySessionRow(fixture.oldParent, { now: now + 50 })?.childSessions,
  ).toBeUndefined();
  expect(loadGatewaySessionRow(fixture.newParent, { now: now + 50 })?.childSessions).toEqual([
    fixture.child,
  ]);
  expect(subagentRegistryReadMock.buildSubagentSessionListReadIndex).not.toHaveBeenCalled();
}

describe("single gateway session row child projections", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
    subagentRegistryReadMock.setSubagentRunsForTest([]);
    vi.clearAllMocks();
  });

  test("retains the loaded owner after a qualified main alias becomes global", async () => {
    await withStateDirEnv("openclaw-single-row-global-owner-", async () => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: {
          entries: {
            main: { default: true, model: { primary: "openai/gpt-5.4" } },
            research: { model: { primary: "openai/gpt-5.5" } },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      await replaceSessionEntry(
        { agentId: "research", sessionKey: "global" },
        { sessionId: "research-main", updatedAt: 42 },
      );
      const key = "agent:research:main";
      expect(loadGatewaySessionEntryReadOnly(key)).toMatchObject({
        agentId: "research",
        canonicalKey: "global",
        entry: { sessionId: "research-main" },
      });
      expect.soft(loadGatewaySessionLifecycleSnapshot(key).row).toMatchObject({
        key: "global",
        sessionId: "research-main",
        agentId: "research",
        model: "gpt-5.5",
      });
      expect(loadGatewaySessionRow(key, { agentId: "research" })).toMatchObject({
        key: "global",
        agentId: "research",
        model: "gpt-5.5",
      });
    });
  });

  test.each([undefined, false])(
    "reads only the selected session while preserving projections and hidden effects (clone: %s)",
    async (clone) => {
      await withSingleRowCacheStore(
        "openclaw-single-row-hidden-effects-",
        "/tmp/openclaw-single-row-hidden-effects",
        async ({ now, storePath }) => {
          const hidden = resolveInternalSessionEffectsIdentity({
            agentId: MAIN_AGENT_ID,
            runId: "suppressed-effects",
          });
          const sessionKey = "agent:main:main";
          const visible: SessionEntry = {
            ...parentSession("visible-session", now),
            skillsSnapshot: { prompt: "saved skill prompt", skills: [] },
            systemPromptReport: {
              source: "run",
              generatedAt: now,
              systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
              injectedWorkspaceFiles: [],
              skills: { promptChars: 0, entries: [] },
              tools: { listChars: 0, schemaChars: 0, entries: [] },
            },
          };
          await seedSessionEntries(storePath, {
            [sessionKey]: visible,
            [hidden.sessionKey]: parentSession(hidden.sessionId, now),
            ...Object.fromEntries(
              Array.from({ length: 24 }, (_, index) => [
                `agent:main:unrelated-${index}`,
                { ...visible, sessionId: `unrelated-session-${index}` },
              ]),
            ),
          });

          // The canonical store scan belongs to handle admission, before repeated row lookups.
          expect(loadExactSessionEntryReadOnly({ sessionKey, storePath })?.entry.sessionId).toBe(
            visible.sessionId,
          );
          const parse = vi.spyOn(JSON, "parse");
          try {
            const metadata = loadSessionEntry("main", {
              agentId: MAIN_AGENT_ID,
              clone,
              projection: "list",
            });
            expect(metadata).toMatchObject({
              agentId: MAIN_AGENT_ID,
              canonicalKey: sessionKey,
              storePath,
              entry: parentSession(visible.sessionId, now),
            });
            expect(metadata.entry?.skillsSnapshot).toBeUndefined();
            expect(metadata.entry?.systemPromptReport).toBeUndefined();
            expect(parse.mock.calls.some(([value]) => value.includes("saved skill prompt"))).toBe(
              false,
            );
            expect(loadSessionEntry("main", { agentId: MAIN_AGENT_ID, clone })).toMatchObject({
              agentId: metadata.agentId,
              canonicalKey: metadata.canonicalKey,
              storePath: metadata.storePath,
              entry: visible,
            });

            expect(loadSessionEntry(hidden.sessionKey, { clone }).entry).toBeUndefined();
            expect(
              loadSessionEntry(hidden.sessionKey, { clone, projection: "list" }).entry,
            ).toBeUndefined();
            expect(loadGatewaySessionEntryReadOnly(hidden.sessionKey).entry?.sessionId).toBe(
              hidden.sessionId,
            );
            expect(loadExactSessionEntryReadOnly({ ...hidden, storePath })?.entry.sessionId).toBe(
              hidden.sessionId,
            );
            expect(
              parse.mock.calls.filter(
                ([value]) => typeof value === "string" && value.includes("unrelated-session-"),
              ),
            ).toHaveLength(0);
          } finally {
            parse.mockRestore();
          }
        },
      );
    },
  );

  test("preserves missing-store behavior for borrowed and owned entry lookups", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-missing-store-",
      "/tmp/openclaw-single-row-missing-store",
      async () => {
        const databasePath = resolveOpenClawAgentSqlitePath({ agentId: MAIN_AGENT_ID });
        expect(loadSessionEntry("main", { clone: false }).entry).toBeUndefined();
        expect(existsSync(databasePath)).toBe(false);
        expect(loadSessionEntry("main").entry).toBeUndefined();
        expect(existsSync(databasePath)).toBe(true);
      },
    );
  });

  test("keeps direct children visible with at most one candidate scan per exact snapshot", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-",
      "/tmp/openclaw-single-row-cache",
      async ({ now, storePath }) => {
        const store: Record<string, SessionEntry> = {
          "agent:main:subagent:parent-a": parentSession("parent-a", now),
          "agent:main:subagent:child-a": {
            ...runningChildSession("child-a", "agent:main:subagent:parent-a", now),
            skillsSnapshot: { prompt: "child saved skill prompt", skills: [] },
          },
          "agent:main:subagent:parent-b": parentSession("parent-b", now),
          "agent:main:subagent:child-b": runningChildSession(
            "child-b",
            "agent:main:subagent:parent-b",
            now,
          ),
        };
        await seedSessionEntries(storePath, store);

        const rowA = loadGatewaySessionRow("agent:main:subagent:parent-a", { now });
        const rowB = loadGatewaySessionRow("agent:main:subagent:parent-b", { now: now + 50 });
        const rowAAfterWindow = loadGatewaySessionRow("agent:main:subagent:parent-a", {
          now: now + 1_500,
        });

        expect(rowA?.childSessions).toEqual(["agent:main:subagent:child-a"]);
        expect(rowB?.childSessions).toEqual(["agent:main:subagent:child-b"]);
        expect(rowAAfterWindow?.childSessions).toEqual(["agent:main:subagent:child-a"]);
        for (let index = 0; index < 2; index += 1) {
          const loaded = loadGatewaySessionEntryReadOnly("agent:main:subagent:parent-a", {
            clone: false,
            includeStoreChildEntries: true,
            projection: "list",
          });
          expect(loaded.store["agent:main:subagent:child-a"]?.skillsSnapshot).toBeUndefined();
          const entriesSpy = vi.spyOn(Object, "entries");
          try {
            const row = buildGatewaySessionInfo({ ...loaded, key: loaded.canonicalKey, now });
            expect(row.childSessions).toEqual(["agent:main:subagent:child-a"]);
            expect(
              entriesSpy.mock.calls.filter(([value]) => value === loaded.store).length,
            ).toBeLessThanOrEqual(1);
          } finally {
            entriesSpy.mockRestore();
          }
        }
        expect(subagentRegistryReadMock.buildSubagentSessionListReadIndex).not.toHaveBeenCalled();
      },
    );
  });

  test("refreshes subagent registry control on each projection", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-fresh-registry-",
      "/tmp/openclaw-single-row-cache-fresh-registry",
      async ({ now, storePath }) => {
        const fixture = createMovingChildFixture(now);
        // This fixture moves runtime control only; an explicit parent would
        // instead declare durable navigation lineage that must remain linked.
        fixture.store[fixture.child] = runningControlledChildSession(
          "child",
          fixture.oldParent,
          now,
        );
        await seedSessionEntries(storePath, fixture.store);

        setSubagentControllerRun(fixture.child, fixture.oldParent, now);
        expect(loadGatewaySessionRow(fixture.oldParent, { now })?.childSessions).toEqual([
          fixture.child,
        ]);

        setSubagentControllerRun(fixture.child, fixture.newParent, now + 25);
        expectChildMovedToNewParent(fixture, now);
      },
    );
  });

  test("keeps independent navigation lineage while runtime control moves", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-navigation-owner-",
      "/tmp/openclaw-single-row-cache-navigation-owner",
      async ({ now, storePath }) => {
        const fixture = createMovingChildFixture(now);
        const navigationParent = "agent:main:dashboard:navigation-parent";
        fixture.store[navigationParent] = parentSession("navigation-parent", now);
        fixture.store[fixture.child] = runningControlledChildSession(
          "child",
          fixture.oldParent,
          now,
          navigationParent,
        );
        await seedSessionEntries(storePath, fixture.store);

        setSubagentControllerRun(fixture.child, fixture.oldParent, now);
        expect(loadGatewaySessionRow(navigationParent, { now })?.childSessions).toEqual([
          fixture.child,
        ]);

        setSubagentControllerRun(fixture.child, fixture.newParent, now + 25);
        expect(loadGatewaySessionRow(navigationParent, { now: now + 50 })?.childSessions).toEqual([
          fixture.child,
        ]);
        expectChildMovedToNewParent(fixture, now);
      },
    );
  });

  test("builds shared subagent metadata context for single-row session lists", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-list-context-",
      "/tmp/openclaw-single-row-list-context",
      async ({ now, storePath }) => {
        const store: Record<string, SessionEntry> = {
          "agent:main:discord:channel:parent": parentSession("parent", now),
        };
        const cfg: OpenClawConfig = {
          agents: {
            list: [
              {
                id: MAIN_AGENT_ID,
                default: true,
                workspace: "/tmp/openclaw-single-row-list-context",
              },
            ],
            defaults: { model: { primary: TEST_MODEL } },
          },
        } as OpenClawConfig;

        const asyncListed = await listSessionFixture({
          cfg,
          storePath,
          store,
          opts: { agentId: MAIN_AGENT_ID, limit: 1 },
        });

        expect(asyncListed.sessions).toHaveLength(1);
        expect(subagentRegistryReadMock.buildSubagentSessionListReadIndex).toHaveBeenCalledTimes(1);
        expect(
          subagentRegistryReadMock.getSessionDisplaySubagentRunByChildSessionKey,
        ).not.toHaveBeenCalled();
      },
    );
  });

  test("refreshes store child candidates after session writes", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-write-version-",
      "/tmp/openclaw-single-row-cache-write-version",
      async ({ now, storePath }) => {
        const fixture = createMovingChildFixture(now);
        await seedSessionEntries(storePath, fixture.store);

        expect(loadGatewaySessionRow(fixture.oldParent, { now })?.childSessions).toEqual([
          fixture.child,
        ]);
        await updateSessionEntry({ sessionKey: fixture.child, storePath }, () => ({
          parentSessionKey: fixture.newParent,
          updatedAt: now + 25,
        }));

        expectChildMovedToNewParent(fixture, now);
      },
    );
  });
});
