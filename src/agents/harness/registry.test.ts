import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentHarnesses,
  disposeRegisteredAgentHarnesses,
  getAgentHarness,
  getRegisteredAgentHarness,
  listAgentHarnessIds,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
  resetRegisteredAgentHarnessSessions,
  restoreRegisteredAgentHarnesses,
} from "./registry.js";
import { selectAgentHarness } from "./selection.js";
import type { AgentHarness } from "./types.js";

const originalRuntime = process.env.OPENCLAW_AGENT_RUNTIME;

afterEach(() => {
  clearAgentHarnesses();
  if (originalRuntime == null) {
    delete process.env.OPENCLAW_AGENT_RUNTIME;
  } else {
    process.env.OPENCLAW_AGENT_RUNTIME = originalRuntime;
  }
});

function makeHarness(
  id: string,
  options: {
    priority?: number;
    providers?: string[];
  } = {},
): AgentHarness {
  const providers = options.providers?.map((provider) => provider.trim().toLowerCase());
  return {
    id,
    label: id,
    supports: (ctx) =>
      !providers || providers.includes(ctx.provider.trim().toLowerCase())
        ? { supported: true, priority: options.priority ?? 10 }
        : { supported: false },
    async runAttempt() {
      throw new Error("not used");
    },
  };
}

describe("agent harness registry", () => {
  it("registers and retrieves a harness with owner metadata", () => {
    const harness = makeHarness("custom");
    registerAgentHarness(harness, { ownerPluginId: "plugin-a" });

    expect(getAgentHarness("custom")).toMatchObject({ id: "custom", pluginId: "plugin-a" });
    expect(getRegisteredAgentHarness("custom")?.ownerPluginId).toBe("plugin-a");
    expect(listAgentHarnessIds()).toEqual(["custom"]);
  });

  it("restores a registry snapshot", () => {
    registerAgentHarness(makeHarness("a"));
    const snapshot = listRegisteredAgentHarnesses();
    registerAgentHarness(makeHarness("b"));

    restoreRegisteredAgentHarnesses(snapshot);

    expect(listAgentHarnessIds()).toEqual(["a"]);
  });

  it("dispatches generic session reset to registered harnesses", async () => {
    const resets: unknown[] = [];
    registerAgentHarness({
      ...makeHarness("custom"),
      reset: async (params) => {
        resets.push(params);
      },
    });

    await resetRegisteredAgentHarnessSessions({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      reason: "reset",
    });

    expect(resets).toEqual([
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile: "/tmp/session.jsonl",
        reason: "reset",
      },
    ]);
  });

  it("disposes registered harness runtime state", async () => {
    const dispose = vi.fn(async () => undefined);
    registerAgentHarness({
      ...makeHarness("custom"),
      dispose,
    });

    await disposeRegisteredAgentHarnesses();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps model-specific harnesses behind plugin registration in auto mode", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";

    expect(selectAgentHarness({ provider: "plugin-models", modelId: "custom-1" }).id).toBe("pi");

    registerAgentHarness(makeHarness("custom", { providers: ["plugin-models"] }), {
      ownerPluginId: "plugin-a",
    });

    expect(selectAgentHarness({ provider: "plugin-models", modelId: "custom-1" }).id).toBe(
      "custom",
    );
  });

  it("falls back to PI for other models", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";

    expect(selectAgentHarness({ provider: "anthropic", modelId: "sonnet-4.6" }).id).toBe("pi");
  });

  it("lets a plugin harness win in auto mode by priority", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";
    registerAgentHarness(makeHarness("plugin-harness", { priority: 200 }), {
      ownerPluginId: "plugin-a",
    });

    expect(selectAgentHarness({ provider: "codex", modelId: "gpt-5.4" }).id).toBe("plugin-harness");
  });

  it("honors explicit PI mode", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "pi";
    registerAgentHarness(makeHarness("plugin-harness", { priority: 200 }), {
      ownerPluginId: "plugin-a",
    });

    expect(selectAgentHarness({ provider: "codex", modelId: "gpt-5.4" }).id).toBe("pi");
  });

  it("honors explicit plugin harness mode when the plugin harness is registered", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "custom";
    registerAgentHarness(makeHarness("custom", { providers: ["custom-provider"] }), {
      ownerPluginId: "plugin-a",
    });

    expect(selectAgentHarness({ provider: "anthropic", modelId: "sonnet-4.6" }).id).toBe("custom");
  });
});
