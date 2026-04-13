import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { buildSubagentList } from "./subagent-list.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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
    expect(list.active).toEqual([]);
    expect(list.recent).toEqual([]);
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
      startedAt: 1000,
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
    expect(list.active[0]?.line).toContain(
      "This is a deliberately long task description used to verify that subagent list output keeps the full task text",
    );
    expect(list.active[0]?.line).toContain("...");
    expect(list.active[0]?.line).not.toContain("after a short hard cutoff.");
  });

  it("keeps ended orchestrators active while descendants remain pending", () => {
    const now = Date.now();
    const orchestratorRun = {
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate child workers",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
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
    expect(list.recent).toEqual([]);
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
      startedAt: 1000,
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const storePath = path.join(testWorkspaceDir, "sessions-subagent-list-usage.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:subagent:usage"] = {
        sessionId: "child-session-usage",
        updatedAt: Date.now(),
        inputTokens: 12,
        outputTokens: 1000,
        totalTokens: 197000,
        model: "opencode/claude-opus-4-6",
      };
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
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
});
