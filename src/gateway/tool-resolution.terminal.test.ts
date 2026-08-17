import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { setFallbackGatewayContext } from "./server-plugin-fallback-context.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import { makeFakePty } from "./terminal/session-manager.test-helpers.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

type TaskLookupRecord = {
  taskId: string;
  runId: string;
  childSessionKey: string;
  status: "running";
};

const taskStatusMocks = vi.hoisted(() => ({
  findTaskByRunIdForChildSessionForStatus: vi.fn(
    (_runId: string, _childSessionKey: string): TaskLookupRecord | undefined => undefined,
  ),
  findTaskByRunIdForStatus: vi.fn((_runId: string): TaskLookupRecord | undefined => undefined),
}));

vi.mock("../tasks/task-status-access.js", () => taskStatusMocks);

describe("resolveGatewayScopedTools terminal ownership", () => {
  it("binds a loopback terminal to the matching child when run ids collide", async () => {
    const backend = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const childSessionKey = "agent:main:loopback-task-2";
    const tasks: TaskLookupRecord[] = [
      {
        taskId: "task-1",
        runId: "shared-run",
        childSessionKey: "agent:main:loopback-task-1",
        status: "running",
      },
      { taskId: "task-2", runId: "shared-run", childSessionKey, status: "running" },
    ];
    taskStatusMocks.findTaskByRunIdForChildSessionForStatus.mockImplementation(
      (runId, sessionKey) =>
        tasks.find((task) => task.runId === runId && task.childSessionKey === sessionKey),
    );
    const clearContext = setFallbackGatewayContext({
      terminalSessions: manager,
      isTerminalEnabled: () => true,
      resolveTerminalLaunchPolicy: () => ({
        ok: true,
        plan: { agentId: "main", cwd: "/tmp", shell: "/bin/sh", args: [] },
      }),
    } as unknown as GatewayRequestContext);

    try {
      const result = resolveGatewayScopedTools({
        cfg: { tools: { allow: ["terminal"] } } as OpenClawConfig,
        sessionKey: childSessionKey,
        runId: "shared-run",
        senderIsOwner: true,
        surface: "loopback",
      });
      const terminal = result.tools.find((tool) => tool.name === "terminal");
      if (!terminal?.execute) {
        throw new Error("expected loopback terminal tool");
      }

      await terminal.execute("terminal-open", { action: "open", show: false });

      expect(taskStatusMocks.findTaskByRunIdForChildSessionForStatus).toHaveBeenCalledWith(
        "shared-run",
        childSessionKey,
      );
      expect(manager.closeAgentSessions("task-2")).toBe(1);
      expect(manager.closeAgentSessions("task-1")).toBe(0);
      expect(backend.killed).toBe(true);
    } finally {
      clearContext();
      manager.disposeAll();
      taskStatusMocks.findTaskByRunIdForChildSessionForStatus.mockReset();
      taskStatusMocks.findTaskByRunIdForStatus.mockReset();
    }
  });
});
