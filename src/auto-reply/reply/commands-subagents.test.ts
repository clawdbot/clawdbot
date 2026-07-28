/**
 * Tests subagent command output: status lines, info, log routing, shared text
 * extraction, and focus resolution. Grouped in one file because each command
 * test file pays the full auto-reply module graph on import; keep sibling
 * subagent command assertions here instead of new per-action files.
 */
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagent-registry-memory.js";
import {
  countPendingDescendantRunsFromRuns,
  listRunsForControllerFromRuns,
} from "../../agents/subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "../../agents/subagent-registry-state.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { failTaskRunByRunId } from "../../tasks/task-executor.js";
import { createTaskRecord } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import type { ReplyPayload } from "../types.js";
import { buildSubagentsStatusLine } from "./commands-status-subagents.js";
import { extractMessageText } from "./commands-subagents-text.js";
import { handleSubagentsInfoAction } from "./commands-subagents/action-info.js";
import { handleSubagentsLogAction } from "./commands-subagents/action-log.js";
import { resolveFocusTargetSession } from "./commands-subagents/shared.js";
import {
  baseCommandTestConfig,
  configureInMemoryTaskRegistryStoreForTests,
} from "./commands.test-harness.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (params: unknown) => callGatewayMock(params),
}));

function requireReplyText(reply: ReplyPayload | undefined): string {
  if (reply?.text === undefined) {
    throw new Error("expected reply text");
  }
  return reply.text;
}

describe("subagents status", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });

  it.each([
    {
      name: "omits subagent status line when none exist",
      seedRuns: () => undefined,
      verboseLevel: "on" as const,
      expectedText: [] as string[],
      unexpectedText: ["Subagents:"],
    },
    {
      name: "includes subagent count and active detail in /status when active",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
      },
      verboseLevel: "off" as const,
      expectedText: ["🤖 Subagents: 1 active", "  • do thing · 4s"],
      unexpectedText: [] as string[],
    },
    {
      name: "includes subagent details in /status when verbose",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
        addSubagentRunForTests({
          runId: "run-2",
          childSessionKey: "agent:main:subagent:def",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "finished task",
          cleanup: "keep",
          createdAt: 900,
          startedAt: 900,
          endedAt: 1200,
          outcome: { status: "ok" },
        });
      },
      verboseLevel: "on" as const,
      expectedText: ["🤖 Subagents: 1 active", "· 1 done", "  • do thing · 4s"],
      unexpectedText: [] as string[],
    },
    {
      name: "preserves verbose done-only summary",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:done-a",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "finished task",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
          endedAt: 2000,
          outcome: { status: "ok" },
        });
      },
      verboseLevel: "on" as const,
      expectedText: ["🤖 Subagents: 0 active · 1 done"],
      unexpectedText: ["  • finished task"],
    },
  ])("$name", ({ seedRuns, verboseLevel, expectedText, unexpectedText }) => {
    seedRuns();
    const runsSnapshot = getSubagentRunsSnapshotForRead(subagentRuns);
    const runs = listRunsForControllerFromRuns(runsSnapshot, "agent:main:main");
    const text =
      buildSubagentsStatusLine({
        runs,
        verboseEnabled: verboseLevel === "on",
        pendingDescendantsForRun: (entry) =>
          countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey),
        now: 5000,
      }) ?? "";
    for (const expected of expectedText) {
      expect(text).toContain(expected);
    }
    for (const blocked of unexpectedText) {
      expect(text).not.toContain(blocked);
    }
  });
});

describe("subagents info", () => {
  const TEST_SESSION_STORE_PATH = path.join(
    os.tmpdir(),
    `openclaw-commands-subagents-info-${process.pid}.json`,
  );

  function buildCommandTestConfig(): OpenClawConfig {
    return {
      ...baseCommandTestConfig,
      session: {
        ...baseCommandTestConfig.session,
        store: TEST_SESSION_STORE_PATH,
      },
    };
  }

  function buildInfoContext(params: { cfg: OpenClawConfig; runs: object[]; restTokens: string[] }) {
    return {
      params: {
        cfg: params.cfg,
        sessionKey: "agent:main:main",
      },
      handledPrefix: "/subagents",
      requesterKey: "agent:main:main",
      runs: params.runs,
      restTokens: params.restTokens,
    } as Parameters<typeof handleSubagentsInfoAction>[0];
  }

  beforeEach(() => {
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
    resetSubagentRegistryForTests();
  });

  it("returns usage for missing targets", () => {
    const cfg = {
      commands: { text: true },
      channels: { quietchat: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const result = handleSubagentsInfoAction(buildInfoContext({ cfg, runs: [], restTokens: [] }));
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/subagents info <id|#>");
  });

  it("returns info for a subagent", () => {
    const now = Date.now();
    const runId = "commands-subagents-info-run";
    const childSessionKey = "agent:main:subagent:commands-info";
    const run = {
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey,
      runId,
      task: "do thing",
      status: "succeeded",
      terminalSummary: "Completed the requested task",
      deliveryStatus: "delivered",
    });
    const cfg = buildCommandTestConfig();
    const result = handleSubagentsInfoAction(
      buildInfoContext({ cfg, runs: [run], restTokens: ["1"] }),
    );
    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("Subagent info");
    expect(text).toContain(`Run: ${runId}`);
    expect(text).toContain("Status: done");
    expect(text).toContain("TaskStatus: succeeded");
    expect(text).toContain("Task summary: Completed the requested task");
  });

  it("omits Date-invalid subagent timestamps", () => {
    const runId = "commands-subagents-info-invalid-date-run";
    const childSessionKey = "agent:main:subagent:commands-info-invalid-date";
    const run = {
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "inspect invalid timestamps",
      cleanup: "keep",
      createdAt: 8_640_000_000_000_001,
      startedAt: 8_640_000_000_000_001,
      endedAt: 8_640_000_000_000_001,
      archiveAtMs: 8_640_000_000_000_001,
      outcome: { status: "ok" },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const cfg = buildCommandTestConfig();

    const result = handleSubagentsInfoAction(
      buildInfoContext({ cfg, runs: [run], restTokens: ["1"] }),
    );

    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expect(text).toContain(`Run: ${runId}`);
    expect(text).toContain("Created: n/a");
    expect(text).toContain("Started: n/a");
    expect(text).toContain("Ended: n/a");
    expect(text).toContain("Archive: n/a");
    expect(text).not.toContain("Invalid Date");
  });

  it("sanitizes leaked task details in /subagents info", () => {
    const now = Date.now();
    const runId = "commands-subagents-info-leak-run";
    const childSessionKey = "agent:main:subagent:commands-info-leak";
    const run = {
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Inspect the stuck run",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: {
        status: "error",
        error: [
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "",
          "[Internal task completion event]",
          "source: subagent",
        ].join("\n"),
      },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey,
      runId,
      task: "Inspect the stuck run",
      status: "running",
      deliveryStatus: "delivered",
    });
    failTaskRunByRunId({
      runId,
      endedAt: now - 1_000,
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      terminalSummary: "Needs manual follow-up.",
    });
    const cfg = buildCommandTestConfig();
    const result = handleSubagentsInfoAction(
      buildInfoContext({ cfg, runs: [run], restTokens: ["1"] }),
    );
    const text = requireReplyText(result.reply);

    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("Subagent info");
    expect(text).toContain("Outcome: error");
    expect(text).toContain("Task summary: Needs manual follow-up.");
    expect(text).not.toContain("OpenClaw runtime context (internal):");
    expect(text).not.toContain("Internal task completion event");
  });

  it("uses the requester key for task ownership lookup", () => {
    const now = Date.now();
    const runId = "commands-subagents-info-routed-run";
    const childSessionKey = "agent:main:subagent:commands-info-routed";
    const run = {
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:target",
      requesterDisplayKey: "target",
      task: "do routed thing",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:target",
      childSessionKey,
      runId,
      task: "do routed thing",
      status: "succeeded",
      terminalSummary: "Resolved via routed owner key",
      deliveryStatus: "delivered",
    });
    const cfg = {
      commands: { text: true },
      channels: { quietchat: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender", store: TEST_SESSION_STORE_PATH },
    } as OpenClawConfig;
    const result = handleSubagentsInfoAction({
      params: {
        cfg,
        sessionKey: "agent:main:slash-session",
      },
      handledPrefix: "/subagents",
      requesterKey: "agent:main:target",
      runs: [run],
      restTokens: ["1"],
    } as Parameters<typeof handleSubagentsInfoAction>[0]);
    const text = requireReplyText(result.reply);

    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("TaskStatus: succeeded");
    expect(text).toContain("Task summary: Resolved via routed owner key");
  });
});

describe("subagents log", () => {
  function makeRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
    return {
      runId: "run-subagent-log",
      childSessionKey: "agent:main:subagent:log",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "inspect logs",
      cleanup: "keep",
      createdAt: Date.now() - 10_000,
      startedAt: Date.now() - 10_000,
      ...overrides,
    };
  }

  function buildLogContext(restTokens: string[], runs: SubagentRunRecord[]) {
    return {
      params: {
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:main",
      },
      handledPrefix: "/subagents",
      requesterKey: "agent:main:main",
      runs,
      restTokens,
    } as Parameters<typeof handleSubagentsLogAction>[0];
  }

  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({
      messages: [{ role: "assistant", content: "log line" }],
    });
  });

  it("does not treat a numeric target as the history limit", async () => {
    const result = await handleSubagentsLogAction(buildLogContext(["1"], [makeRun()]));

    expect(result.shouldContinue).toBe(false);
    expect(requireReplyText(result.reply)).toContain("log line");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:log", limit: 20 },
    });
  });

  it("uses the numeric token after the target as the history limit", async () => {
    await handleSubagentsLogAction(buildLogContext(["1", "5"], [makeRun()]));

    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:log", limit: 5 },
    });
  });

  it("clamps a zero history limit to one", async () => {
    await handleSubagentsLogAction(buildLogContext(["1", "0"], [makeRun()]));

    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:log", limit: 1 },
    });
  });

  it("ignores unsafe history limit tokens", async () => {
    await handleSubagentsLogAction(buildLogContext(["1", "9007199254740992"], [makeRun()]));

    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:log", limit: 20 },
    });
  });
});

describe("extractMessageText", () => {
  it("preserves user markers and sanitizes assistant markers", () => {
    const cases = [
      {
        message: { role: "user", content: "Here [Tool Call: foo (ID: 1)] ok" },
        expectedText: "Here [Tool Call: foo (ID: 1)] ok",
      },
      {
        message: { role: "assistant", content: "Here [Tool Call: foo (ID: 1)] ok" },
        expectedText: "Here ok",
      },
    ] as const;

    for (const testCase of cases) {
      const result = extractMessageText(testCase.message);
      expect(result?.text).toBe(testCase.expectedText);
    }
  });
});

describe("resolveFocusTargetSession", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("restricts gateway fallback resolution to a subagent requester's children", async () => {
    callGatewayMock.mockResolvedValue({
      key: "agent:main:subagent:child",
    });

    const result = await resolveFocusTargetSession({
      runs: [],
      token: "child",
      requesterKey: "agent:main:subagent:parent",
    });

    expect(result?.targetSessionKey).toBe("agent:main:subagent:child");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.resolve",
      params: {
        key: "child",
        spawnedBy: "agent:main:subagent:parent",
      },
    });
  });
});
