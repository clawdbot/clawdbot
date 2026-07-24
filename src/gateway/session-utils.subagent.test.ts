/**
 * Tests subagent session utility behavior and persisted session lookups.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { saveSubagentRegistryToSqlite } from "../agents/subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { registerAgentRunContext, resetAgentEventsForTest } from "../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnv } from "../test-utils/env.js";
import {
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  resolveGatewayModelSupportsImages,
} from "./session-utils.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

async function seedSessionEntry(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
  agentId?: string,
): Promise<void> {
  await replaceSessionEntry({ ...(agentId ? { agentId } : {}), sessionKey, storePath }, entry);
}

describe("listSessionsFromStore subagent metadata", () => {
  afterEach(() => {
    resetAgentEventsForTest({ preserveListeners: true });
    closeOpenClawStateDatabaseForTest();
    resetSubagentRegistryForTests({ persist: false });
  });
  beforeEach(() => {
    resetAgentEventsForTest({ preserveListeners: true });
    resetSubagentRegistryForTests({ persist: false });
  });

  const cfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  test("searches channel-derived display names before row enrichment", () => {
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:slack:group:general": {
          sessionId: "slack-general-session",
          updatedAt: 2,
          channel: "slack",
        } as SessionEntry,
        "agent:main:discord:group:random": {
          sessionId: "discord-random-session",
          updatedAt: 1,
          channel: "discord",
        } as SessionEntry,
      },
      opts: { search: "slack:g-general" },
    });

    expect(result.sessions.map((session) => session.key)).toEqual([
      "agent:main:slack:group:general",
    ]);
    expect(result.sessions[0]?.displayName).toBe("slack:g-general");
  });

  test("applies limit before transcript enrichment", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:newest": {
        sessionId: "newest-session",
        sessionFile: "/tmp/newest-session.jsonl",
        updatedAt: 300,
      } as SessionEntry,
      "agent:main:middle": {
        sessionId: "middle-session",
        sessionFile: "/tmp/middle-session.jsonl",
        updatedAt: 200,
      } as SessionEntry,
      "agent:main:oldest": {
        sessionId: "old-session",
        sessionFile: "/tmp/old-session.jsonl",
        updatedAt: 100,
      } as SessionEntry,
    };
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      const result = listSessionsFromStore({
        cfg,
        storePath: "/tmp/sessions.json",
        store,
        opts: { limit: 2 },
      });

      expect(result.sessions.map((session) => session.sessionId)).toEqual([
        "newest-session",
        "middle-session",
      ]);
      expect(existsSpy.mock.calls.flat().join("\n")).not.toContain("old-session");
    } finally {
      existsSpy.mockRestore();
    }
  });

  test("keeps persisted navigation lineage separate from live registry control", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:controlled-child";
    const entry = {
      sessionId: "sess-controlled-child",
      updatedAt: now,
      spawnedBy: "agent:main:subagent:persisted-spawner",
      parentSessionKey: "agent:main:dashboard:navigation-parent",
      createdVia: "spawn",
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: now - 10_000,
      forkSource: {
        sessionKey: "agent:main:main",
        sessionId: "sess-source",
        entryId: "entry-source",
      },
      previousSessionId: "sess-previous",
    } satisfies SessionEntry;

    addSubagentRunForTests({
      runId: "run-controlled-child",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:runtime-controller",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "controlled child",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: { [childSessionKey]: entry },
      opts: {},
    });
    const row = expectDefined(result.sessions[0], "controlled child row");

    expect(row.spawnedBy).toBe("agent:main:subagent:runtime-controller");
    expect(row.controlOwnerSessionKey).toBe("agent:main:subagent:runtime-controller");
    expect(row.parentSessionKey).toBe("agent:main:dashboard:navigation-parent");
    expect(row.createdVia).toBe("spawn");
    expect(row.createdActor).toEqual({ type: "agent", id: "agent:main:main" });
    expect(row.createdAt).toBe(now - 10_000);
    expect(row.forkSource).toEqual({
      sessionKey: "agent:main:main",
      sessionId: "sess-source",
      entryId: "entry-source",
    });
    expect(row.previousSessionId).toBe("sess-previous");
  });

  test("includes subagent status timing and direct child session keys", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: now - 2_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:parent",
        spawnedWorkspaceDir: "/tmp/child-workspace",
        spawnedCwd: "/tmp/task-repo",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
      } as SessionEntry,
      "agent:main:subagent:failed": {
        sessionId: "sess-failed",
        updatedAt: now - 500,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-parent",
      childSessionKey: "agent:main:subagent:parent",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "parent task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
      model: "openai/gpt-5.4",
    });
    registerAgentRunContext("run-parent", {
      sessionKey: "agent:main:subagent:parent",
    });
    addSubagentRunForTests({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:child",
      controllerSessionKey: "agent:main:subagent:parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "child task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_500,
      endedAt: now - 2_500,
      outcome: { status: "ok" },
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
      runId: "run-failed",
      childSessionKey: "agent:main:subagent:failed",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "failed task",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 500,
      outcome: { status: "error", error: "boom" },
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toEqual([
      "agent:main:subagent:parent",
      "agent:main:subagent:failed",
    ]);
    expect(main?.status).toBeUndefined();

    const parent = result.sessions.find((session) => session.key === "agent:main:subagent:parent");
    expect(parent?.status).toBe("running");
    expect(parent?.startedAt).toBe(now - 9_000);
    expect(parent?.endedAt).toBeUndefined();
    expect(parent?.runtimeMs).toBeGreaterThanOrEqual(9_000);
    expect(parent?.childSessions).toEqual(["agent:main:subagent:child"]);

    const child = result.sessions.find((session) => session.key === "agent:main:subagent:child");
    expect(child?.status).toBe("done");
    expect(child?.startedAt).toBe(now - 7_500);
    expect(child?.endedAt).toBe(now - 2_500);
    expect(child?.runtimeMs).toBe(5_000);
    expect(child?.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
    expect(child?.spawnedCwd).toBe("/tmp/task-repo");
    expect(child?.forkedFromParent).toBe(true);
    expect(child?.spawnDepth).toBe(2);
    expect(child?.subagentRole).toBe("orchestrator");
    expect(child?.subagentControlScope).toBe("children");
    expect(child?.childSessions).toBeUndefined();

    const failed = result.sessions.find((session) => session.key === "agent:main:subagent:failed");
    expect(failed?.status).toBe("failed");
    expect(failed?.runtimeMs).toBe(5_000);
  });

  test("does not show stale registry-only subagent runs as actively running", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-display";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-stale-display",
        updatedAt: now - 250,
        spawnedBy: "agent:main:main",
        status: "done",
        startedAt: now - 4_000,
        endedAt: now - 500,
        runtimeMs: 3_500,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-stale-display",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale display task",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const row = result.sessions.find((session) => session.key === childSessionKey);
    expect(row?.status).toBe("done");
    expect(row?.subagentRunState).toBe("historical");
    expect(row?.hasActiveSubagentRun).toBe(false);
    expect(row?.endedAt).toBe(now - 500);
    expect(row?.runtimeMs).toBe(3_500);
  });

  test("does not keep childSessions attached to a stale older controller row", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent": {
        sessionId: "sess-old-parent",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent": {
        sessionId: "sess-new-parent",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child": {
        sessionId: "sess-shared-child",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:new-parent",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent",
      childSessionKey: "agent:main:subagent:old-parent",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent",
      childSessionKey: "agent:main:subagent:new-parent",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child",
      controllerSessionKey: "agent:main:subagent:old-parent",
      requesterSessionKey: "agent:main:subagent:old-parent",
      requesterDisplayKey: "old-parent",
      task: "shared child stale parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-current-parent",
      childSessionKey: "agent:main:subagent:shared-child",
      controllerSessionKey: "agent:main:subagent:new-parent",
      requesterSessionKey: "agent:main:subagent:new-parent",
      requesterDisplayKey: "new-parent",
      task: "shared child current parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const oldParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:old-parent",
    );
    const newParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:new-parent",
    );

    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent?.childSessions).toEqual(["agent:main:subagent:shared-child"]);
  });

  test("does not reattach moved children through stale spawnedBy store metadata", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent-store": {
        sessionId: "sess-old-parent-store",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent-store": {
        sessionId: "sess-new-parent-store",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child-store": {
        sessionId: "sess-shared-child-store",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:old-parent-store",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent-store",
      childSessionKey: "agent:main:subagent:old-parent-store",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent store task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent-store",
      childSessionKey: "agent:main:subagent:new-parent-store",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent store task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-store-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child-store",
      controllerSessionKey: "agent:main:subagent:old-parent-store",
      requesterSessionKey: "agent:main:subagent:old-parent-store",
      requesterDisplayKey: "old-parent-store",
      task: "shared child stale store parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-store-current-parent",
      childSessionKey: "agent:main:subagent:shared-child-store",
      controllerSessionKey: "agent:main:subagent:new-parent-store",
      requesterSessionKey: "agent:main:subagent:new-parent-store",
      requesterDisplayKey: "new-parent-store",
      task: "shared child current store parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const oldParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:old-parent-store",
    );
    const newParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:new-parent-store",
    );

    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent?.childSessions).toEqual(["agent:main:subagent:shared-child-store"]);
  });

  test("does not return moved child sessions from stale spawnedBy filters", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent-filter": {
        sessionId: "sess-old-parent-filter",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent-filter": {
        sessionId: "sess-new-parent-filter",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child-filter": {
        sessionId: "sess-shared-child-filter",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:old-parent-filter",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent-filter",
      childSessionKey: "agent:main:subagent:old-parent-filter",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent filter task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent-filter",
      childSessionKey: "agent:main:subagent:new-parent-filter",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent filter task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-filter-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child-filter",
      controllerSessionKey: "agent:main:subagent:old-parent-filter",
      requesterSessionKey: "agent:main:subagent:old-parent-filter",
      requesterDisplayKey: "old-parent-filter",
      task: "shared child stale filter parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-filter-current-parent",
      childSessionKey: "agent:main:subagent:shared-child-filter",
      controllerSessionKey: "agent:main:subagent:new-parent-filter",
      requesterSessionKey: "agent:main:subagent:new-parent-filter",
      requesterDisplayKey: "new-parent-filter",
      task: "shared child current filter parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:subagent:old-parent-filter",
      },
    });

    expect(result.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("reports the newest run owner for moved child session rows", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-child-owner";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-shared-child-owner",
        updatedAt: now,
        spawnedBy: "agent:main:subagent:old-parent-owner",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-child-owner-stale-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:old-parent-owner",
      requesterSessionKey: "agent:main:subagent:old-parent-owner",
      requesterDisplayKey: "old-parent-owner",
      task: "shared child stale owner parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-owner-current-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:new-parent-owner",
      requesterSessionKey: "agent:main:subagent:new-parent-owner",
      requesterDisplayKey: "new-parent-owner",
      task: "shared child current owner parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.key).toBe(childSessionKey);
    expect(result.sessions[0]?.spawnedBy).toBe("agent:main:subagent:new-parent-owner");
  });

  test("keeps the persisted parentSessionKey while reporting the newest runtime controller", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-child-parent";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-shared-child-parent",
        updatedAt: now,
        parentSessionKey: "agent:main:subagent:old-parent-parent",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-child-parent-stale-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:old-parent-parent",
      requesterSessionKey: "agent:main:subagent:old-parent-parent",
      requesterDisplayKey: "old-parent-parent",
      task: "shared child stale parentSessionKey parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-parent-current-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:new-parent-parent",
      requesterSessionKey: "agent:main:subagent:new-parent-parent",
      requesterDisplayKey: "new-parent-parent",
      task: "shared child current parentSessionKey parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.key).toBe(childSessionKey);
    expect(result.sessions[0]?.parentSessionKey).toBe("agent:main:subagent:old-parent-parent");
    expect(result.sessions[0]?.spawnedBy).toBe("agent:main:subagent:new-parent-parent");
    expect(result.sessions[0]?.controlOwnerSessionKey).toBe(
      "agent:main:subagent:new-parent-parent",
    );
  });

  test("preserves original session timing across follow-up replacement runs", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:followup": {
        sessionId: "sess-followup",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-followup-new",
      childSessionKey: "agent:main:subagent:followup",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "follow-up task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 30_000,
      sessionStartedAt: now - 150_000,
      accumulatedRuntimeMs: 120_000,
      model: "openai/gpt-5.4",
    });
    registerAgentRunContext("run-followup-new", {
      sessionKey: "agent:main:subagent:followup",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const followup = result.sessions.find(
      (session) => session.key === "agent:main:subagent:followup",
    );
    expect(followup?.status).toBe("running");
    expect(followup?.startedAt).toBe(now - 150_000);
    expect(followup?.runtimeMs).toBeGreaterThanOrEqual(150_000);
  });

  test("uses the newest child-session row for stale/current replacement pairs", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-current";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-stale-current",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-stale-active",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale active row",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_500,
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
      runId: "run-current-ended",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current ended row",
      cleanup: "keep",
      createdAt: now - 1_000,
      startedAt: now - 900,
      endedAt: now - 200,
      outcome: { status: "ok" },
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.key).toBe(childSessionKey);
    expect(result.sessions[0]?.status).toBe("done");
    expect(result.sessions[0]?.startedAt).toBe(now - 900);
    expect(result.sessions[0]?.endedAt).toBe(now - 200);
  });

  test("prefers persisted terminal session state when only stale active subagent snapshots remain", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-subagent-"));
    const stateDir = path.join(tempRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:disk-live";
      const persistedRuns = new Map<string, SubagentRunRecord>([
        [
          "run-complete",
          {
            runId: "run-complete",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "finished too early",
            cleanup: "keep",
            createdAt: now - 2_000,
            startedAt: now - 1_900,
            endedAt: now - 1_800,
            outcome: { status: "ok" },
          },
        ],
        [
          "run-live",
          {
            runId: "run-live",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "still running",
            cleanup: "keep",
            createdAt: now - 10_000,
            startedAt: now - 9_000,
          },
        ],
      ]);

      const row = withEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1",
        },
        () => {
          saveSubagentRegistryToSqlite(persistedRuns);
          const result = listSessionsFromStore({
            cfg,
            storePath: "/tmp/sessions.json",
            store: {
              [childSessionKey]: {
                sessionId: "sess-disk-live",
                updatedAt: now,
                spawnedBy: "agent:main:main",
                status: "done",
                endedAt: now - 1_800,
                runtimeMs: 100,
              } as SessionEntry,
            },
            opts: {},
          });
          return result.sessions.find((session) => session.key === childSessionKey);
        },
      );

      expect(row?.status).toBe("done");
      expect(row?.subagentRunState).toBe("historical");
      expect(row?.hasActiveSubagentRun).toBe(false);
      expect(row?.startedAt).toBe(now - 9_000);
      expect(row?.endedAt).toBe(now - 1_800);
      expect(row?.runtimeMs).toBe(100);
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("reuses one SQLite registry snapshot across sessions.list filtering and row enrichment", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-session-utils-subagent-cache-"),
    );
    const stateDir = path.join(tempRoot, "state");
    const registryPath = path.join(stateDir, "subagents", "runs.json");
    const now = Date.now();
    const controllerSessionKey = "agent:main:main";
    const childKeys = [
      "agent:main:subagent:cache-child-a",
      "agent:main:subagent:cache-child-b",
      "agent:main:subagent:cache-child-c",
    ];
    const firstChildKey = expectDefined(childKeys[0], "first child session key");
    const secondChildKey = expectDefined(childKeys[1], "second child session key");
    const thirdChildKey = expectDefined(childKeys[2], "third child session key");
    const persistedRuns = new Map<string, SubagentRunRecord>(
      childKeys.map((childSessionKey, index) => [
        `run-cache-child-${index}`,
        {
          runId: `run-cache-child-${index}`,
          childSessionKey,
          controllerSessionKey,
          requesterSessionKey: controllerSessionKey,
          requesterDisplayKey: "main",
          task: "cache test child",
          cleanup: "keep",
          createdAt: now - 5_000 + index,
          startedAt: now - 4_000 + index,
        },
      ]),
    );

    const store: Record<string, SessionEntry> = {
      [controllerSessionKey]: {
        updatedAt: now,
      } as SessionEntry,
      [firstChildKey]: {
        updatedAt: now - 1_000,
        spawnedBy: controllerSessionKey,
      } as SessionEntry,
      [secondChildKey]: {
        updatedAt: now - 2_000,
        spawnedBy: controllerSessionKey,
      } as SessionEntry,
      [thirdChildKey]: {
        updatedAt: now - 3_000,
        spawnedBy: controllerSessionKey,
      } as SessionEntry,
    };

    const statSpy = vi.spyOn(fs, "statSync");
    try {
      const result = withEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1",
        },
        () => {
          saveSubagentRegistryToSqlite(persistedRuns);
          return listSessionsFromStore({
            cfg,
            storePath: "/tmp/sessions.json",
            store,
            opts: { spawnedBy: controllerSessionKey },
          });
        },
      );

      expect(result.sessions.map((session) => session.key)).toEqual(childKeys);
      const registryStatCount = statSpy.mock.calls.filter(
        ([pathname]) => path.normalize(String(pathname)) === path.normalize(registryPath),
      ).length;
      expect(registryStatCount).toBe(0);
    } finally {
      statSpy.mockRestore();
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("does not read the subagent registry when raw filters drop every session", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-session-utils-subagent-cache-empty-"),
    );
    const stateDir = path.join(tempRoot, "state");
    const registryPath = path.join(stateDir, "subagents", "runs.json");

    const statSpy = vi.spyOn(fs, "statSync");
    try {
      const result = withEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1",
        },
        () =>
          listSessionsFromStore({
            cfg,
            storePath: "/tmp/sessions.json",
            store: {
              "agent:main:filtered-out": {
                label: "keep-me-out",
                updatedAt: Date.now(),
              } as SessionEntry,
            },
            opts: { label: "wanted-label" },
          }),
      );

      expect(result.sessions).toStrictEqual([]);
      const registryStatCount = statSpy.mock.calls.filter(
        ([pathname]) => path.normalize(String(pathname)) === path.normalize(registryPath),
      ).length;
      expect(registryStatCount).toBe(0);
    } finally {
      statSpy.mockRestore();
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("includes explicit parentSessionKey relationships for dashboard child sessions", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:dashboard:child": {
        sessionId: "sess-child",
        updatedAt: now - 1_000,
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    const child = result.sessions.find((session) => session.key === "agent:main:dashboard:child");
    expect(main?.childSessions).toEqual(["agent:main:dashboard:child"]);
    expect(child?.parentSessionKey).toBe("agent:main:main");
  });

  test("returns dashboard child sessions when filtering by parentSessionKey owner", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:dashboard:child": {
        sessionId: "sess-dashboard-child",
        updatedAt: now - 1_000,
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:main",
      },
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:dashboard:child"]);
  });

  test("does not reattach stale terminal store-only child links", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const staleAt = now - 2 * 60 * 60_000;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:claude:acp:done-child": {
        sessionId: "sess-done-child",
        updatedAt: staleAt,
        spawnedBy: "agent:main:main",
        status: "done",
        endedAt: staleAt,
      } as SessionEntry,
    };

    const all = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:main",
      },
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("does not reattach stale orphan store-only child links without lifecycle fields", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const staleAt = now - 2 * 60 * 60_000;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:orphan": {
        sessionId: "sess-orphan",
        updatedAt: staleAt,
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };

    const all = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:main",
      },
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("does not keep old ended registry runs attached as child sessions", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-ended": {
        sessionId: "sess-old-ended",
        updatedAt: now - 60 * 60_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-ended",
      childSessionKey: "agent:main:subagent:old-ended",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old ended task",
      cleanup: "keep",
      createdAt: now - 60 * 60_000,
      startedAt: now - 59 * 60_000,
      endedAt: now - 31 * 60_000,
      outcome: { status: "ok" },
    });

    const all = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:main",
      },
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("keeps ended parents attached while live descendants are still running", () => {
    const now = Date.now();
    const parentKey = "agent:main:subagent:ended-parent";
    const childKey = "agent:main:subagent:ended-parent:subagent:live-child";
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      [parentKey]: {
        sessionId: "sess-ended-parent",
        updatedAt: now - 31 * 60_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      [childKey]: {
        sessionId: "sess-live-child",
        updatedAt: now,
        spawnedBy: parentKey,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-ended-parent",
      childSessionKey: parentKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ended parent task",
      cleanup: "keep",
      createdAt: now - 60 * 60_000,
      startedAt: now - 59 * 60_000,
      endedAt: now - 31 * 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-live-child",
      childSessionKey: childKey,
      controllerSessionKey: parentKey,
      requesterSessionKey: parentKey,
      requesterDisplayKey: "ended-parent",
      task: "live child task",
      cleanup: "keep",
      createdAt: now - 1_000,
      startedAt: now - 900,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const main = result.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toEqual([parentKey]);
  });

  test("falls back to persisted subagent timing after run archival", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:archived": {
        sessionId: "sess-archived",
        updatedAt: now,
        spawnedBy: "agent:main:main",
        startedAt: now - 20_000,
        endedAt: now - 5_000,
        runtimeMs: 15_000,
        status: "done",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const archived = result.sessions.find(
      (session) => session.key === "agent:main:subagent:archived",
    );
    expect(archived?.status).toBe("done");
    expect(archived?.startedAt).toBe(now - 20_000);
    expect(archived?.endedAt).toBe(now - 5_000);
    expect(archived?.runtimeMs).toBe(15_000);
  });

  test("maps timeout outcomes to timeout status and clamps negative runtime", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:timeout": {
        sessionId: "sess-timeout",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-timeout",
      childSessionKey: "agent:main:subagent:timeout",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "timeout task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 1_000,
      endedAt: now - 2_000,
      outcome: { status: "timeout" },
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const timeout = result.sessions.find(
      (session) => session.key === "agent:main:subagent:timeout",
    );
    expect(timeout?.status).toBe("timeout");
    expect(timeout?.runtimeMs).toBe(0);
  });

  test("fails closed when model lookup misses", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", name: "GPT-5.4", provider: "other", input: ["text", "image"] },
        ],
      }),
    ).resolves.toBe(false);
  });

  test("fails closed when model catalog load throws", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => {
          throw new Error("catalog unavailable");
        },
      }),
    ).resolves.toBe(false);
  });
});

describe("loadCombinedSessionStoreForGateway includes disk-only agents (#32804)", () => {
  test("fixed stores merge every configured agent's partition", async () => {
    await withStateDirEnv("openclaw-fixed-store-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "shared-sessions.json");
      const cfg = {
        session: { mainKey: "main", store: storePath },
        agents: {
          entries: {
            ops: { default: true },
            worker: {},
          },
        },
      } as OpenClawConfig;

      await seedSessionEntry(
        storePath,
        "agent:ops:main",
        { sessionId: "s-ops", updatedAt: 100 },
        "ops",
      );
      await seedSessionEntry(
        storePath,
        "agent:worker:main",
        { sessionId: "s-worker", updatedAt: 200 },
        "worker",
      );
      await seedSessionEntry(
        storePath,
        "agent:dynamic:main",
        { sessionId: "s-dynamic", updatedAt: 300 },
        "dynamic",
      );
      await seedSessionEntry(
        storePath,
        "agent:ops:legacy",
        { sessionId: "s-legacy-ops", spawnedBy: "main", updatedAt: 400 },
        "main",
      );
      const dynamicIncognitoKey = "dashboard:incognito-dynamic";
      await seedSessionEntry(
        resolveIncognitoOpenClawAgentSqlitePath({ agentId: "dynamic" }),
        dynamicIncognitoKey,
        { incognito: true, sessionId: "s-incognito-dynamic", updatedAt: 500 },
        "dynamic",
      );

      const { store } = loadCombinedSessionStoreForGateway(cfg);
      expect(store["agent:ops:main"]?.sessionId).toBe("s-ops");
      expect(store["agent:worker:main"]?.sessionId).toBe("s-worker");
      expect(store["agent:dynamic:main"]?.sessionId).toBe("s-dynamic");

      const configuredOnly = loadCombinedSessionStoreForGateway(cfg, {
        configuredAgentsOnly: true,
      }).store;
      expect(configuredOnly["agent:ops:legacy"]?.sessionId).toBe("s-legacy-ops");
      expect(configuredOnly["agent:ops:legacy"]?.spawnedBy).toBe("agent:ops:main");
      expect(configuredOnly["agent:dynamic:main"]).toBeUndefined();
      expect(configuredOnly[dynamicIncognitoKey]).toBeUndefined();

      const opsOnly = loadCombinedSessionStoreForGateway(cfg, { agentId: "ops" }).store;
      expect(opsOnly["agent:ops:main"]?.sessionId).toBe("s-ops");
      expect(opsOnly["agent:ops:legacy"]?.sessionId).toBe("s-legacy-ops");
      expect(opsOnly["agent:worker:main"]).toBeUndefined();
      expect(opsOnly["agent:dynamic:main"]).toBeUndefined();

      const explicitDynamic = loadCombinedSessionStoreForGateway(cfg, {
        agentId: "dynamic",
        configuredAgentsOnly: true,
      }).store;
      expect(explicitDynamic["agent:dynamic:main"]?.sessionId).toBe("s-dynamic");

      const mainOnly = loadCombinedSessionStoreForGateway(cfg, { agentId: "main" }).store;
      expect(mainOnly["agent:ops:legacy"]).toBeUndefined();
    });
  });

  test("ACP agent sessions are visible even when agents.list is configured", async () => {
    await withStateDirEnv("openclaw-acp-vis-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const agentsDir = path.join(customRoot, "agents");
      const mainDir = path.join(agentsDir, "main", "sessions");
      const codexDir = path.join(agentsDir, "codex", "sessions");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });

      await seedSessionEntry(path.join(mainDir, "sessions.json"), "agent:main:main", {
        sessionId: "s-main",
        updatedAt: 100,
      });
      await seedSessionEntry(path.join(codexDir, "sessions.json"), "agent:codex:acp-task", {
        sessionId: "s-codex",
        updatedAt: 200,
      });

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;

      const { store } = loadCombinedSessionStoreForGateway(cfg);
      expect(store["agent:main:main"]?.sessionId).toBe("s-main");
      expect(store["agent:codex:acp-task"]?.sessionId).toBe("s-codex");
    });
  });

  test("agent-scoped loads read only matching agent stores", async () => {
    await withStateDirEnv("openclaw-acp-scoped-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const agentsDir = path.join(customRoot, "agents");
      const mainDir = path.join(agentsDir, "main", "sessions");
      const codexDir = path.join(agentsDir, "codex", "sessions");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });

      const mainStorePath = path.join(mainDir, "sessions.json");
      const codexStorePath = path.join(codexDir, "sessions.json");
      await seedSessionEntry(mainStorePath, "agent:main:main", {
        sessionId: "s-main",
        updatedAt: 100,
      });
      await seedSessionEntry(codexStorePath, "agent:codex:acp-task", {
        sessionId: "s-codex",
        updatedAt: 200,
      });

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;

      const { store, storePath } = loadCombinedSessionStoreForGateway(cfg, { agentId: "codex" });

      expect(path.resolve(storePath)).toBe(path.resolve(codexStorePath));
      expect(store["agent:codex:acp-task"]?.sessionId).toBe("s-codex");
      expect(store["agent:main:main"]).toBeUndefined();

      const mainOnly = loadCombinedSessionStoreForGateway(cfg, { agentId: "main" }).store;
      expect(mainOnly["agent:main:main"]?.sessionId).toBe("s-main");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
