import { describe, expect, it, vi } from "vitest";
import { runStartupTasks, type StartupTask } from "./startup-tasks.js";

function createLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

describe("runStartupTasks", () => {
  it("runs tasks in order and logs skipped/failed outcomes with task identity", async () => {
    const log = createLogger();
    const events: string[] = [];
    const tasks: StartupTask[] = [
      {
        source: "boot-md",
        agentId: "main",
        workspaceDir: "/ws/main",
        run: async () => {
          events.push("boot");
          return { status: "skipped", reason: "missing" };
        },
      },
      {
        source: "restart-sentinel",
        sessionKey: "agent:main:telegram:chat",
        run: async () => {
          events.push("restart");
          return { status: "ran" };
        },
      },
      {
        source: "boot-md",
        agentId: "ops",
        workspaceDir: "/ws/ops",
        run: async () => {
          events.push("ops");
          throw new Error("boom");
        },
      },
    ];

    const results = await runStartupTasks({ tasks, log });

    expect(events).toEqual(["boot", "restart", "ops"]);
    expect(results).toEqual([
      { status: "skipped", reason: "missing" },
      { status: "ran" },
      { status: "failed", reason: "boom" },
    ]);
    expect(log.debug).toHaveBeenCalledWith("startup task skipped", {
      source: "boot-md",
      agentId: "main",
      workspaceDir: "/ws/main",
      reason: "missing",
    });
    expect(log.warn).toHaveBeenCalledWith("startup task failed", {
      source: "boot-md",
      agentId: "ops",
      workspaceDir: "/ws/ops",
      reason: "boom",
    });
  });
});
