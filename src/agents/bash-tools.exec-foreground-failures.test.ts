import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";
import { resolveShellFromPath } from "./shell-utils.js";

const isWin = process.platform === "win32";
const defaultShell = isWin
  ? undefined
  : process.env.OPENCLAW_TEST_SHELL || resolveShellFromPath("bash") || process.env.SHELL || "sh";
const longDelayCmd = isWin ? "Start-Sleep -Seconds 5" : "sleep 5";

describe("exec foreground failures", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    vi.useRealTimers();
    envSnapshot = captureEnv(["SHELL"]);
    if (!isWin && defaultShell) {
      process.env.SHELL = defaultShell;
    }
    resetProcessRegistryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    envSnapshot.restore();
  });

  it("returns a failed text result when the default timeout is exceeded", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
      timeoutSec: 0.05,
      backgroundMs: 10,
      allowBackground: false,
    });

    const result = await tool.execute("call-timeout", {
      command: longDelayCmd,
    });

    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text?: string }).text).toMatch(/timed out/i);
    expect((result.content[0] as { text?: string }).text).toMatch(/re-run with a higher timeout/i);
    const details = result.details as {
      status?: string;
      exitCode?: number | null;
      aggregated?: string;
      durationMs?: number;
    };
    expect(details.status).toBe("failed");
    expect(details.exitCode).toBeNull();
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
