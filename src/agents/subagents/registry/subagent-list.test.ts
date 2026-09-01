// Subagent list tests cover active/recent formatting, usage summaries, and
// stale-run filtering for the user-visible subagent status command.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { buildSubagentList } from "./subagent-list.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;

let testWorkspaceDir = os.tmpdir();

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-list-"));
});

afterAll(async () => {
  await fs.rm(testWorkspaceDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

beforeEach(() => {
  resetSubagentRegistryForTests();
});

describe("buildSubagentList", () => {
  it("returns empty active and recent sections when no runs exist", () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      runs: [],
      recentMinutes: 30,
      taskMaxChars: 110,
    });
    expect(list.active).toStrictEqual([]);
    expect(list.recent).toStrictEqual([]);
    expect(list.text).toContain("active subagents:");
    expect(list.text).toContain("recent (last 30m):");
  });

  it("truncates long task text in list lines", () => {
    const run = {
      runId: "run-long-task",
      childSessionKey: "agent:main:subagent:long-task",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "This is a deliberately long task description used to verify that subagent list output keeps the full task text instead of appending ellipsis after a short hard cutoff.",
      cleanup: "keep",
      createdAt: 1000,
      execution: { status: "running", startedAt: 1000 },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      runs: [run],
      recentMinutes: 30,
      taskMaxChars: 110,
    });
    expect(list.active[0]?.task).toHaveLength(110);
    expect(list.active[0]?.task).toMatch(/\.\.\.$/);
    expect(list.active[0]?.line).not.toContain("after a short hard cutoff.");
  });

  it("shows taskName in list lines and structured views", () => {
    const run = {
      runId: "run-task-name",
      childSessionKey: "agent:main:subagent:task-name",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "review the subagent orchestration code",
      taskName: "review_subagents",
      cleanup: "keep",
      label: "Review worker",
      createdAt: 1000,
      execution: { status: "running", startedAt: 1000 },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const list = buildSubagentList({
      cfg,
      runs: [run],
      recentMinutes: 30,
    });

    expect(list.active[0]?.taskName).toBe("review_subagents");
    expect(list.active[0]?.line).toContain("review_subagents: Review worker");
  });

  it.each([
    {
      name: "a killed run with a provider failure",
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" } as const,
      expectedStatus: "killed",
    },
    {
      name: "a killed run with an earlier successful provider outcome",
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "ok" } as const,
      expectedStatus: "killed",
    },
    {
      name: "a failed run",
      outcome: { status: "error", error: "provider rejected the request" } as const,
      expectedStatus: "failed",
    },
    {
      name: "a timed-out run",
      outcome: { status: "timeout" } as const,
      expectedStatus: "timeout",
    },
    {
      name: "a completed run",
      outcome: { status: "ok" } as const,
      expectedStatus: "done",
    },
  ])(
    "projects the canonical terminal status for $name",
    ({ endedReason, outcome, expectedStatus }) => {
      const now = Date.now();
      const run = {
        runId: `run-status-${expectedStatus}`,
        childSessionKey: `agent:main:subagent:status-${expectedStatus}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "report the actual child outcome",
        cleanup: "keep",
        createdAt: now - 2_000,
        execution: {
          status: "terminal",
          startedAt: now - 2_000,
          endedAt: now - 1_000,
          outcome,
        },
        ...(endedReason ? { endedReason } : {}),
      } satisfies SubagentRunRecord;
      addSubagentRunForTests(run);

      const list = buildSubagentList({
        cfg: {} as OpenClawConfig,
        runs: [run],
        recentMinutes: 30,
      });

      expect(list.recent[0]?.status).toBe(expectedStatus);
      expect(list.recent[0]?.line).toContain(` ${expectedStatus}`);
    },
  );

  it("keeps ended orchestrators active while descendants remain pending", () => {
    // Parent orchestrators can finish their own turn before child workers do;
    // list output should keep them active until descendants settle.
    const now = Date.now();
    const orchestratorRun = {
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate child workers",
      cleanup: "keep",
      createdAt: now - 120_000,
      execution: {
        status: "terminal",
        startedAt: now - 120_000,
        endedAt: now - 60_000,
        outcome: { status: "ok" },
      },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(orchestratorRun);
    addSubagentRunForTests({
      runId: "run-orchestrator-child-active",
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:child",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterDisplayKey: "subagent:orchestrator-ended",
      task: "child worker still running",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      runs: [orchestratorRun],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active[0]?.status).toBe("active (waiting on 1 child)");
    expect(list.active[0]?.childSessions).toEqual([
      "agent:main:subagent:orchestrator-ended:subagent:child",
    ]);
    expect(list.recent).toStrictEqual([]);
  });

  it.each([
    {
      name: "a killed parent with a provider failure",
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" } as const,
      pendingChildren: 1,
      expectedStatus: "killed (waiting on 1 child)",
    },
    {
      name: "a killed parent with an earlier successful provider outcome",
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "ok" } as const,
      pendingChildren: 2,
      expectedStatus: "killed (waiting on 2 children)",
    },
    {
      name: "a failed parent",
      outcome: { status: "error", error: "provider rejected the request" } as const,
      pendingChildren: 1,
      expectedStatus: "failed (waiting on 1 child)",
    },
    {
      name: "a timed-out parent",
      outcome: { status: "timeout" } as const,
      pendingChildren: 2,
      expectedStatus: "timeout (waiting on 2 children)",
    },
    {
      name: "a successfully completed parent",
      outcome: { status: "ok" } as const,
      pendingChildren: 2,
      expectedStatus: "active (waiting on 2 children)",
    },
    {
      name: "a still-running parent",
      ended: false,
      pendingChildren: 1,
      expectedStatus: "active (waiting on 1 child)",
    },
  ])(
    "preserves the status of $name while descendants remain pending",
    ({ endedReason, outcome, ended, pendingChildren, expectedStatus }) => {
      const now = Date.now();
      const parentRun = {
        runId: `run-parent-${expectedStatus.replaceAll(" ", "-")}`,
        childSessionKey: `agent:main:subagent:parent-${expectedStatus.replaceAll(" ", "-")}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "orchestrate child workers",
        cleanup: "keep",
        createdAt: now - 120_000,
        execution:
          ended === false
            ? { status: "running", startedAt: now - 120_000 }
            : {
                status: "terminal",
                startedAt: now - 120_000,
                endedAt: now - 60_000,
                outcome,
              },
        ...(endedReason ? { endedReason } : {}),
      } satisfies SubagentRunRecord;
      addSubagentRunForTests(parentRun);
      for (let childIndex = 0; childIndex < pendingChildren; childIndex += 1) {
        addSubagentRunForTests({
          runId: `${parentRun.runId}-child-${childIndex}`,
          childSessionKey: `${parentRun.childSessionKey}:subagent:child-${childIndex}`,
          requesterSessionKey: parentRun.childSessionKey,
          requesterDisplayKey: "subagent:parent",
          task: "child worker still running",
          cleanup: "keep",
          createdAt: now - 30_000,
          startedAt: now - 30_000,
        });
      }

      const list = buildSubagentList({
        cfg: {} as OpenClawConfig,
        runs: [parentRun],
        recentMinutes: 30,
      });

      expect(list.active).toHaveLength(1);
      expect(list.active[0]).toMatchObject({
        runId: parentRun.runId,
        status: expectedStatus,
        pendingDescendants: pendingChildren,
      });
      expect(list.active[0]?.line).toContain(` ${expectedStatus}`);
      expect(list.active[0]?.childSessions).toHaveLength(pendingChildren);
      expect(list.recent).toStrictEqual([]);
    },
  );

  it("omits old ended descendants from child session summaries", () => {
    const now = Date.now();
    const parentRun = {
      runId: "run-parent-active-old-child",
      childSessionKey: "agent:main:subagent:parent-active-old-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "parent active",
      cleanup: "keep",
      createdAt: now - 120_000,
      execution: { status: "running", startedAt: now - 120_000 },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(parentRun);
    addSubagentRunForTests({
      runId: "run-old-ended-child-summary",
      childSessionKey: `${parentRun.childSessionKey}:subagent:old-ended-child`,
      requesterSessionKey: parentRun.childSessionKey,
      requesterDisplayKey: "subagent:parent-active-old-child",
      task: "old ended child",
      cleanup: "keep",
      createdAt: now - 60 * 60_000,
      startedAt: now - 59 * 60_000,
      endedAt: now - 31 * 60_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const list = buildSubagentList({
      cfg,
      runs: [parentRun],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active[0]?.childSessions).toBeUndefined();
  });

  it("formats io and prompt/cache usage from session entries", async () => {
    const run = {
      runId: "run-usage",
      childSessionKey: "agent:main:subagent:usage",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      execution: { status: "running", startedAt: 1000 },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const storePath = path.join(testWorkspaceDir, "sessions-subagent-list-usage.json");
    await replaceSessionEntry(
      {
        storePath,
        sessionKey: "agent:main:subagent:usage",
      },
      {
        sessionId: "child-session-usage",
        updatedAt: Date.now(),
        inputTokens: 12,
        outputTokens: 1000,
        totalTokens: 197000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        model: "opencode/claude-opus-4-6",
      },
    );
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    // Prompt/cache usage is separate from visible IO so operators can spot
    // cache-heavy sessions without misreading it as assistant output.
    const list = buildSubagentList({
      cfg,
      runs: [run],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active[0]?.line).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
    expect(list.active[0]?.line).toContain("prompt/cache 197k");
    expect(list.active[0]?.line).not.toContain("1k io");
  });

  it("keeps stale unended runs out of active and recent list output", () => {
    const now = Date.now();
    const staleRun = {
      runId: "run-stale-list",
      childSessionKey: "agent:main:subagent:stale-list",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale hidden work",
      cleanup: "keep",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      execution: {
        status: "running",
        startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(staleRun);
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const list = buildSubagentList({
      cfg,
      runs: [staleRun],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.total).toBe(1);
    expect(list.active).toStrictEqual([]);
    expect(list.recent).toStrictEqual([]);
    expect(list.text).toContain("active subagents:\n(none)");
  });

  it("does not let a stale unended child keep an ended parent listed active", () => {
    const now = Date.now();
    const parentRun = {
      runId: "run-parent-ended-stale-child",
      childSessionKey: "agent:main:subagent:parent-ended-stale-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "parent ended",
      cleanup: "keep",
      createdAt: now - 120_000,
      execution: {
        status: "terminal",
        startedAt: now - 120_000,
        endedAt: now - 60_000,
        outcome: { status: "ok" },
      },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(parentRun);
    addSubagentRunForTests({
      runId: "run-stale-child",
      childSessionKey: `${parentRun.childSessionKey}:subagent:stale-child`,
      requesterSessionKey: parentRun.childSessionKey,
      requesterDisplayKey: "subagent:parent-ended-stale-child",
      task: "stale child",
      cleanup: "keep",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const list = buildSubagentList({
      cfg,
      runs: [parentRun],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active).toStrictEqual([]);
    expect(list.recent[0]?.status).toBe("done");
  });

  // The shared-cwd advisory warns when a caller deliberately aimed two live
  // children at one directory. Assertions target the structured `sharedCwd`
  // field, not just the line suffix: subagents-tool strips `line` from its JSON
  // output, so line-only coverage would pass while the tool surface carried
  // nothing.
  describe("shared cwd advisory", () => {
    const makeRun = (
      suffix: string,
      now: number,
      options?: { ended?: boolean },
    ): SubagentRunRecord =>
      ({
        runId: `run-${suffix}`,
        childSessionKey: `agent:main:subagent:${suffix}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: `work inside ${suffix}`,
        cleanup: "keep",
        createdAt: now - 120_000,
        execution: options?.ended
          ? {
              status: "terminal",
              startedAt: now - 120_000,
              endedAt: now - 60_000,
              outcome: { status: "ok" },
            }
          : { status: "running", startedAt: now - 120_000 },
      }) satisfies SubagentRunRecord;

    const seedSessionEntry = async (storePath: string, sessionKey: string, spawnedCwd?: string) => {
      await replaceSessionEntry(
        { storePath, sessionKey },
        {
          sessionId: `session-${sessionKey}`,
          updatedAt: Date.now(),
          ...(spawnedCwd ? { spawnedCwd } : {}),
        },
      );
    };

    it("reports peers and path for live runs spawned into the same explicit cwd", async () => {
      const now = Date.now();
      const sharedDir = path.join(testWorkspaceDir, "shared-tree");
      const runA = makeRun("shared-cwd-a", now);
      const runB = makeRun("shared-cwd-b", now);
      addSubagentRunForTests(runA);
      addSubagentRunForTests(runB);
      const storePath = path.join(testWorkspaceDir, "sessions-shared-cwd-pair.json");
      await seedSessionEntry(storePath, runA.childSessionKey, sharedDir);
      await seedSessionEntry(storePath, runB.childSessionKey, sharedDir);
      const cfg = { session: { store: storePath } } as OpenClawConfig;

      const list = buildSubagentList({ cfg, runs: [runA, runB], recentMinutes: 30 });

      expect(list.active).toHaveLength(2);
      const byRunId = new Map(list.active.map((item) => [item.runId, item]));
      expect(byRunId.get(runA.runId)?.sharedCwd).toEqual({
        path: path.resolve(sharedDir),
        peerRunIds: [runB.runId],
      });
      expect(byRunId.get(runB.runId)?.sharedCwd).toEqual({
        path: path.resolve(sharedDir),
        peerRunIds: [runA.runId],
      });
      expect(byRunId.get(runA.runId)?.line).toContain(
        `[shared cwd with 1 other run: ${path.resolve(sharedDir)}]`,
      );
    });

    it("pluralizes the suffix and excludes self from peers for three sharing runs", async () => {
      const now = Date.now();
      const sharedDir = path.join(testWorkspaceDir, "shared-tree-trio");
      const runs = ["trio-a", "trio-b", "trio-c"].map((suffix) => makeRun(suffix, now));
      for (const run of runs) {
        addSubagentRunForTests(run);
      }
      const storePath = path.join(testWorkspaceDir, "sessions-shared-cwd-trio.json");
      for (const run of runs) {
        await seedSessionEntry(storePath, run.childSessionKey, sharedDir);
      }
      const cfg = { session: { store: storePath } } as OpenClawConfig;

      const list = buildSubagentList({ cfg, runs, recentMinutes: 30 });

      expect(list.active).toHaveLength(3);
      for (const item of list.active) {
        expect(item.sharedCwd?.path).toBe(path.resolve(sharedDir));
        expect(item.sharedCwd?.peerRunIds).not.toContain(item.runId);
        expect(item.sharedCwd?.peerRunIds).toHaveLength(2);
        expect(item.line).toContain("[shared cwd with 2 other runs:");
      }
    });

    it("stays silent for live runs that inherited the parent workspace", async () => {
      // Default `collect` swarms pass no `cwd`, so every child has
      // spawnedCwd === undefined and legitimately shares the parent workspace.
      const now = Date.now();
      const runA = makeRun("inherited-a", now);
      const runB = makeRun("inherited-b", now);
      addSubagentRunForTests(runA);
      addSubagentRunForTests(runB);
      const storePath = path.join(testWorkspaceDir, "sessions-shared-cwd-inherited.json");
      await seedSessionEntry(storePath, runA.childSessionKey);
      await seedSessionEntry(storePath, runB.childSessionKey);
      const cfg = { session: { store: storePath } } as OpenClawConfig;

      const list = buildSubagentList({ cfg, runs: [runA, runB], recentMinutes: 30 });

      expect(list.active).toHaveLength(2);
      for (const item of list.active) {
        expect(item.sharedCwd).toBeUndefined();
        expect(item.line).not.toContain("shared cwd");
      }
    });

    it("stays silent for live runs pointed at different explicit directories", async () => {
      const now = Date.now();
      const runA = makeRun("distinct-a", now);
      const runB = makeRun("distinct-b", now);
      addSubagentRunForTests(runA);
      addSubagentRunForTests(runB);
      const storePath = path.join(testWorkspaceDir, "sessions-shared-cwd-distinct.json");
      await seedSessionEntry(
        storePath,
        runA.childSessionKey,
        path.join(testWorkspaceDir, "tree-a"),
      );
      await seedSessionEntry(
        storePath,
        runB.childSessionKey,
        path.join(testWorkspaceDir, "tree-b"),
      );
      const cfg = { session: { store: storePath } } as OpenClawConfig;

      const list = buildSubagentList({ cfg, runs: [runA, runB], recentMinutes: 30 });

      expect(list.active).toHaveLength(2);
      for (const item of list.active) {
        expect(item.sharedCwd).toBeUndefined();
        expect(item.line).not.toContain("shared cwd");
      }
    });

    it("groups live runs that reached one directory through a symlink alias", async () => {
      // Two callers can name the same checkout differently; lexical equality
      // alone would leave both concurrent writers unflagged.
      const now = Date.now();
      const realDir = path.join(testWorkspaceDir, "alias-real-tree");
      const linkDir = path.join(testWorkspaceDir, "alias-link-tree");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, linkDir, "dir");
      const runA = makeRun("alias-real", now);
      const runB = makeRun("alias-link", now);
      addSubagentRunForTests(runA);
      addSubagentRunForTests(runB);
      const storePath = path.join(testWorkspaceDir, "sessions-shared-cwd-alias.json");
      await seedSessionEntry(storePath, runA.childSessionKey, realDir);
      await seedSessionEntry(storePath, runB.childSessionKey, linkDir);
      const cfg = { session: { store: storePath } } as OpenClawConfig;

      const list = buildSubagentList({ cfg, runs: [runA, runB], recentMinutes: 30 });

      expect(list.active).toHaveLength(2);
      const canonical = await fs.realpath(realDir);
      const byRunId = new Map(list.active.map((item) => [item.runId, item]));
      expect(byRunId.get(runA.runId)?.sharedCwd).toEqual({
        path: canonical,
        peerRunIds: [runB.runId],
      });
      // The alias row reports the canonical directory, not the link it named.
      expect(byRunId.get(runB.runId)?.sharedCwd).toEqual({
        path: canonical,
        peerRunIds: [runA.runId],
      });
    });

    it("falls back to lexical comparison when an explicit directory no longer exists", async () => {
      // A deleted directory cannot be canonicalized; grouping must still work
      // off the recorded paths rather than throwing or dropping the advisory.
      const now = Date.now();
      const missingDir = path.join(testWorkspaceDir, "missing-tree");
      const runA = makeRun("missing-a", now);
      const runB = makeRun("missing-b", now);
      addSubagentRunForTests(runA);
      addSubagentRunForTests(runB);
      const storePath = path.join(testWorkspaceDir, "sessions-shared-cwd-missing.json");
      await seedSessionEntry(storePath, runA.childSessionKey, missingDir);
      await seedSessionEntry(storePath, runB.childSessionKey, missingDir);
      const cfg = { session: { store: storePath } } as OpenClawConfig;

      const list = buildSubagentList({ cfg, runs: [runA, runB], recentMinutes: 30 });

      expect(list.active).toHaveLength(2);
      for (const item of list.active) {
        expect(item.sharedCwd?.path).toBe(path.resolve(missingDir));
        expect(item.sharedCwd?.peerRunIds).toHaveLength(1);
      }
    });

    it("ignores ended runs that shared a directory", async () => {
      const now = Date.now();
      const sharedDir = path.join(testWorkspaceDir, "shared-tree-ended");
      const runA = makeRun("ended-share-a", now, { ended: true });
      const runB = makeRun("ended-share-b", now, { ended: true });
      addSubagentRunForTests(runA);
      addSubagentRunForTests(runB);
      const storePath = path.join(testWorkspaceDir, "sessions-shared-cwd-ended.json");
      await seedSessionEntry(storePath, runA.childSessionKey, sharedDir);
      await seedSessionEntry(storePath, runB.childSessionKey, sharedDir);
      const cfg = { session: { store: storePath } } as OpenClawConfig;

      const list = buildSubagentList({ cfg, runs: [runA, runB], recentMinutes: 30 });

      expect(list.active).toStrictEqual([]);
      expect(list.recent).toHaveLength(2);
      for (const item of list.recent) {
        expect(item.sharedCwd).toBeUndefined();
        expect(item.line).not.toContain("shared cwd");
      }
    });

    it("does not flag a live run whose only directory peer has ended", async () => {
      // Exclusivity is only at risk while both runs are live; a settled peer
      // leaves the directory to the survivor.
      const now = Date.now();
      const sharedDir = path.join(testWorkspaceDir, "shared-tree-mixed");
      const liveRun = makeRun("mixed-live", now);
      const endedRun = makeRun("mixed-ended", now, { ended: true });
      addSubagentRunForTests(liveRun);
      addSubagentRunForTests(endedRun);
      const storePath = path.join(testWorkspaceDir, "sessions-shared-cwd-mixed.json");
      await seedSessionEntry(storePath, liveRun.childSessionKey, sharedDir);
      await seedSessionEntry(storePath, endedRun.childSessionKey, sharedDir);
      const cfg = { session: { store: storePath } } as OpenClawConfig;

      const list = buildSubagentList({ cfg, runs: [liveRun, endedRun], recentMinutes: 30 });

      expect(list.active).toHaveLength(1);
      expect(list.active[0]?.runId).toBe(liveRun.runId);
      expect(list.active[0]?.sharedCwd).toBeUndefined();
      expect(list.active[0]?.line).not.toContain("shared cwd");
      expect(list.recent[0]?.sharedCwd).toBeUndefined();
    });
  });
});
