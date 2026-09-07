import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";

const taskTracking = vi.hoisted(() => ({
  createBackgroundExecTask: vi.fn(),
  finalizeBackgroundExecTask: vi.fn(),
}));

vi.mock("./bash-tools.exec-task-tracking.js", () => taskTracking);

import { getFinishedSession } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

describe("exec background task wiring", () => {
  beforeEach(() => {
    taskTracking.createBackgroundExecTask.mockReset();
    taskTracking.finalizeBackgroundExecTask.mockReset();
  });

  it("does not spawn when the turn closes during asynchronous process preparation", async () => {
    const abortController = new AbortController();
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>();
    const preparationStarted = createDeferred();
    const preparation =
      createDeferred<Awaited<ReturnType<NonNullable<BashSandboxConfig["buildExecSpec"]>>>>();
    const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "sandbox",
        workspaceDir: process.cwd(),
        containerWorkdir: process.cwd(),
        buildExecSpec: async () => {
          preparationStarted.resolve();
          return await preparation.promise;
        },
        finalizeExec,
      },
    });
    try {
      const execution = tool.execute(
        "closed-before-spawn",
        { command: "sandbox-command" },
        abortController.signal,
      );
      const settled = Promise.allSettled([execution]);
      await preparationStarted.promise;
      abortController.abort(new Error("turn closed during preparation"));
      preparation.resolve({
        argv: [process.execPath, "-e", ""],
        env: process.env,
        stdinMode: "pipe-closed",
        finalizeToken: "cancelled-startup",
      });
      await settled;
      expect(spawn.mock.calls.length).toBe(0);
      await expect(execution).rejects.toThrow("turn closed during preparation");
      expect(finalizeExec).toHaveBeenCalledExactlyOnceWith({
        token: "cancelled-startup",
        status: "failed",
        exitCode: null,
        timedOut: false,
      });
      expect(taskTracking.createBackgroundExecTask).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
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

  it("does not background a terminal process while sandbox finalization is pending", async () => {
    const yieldMs = 250;
    const finalizationStarted = createDeferred();
    const finalization = createDeferred();
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {
      finalizationStarted.resolve();
      await finalization.promise;
    });
    vi.useFakeTimers();

    try {
      const tool = createExecTool({
        host: "sandbox",
        security: "full",
        ask: "off",
        allowBackground: true,
        sessionKey: "agent:main:main",
        sandbox: {
          containerName: "sandbox",
          workspaceDir: process.cwd(),
          containerWorkdir: process.cwd(),
          buildExecSpec: async () => ({
            argv: [process.execPath, "-e", ""],
            env: process.env,
            stdinMode: "pipe-closed",
            finalizeToken: "sandbox-token",
          }),
          finalizeExec,
        },
      });

      const execution = tool.execute("terminal-during-finalize", {
        command: "sandbox-command",
        yieldMs,
      });
      const executionSettled = vi.fn();
      void execution.then(executionSettled, executionSettled);
      await finalizationStarted.promise;
      await vi.advanceTimersByTimeAsync(yieldMs + 1);

      expect(executionSettled).not.toHaveBeenCalled();
      expect(taskTracking.createBackgroundExecTask).not.toHaveBeenCalled();
      finalization.resolve();
      const result = await execution;

      expect(result.details.status).toBe("completed");
      expect(taskTracking.finalizeBackgroundExecTask).toHaveBeenCalledWith({
        handle: null,
        outcome: expect.objectContaining({ status: "completed" }),
      });
    } finally {
      finalization.resolve();
      vi.useRealTimers();
    }
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
    const settledIdentity = vi.fn();
    taskTracking.finalizeBackgroundExecTask.mockImplementation(() =>
      settledIdentity(getGatewayToolCallerIdentity()),
    );
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
    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:background-lifetime" },
      () =>
        tool.execute(
          "abort-real-background",
          { command, background: true },
          abortController.signal,
        ),
    );

    expect(result.details.status).toBe("running");
    if (result.details.status !== "running") {
      throw new Error("expected a running background process");
    }
    const { sessionId } = result.details;
    abortController.abort();

    await expect
      .poll(() => getFinishedSession(sessionId)?.terminalStatus, {
        timeout: 5_000,
        interval: 10,
      })
      .toBe("completed");
    expect(settledIdentity).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
