import { beforeEach, describe, expect, it, vi } from "vitest";

const taskTracking = vi.hoisted(() => ({
  createBackgroundExecTask: vi.fn(),
  finalizeBackgroundExecTask: vi.fn(),
}));

vi.mock("./bash-tools.exec-task-tracking.js", () => taskTracking);

import { createExecTool } from "./bash-tools.exec.js";

describe("exec background task wiring", () => {
  beforeEach(() => {
    taskTracking.createBackgroundExecTask.mockReset();
    taskTracking.finalizeBackgroundExecTask.mockReset();
  });

  it("does not register a foreground command that settles before the yield timer", async () => {
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: true,
      backgroundMs: 10_000,
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("foreground-before-yield", {
      command: process.platform === "win32" ? "Write-Output done" : "echo done",
    });

    expect(result.details).toMatchObject({ status: "completed" });
    expect(taskTracking.createBackgroundExecTask).not.toHaveBeenCalled();
    expect(taskTracking.finalizeBackgroundExecTask).toHaveBeenCalledWith({
      handle: null,
      outcome: expect.objectContaining({ status: "completed" }),
    });
  });
});
