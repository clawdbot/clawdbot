import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import { buildSubagentList } from "./subagent-list.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

let testWorkspaceDir = os.tmpdir();

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-list-meta-"));
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSubagentList metadata projection", () => {
  it("does not decode unrelated saved prompts in a large session store", () => {
    const run = {
      runId: "run-meta",
      childSessionKey: "agent:main:subagent:target",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "target task",
      cleanup: "keep",
      createdAt: 1000,
      execution: { status: "running", startedAt: 1000 },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);

    const storePath = path.join(testWorkspaceDir, "sessions-metadata-projection.json");
    // Seed 20 unrelated sessions whose skillsSnapshot.prompt is a 4 KiB blob.
    for (let i = 0; i < 20; i++) {
      replaceSessionEntrySync(
        { storePath, sessionKey: `agent:main:subagent:other-${i}` },
        {
          sessionId: `other-${i}`,
          updatedAt: 1,
          skillsSnapshot: {
            prompt: `UNRELATED_PAYLOAD_${"x".repeat(4096)}`,
            skills: [],
          },
        },
      );
    }
    // Seed the one target session the list actually consumes.
    replaceSessionEntrySync(
      { storePath, sessionKey: "agent:main:subagent:target" },
      {
        sessionId: "target",
        updatedAt: 2000,
        model: "opencode/claude-opus-4-6",
        inputTokens: 5,
        outputTokens: 10,
        totalTokens: 15,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    );

    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;

    const parse = vi.spyOn(JSON, "parse");
    const list = buildSubagentList({
      cfg,
      runs: [run],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    // The target session must still appear in the active list.
    expect(list.active[0]?.task).toBe("target task");

    const unrelatedParses = parse.mock.calls.filter(
      ([value]) => typeof value === "string" && value.includes("UNRELATED_PAYLOAD_"),
    ).length;
    expect(unrelatedParses).toBe(0);
  });
});
