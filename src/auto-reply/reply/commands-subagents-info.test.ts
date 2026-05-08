import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { failTaskRunByRunId } from "../../tasks/task-executor.js";
import { createTaskRecord, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import type { ReplyPayload } from "../types.js";
import { handleSubagentsInfoAction } from "./commands-subagents/action-info.js";
import {
  baseCommandTestConfig,
  configureInMemoryTaskRegistryStoreForTests,
} from "./commands.test-harness.js";

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

function requireReplyText(reply: ReplyPayload | undefined): string {
  if (reply?.text === undefined) {
    throw new Error("expected reply text");
  }
  return reply.text;
}

beforeEach(() => {
  resetTaskRegistryForTests({ persist: false });
  configureInMemoryTaskRegistryStoreForTests();
  resetSubagentRegistryForTests();
});

describe("subagents info", () => {
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
