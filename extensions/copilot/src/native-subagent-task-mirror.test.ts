import { createHash } from "node:crypto";
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
const REQUESTER_SESSION_KEY = "agent:main:discord:channel:C123";

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
    emitSubagentProgress: vi.fn(),
  } satisfies Pick<
    AgentHarnessTaskRuntime,
    | "tryCreateRunningTaskRun"
    | "recordTaskRunProgressByRunId"
    | "finalizeTaskRunByRunId"
    | "emitSubagentProgress"
  >;
}

function createMirror(
  runtime: ReturnType<typeof createRuntime>,
  params: { agentId?: string; now?: () => number; requesterSessionKey?: string } = {},
) {
  taskRuntimeMocks.runtime = runtime;
  const { requesterSessionKey = REQUESTER_SESSION_KEY, ...mirrorParams } = params;
  const mirror = createCopilotNativeSubagentTaskMirror({
    ...mirrorParams,
    scope: { requesterSessionKey } as AgentHarnessTaskRuntimeScope,
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
      runId: copilotRunId("child-1"),
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
      runId: copilotRunId("child-1"),
      status: "succeeded",
      endedAt: 100,
      lastEventAt: 100,
      progressSummary: "Copilot native subagent completed.",
      terminalSummary: "Copilot native subagent completed (2 tool calls, 30 tokens).",
    });
    expect(runtime.emitSubagentProgress).toHaveBeenNthCalledWith(1, {
      phase: "started",
      runId: copilotRunId("child-1"),
      childSessionKey: copilotRunId("child-1"),
    });
    expect(runtime.emitSubagentProgress).toHaveBeenNthCalledWith(2, {
      phase: "ended",
      runId: copilotRunId("child-1"),
      childSessionKey: copilotRunId("child-1"),
      outcome: "ok",
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
        runId: copilotRunId("call-2"),
        status: "failed",
        error: "failed",
      }),
    );
    expect(runtime.emitSubagentProgress).toHaveBeenLastCalledWith({
      phase: "ended",
      runId: copilotRunId("call-2"),
      childSessionKey: copilotRunId("call-2"),
      outcome: "error",
    });
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
      expect.objectContaining({ runId: copilotRunId("child-1") }),
    );
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: copilotRunId("child-2") }),
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
      runId: copilotRunId("call-3"),
      status: "cancelled",
      endedAt: 300,
      lastEventAt: 300,
      error: "Copilot native subagent ended with its parent attempt.",
      progressSummary: "Copilot native subagent cancelled with its parent attempt.",
      terminalSummary: "Copilot native subagent cancelled.",
    });
    expect(runtime.emitSubagentProgress).toHaveBeenLastCalledWith({
      phase: "ended",
      runId: copilotRunId("call-3"),
      childSessionKey: copilotRunId("call-3"),
      outcome: "killed",
    });
  });

  it("does not create conflicting presentation when terminal events arrive before start", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 400 });
    const failed = makeEvent("subagent.failed", {
      agentDisplayName: "Researcher",
      agentName: "researcher",
      error: "failed before replayed start",
      toolCallId: "call-reordered",
    });

    mirror.handleEvent(failed);
    mirror.handleEvent(
      makeEvent("subagent.started", {
        agentDescription: "inspect",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-reordered",
      }),
    );
    mirror.handleEvent(failed);

    expect(runtime.tryCreateRunningTaskRun).not.toHaveBeenCalled();
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(runtime.emitSubagentProgress).not.toHaveBeenCalled();
  });

  it("namespaces presentation run ids by requester session", () => {
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    const first = createMirror(firstRuntime, { requesterSessionKey: "agent:main:session-a" });
    const second = createMirror(secondRuntime, { requesterSessionKey: "agent:main:session-b" });
    const event = makeEvent("subagent.started", {
      agentDescription: "inspect",
      agentDisplayName: "Researcher",
      agentName: "researcher",
      toolCallId: "call-shared",
    });

    first.handleEvent(event);
    second.handleEvent(event);

    const firstRunId = firstRuntime.emitSubagentProgress.mock.calls[0]?.[0].runId;
    const secondRunId = secondRuntime.emitSubagentProgress.mock.calls[0]?.[0].runId;
    expect(firstRunId).toMatch(/^copilot-agent:[a-f0-9]{16}:call-shared$/u);
    expect(secondRunId).toMatch(/^copilot-agent:[a-f0-9]{16}:call-shared$/u);
    expect(firstRunId).not.toBe(secondRunId);
  });
});

function copilotRunId(identity: string): string {
  const namespace = createHash("sha256").update(REQUESTER_SESSION_KEY).digest("hex").slice(0, 16);
  return `copilot-agent:${namespace}:${identity}`;
}
