import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  bindAgentToolSourceExecutionGuard,
  captureAgentToolSourceExecutionGuard,
} from "../agents/agent-tool-source-execution-guard.js";
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

  it("retained effect guards cannot borrow a replacement invocation's authority", async () => {
    let retainedGuard: (() => void) | undefined;
    const effect = vi.fn();
    await agentExecCommand("inspect", {}, runtime, {
      baseConfig,
      isCurrent: () => true,
      runAgent: async () => {
        retainedGuard = captureAgentToolSourceExecutionGuard();
        return success();
      },
    });
    const replacement = await agentExecCommand("inspect", {}, runtime, {
      baseConfig,
      isCurrent: () => true,
      runAgent: async () => {
        expect(() => {
          retainedGuard?.();
          effect();
        }).toThrow("execution scope is no longer active");
        return success();
      },
    });
    expect(replacement.exitCode).toBe(0);
    expect(effect).not.toHaveBeenCalled();
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
          const ready = createDeferred();
          let output = "";
          child = await getProcessSupervisor().spawn({
            mode: "child",
            argv: [
              process.execPath,
              "-e",
              `process.once("SIGTERM", () => setTimeout(() => process.exit(0), 250));
               process.stdout.write("ready");
               setInterval(() => {}, 1000);`,
            ],
            scopeKey: String(opts.sessionKey),
            timeoutMs: 30_000,
            onStdout: (chunk) => {
              output += chunk;
              if (output.includes("ready")) {
                ready.resolve();
              }
            },
          });
          await Promise.race([
            ready.promise,
            child.wait().then(() => {
              throw new Error("The background process exited before readiness");
            }),
          ]);
          return success();
        },
      });

      expect(result.exitCode).toBe(process.platform === "win32" ? 1 : 0);
      if (process.platform === "win32") {
        expect(result.envelope.error?.message).toContain(
          "cannot confirm owned execution-tree settlement",
        );
      }
      const pid = child?.pid;
      expect(pid).toBeTypeOf("number");
      if (pid === undefined) {
        throw new Error("The background process did not start");
      }
      // No post-return wait may supply the cleanup that the command must own.
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await child?.wait()).toMatchObject({ reason: "manual-cancel" });
    } finally {
      child?.cancel();
      await child?.wait();
      await child?.waitForExtinction?.();
    }
  });
});
