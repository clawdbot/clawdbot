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

import { loadGatewaySessionRow } from "./session-utils.js";

describe("single gateway session row child-session cache", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
    subagentRegistryReadMock.setSubagentRunsForTest([]);
    vi.clearAllMocks();
  });

  test("shares the child-session index across repeated single-row loads for the same store", async () => {
    await withStateDirEnv("openclaw-single-row-cache-", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            {
              id: "main",
              default: true,
              workspace: "/tmp/openclaw-single-row-cache",
            },
          ],
          defaults: { model: { primary: "openai/gpt-5.4" } },
        },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);
      const now = Math.floor(Date.now() / 1_000) * 1_000 + 100;
      const store: Record<string, SessionEntry> = {
        "agent:main:subagent:parent-a": {
          sessionId: "parent-a",
          updatedAt: now,
        },
        "agent:main:subagent:child-a": {
          sessionId: "child-a",
          parentSessionKey: "agent:main:subagent:parent-a",
          updatedAt: now,
          status: "running",
        },
        "agent:main:subagent:parent-b": {
          sessionId: "parent-b",
          updatedAt: now,
        },
        "agent:main:subagent:child-b": {
          sessionId: "child-b",
          parentSessionKey: "agent:main:subagent:parent-b",
          updatedAt: now,
          status: "running",
        },
      };
      await saveSessionStore(resolveStorePath(cfg.session?.store, { agentId: "main" }), store);

      const rowA = loadGatewaySessionRow("agent:main:subagent:parent-a", { now });
      const rowB = loadGatewaySessionRow("agent:main:subagent:parent-b", { now: now + 50 });
      const rowAAfterWindow = loadGatewaySessionRow("agent:main:subagent:parent-a", {
        now: now + 1_500,
      });

      expect(rowA?.childSessions).toEqual(["agent:main:subagent:child-a"]);
      expect(rowB?.childSessions).toEqual(["agent:main:subagent:child-b"]);
      expect(rowAAfterWindow?.childSessions).toEqual(["agent:main:subagent:child-a"]);
      expect(subagentRegistryReadMock.buildSubagentRunReadIndex).not.toHaveBeenCalled();
    });
  });

  test("refreshes subagent registry state while reusing store child candidates", async () => {
    await withStateDirEnv("openclaw-single-row-cache-fresh-registry-", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            {
              id: "main",
              default: true,
              workspace: "/tmp/openclaw-single-row-cache-fresh-registry",
            },
          ],
          defaults: { model: { primary: "openai/gpt-5.4" } },
        },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);
      const now = Math.floor(Date.now() / 1_000) * 1_000 + 100;
      const oldParent = "agent:main:subagent:parent-old";
      const newParent = "agent:main:subagent:parent-new";
      const child = "agent:main:subagent:child";
      const store: Record<string, SessionEntry> = {
        [oldParent]: {
          sessionId: "parent-old",
          updatedAt: now,
        },
        [newParent]: {
          sessionId: "parent-new",
          updatedAt: now,
        },
        [child]: {
          sessionId: "child",
          parentSessionKey: oldParent,
          updatedAt: now,
          status: "running",
        },
      };
      await saveSessionStore(resolveStorePath(cfg.session?.store, { agentId: "main" }), store);

      subagentRegistryReadMock.setSubagentRunsForTest([
        {
          childSessionKey: child,
          controllerSessionKey: oldParent,
          requesterSessionKey: oldParent,
          createdAt: now,
        },
      ]);
      expect(loadGatewaySessionRow(oldParent, { now })?.childSessions).toEqual([child]);

      subagentRegistryReadMock.setSubagentRunsForTest([
        {
          childSessionKey: child,
          controllerSessionKey: newParent,
          requesterSessionKey: newParent,
          createdAt: now + 25,
        },
      ]);
      expect(loadGatewaySessionRow(oldParent, { now: now + 50 })?.childSessions).toBeUndefined();
      expect(loadGatewaySessionRow(newParent, { now: now + 50 })?.childSessions).toEqual([child]);
      expect(subagentRegistryReadMock.buildSubagentRunReadIndex).not.toHaveBeenCalled();
    });
  });

  test("rebuilds store child candidates after same-object session store writes", async () => {
    await withStateDirEnv("openclaw-single-row-cache-write-version-", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            {
              id: "main",
              default: true,
              workspace: "/tmp/openclaw-single-row-cache-write-version",
            },
          ],
          defaults: { model: { primary: "openai/gpt-5.4" } },
        },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);
      const now = Math.floor(Date.now() / 1_000) * 1_000 + 100;
      const oldParent = "agent:main:subagent:parent-old";
      const newParent = "agent:main:subagent:parent-new";
      const child = "agent:main:subagent:child";
      const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
      const store: Record<string, SessionEntry> = {
        [oldParent]: {
          sessionId: "parent-old",
          updatedAt: now,
        },
        [newParent]: {
          sessionId: "parent-new",
          updatedAt: now,
        },
        [child]: {
          sessionId: "child",
          parentSessionKey: oldParent,
          updatedAt: now,
          status: "running",
        },
      };
      await saveSessionStore(storePath, store);

      expect(loadGatewaySessionRow(oldParent, { now })?.childSessions).toEqual([child]);
      await updateSessionStore(
        storePath,
        (cachedStore) => {
          const childEntry = cachedStore[child];
          if (childEntry) {
            childEntry.parentSessionKey = newParent;
            childEntry.updatedAt = now + 25;
          }
        },
        { skipMaintenance: true, takeCacheOwnership: true },
      );

      expect(loadGatewaySessionRow(oldParent, { now: now + 50 })?.childSessions).toBeUndefined();
      expect(loadGatewaySessionRow(newParent, { now: now + 50 })?.childSessions).toEqual([child]);
      expect(subagentRegistryReadMock.buildSubagentRunReadIndex).not.toHaveBeenCalled();
    });
  });
});
