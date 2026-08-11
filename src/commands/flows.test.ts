// Flows command tests cover task creation, task execution, and runtime command output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import type { RuntimeEnv } from "../runtime.js";
import { createRunningTaskRunCore as createRunningTaskRunOrNull } from "../tasks/task-executor.js";
import { createManagedTaskFlow as createManagedTaskFlowOrNull } from "../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { markTaskLostById, markTaskTerminalById } from "../tasks/task-registry.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { flowsCancelCommand, flowsListCommand, flowsShowCommand } from "./flows.js";

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  loadConfig: vi.fn(() => ({})),
  resetConfigRuntimeState: () => undefined,
}));

function jsonRoundTrip<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function createRunningTaskRunCore(
  params: Parameters<typeof createRunningTaskRunOrNull>[0],
): TaskRecord {
  const task = createRunningTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected running task creation to succeed");
  }
  return task;
}

type TestRuntime = RuntimeEnv & {
  writeStdout: ReturnType<typeof vi.fn>;
  writeJson: ReturnType<typeof vi.fn>;
};

function createRuntime(): TestRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

async function withTaskFlowCommandStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-flows-command-",
    },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run(state.stateDir);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("flows commands", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("lists TaskFlows as JSON with linked tasks and summaries", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect a PR cluster",
        status: "blocked",
        blockedSummary: "Waiting on child task",
        createdAt: 100,
        updatedAt: 100,
      });

      const childTask = createRunningTaskRunCore({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-child-1",
        label: "Inspect PR 123",
        task: "Inspect PR 123",
        startedAt: 100,
        lastEventAt: 100,
      });

      const runtime = createRuntime();
      await flowsListCommand({ json: true, status: "blocked" }, runtime);

      expect(runtime.log).not.toHaveBeenCalled();
      const payload = jsonRoundTrip(vi.mocked(runtime.writeJson).mock.calls[0]?.[0]);

      expect(payload).toStrictEqual({
        count: 1,
        status: "blocked",
        flows: [
          {
            ...jsonRoundTrip(flow),
            tasks: [jsonRoundTrip(childTask)],
            taskSummary: {
              total: 1,
              active: 1,
              terminal: 0,
              failures: 0,
              byStatus: {
                queued: 0,
                running: 1,
                succeeded: 0,
                failed: 0,
                timed_out: 0,
                cancelled: 0,
                lost: 0,
              },
              byRuntime: {
                subagent: 0,
                acp: 1,
                cli: 0,
                cron: 0,
              },
            },
          },
        ],
      });
    });
  });

  it("reports blank status filters as absent in JSON output", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect a PR cluster",
        status: "running",
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsListCommand({ json: true, status: "   " }, runtime);

      expect(runtime.log).not.toHaveBeenCalled();
      expect(jsonRoundTrip(vi.mocked(runtime.writeJson).mock.calls[0]?.[0])).toMatchObject({
        count: 1,
        status: null,
        flows: [expect.objectContaining(jsonRoundTrip(flow))],
      });
    });
  });

  it("counts pending cancellation intent in TaskFlow pressure", async () => {
    await withTaskFlowCommandStateDir(async () => {
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Cancel pending work",
        status: "running",
        cancelRequestedAt: 200,
        createdAt: 100,
        updatedAt: 200,
      });

      const runtime = createRuntime();
      await flowsListCommand({}, runtime);

      expect(vi.mocked(runtime.log).mock.calls.map(([line]) => String(line))).toContain(
        "TaskFlow pressure: 1 active · 0 blocked · 1 cancel-requested · 1 total",
      );
    });
  });

  it("keeps truncated text rows UTF-16 well-formed", async () => {
    await withTaskFlowCommandStateDir(async () => {
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: `${"x".repeat(18)}🚀tail`,
        goal: "Inspect a PR cluster",
        status: "running",
        createdAt: 100,
        updatedAt: 100,
      });
      const runtime = createRuntime();

      await flowsListCommand({}, runtime);

      const output = vi
        .mocked(runtime.log)
        .mock.calls.map(([line]) => String(line))
        .join("\n");
      expect(output).toContain(`${"x".repeat(18)}…`);
      expect(output).not.toContain("\uD83D");
    });
  });

  it("keeps TaskFlow columns aligned for wide controller ids", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const controllers = [
        { controllerId: "plain-controller", goal: "Plain controller" },
        { controllerId: "控制器🚀", goal: "Wide controller" },
        { controllerId: "控制器".repeat(8), goal: "Long wide controller" },
      ];
      for (const [index, entry] of controllers.entries()) {
        createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: entry.controllerId,
          goal: entry.goal,
          status: "running",
          createdAt: 100 + index,
          updatedAt: 100 + index,
        });
      }
      const runtime = createRuntime();

      await flowsListCommand({}, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      const countColumnWidths = controllers.map((entry) => {
        const line = lines.find((candidate) => candidate.endsWith(entry.goal));
        expect(line).toBeDefined();
        return visibleWidth((line ?? "").slice(0, (line ?? "").indexOf("0 active/0 total")));
      });
      expect(new Set(countColumnWidths).size).toBe(1);
      expect(lines.find((line) => line.endsWith("Long wide controller"))).toContain("…");
    });
  });

  it("shows one TaskFlow as JSON through the runtime JSON writer", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect a single flow",
        status: "running",
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: true }, runtime);

      expect(runtime.log).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.writeJson).mock.calls[0]?.[0]).toMatchObject({
        ...jsonRoundTrip(flow),
        tasks: [],
        taskSummary: {
          total: 0,
          active: 0,
          terminal: 0,
          failures: 0,
        },
      });
    });
  });

  it("shows one TaskFlow with linked task details in text mode", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Investigate a flaky queue",
        status: "blocked",
        currentStep: "spawn_child",
        blockedSummary: "Waiting on child task output",
        createdAt: 100,
        updatedAt: 100,
      });

      const task = createRunningTaskRunCore({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-child-2",
        label: "Collect logs",
        task: "Collect logs",
        startedAt: 100,
        lastEventAt: 100,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: false }, runtime);

      expect(vi.mocked(runtime.log).mock.calls.map(([line]) => String(line))).toEqual([
        "TaskFlow:",
        `flowId: ${flow.flowId}`,
        "status: blocked",
        "goal: Investigate a flaky queue",
        "currentStep: spawn_child",
        "owner: agent:main:main",
        "notify: done_only",
        "state: Waiting on child task output",
        "createdAt: 1970-01-01T00:00:00.100Z",
        "updatedAt: 1970-01-01T00:00:00.100Z",
        "endedAt: n/a",
        "tasks: 1 total · 1 active · 0 issues",
        "Linked tasks:",
        `- ${task.taskId} running run-child-2 Collect logs`,
      ]);
    });
  });

  it.each(["failed", "timed_out", "lost"] as const)(
    "shows the persisted failure reason for linked %s tasks",
    async (status) => {
      await withTaskFlowCommandStateDir(async () => {
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/flows-command-failure-detail",
          goal: "Inspect child task failures",
          status: "running",
        });
        const task = createRunningTaskRunCore({
          runtime: "subagent",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          parentFlowId: flow.flowId,
          childSessionKey: `agent:main:flow-child-${status}`,
          runId: `run-flow-child-${status}`,
          label: "Inspect linked child",
          task: "Inspect linked child",
          notifyPolicy: "silent",
          startedAt: Date.now(),
          progressSummary: "Outdated child progress",
        });
        const error = `${status}: linked provider credentials need attention`;
        const endedAt = Date.now();

        if (status === "lost") {
          markTaskLostById({ taskId: task.taskId, endedAt, error });
        } else {
          markTaskTerminalById({
            taskId: task.taskId,
            status,
            endedAt,
            error,
            terminalSummary: "Generic child completion summary",
          });
        }

        const runtime = createRuntime();
        await flowsShowCommand({ lookup: flow.flowId }, runtime);

        const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
        const linkedTaskLine = lines.find((line) => line.startsWith(`- ${task.taskId} `));
        expect(linkedTaskLine).toContain("Inspect linked child");
        expect(linkedTaskLine).toContain(error);
        expect(linkedTaskLine).not.toContain("Outdated child progress");
        expect(linkedTaskLine).not.toContain("Generic child completion summary");

        const jsonRuntime = createRuntime();
        await flowsShowCommand({ lookup: flow.flowId, json: true }, jsonRuntime);
        expect(vi.mocked(jsonRuntime.writeJson).mock.calls[0]?.[0]).toMatchObject({
          tasks: [expect.objectContaining({ status, error })],
        });
      });
    },
  );

  it("includes running progress and terminal completion summaries for linked tasks", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command-task-progress",
        goal: "Inspect child task updates",
        status: "running",
      });
      const running = createRunningTaskRunCore({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:flow-child-running",
        runId: "run-flow-child-running",
        label: "Inspect running child",
        task: "Inspect running child",
        notifyPolicy: "silent",
        startedAt: Date.now(),
        progressSummary: "Downloading provider metadata",
      });
      const completed = createRunningTaskRunCore({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:flow-child-completed",
        runId: "run-flow-child-completed",
        label: "Inspect completed child",
        task: "Inspect completed child",
        notifyPolicy: "silent",
        startedAt: Date.now(),
      });
      markTaskTerminalById({
        taskId: completed.taskId,
        status: "succeeded",
        endedAt: Date.now(),
        terminalSummary: "Provider metadata refreshed",
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId }, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      expect(lines.find((line) => line.startsWith(`- ${running.taskId} `))).toContain(
        "Downloading provider metadata",
      );
      expect(lines.find((line) => line.startsWith(`- ${completed.taskId} `))).toContain(
        "Provider metadata refreshed",
      );
    });
  });

  it("sanitizes linked task failure reasons before terminal display", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command-task-safety",
        goal: "Inspect unsafe child error",
        status: "running",
      });
      const task = createRunningTaskRunCore({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:flow-child-safety",
        runId: "run-flow-child-safety",
        label: "Inspect child safely",
        task: "Inspect child safely",
        notifyPolicy: "silent",
        startedAt: Date.now(),
      });
      markTaskTerminalById({
        taskId: task.taskId,
        status: "failed",
        endedAt: Date.now(),
        error: "Provider \u001b[31mrejected\nforged: yes",
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId }, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      const linkedTaskLine = lines.find((line) => line.startsWith(`- ${task.taskId} `));
      expect(linkedTaskLine).toContain("Provider rejected forged: yes");
      expect(linkedTaskLine).not.toContain("\u001b");
      expect(linkedTaskLine).not.toContain("\n");
    });
  });

  it("sanitizes persisted linked task identifiers while preserving raw flow JSON", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const unsafe = "\u001b]52;c;Zm9yZ2Vk\u0007\nforged: yes";
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: `controller${unsafe}`,
        goal: `goal${unsafe}`,
        currentStep: `step${unsafe}`,
        status: "running",
      });
      const task = createRunningTaskRunCore({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: `agent:main:child${unsafe}`,
        runId: `run${unsafe}`,
        label: `label${unsafe}`,
        task: `prompt${unsafe}`,
        notifyPolicy: "silent",
        startedAt: Date.now(),
      });
      markTaskTerminalById({
        taskId: task.taskId,
        status: "failed",
        endedAt: Date.now(),
        error: `error${unsafe}`,
      });

      const humanRuntime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId }, humanRuntime);

      const lines = vi.mocked(humanRuntime.log).mock.calls.map(([line]) => String(line));
      const linkedTaskLine = lines.find((line) => line.startsWith(`- ${task.taskId} `));
      expect(linkedTaskLine).toContain("label");
      expect(linkedTaskLine).toContain("error");
      for (const line of lines) {
        expect(line).not.toContain("\u001b");
        expect(line).not.toContain("\u0007");
        expect(line).not.toContain("\n");
      }

      const jsonRuntime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: true }, jsonRuntime);
      expect(vi.mocked(jsonRuntime.writeJson).mock.calls[0]?.[0]).toMatchObject({
        goal: `goal${unsafe}`,
        currentStep: `step${unsafe}`,
        tasks: [
          expect.objectContaining({
            childSessionKey: `agent:main:child${unsafe}`,
            runId: `run${unsafe}`,
            label: `label${unsafe}`,
            task: `prompt${unsafe}`,
            error: `error${unsafe}`,
          }),
        ],
      });
    });
  });

  it("sanitizes untrusted TaskFlow filters and lookup errors", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const unsafe = "\u001b]52;c;Zm9yZ2Vk\u0007\nforged: yes";
      const filterRuntime = createRuntime();
      await flowsListCommand({ status: `running${unsafe}` }, filterRuntime);

      const lookupRuntime = createRuntime();
      await flowsShowCommand({ lookup: `missing${unsafe}` }, lookupRuntime);

      const lines = [
        ...vi.mocked(filterRuntime.log).mock.calls.map(([line]) => String(line)),
        ...vi.mocked(lookupRuntime.error).mock.calls.map(([line]) => String(line)),
      ];
      expect(lines.some((line) => line.includes("Status filter: running"))).toBe(true);
      expect(lines.some((line) => line.includes("TaskFlow not found: missing"))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain("\u001b");
        expect(line).not.toContain("\u0007");
        expect(line).not.toContain("\n");
      }
    });
  });

  it("shows TaskFlows with Date-invalid timestamps without crashing", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect malformed flow timestamp",
        status: "running",
        createdAt: 100,
        updatedAt: 8_700_000_000_000_000,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: false }, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      expect(lines).toContain(`flowId: ${flow.flowId}`);
      expect(lines).toContain("createdAt: 1970-01-01T00:00:00.100Z");
      expect(lines).toContain("updatedAt: n/a");
    });
  });

  it("sanitizes TaskFlow text output before printing to the terminal", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const unsafeOwnerKey = "agent:main:\u001b[31mowner";
      const flow = createManagedTaskFlow({
        ownerKey: unsafeOwnerKey,
        controllerId: "tests/flows-command",
        goal: "Investigate\nqueue\tstate",
        status: "blocked",
        currentStep: "spawn\u001b[2K_child",
        blockedSummary: "Waiting\u001b[31m on child\nforged: yes",
        createdAt: 100,
        updatedAt: 100,
      });

      const task = createRunningTaskRunCore({
        runtime: "subagent",
        ownerKey: unsafeOwnerKey,
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-child-3",
        label: "Collect\nlogs\u001b[2K",
        task: "Collect logs",
        startedAt: 100,
        lastEventAt: 100,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: false }, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      expect(lines).toEqual([
        "TaskFlow:",
        `flowId: ${flow.flowId}`,
        "status: blocked",
        "goal: Investigate\\nqueue\\tstate",
        "currentStep: spawn_child",
        "owner: agent:main:owner",
        "notify: done_only",
        "state: Waiting on child\\nforged: yes",
        "createdAt: 1970-01-01T00:00:00.100Z",
        "updatedAt: 1970-01-01T00:00:00.100Z",
        "endedAt: n/a",
        "tasks: 1 total · 1 active · 0 issues",
        "Linked tasks:",
        `- ${task.taskId} running run-child-3 Collect\\nlogs`,
      ]);
      expect(lines.join("\n")).not.toContain("\u001b[");
    });
  });

  it("cancels a managed TaskFlow with no active children", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Stop detached work",
        status: "running",
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsCancelCommand({ lookup: flow.flowId }, runtime);

      expect(vi.mocked(runtime.error)).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.exit)).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.log).mock.calls.map(([line]) => String(line))).toEqual([
        `Cancelled ${flow.flowId} (managed) with status cancelled.`,
      ]);

      const listRuntime = createRuntime();
      await flowsListCommand({}, listRuntime);
      expect(vi.mocked(listRuntime.log).mock.calls.map(([line]) => String(line))).toContain(
        "TaskFlow pressure: 0 active · 0 blocked · 0 cancel-requested · 1 total",
      );

      const jsonRuntime = createRuntime();
      await flowsListCommand({ json: true }, jsonRuntime);
      expect(vi.mocked(jsonRuntime.writeJson).mock.calls[0]?.[0]).toMatchObject({
        flows: [
          expect.objectContaining({
            flowId: flow.flowId,
            status: "cancelled",
            cancelRequestedAt: expect.any(Number),
          }),
        ],
      });
    });
  });
});
