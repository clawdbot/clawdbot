/**
 * Tests single-row session cache behavior in gateway session utilities.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveStorePath,
  saveSessionStore,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";

const subagentRegistryReadMock = vi.hoisted(() => {
  let runsByChildSessionKey = new Map<string, Record<string, unknown>>();
  const buildSubagentRunReadIndex = vi.fn(() => {
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
      getDisplaySubagentRun: vi.fn(
        (childSessionKey: string) => runsByChildSessionKey.get(childSessionKey) ?? null,
      ),
      countActiveDescendantRuns: vi.fn(() => 0),
    };
  });
  return {
    buildSubagentRunReadIndex,
    countActiveDescendantRuns: vi.fn(() => 0),
    getSessionDisplaySubagentRunByChildSessionKey: vi.fn(
      (childSessionKey: string) => runsByChildSessionKey.get(childSessionKey) ?? null,
    ),
    getSubagentSessionRuntimeMs: vi.fn(() => undefined),
    getSubagentSessionStartedAt: vi.fn(() => undefined),
    isSubagentRunLive: vi.fn(() => false),
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

vi.mock("../agents/subagent-registry-read.js", () => subagentRegistryReadMock);

import {
  listSessionsFromStore,
  listSessionsFromStoreAsync,
  loadGatewaySessionRow,
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
      storePath: resolveStorePath(cfg.session?.store, { agentId: MAIN_AGENT_ID }),
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
  expect(subagentRegistryReadMock.buildSubagentRunReadIndex).not.toHaveBeenCalled();
}

describe("single gateway session row child-session cache", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
    subagentRegistryReadMock.setSubagentRunsForTest([]);
    vi.clearAllMocks();
  });

  test("shares the child-session index across repeated single-row loads for the same store", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-",
      "/tmp/openclaw-single-row-cache",
      async ({ now, storePath }) => {
        const store: Record<string, SessionEntry> = {
          "agent:main:subagent:parent-a": parentSession("parent-a", now),
          "agent:main:subagent:child-a": runningChildSession(
            "child-a",
            "agent:main:subagent:parent-a",
            now,
          ),
          "agent:main:subagent:parent-b": parentSession("parent-b", now),
          "agent:main:subagent:child-b": runningChildSession(
            "child-b",
            "agent:main:subagent:parent-b",
            now,
          ),
        };
        await saveSessionStore(storePath, store);

        const rowA = loadGatewaySessionRow("agent:main:subagent:parent-a", { now });
        const rowB = loadGatewaySessionRow("agent:main:subagent:parent-b", { now: now + 50 });
        const rowAAfterWindow = loadGatewaySessionRow("agent:main:subagent:parent-a", {
          now: now + 1_500,
        });

        expect(rowA?.childSessions).toEqual(["agent:main:subagent:child-a"]);
        expect(rowB?.childSessions).toEqual(["agent:main:subagent:child-b"]);
        expect(rowAAfterWindow?.childSessions).toEqual(["agent:main:subagent:child-a"]);
        expect(subagentRegistryReadMock.buildSubagentRunReadIndex).not.toHaveBeenCalled();
      },
    );
  });

  test("refreshes subagent registry state while reusing store child candidates", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-fresh-registry-",
      "/tmp/openclaw-single-row-cache-fresh-registry",
      async ({ now, storePath }) => {
        const fixture = createMovingChildFixture(now);
        await saveSessionStore(storePath, fixture.store);

        setSubagentControllerRun(fixture.child, fixture.oldParent, now);
        expect(loadGatewaySessionRow(fixture.oldParent, { now })?.childSessions).toEqual([
          fixture.child,
        ]);

        setSubagentControllerRun(fixture.child, fixture.newParent, now + 25);
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

        const syncListed = listSessionsFromStore({
          cfg,
          storePath,
          store,
          opts: { agentId: MAIN_AGENT_ID, limit: 1 },
        });

        expect(syncListed.sessions).toHaveLength(1);
        expect(subagentRegistryReadMock.buildSubagentRunReadIndex).toHaveBeenCalledTimes(1);
        expect(
          subagentRegistryReadMock.getSessionDisplaySubagentRunByChildSessionKey,
        ).not.toHaveBeenCalled();

        vi.clearAllMocks();

        const asyncListed = await listSessionsFromStoreAsync({
          cfg,
          storePath,
          store,
          opts: { agentId: MAIN_AGENT_ID, limit: 1 },
        });

        expect(asyncListed.sessions).toHaveLength(1);
        expect(subagentRegistryReadMock.buildSubagentRunReadIndex).toHaveBeenCalledTimes(1);
        expect(
          subagentRegistryReadMock.getSessionDisplaySubagentRunByChildSessionKey,
        ).not.toHaveBeenCalled();
      },
    );
  });

  test("rebuilds store child candidates after same-object session store writes", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-write-version-",
      "/tmp/openclaw-single-row-cache-write-version",
      async ({ now, storePath }) => {
        const fixture = createMovingChildFixture(now);
        await saveSessionStore(storePath, fixture.store);

        expect(loadGatewaySessionRow(fixture.oldParent, { now })?.childSessions).toEqual([
          fixture.child,
        ]);
        await updateSessionStore(
          storePath,
          (cachedStore) => {
            const childEntry = cachedStore[fixture.child];
            if (childEntry) {
              childEntry.parentSessionKey = fixture.newParent;
              childEntry.updatedAt = now + 25;
            }
          },
          { skipMaintenance: true, takeCacheOwnership: true },
        );

        expectChildMovedToNewParent(fixture, now);
      },
    );
  });
});
