import type { SessionEvent } from "@github/copilot-sdk";
import type {
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntime,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCopilotNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

const taskRuntimeMocks = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock("openclaw/plugin-sdk/agent-harness-task-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-task-runtime")>();
  return {
    ...actual,
    createAgentHarnessTaskRuntime: vi.fn(() => taskRuntimeMocks.runtime),
  };
});

type NativeSubagentEventType = "subagent.started" | "subagent.completed" | "subagent.failed";

function makeEvent<T extends NativeSubagentEventType>(
  type: T,
  data: Extract<SessionEvent, { type: T }>["data"],
  agentId?: string,
): Extract<SessionEvent, { type: T }> {
  return {
    data,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    type,
    ...(agentId ? { agentId } : {}),
  } as Extract<SessionEvent, { type: T }>;
}

function createRuntime() {
  const task = {} as AgentHarnessTaskRecord;
  return {
    tryCreateRunningTaskRun: vi.fn(() => task),
    recordTaskRunProgressByRunId: vi.fn(() => []),
    finalizeTaskRunByRunId: vi.fn(() => []),
  } satisfies Pick<
    AgentHarnessTaskRuntime,
    "tryCreateRunningTaskRun" | "recordTaskRunProgressByRunId" | "finalizeTaskRunByRunId"
  >;
}

function createMirror(
  runtime: ReturnType<typeof createRuntime>,
  params: { agentId?: string; now?: () => number } = {},
) {
  taskRuntimeMocks.runtime = runtime;
  const mirror = createCopilotNativeSubagentTaskMirror({
    ...params,
    scope: {} as AgentHarnessTaskRuntimeScope,
  });
  if (!mirror) {
    throw new Error("expected Copilot native subagent task mirror");
  }
  return mirror;
}

describe("CopilotNativeSubagentTaskMirror", () => {
  it("does not create a mirror without a host-issued task scope", () => {
    expect(createCopilotNativeSubagentTaskMirror({})).toBeUndefined();
  });

  it("mirrors start and completion using agentId with toolCallId fallback", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { agentId: "parent-agent", now: () => 100 });

    mirror.handleEvent(
      makeEvent(
        "subagent.started",
        {
          agentDescription: "inspect the repository",
          agentDisplayName: "Researcher",
          agentName: "researcher",
          toolCallId: "call-1",
        },
        "child-1",
      ),
    );
    mirror.handleEvent(
      makeEvent(
        "subagent.completed",
        {
          agentDisplayName: "Researcher",
          agentName: "researcher",
          toolCallId: "call-1",
          totalToolCalls: 2,
          totalTokens: 30,
        },
        "child-1",
      ),
    );

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledWith({
      sourceId: "call-1",
      agentId: "parent-agent",
      runId: "copilot-agent:child-1",
      label: "Researcher",
      task: "inspect the repository",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: 100,
      lastEventAt: 100,
      progressSummary: "Copilot native subagent started.",
    });
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "copilot-agent:child-1",
      status: "succeeded",
      endedAt: 100,
      lastEventAt: 100,
      progressSummary: "Copilot native subagent completed.",
      terminalSummary: "Copilot native subagent completed (2 tool calls, 30 tokens).",
    });
  });

  it("uses toolCallId when the SDK omits agentId", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 200 });

    mirror.handleEvent(
      makeEvent("subagent.started", {
        agentDescription: "",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-2",
      }),
    );
    mirror.handleEvent(
      makeEvent("subagent.failed", {
        agentDisplayName: "Researcher",
        agentName: "researcher",
        error: "failed",
        toolCallId: "call-2",
      }),
    );

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "copilot-agent:call-2",
        status: "failed",
        error: "failed",
      }),
    );
  });

  it("keeps parallel subagents distinct when they share a parent tool call", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 250 });

    for (const agentId of ["child-1", "child-2"]) {
      mirror.handleEvent(
        makeEvent(
          "subagent.started",
          {
            agentDescription: `inspect ${agentId}`,
            agentDisplayName: "Researcher",
            agentName: "researcher",
            toolCallId: "call-shared",
          },
          agentId,
        ),
      );
    }
    for (const agentId of ["child-1", "child-2"]) {
      mirror.handleEvent(
        makeEvent(
          "subagent.completed",
          {
            agentDisplayName: "Researcher",
            agentName: "researcher",
            toolCallId: "call-shared",
          },
          agentId,
        ),
      );
    }

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledTimes(2);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(2);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runId: "copilot-agent:child-1" }),
    );
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: "copilot-agent:child-2" }),
    );
  });

  it("finalizes active tasks when the parent attempt tears down", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 300 });

    mirror.handleEvent(
      makeEvent("subagent.started", {
        agentDescription: "inspect",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-3",
      }),
    );
    mirror.finalizeActiveRuns();

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "copilot-agent:call-3",
      status: "cancelled",
      endedAt: 300,
      lastEventAt: 300,
      error: "Copilot native subagent ended with its parent attempt.",
      progressSummary: "Copilot native subagent cancelled with its parent attempt.",
      terminalSummary: "Copilot native subagent cancelled.",
    });
  });
});
