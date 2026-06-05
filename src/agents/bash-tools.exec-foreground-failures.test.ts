/**
 * Foreground exec failure tests.
 * Verifies failed process outcomes surface useful text/details for shell
 * errors, timeouts, signals, and runtime failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnInput } from "../process/supervisor/index.js";
import { captureEnv } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";
import { resolveShellFromPath } from "./shell-utils.js";

const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  cancel: vi.fn(),
  cancelScope: vi.fn(),
  reconcileOrphans: vi.fn(),
  getRecord: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

const isWin = process.platform === "win32";
const defaultShell = isWin
  ? undefined
  : process.env.OPENCLAW_TEST_SHELL || resolveShellFromPath("bash") || process.env.SHELL || "sh";

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
    supervisorMock.reconcileOrphans.mockReset();
    supervisorMock.getRecord.mockReset();
    resetProcessRegistryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    envSnapshot?.restore();
    envSnapshot = undefined;
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
        exitSignal: null,
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
    expect(text).toMatch(/re-run with a higher timeout/i);
    const details = requireFailedDetails(result.details);
    expect(details.exitCode).toBeNull();
    expect(details.timedOut).toBe(true);
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
});
