import { describe, expect, it, vi } from "vitest";
import type { CanonicalReadinessResult } from "../readiness/conditions.js";
import { formatReadyResult, readyCommand } from "./ready.js";

const ready: CanonicalReadinessResult = {
  ready: true,
  conditions: [
    {
      type: "GatewayResponding",
      status: "True",
      requirement: "required",
      reason: "GatewayResponding",
      message: "Gateway is responding.",
    },
    {
      type: "PluginsLoaded",
      status: "False",
      requirement: "advisory",
      reason: "PluginLoadFailed",
      message: "One plugin failed to load.",
    },
  ],
  failures: [],
  advisories: ["PluginLoadFailed"],
};

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("readyCommand", () => {
  it("writes the canonical result as JSON and keeps advisory-only results successful", async () => {
    const runtime = createRuntime();
    const callReady = vi.fn().mockResolvedValue(ready);
    await readyCommand({ json: true, timeoutMs: 2500 }, runtime, {
      loadConfig: async () => ({}),
      callReady,
    });
    expect(callReady).toHaveBeenCalledWith({ config: {}, timeoutMs: 2500 });
    expect(runtime.log).toHaveBeenCalledWith(JSON.stringify(ready, null, 2));
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("prints structured findings and exits one for required failures", async () => {
    const runtime = createRuntime();
    const notReady: CanonicalReadinessResult = {
      ...ready,
      ready: false,
      conditions: [
        ...ready.conditions,
        {
          type: "openclaw.workspace-writable",
          status: "False",
          requirement: "required",
          reason: "WorkspaceStorageFull",
          message: "The effective workspace is full.",
        },
      ],
      failures: ["WorkspaceStorageFull"],
    };
    await readyCommand({}, runtime, {
      loadConfig: async () => ({}),
      callReady: async () => notReady,
    });
    expect(runtime.log.mock.calls[0]?.[0]).toContain("Ready: no");
    expect(runtime.log.mock.calls[0]?.[0]).toContain("WorkspaceStorageFull");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed with JSON when the Gateway is unavailable", async () => {
    const runtime = createRuntime();
    await readyCommand({ json: true }, runtime, {
      loadConfig: async () => ({}),
      callReady: async () => {
        throw new Error("connection refused");
      },
    });
    expect(runtime.log.mock.calls[0]?.[0]).toContain('"reason": "GatewayReadinessUnavailable"');
    expect(runtime.log.mock.calls[0]?.[0]).toContain("connection refused");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when an older Gateway does not expose the readiness method", async () => {
    const runtime = createRuntime();
    await readyCommand({}, runtime, {
      loadConfig: async () => ({}),
      callReady: async () => {
        throw new Error("unknown method: ready");
      },
    });
    expect(runtime.error).toHaveBeenCalledWith(
      "GatewayReadinessUnavailable: unknown method: ready",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("formatReadyResult", () => {
  it("summarizes required and advisory conditions", () => {
    const output = formatReadyResult(ready);
    expect(output).toContain("Ready: yes");
    expect(output).toContain("Required: 1/1");
    expect(output).toContain("Advisories: 1");
    expect(output).toContain("WARN");
    expect(output).toContain("PluginLoadFailed");
  });
});
