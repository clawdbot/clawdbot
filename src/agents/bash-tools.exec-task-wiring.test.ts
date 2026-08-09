import { beforeEach, describe, expect, it, vi } from "vitest";

const taskTracking = vi.hoisted(() => ({
  createBackgroundExecTask: vi.fn(),
  finalizeBackgroundExecTask: vi.fn(),
}));

vi.mock("./bash-tools.exec-task-tracking.js", () => taskTracking);

import { getFinishedSession } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec-run.js";

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

  it.each([
    {
      label: "foreground execution",
      defaults: { allowBackground: false },
      args: {},
    },
    {
      label: "foreground execution before the yield timer",
      defaults: { allowBackground: true, backgroundMs: 60_000 },
      args: { yieldMs: 60_000 },
    },
  ])("finalizes and rejects an aborted real $label", async ({ defaults, args }) => {
    const abortController = new AbortController();
    const abortReason = new Error("operator cancelled the foreground command");
    const onUpdate = vi.fn(() => abortController.abort(abortReason));
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      ...defaults,
    });
    const command =
      `${JSON.stringify(process.execPath)} -e ` +
      `"process.stdout.write('ready\\n');setTimeout(() => {}, 30_000)"`;

    await expect(
      tool.execute("abort-real-foreground", { command, ...args }, abortController.signal, onUpdate),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "Tool execution was aborted",
      cause: abortReason,
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(taskTracking.createBackgroundExecTask).not.toHaveBeenCalled();
    expect(taskTracking.finalizeBackgroundExecTask).toHaveBeenCalledWith({
      handle: null,
      outcome: expect.objectContaining({ status: "failed" }),
    });
  });

  it("keeps a real background process running after its tool signal aborts", async () => {
    const abortController = new AbortController();
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: true,
      backgroundMs: 0,
    });
    const command =
      `${JSON.stringify(process.execPath)} -e ` +
      `"setTimeout(() => process.stdout.write('background-survived\\n'), 30)"`;
    const result = await tool.execute(
      "abort-real-background",
      { command, background: true },
      abortController.signal,
    );

    expect(result.details.status).toBe("running");
    if (result.details.status !== "running") {
      throw new Error("expected a running background process");
    }
    const { sessionId } = result.details;
    abortController.abort();

    await expect
      .poll(() => getFinishedSession(sessionId)?.status, {
        timeout: 5_000,
        interval: 10,
      })
      .toBe("completed");
  });
});
