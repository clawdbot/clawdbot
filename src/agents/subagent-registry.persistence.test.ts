import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const noop = () => {};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({
    status: "ok",
    startedAt: 111,
    endedAt: 222,
  })),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => noop),
}));

const announceSpy = vi.fn(async () => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: (...args: unknown[]) => announceSpy(...args),
}));

describe("subagent registry persistence", () => {
  const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
  let tempStateDir: string | null = null;

  afterEach(async () => {
    announceSpy.mockClear();
    vi.resetModules();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousStateDir === undefined) {
      delete process.env.CLAWDBOT_STATE_DIR;
    } else {
      process.env.CLAWDBOT_STATE_DIR = previousStateDir;
    }
  });

  it("persists runs to disk and resumes after restart", async () => {
    tempStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-subagent-"),
    );
    process.env.CLAWDBOT_STATE_DIR = tempStateDir;

    vi.resetModules();
    const mod1 = await import("./subagent-registry.js");

    mod1.registerSubagentRun({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do the thing",
      cleanup: "keep",
    });

    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as { runs?: Record<string, unknown> };
    expect(parsed.runs && Object.keys(parsed.runs)).toContain("run-1");

    // Simulate a process restart: module re-import should load persisted runs
    // and trigger the announce flow once the run resolves.
    vi.resetModules();
    const mod2 = await import("./subagent-registry.js");
    mod2.initSubagentRegistry();

    // allow queued async wait/announce to execute
    await new Promise((r) => setTimeout(r, 0));

    expect(announceSpy).toHaveBeenCalled();

    type AnnounceParams = {
      childRunId: string;
      childSessionKey: string;
    };
    const first = announceSpy.mock.calls[0]?.[0] as unknown as AnnounceParams;
    expect(first.childRunId).toBe("run-1");
    expect(first.childSessionKey).toBe("agent:main:subagent:test");
  });

  it("retries announce even when announceHandled was persisted", async () => {
    tempStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-subagent-"),
    );
    process.env.CLAWDBOT_STATE_DIR = tempStateDir;

    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    const persisted = {
      version: 1,
      runs: {
        "run-2": {
          runId: "run-2",
          childSessionKey: "agent:main:subagent:two",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do the other thing",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
          announceHandled: true,
        },
      },
    };
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");

    vi.resetModules();
    const mod = await import("./subagent-registry.js");
    mod.initSubagentRegistry();

    await new Promise((r) => setTimeout(r, 0));

    const calls = announceSpy.mock.calls.map((call) => call[0]);
    const match = calls.find(
      (params) => (params as { childRunId?: string }).childRunId === "run-2",
    );
    expect(match).toBeTruthy();
  });
});
