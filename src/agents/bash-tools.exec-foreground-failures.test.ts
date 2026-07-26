/**
 * Foreground exec failure tests.
 * Verifies failed process outcomes surface useful text/details for shell
 * errors, timeouts, signals, and runtime failures.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ProcessSupervisor } from "../process/supervisor/index.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { captureEnv } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { getBashShellConfig } from "./shell-utils.js";

const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  cancel: vi.fn<ProcessSupervisor["cancel"]>(),
  cancelScope: vi.fn<ProcessSupervisor["cancelScope"]>(),
  getRecord: vi.fn<ProcessSupervisor["getRecord"]>(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

const isWin = process.platform === "win32";
const defaultShell = isWin
  ? undefined
  : process.env.OPENCLAW_TEST_SHELL || getBashShellConfig().shell;
const tempDirs = createTempDirTracker();

function requireTextContent(
  result: Awaited<ReturnType<ReturnType<typeof createExecTool>["execute"]>>,
) {
  const content = result.content[0];
  expect(content?.type).toBe("text");
  if (content?.type !== "text") {
    throw new Error(`expected text content, got ${content?.type ?? "missing"}`);
  }
  return content.text;
}

function requireFailedDetails(
  details: Awaited<ReturnType<ReturnType<typeof createExecTool>["execute"]>>["details"],
) {
  expect(details.status).toBe("failed");
  if (details.status !== "failed") {
    throw new Error(`expected failed details, got ${details.status}`);
  }
  return details;
}

function mockSuccessfulSpawn(stdout = "ok\n") {
  supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
    runId: input.runId ?? "call-success",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    },
    wait: vi.fn(async () => ({
      reason: "exit" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 1,
      stdout,
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    })),
    cancel: vi.fn(),
  }));
}

async function expectUnavailableWorkdir(params: {
  workdir: string;
  toolDefaults?: Parameters<typeof createExecTool>[0];
  executeArgs?: Partial<Parameters<ReturnType<typeof createExecTool>["execute"]>[1]>;
  cleanup?: () => void;
}) {
  const tool = createExecTool({
    security: "full",
    ask: "off",
    allowBackground: false,
    ...params.toolDefaults,
  });

  try {
    const executeArgs = params.executeArgs ?? { workdir: params.workdir };
    const result = await tool.execute("call-unavailable-workdir", {
      command: "echo should-not-run",
      ...executeArgs,
    });

    const text = requireTextContent(result);
    expect(text).toContain(`workdir "${params.workdir}" is unavailable or not a directory`);
    expect(text).toContain("command was not executed");
    expect(text).toContain("workdir is treated as a literal path");
    expect(text).toContain('shell expansions such as "~" are not applied');
    const details = requireFailedDetails(result.details);
    expect(details.exitCode).toBeNull();
    expect(details.timedOut).toBe(false);
    expect(details.aggregated).toBe("");
    expect(details.cwd).toBe(params.workdir);
    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  } finally {
    params.cleanup?.();
  }
}

describe("exec foreground failures", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    envSnapshot = captureEnv(["SHELL"]);
    if (!isWin && defaultShell) {
      process.env.SHELL = defaultShell;
    }
    supervisorMock.spawn.mockReset();
    supervisorMock.cancel.mockReset();
    supervisorMock.cancelScope.mockReset();
    supervisorMock.getRecord.mockReset();
    resetProcessRegistryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    envSnapshot?.restore();
    envSnapshot = undefined;
    tempDirs.cleanup();
  });

  it("keeps the background fallback warning when gateway exec actually runs inline", async () => {
    mockSuccessfulSpawn();
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: false,
    });

    const result = await tool.execute("call-background-disabled-foreground", {
      command: "echo ok",
      background: true,
    });

    expect(result.details.status).toBe("completed");
    expect(requireTextContent(result)).toContain(
      "Warning: background execution is disabled; running synchronously.",
    );
  });

  it("returns a failed text result when the default timeout is exceeded", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
      timeoutSec: 1,
      backgroundMs: 10,
      allowBackground: false,
    });
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
      runId: input.runId ?? "call-timeout",
      pid: 1234,
      startedAtMs: Date.now(),
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      },
      wait: vi.fn(async () => ({
        reason: "overall-timeout" as const,
        exitCode: null,
        exitSignal: "SIGKILL" as NodeJS.Signals,
        durationMs: input.timeoutMs ?? 50,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      })),
      cancel: vi.fn(),
    }));

    const result = await tool.execute("call-timeout", {
      command: "echo never-runs",
      host: "gateway",
    });

    expect(supervisorMock.spawn).toHaveBeenCalledOnce();
    expect(supervisorMock.spawn.mock.calls[0]?.[0]?.timeoutMs).toBe(1_000);
    const text = requireTextContent(result);
    expect(text).toMatch(/timed out/i);
    expect(text).toContain("external side effects may already have completed");
    expect(text).toContain("Verify the resulting state before retrying");
    expect(text).toContain("Do not automatically rerun non-idempotent commands");
    expect(text).toContain("known to be safe to retry");
    const details = requireFailedDetails(result.details);
    expect(details.exitCode).toBeNull();
    expect(details.exitSignal).toBe("SIGKILL");
    expect(details.failureKind).toBe("overall-timeout");
    expect(details.exitReason).toBe("overall-timeout");
    expect(details.timedOut).toBe(true);
    expect(details.noOutputTimedOut).toBe(false);
    expect(details.aggregated).toBe("");
    expect(details.durationMs).toBeTypeOf("number");
    expect(details.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects invalid host values before launching a command", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
      allowBackground: false,
    });
    for (const testCase of [
      {
        host: "spark-ff13",
        message: 'Invalid exec host "spark-ff13". Allowed values: auto, sandbox, gateway, node.',
      },
      {
        host: 42,
        message:
          "Invalid exec host value type number. Allowed values: auto, sandbox, gateway, node.",
      },
    ]) {
      const malformedArgs = {
        command: "echo should-not-run",
        host: testCase.host,
      } as unknown as Parameters<typeof tool.execute>[1];

      await expect(tool.execute("call-invalid-host", malformedArgs)).rejects.toThrow(
        testCase.message,
      );
    }
  });

  it("returns a failed result for unavailable explicit host workdirs before launching", async () => {
    const missingWorkdir = path.join(
      os.tmpdir(),
      `openclaw-missing-workdir-${process.pid}-${Date.now()}`,
    );
    fs.rmSync(missingWorkdir, { recursive: true, force: true });

    const fileWorkdir = path.join(
      os.tmpdir(),
      `openclaw-file-workdir-${process.pid}-${Date.now()}`,
    );
    fs.writeFileSync(fileWorkdir, "not a directory");

    try {
      for (const workdir of [missingWorkdir, "   ", fileWorkdir]) {
        await expectUnavailableWorkdir({ workdir });
        supervisorMock.spawn.mockClear();
      }
    } finally {
      fs.rmSync(fileWorkdir, { force: true });
    }
  });

  it("returns a failed result for unavailable configured host workdirs before launching", async () => {
    const missingDefaultWorkdir = path.join(
      os.tmpdir(),
      `openclaw-missing-default-workdir-${process.pid}-${Date.now()}`,
    );
    fs.rmSync(missingDefaultWorkdir, { recursive: true, force: true });

    await expectUnavailableWorkdir({
      workdir: missingDefaultWorkdir,
      toolDefaults: { cwd: missingDefaultWorkdir },
      executeArgs: {},
    });
  });

  it("returns a failed result when the current gateway cwd is unavailable", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("current cwd unavailable");
    });
    try {
      await expectUnavailableWorkdir({
        workdir: "current working directory",
        executeArgs: {},
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("returns a failed result for unavailable configured sandbox workdirs before launching", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    try {
      await expectUnavailableWorkdir({
        workdir: "/workspace/missing",
        toolDefaults: {
          cwd: "/workspace/missing",
          host: "sandbox",
          sandbox: {
            containerName: "sandbox-workdir-test",
            workspaceDir,
            containerWorkdir: "/workspace",
          },
        },
        executeArgs: {},
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("defaults omitted sandbox workdirs to the sandbox workspace", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    mockSuccessfulSpawn();

    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      allowBackground: false,
      sandbox: {
        containerName: "sandbox-workdir-test",
        workspaceDir,
        containerWorkdir: "/workspace",
      },
    });

    try {
      const result = await tool.execute("call-sandbox-default-workdir", {
        command: "echo ok",
      });

      expect(result.details.status).toBe("completed");
      expect(result.details.cwd).toBe(workspaceDir);
      expect(supervisorMock.spawn).toHaveBeenCalledOnce();
      const input = supervisorMock.spawn.mock.calls[0]?.[0];
      expect(input?.cwd).toBe(workspaceDir);
      expect(input?.mode).toBe("child");
      if (input?.mode === "child") {
        expect(input.argv).toContain("-w");
        expect(input.argv).toContain("/workspace");
      }
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("lets backend-validated sandbox workdirs reach the backend without host stat fallback", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(
      async (params) => ({
        argv: ["remote-shell", params.command],
        env: {},
        stdinMode: "pipe-open" as const,
      }),
    );
    const validateWorkdir = vi.fn<NonNullable<BashSandboxConfig["validateWorkdir"]>>(
      async (workdir) => workdir,
    );
    mockSuccessfulSpawn();

    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      allowBackground: false,
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir,
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
        buildExecSpec,
      },
    });

    try {
      const result = await tool.execute("call-remote-sandbox-workdir", {
        command: "echo ok",
        workdir: "/remote/workspace/generated",
      });

      expect(result.details.status).toBe("completed");
      expect(result.details.cwd).toBe(workspaceDir);
      expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/generated");
      expect(buildExecSpec).toHaveBeenCalledOnce();
      expect(buildExecSpec.mock.calls[0]?.[0]?.workdir).toBe("/remote/workspace/generated");
      expect(supervisorMock.spawn).toHaveBeenCalledOnce();
      expect(supervisorMock.spawn.mock.calls[0]?.[0]?.cwd).toBe(workspaceDir);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("finalizes backend sandbox exec tokens when process spawn fails", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    const finalizeToken = { session: "remote-session" };
    const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(
      async (params) => ({
        argv: ["remote-shell", params.command],
        env: {},
        stdinMode: "pipe-open" as const,
        finalizeToken,
      }),
    );
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
    const validateWorkdir = vi.fn<NonNullable<BashSandboxConfig["validateWorkdir"]>>(
      async (workdir) => workdir,
    );
    supervisorMock.spawn.mockRejectedValueOnce(new Error("spawn failed"));

    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      allowBackground: false,
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir,
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
        buildExecSpec,
        finalizeExec,
      },
    });

    try {
      await expect(
        tool.execute("call-remote-sandbox-spawn-failure", {
          command: "echo ok",
          workdir: "/remote/workspace/generated",
        }),
      ).rejects.toThrow("spawn failed");

      expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/generated");
      expect(buildExecSpec).toHaveBeenCalledOnce();
      expect(supervisorMock.spawn).toHaveBeenCalledOnce();
      expect(finalizeExec).toHaveBeenCalledOnce();
      expect(finalizeExec).toHaveBeenCalledWith({
        status: "failed",
        exitCode: null,
        timedOut: false,
        token: finalizeToken,
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe commands before backend workdir validation", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(
      async (params) => ({
        argv: ["remote-shell", params.command],
        env: {},
        stdinMode: "pipe-open" as const,
      }),
    );
    const validateWorkdir = vi.fn<NonNullable<BashSandboxConfig["validateWorkdir"]>>(
      async (workdir) => workdir,
    );
    const discardPreparedWorkdir =
      vi.fn<NonNullable<BashSandboxConfig["discardPreparedWorkdir"]>>();

    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      allowBackground: false,
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir,
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
        discardPreparedWorkdir,
        buildExecSpec,
      },
    });

    try {
      await expect(
        tool.execute("call-remote-sandbox-rejected-command", {
          command: "/approve approval-1 deny",
          workdir: "/remote/workspace/generated",
        }),
      ).rejects.toThrow("exec cannot run /approve commands");

      expect(validateWorkdir).not.toHaveBeenCalled();
      expect(discardPreparedWorkdir).not.toHaveBeenCalled();
      expect(buildExecSpec).not.toHaveBeenCalled();
      expect(supervisorMock.spawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not preflight remote-only backend workdirs from the local workspace root", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    fs.writeFileSync(path.join(workspaceDir, "script.py"), "print($TOKEN)\n");
    const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(
      async (params) => ({
        argv: ["remote-shell", params.command],
        env: {},
        stdinMode: "pipe-open" as const,
      }),
    );
    const validateWorkdir = vi.fn<NonNullable<BashSandboxConfig["validateWorkdir"]>>(
      async (workdir) => workdir,
    );
    mockSuccessfulSpawn();

    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      allowBackground: false,
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir,
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
        buildExecSpec,
      },
    });

    try {
      const result = await tool.execute("call-remote-only-script", {
        command: "python script.py",
        workdir: "/remote/workspace/generated",
      });

      expect(result.details.status).toBe("completed");
      expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/generated");
      expect(buildExecSpec).toHaveBeenCalledOnce();
      expect(buildExecSpec.mock.calls[0]?.[0]?.workdir).toBe("/remote/workspace/generated");
      expect(supervisorMock.spawn).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses the mapped host cwd for existing relative backend-validated sandbox workdirs", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    const srcDir = path.join(workspaceDir, "src");
    fs.mkdirSync(srcDir);
    const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(
      async (params) => ({
        argv: ["remote-shell", params.command],
        env: {},
        stdinMode: "pipe-open" as const,
      }),
    );
    const validateWorkdir = vi.fn<NonNullable<BashSandboxConfig["validateWorkdir"]>>(
      async (workdir) => workdir,
    );
    mockSuccessfulSpawn();

    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      allowBackground: false,
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir,
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
        buildExecSpec,
      },
    });

    try {
      const result = await tool.execute("call-relative-remote-sandbox-workdir", {
        command: "echo ok",
        workdir: "src",
      });

      expect(result.details.status).toBe("completed");
      expect(result.details.cwd).toBe(srcDir);
      expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/src");
      expect(buildExecSpec).toHaveBeenCalledOnce();
      expect(buildExecSpec.mock.calls[0]?.[0]?.workdir).toBe("/remote/workspace/src");
      expect(supervisorMock.spawn).toHaveBeenCalledOnce();
      expect(supervisorMock.spawn.mock.calls[0]?.[0]?.cwd).toBe(srcDir);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("fails backend-validated sandbox workdirs before launch when backend validation rejects", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    const validateWorkdir = vi.fn<NonNullable<BashSandboxConfig["validateWorkdir"]>>(
      async () => null,
    );
    const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(
      async (params) => ({
        argv: ["remote-shell", params.command],
        env: {},
        stdinMode: "pipe-open" as const,
      }),
    );

    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      allowBackground: false,
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir,
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
        buildExecSpec,
      },
    });

    try {
      const result = await tool.execute("call-remote-sandbox-workdir", {
        command: "echo ok",
        workdir: "/remote/workspace/generated",
      });

      expect(result.details).toMatchObject({
        status: "failed",
        cwd: "/remote/workspace/generated",
      });
      expect(JSON.stringify(result)).toContain("unavailable or not a directory");
      expect(validateWorkdir).toHaveBeenCalledOnce();
      expect(buildExecSpec).not.toHaveBeenCalled();
      expect(supervisorMock.spawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("returns a failed result for unavailable explicit sandbox workdirs before launching a command", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    const outsideDir = tempDirs.make("openclaw-outside-workdir-");
    fs.writeFileSync(path.join(workspaceDir, "not-dir"), "not a directory");
    try {
      for (const workdir of ["/workspace/missing", "   ", "/workspace/not-dir", outsideDir]) {
        await expectUnavailableWorkdir({
          workdir,
          toolDefaults: {
            host: "sandbox",
            sandbox: {
              containerName: "sandbox-workdir-test",
              workspaceDir,
              containerWorkdir: "/workspace",
            },
          },
        });
        supervisorMock.spawn.mockClear();
      }
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
