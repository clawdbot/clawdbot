import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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

beforeEach(() => {
  clearAgentHarnesses();
});

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

function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://api.openclaw.test/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

describe("agent harness registry", () => {
  it("registers and retrieves a harness with owner metadata", () => {
    const harness = makeHarness("custom");
    registerAgentHarness(harness, { ownerPluginId: "plugin-a" });

    const registeredHarness = getAgentHarness("custom");
    expect(registeredHarness?.id).toBe("custom");
    expect(registeredHarness?.pluginId).toBe("plugin-a");
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

  it("honors explicit provider PI runtime policy", () => {
    registerAgentHarness(makeHarness("plugin-harness", { priority: 200 }), {
      ownerPluginId: "plugin-a",
    });

    expect(
      selectAgentHarness({
        provider: "codex",
        modelId: "gpt-5.4",
        config: providerRuntimeConfig("codex", "pi"),
      }).id,
    ).toBe("pi");
  });

  it("honors explicit provider plugin runtime policy when the plugin harness is registered", () => {
    registerAgentHarness(makeHarness("custom", { providers: ["custom-provider"] }), {
      ownerPluginId: "plugin-a",
    });

    expect(
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config: providerRuntimeConfig("anthropic", "custom"),
      }).id,
    ).toBe("custom");
  });
});
