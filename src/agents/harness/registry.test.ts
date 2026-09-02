// Exercises agent harness registration, ownership metadata, and selection handoff.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  clearAgentHarnesses,
  disposeRegisteredAgentHarnesses,
  getRegisteredAgentHarness,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
  resolveAgentHarnessOwnerPluginId,
  resolveCodexAgentHarnessNativeCompaction,
  resetRegisteredAgentHarnessSessions,
} from "./registry.js";
import { selectAgentHarness } from "./selection.js";
import type { AgentHarness } from "./types.js";

const resolveProviderRefOwnership = vi.hoisted(() => vi.fn(() => ({ status: "unowned" as const })));

// Registry tests exercise selection handoff; provider owner/route tests own the real artifacts,
// which would cold-load bundled plugin surfaces for this synthetic provider config.
vi.mock("../../plugins/providers.js", () => ({
  resolveProviderRefOwnership,
}));
vi.mock("../../plugins/provider-model-routes.js", () => ({
  resolveProviderModelCatalogId: () => null,
  resolveProviderModelRoutes: () => null,
}));

const originalRuntime = process.env.OPENCLAW_AGENT_RUNTIME;

beforeEach(() => {
  clearAgentHarnesses();
  resolveProviderRefOwnership.mockClear();
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
  // Test harnesses keep support decisions provider-scoped so selection tests
  // can distinguish registration from runtime-policy preference.
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
  it("rejects the built-in runtime id before mutating the registry", () => {
    expect(() =>
      registerAgentHarness(makeHarness("openclaw"), { ownerPluginId: "untrusted-plugin" }),
    ).toThrow('agent harness id "openclaw" is reserved for the built-in runtime');
    expect(listRegisteredAgentHarnesses()).toEqual([]);
  });

  it("registers and retrieves a harness with owner metadata", () => {
    const harness = makeHarness("custom");
    registerAgentHarness(harness, { ownerPluginId: "plugin-a" });

    const registeredHarness = getRegisteredAgentHarness("custom");
    expect(registeredHarness?.harness.id).toBe("custom");
    expect(registeredHarness?.harness.pluginId).toBe("plugin-a");
    expect(registeredHarness?.ownerPluginId).toBe("plugin-a");
    expect(listRegisteredAgentHarnesses().map((entry) => entry.harness.id)).toEqual(["custom"]);
  });

  it("keeps explicit ownership distinct from harness metadata", () => {
    const harness = { ...makeHarness("custom"), pluginId: "harness-declared" };
    registerAgentHarness(harness, { ownerPluginId: "registry-owner" });

    expect(getRegisteredAgentHarness("custom")).toEqual({
      harness,
      ownerPluginId: "registry-owner",
    });
    expect(listRegisteredAgentHarnesses()).toEqual([{ harness, ownerPluginId: "registry-owner" }]);
  });

  it("resolves native compaction only from the exact registry-owned Codex harness", () => {
    const nativeCompaction = vi.fn(async () => ({ ok: true, compacted: true }));
    registerAgentHarness(makeHarness("codex"), {
      ownerPluginId: "codex",
      nativeCompaction,
    });
    const registered = getRegisteredAgentHarness("codex")?.harness;

    expect(registered).toBeDefined();
    expect(resolveCodexAgentHarnessNativeCompaction(registered as AgentHarness)).toBe(
      nativeCompaction,
    );
    expect(() => resolveCodexAgentHarnessNativeCompaction(makeHarness("codex"))).toThrow(
      "Agent harness codex changed during native compaction resolution",
    );
  });

  it("rejects native compaction registered by a foreign harness owner", () => {
    expect(() =>
      registerAgentHarness(makeHarness("codex"), {
        ownerPluginId: "copilot",
        nativeCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
      }),
    ).toThrow("native compaction requires the registry-owned Codex harness");
    expect(listRegisteredAgentHarnesses()).toEqual([]);
  });

  it.each(["active", "request", "registration"] as const)(
    "rejects retired %s harnesses without falling through to another registry",
    async (context) => {
      const snapshot = captureActivePluginRegistrySnapshot();
      const active = createEmptyPluginRegistry();
      const selected = context === "active" ? active : createEmptyPluginRegistry();
      const dispose = vi.fn(async () => {});
      const reset = vi.fn(async () => {});
      const nativeCompaction = vi.fn(async () => ({ ok: true, compacted: true }));
      const inContext = <T>(run: () => T): T =>
        context === "registration"
          ? withPluginRegistrationContext(selected, "codex", run)
          : context === "request"
            ? withPluginRuntimeRegistryScope(selected, run)
            : run();
      try {
        setActivePluginRegistry(active);
        registerAgentHarness(makeHarness("codex"), { ownerPluginId: "codex" });
        withPluginRegistrationContext(selected, "codex", () =>
          registerAgentHarness({ ...makeHarness("codex"), dispose, reset }, { nativeCompaction }),
        );
        const registered = inContext(() => getRegisteredAgentHarness("codex"))!;
        const read = () => {
          expect(getRegisteredAgentHarness("codex")).toEqual(registered);
          expect(listRegisteredAgentHarnesses()).toEqual([registered]);
          expect(resolveAgentHarnessOwnerPluginId(registered.harness)).toBe("codex");
          expect(resolveCodexAgentHarnessNativeCompaction(registered.harness)).toBe(
            nativeCompaction,
          );
        };
        inContext(read);
        await inContext(() => resetRegisteredAgentHarnessSessions({ reason: "reset" }));
        await inContext(disposeRegisteredAgentHarnesses);
        expect(reset).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();

        markPluginRegistryRetired(selected);
        inContext(() => {
          expect.soft(getRegisteredAgentHarness("codex")).toBeUndefined();
          expect.soft(listRegisteredAgentHarnesses()).toEqual([]);
          expect
            .soft(() => resolveAgentHarnessOwnerPluginId(registered.harness))
            .toThrow("changed during owner resolution");
          expect
            .soft(() => resolveCodexAgentHarnessNativeCompaction(registered.harness))
            .toThrow("changed during native compaction resolution");
          expect
            .soft(() =>
              selectAgentHarness({
                provider: "synthetic",
                agentHarnessId: "codex",
              }),
            )
            .toThrow('Requested agent harness "codex" is not registered');
        });
        await inContext(() => resetRegisteredAgentHarnessSessions({ reason: "reset" }));
        await inContext(disposeRegisteredAgentHarnesses);
        expect.soft(reset).toHaveBeenCalledOnce();
        expect.soft(dispose).toHaveBeenCalledOnce();
        if (selected !== active) {
          expect(getRegisteredAgentHarness("codex")?.harness).not.toBe(registered.harness);
          expect(getRegisteredAgentHarness("codex")).toBeDefined();
        }
      } finally {
        restoreActivePluginRegistrySnapshot(snapshot);
      }
    },
  );

  it("uses builder ownership and preserves a harness registered by another plugin", () => {
    const building = createEmptyPluginRegistry();
    const original = makeHarness("shared");
    building.agentHarnesses.push({
      pluginId: "first-plugin",
      source: "runtime",
      harness: original,
    });

    expect(() =>
      withPluginRegistrationContext(building, "failing-plugin", () => {
        registerAgentHarness(makeHarness("shared"));
      }),
    ).toThrow("agent harness shared already registered by first-plugin");
    expect(building.agentHarnesses).toEqual([
      { pluginId: "first-plugin", source: "runtime", harness: original },
    ]);

    withPluginRegistrationContext(building, "builder-plugin", () => {
      registerAgentHarness(makeHarness("owned"));
    });
    expect(building.agentHarnesses[1]?.pluginId).toBe("builder-plugin");
  });

  it("keeps harness reads in registration, request, then active registry order", () => {
    registerAgentHarness(makeHarness("shared"), { ownerPluginId: "active-plugin" });
    const request = createEmptyPluginRegistry();
    const building = createEmptyPluginRegistry();
    const expectOwner = (ownerPluginId: string) => {
      expect(getRegisteredAgentHarness("shared")?.ownerPluginId).toBe(ownerPluginId);
      expect(listRegisteredAgentHarnesses().map((entry) => entry.ownerPluginId)).toEqual([
        ownerPluginId,
      ]);
    };

    withPluginRuntimeRegistryScope(request, () => {
      expect(getRegisteredAgentHarness("shared")).toBeUndefined();
      expect(listRegisteredAgentHarnesses()).toEqual([]);
      registerAgentHarness(makeHarness("shared"), { ownerPluginId: "request-plugin" });
      expectOwner("request-plugin");
      withPluginRegistrationContext(building, "builder-plugin", () => {
        expect(getRegisteredAgentHarness("shared")).toBeUndefined();
        expect(listRegisteredAgentHarnesses()).toEqual([]);
        registerAgentHarness(makeHarness("shared"));
        expectOwner("builder-plugin");
      });
      expectOwner("request-plugin");
    });
    expectOwner("active-plugin");
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
    // Auto mode should not select a model-specific runtime until the owning
    // plugin has registered its harness in this process.
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";

    expect(selectAgentHarness({ provider: "plugin-models", modelId: "custom-1" }).id).toBe(
      "openclaw",
    );

    registerAgentHarness(makeHarness("custom", { providers: ["plugin-models"] }), {
      ownerPluginId: "plugin-a",
    });

    expect(selectAgentHarness({ provider: "plugin-models", modelId: "custom-1" }).id).toBe(
      "custom",
    );
  });

  it("falls back to OpenClaw for other models", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";

    expect(selectAgentHarness({ provider: "anthropic", modelId: "sonnet-4.6" }).id).toBe(
      "openclaw",
    );
  });

  it("lets a plugin harness win in auto mode by priority", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";
    registerAgentHarness(makeHarness("plugin-harness", { priority: 200 }), {
      ownerPluginId: "plugin-a",
    });

    expect(selectAgentHarness({ provider: "codex", modelId: "gpt-5.4" }).id).toBe("plugin-harness");
  });

  it("honors explicit provider OpenClaw runtime policy", () => {
    registerAgentHarness(makeHarness("plugin-harness", { priority: 200 }), {
      ownerPluginId: "plugin-a",
    });

    expect(
      selectAgentHarness({
        provider: "codex",
        modelId: "gpt-5.4",
        config: providerRuntimeConfig("codex", "openclaw"),
      }).id,
    ).toBe("openclaw");
  });

  it("honors explicit provider plugin runtime policy when the plugin harness is registered", () => {
    registerAgentHarness(makeHarness("custom", { providers: ["anthropic"] }), {
      ownerPluginId: "plugin-a",
    });
    const config = providerRuntimeConfig("anthropic", "custom");

    expect(
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config,
      }).id,
    ).toBe("custom");
    expect(resolveProviderRefOwnership).toHaveBeenCalledWith({
      provider: "anthropic",
      config,
    });
  });
});
