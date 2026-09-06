import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import { getRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { ManagedRun } from "../process/supervisor/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentExecCommand } from "./agent-exec.js";

const baseConfig: OpenClawConfig = {
  agents: {
    defaults: { systemAgent: { agentId: "operator" } },
    entries: { operator: {}, assistant: {} },
  },
};
const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
const success = () => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } });

afterEach(() => vi.restoreAllMocks());

describe("bounded agent exec", () => {
  it.each([
    { name: "inherits fallbacks for the CLI collector default", override: undefined },
    { name: "disables fallbacks for an explicit internal override", override: [] },
  ])("uses an in-memory config and explicit auth owner and $name", async ({ override }) => {
    const runAgent = vi.fn(async (opts: Record<string, unknown>) => {
      expect(opts.agentId).toBe("assistant");
      expect(opts.modelFallbacksOverride).toEqual(override);
      expect(getRuntimeConfigSnapshot()?.agents?.entries?.operator).toBeDefined();
      return success();
    });

    const result = await agentExecCommand(
      "inspect",
      { model: "test/model", fallback: [] },
      runtime,
      { baseConfig, agentId: "assistant", modelFallbacksOverride: override, runAgent },
    );

    expect(result.exitCode).toBe(0);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("admits exactly the cap across parallel source executions and reports the actual count", async () => {
    const source = vi.fn(async () => ({ content: [], details: {} }));
    const result = await agentExecCommand("inspect", {}, runtime, {
      baseConfig,
      maxToolCalls: 2,
      runAgent: async () => {
        const tool = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
        await Promise.allSettled([1, 2, 3].map((id) => tool.execute(String(id), {})));
        return success();
      },
    });

    expect(source).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      toolCalls: 2,
      exitCode: 1,
      envelope: { error: { message: "Agent tool-call budget exhausted" } },
    });
  });

  it("does not charge calls refused at the existing source authority boundary", async () => {
    const source = vi.fn(async () => ({ content: [], details: {} }));
    const result = await agentExecCommand("inspect", {}, runtime, {
      baseConfig,
      maxToolCalls: 1,
      runAgent: async () => {
        const refused = wrapToolWithBeforeToolCallHook(
          bindAgentToolSourceExecutionGuard({ ...createStubTool("read"), execute: source }, () => {
            throw new Error("closed source owner");
          }),
        );
        await expect(refused.execute("blocked", {})).rejects.toThrow("closed source owner");
        const allowed = wrapToolWithBeforeToolCallHook({
          ...createStubTool("read"),
          execute: source,
        });
        await allowed.execute("allowed", {});
        return success();
      },
    });

    expect(source).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ toolCalls: 1, exitCode: 0 });
  });

  it("closes retained tool closures when the invocation ends", async () => {
    const source = vi.fn(async () => ({ content: [], details: {} }));
    let retained: ReturnType<typeof wrapToolWithBeforeToolCallHook> | undefined;
    const result = await agentExecCommand("inspect", {}, runtime, {
      baseConfig,
      maxToolCalls: 1,
      runAgent: async () => {
        retained = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
        return success();
      },
    });

    expect(result.exitCode).toBe(0);
    await expect(retained?.execute("late", {})).rejects.toThrow();
    expect(source).not.toHaveBeenCalled();
  });

  it("aborts an unattended turn at its millisecond deadline even without a state lock", async () => {
    const result = await agentExecCommand("inspect", {}, runtime, {
      baseConfig,
      timeoutMs: 25,
      runAgent: async (opts) => {
        const signal = opts.abortSignal as AbortSignal;
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
          } else {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        return success();
      },
    });

    expect(result).toMatchObject({
      toolCalls: 0,
      exitCode: 2,
      envelope: { status: "timeout" },
    });
  });

  it("cancels and drains an owned background process before returning", async () => {
    let child: ManagedRun | undefined;
    try {
      const result = await agentExecCommand("inspect", {}, runtime, {
        baseConfig,
        maxToolCalls: 1,
        runAgent: async (opts) => {
          child = await getProcessSupervisor().spawn({
            mode: "child",
            argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
            sessionId: String(opts.sessionId),
            scopeKey: String(opts.sessionKey),
            backendId: "budget-test",
            timeoutMs: 30_000,
          });
          return success();
        },
      });

      expect(result.exitCode).toBe(0);
      expect(await child?.wait()).toMatchObject({ reason: "manual-cancel" });
      const pid = child?.pid;
      expect(pid).toBeTypeOf("number");
      if (pid === undefined) {
        throw new Error("The background process did not start");
      }
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      child?.cancel();
      await child?.waitForExtinction?.();
    }
  });
});
