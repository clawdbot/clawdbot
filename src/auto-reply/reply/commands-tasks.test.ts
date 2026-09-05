// Tests task command routing and persisted task state replies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeTaskRunByRunIdCore,
  createQueuedTaskRunCore,
  createRunningTaskRunCore,
  failTaskRunByRunIdCore,
} from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { handleTasksCommand } from "./commands-tasks.js";
import {
  baseCommandTestConfig,
  buildCommandTestParams,
  configureInMemoryTaskRegistryStoreForTests,
} from "./commands.test-harness.js";

const baseCfg = baseCommandTestConfig;

async function buildTasksReplyForTest(
  params: {
    agentId?: string;
    sessionKey?: string;
    cfg?: Parameters<typeof buildCommandTestParams>[1];
  } = {},
) {
  const commandParams = buildCommandTestParams("/tasks", params.cfg ?? baseCfg);
  const result = await handleTasksCommand(
    {
      ...commandParams,
      agentId: params.agentId ?? commandParams.agentId,
      sessionKey: params.sessionKey ?? commandParams.sessionKey,
    },
    true,
  );
  if (!result?.reply) {
    throw new Error("expected /tasks reply");
  }
  return result.reply;
}

describe("handleTasksCommand task board", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
  });

  it("lists active and recent tasks for the current session", async () => {
    createRunningTaskRunCore({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:tasks-running",
      runId: "run-tasks-running",
      task: "active background task",
      progressSummary: "still working",
    });
    createQueuedTaskRunCore({
      runtime: "cron",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:tasks-queued",
      runId: "run-tasks-queued",
      task: "queued background task",
    });
    createRunningTaskRunCore({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:acp:tasks-failed",
      runId: "run-tasks-failed",
      task: "failed background task",
    });
    failTaskRunByRunIdCore({
      runId: "run-tasks-failed",
      endedAt: Date.now(),
      error: "approval denied",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("📋 Tasks");
    expect(reply.text).toContain("Current session: 2 active · 3 total");
    expect(reply.text).toContain("🟢 active background task");
    expect(reply.text).toContain("🟡 queued background task");
    expect(reply.text).toContain("🔴 failed background task");
    expect(reply.text).toContain("approval denied");
  });

  it("shows blocked completions as warnings instead of successes", async () => {
    createRunningTaskRunCore({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:tasks-blocked",
      runId: "run-tasks-blocked",
      task: "Incomplete background task",
    });
    completeTaskRunByRunIdCore({
      runId: "run-tasks-blocked",
      endedAt: Date.now(),
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("⚠️ Incomplete background task");
    expect(reply.text).toContain("Subagent · blocked");
    expect(reply.text).not.toContain("✅ Incomplete background task");
  });

  it.each(["research", "ops"])("isolates the global task board for %s", async (agentId) => {
    for (const requesterAgentId of ["research", "ops", undefined]) {
      const executorAgentId = requesterAgentId === "research" ? "ops" : "research";
      createRunningTaskRunCore({
        runtime: "cli",
        requesterSessionKey: "global",
        requesterAgentId,
        agentId: executorAgentId,
        childSessionKey: `agent:${executorAgentId}:subagent:${requesterAgentId ?? "unknown"}`,
        runId: `global-board-task-${requesterAgentId ?? "unknown"}`,
        task: `${requesterAgentId ?? "unknown"} private task`,
      });
    }

    const reply = await buildTasksReplyForTest({
      sessionKey: "global",
      agentId,
      cfg: {
        ...baseCfg,
        session: { scope: "global" },
        agents: { ownership: "explicit", entries: { research: {}, ops: {} } },
      },
    });

    expect(reply.text).toContain("Current session: 1 active · 1 total");
    expect(reply.text).toContain(`${agentId} private task`);
    expect(reply.text).not.toContain(`${agentId === "research" ? "ops" : "research"} private task`);
    expect(reply.text).not.toContain("unknown private task");
  });

  it("lists session-backed video generation tasks for the current session", async () => {
    createRunningTaskRunCore({
      runtime: "cli",
      taskKind: "video_generation",
      sourceId: "video_generate:openai",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:main",
      runId: "tool:video_generate:tasks-visible",
      label: "Video generation",
      task: "friendly lobster surfing",
      progressSummary: "Queued video generation",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("Current session: 1 active · 1 total");
    expect(reply.text).toContain("🟢 Video generation");
    expect(reply.text).toContain("CLI · running");
    expect(reply.text).toContain("Queued video generation");
  });

  it("lists session-backed image generation tasks for the current session", async () => {
    createRunningTaskRunCore({
      runtime: "cli",
      taskKind: "image_generation",
      sourceId: "image_generate:openai",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:main",
      runId: "tool:image_generate:tasks-visible",
      label: "Image generation",
      task: "blue square icon",
      progressSummary: "Queued image generation",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("Current session: 1 active · 1 total");
    expect(reply.text).toContain("🟢 Image generation");
    expect(reply.text).toContain("CLI · running");
    expect(reply.text).toContain("Queued image generation");
  });

  it("sanitizes leaked internal runtime context from visible task details", async () => {
    createRunningTaskRunCore({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:acp:tasks-sanitized-failed",
      runId: "run-tasks-sanitized-failed",
      task: "Visible failed task",
      progressSummary: "still working",
    });
    failTaskRunByRunIdCore({
      runId: "run-tasks-sanitized-failed",
      endedAt: Date.now(),
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      terminalSummary: "Needs a login refresh.",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("Visible failed task");
    expect(reply.text).toContain("Needs a login refresh.");
    expect(reply.text).not.toContain("OpenClaw runtime context (internal):");
    expect(reply.text).not.toContain("Internal task completion event");
  });

  it("sanitizes inline internal runtime fences from visible task titles", async () => {
    createRunningTaskRunCore({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:main",
      runId: "run-tasks-inline-fence",
      task: [
        "[Mon 2026-04-06 02:42 GMT+1] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
      ].join("\n"),
      progressSummary: "done",
    });
    completeTaskRunByRunIdCore({
      runId: "run-tasks-inline-fence",
      endedAt: Date.now(),
      terminalSummary: "Finished.",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("Background task");
    expect(reply.text).toContain("Finished.");
    expect(reply.text).not.toContain("[Mon 2026-04-06 02:42 GMT+1]");
    expect(reply.text).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
    expect(reply.text).not.toContain("OpenClaw runtime context (internal):");
  });

  it("hides stale completed tasks from the task board", async () => {
    createQueuedTaskRunCore({
      runtime: "cron",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:tasks-stale",
      runId: "run-tasks-stale",
      task: "stale completed task",
    });
    completeTaskRunByRunIdCore({
      runId: "run-tasks-stale",
      endedAt: Date.now() - 10 * 60_000,
      terminalSummary: "done a while ago",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).not.toContain("stale completed task");
    expect(reply.text).not.toContain("done a while ago");
  });

  it("falls back to agent-local counts when the current session has no visible tasks", async () => {
    createRunningTaskRunCore({
      runtime: "subagent",
      requesterSessionKey: "agent:main:other-session",
      childSessionKey: "agent:main:subagent:tasks-agent-fallback",
      runId: "run-tasks-agent-fallback",
      agentId: "main",
      task: "hidden background task",
      progressSummary: "hidden progress detail",
    });

    const reply = await buildTasksReplyForTest({
      sessionKey: "agent:main:empty-session",
    });

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).toContain("Agent-local: 1 active · 1 total");
    expect(reply.text).not.toContain("hidden background task");
    expect(reply.text).not.toContain("hidden progress detail");
  });

  it("counts session-backed video generation tasks in agent-local fallback", async () => {
    createRunningTaskRunCore({
      runtime: "cli",
      taskKind: "video_generation",
      sourceId: "video_generate:openai",
      requesterSessionKey: "agent:main:other-session",
      childSessionKey: "agent:main:other-session",
      runId: "tool:video_generate:tasks-agent-fallback",
      label: "Video generation",
      task: "hidden video background task",
      progressSummary: "Queued video generation",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    const reply = await buildTasksReplyForTest({
      sessionKey: "agent:main:empty-session",
    });

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).toContain("Agent-local: 1 active · 1 total");
    expect(reply.text).not.toContain("hidden video background task");
    expect(reply.text).not.toContain("Queued video generation");
  });

  it("uses the canonical target session agent for agent-local fallback counts", async () => {
    createRunningTaskRunCore({
      runtime: "subagent",
      requesterSessionKey: "agent:target:other-session",
      childSessionKey: "agent:target:subagent:tasks-target-fallback",
      runId: "run-tasks-target-fallback",
      agentId: "target",
      task: "target hidden background task",
      progressSummary: "hidden target progress detail",
    });
    const reply = await buildTasksReplyForTest({
      agentId: "target",
      sessionKey: "agent:target:empty-session",
    });

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).toContain("Agent-local: 1 active · 1 total");
    expect(reply.text).not.toContain("target hidden background task");
  });
});

describe("handleTasksCommand", () => {
  it("returns usage for unsupported args", async () => {
    const params = buildCommandTestParams("/tasks extra", baseCfg);

    const result = await handleTasksCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /tasks" },
    });
  });
});
