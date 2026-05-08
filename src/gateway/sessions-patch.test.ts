import { afterEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const SUBAGENT_MODEL = "synthetic/hf:moonshotai/Kimi-K2.5";
const KIMI_SUBAGENT_KEY = "agent:kimi:subagent:child";
const MAIN_SESSION_KEY = "agent:main:main";
const EMPTY_CFG = {} as OpenClawConfig;

type ApplySessionsPatchArgs = Parameters<typeof applySessionsPatchToStore>[0];

async function runPatch(params: {
  patch: ApplySessionsPatchArgs["patch"];
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  storeKey?: string;
  loadGatewayModelCatalog?: ApplySessionsPatchArgs["loadGatewayModelCatalog"];
}) {
  return applySessionsPatchToStore({
    cfg: params.cfg ?? EMPTY_CFG,
    store: params.store ?? {},
    storeKey: params.storeKey ?? MAIN_SESSION_KEY,
    patch: params.patch,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
  });
}

function expectPatchOk(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
): SessionEntry {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.entry;
}

function expectPatchError(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
  message: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected patch failure containing: ${message}`);
  }
  expect(result.error.message).toContain(message);
}

async function applySubagentModelPatch(cfg: OpenClawConfig) {
  return expectPatchOk(
    await runPatch({
      cfg,
      storeKey: KIMI_SUBAGENT_KEY,
      patch: {
        key: KIMI_SUBAGENT_KEY,
        model: SUBAGENT_MODEL,
      },
      loadGatewayModelCatalog: async () => [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "sonnet" },
        { provider: "synthetic", id: "hf:moonshotai/Kimi-K2.5", name: "kimi" },
      ],
    }),
  );
}

function makeKimiSubagentCfg(params: {
  agentPrimaryModel?: string;
  agentSubagentModel?: string;
  defaultsSubagentModel?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
        subagents: params.defaultsSubagentModel
          ? { model: params.defaultsSubagentModel }
          : undefined,
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "default" },
        },
      },
      list: [
        {
          id: "kimi",
          model: params.agentPrimaryModel ? { primary: params.agentPrimaryModel } : undefined,
          subagents: params.agentSubagentModel ? { model: params.agentSubagentModel } : undefined,
        },
      ],
    },
  } as OpenClawConfig;
}

function createAllowlistedAnthropicModelCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
        },
      },
    },
  } as OpenClawConfig;
}

describe("gateway sessions patch", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  test("persists thinkingLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: "off" },
      }),
    );
    expect(entry.thinkingLevel).toBe("off");
  });

  test("clears thinkingLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { thinkingLevel: "low" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: null },
      }),
    );
    expect(entry.thinkingLevel).toBeUndefined();
  });

  test("persists reasoningLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, reasoningLevel: "off" },
      }),
    );
    expect(entry.reasoningLevel).toBe("off");
  });

  test("clears reasoningLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { reasoningLevel: "stream" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, reasoningLevel: null },
      }),
    );
    expect(entry.reasoningLevel).toBeUndefined();
  });

  test("persists fastMode=false (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, fastMode: false },
      }),
    );
    expect(entry.fastMode).toBe(false);
  });

  test("persists fastMode=true", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, fastMode: true },
      }),
    );
    expect(entry.fastMode).toBe(true);
  });

  test("clears fastMode when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { fastMode: true } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, fastMode: null },
      }),
    );
    expect(entry.fastMode).toBeUndefined();
  });

  test("persists verboseLevel=full", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, verboseLevel: "full" },
      }),
    );
    expect(entry.verboseLevel).toBe("full");
  });

  test("rejects invalid verboseLevel values with all valid choices in the error", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, verboseLevel: "maybe" },
    });
    expectPatchError(result, 'invalid verboseLevel (use "on"|"off"|"full")');
  });

  test("persists elevatedLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, elevatedLevel: "off" },
      }),
    );
    expect(entry.elevatedLevel).toBe("off");
  });

  test("persists elevatedLevel=on", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, elevatedLevel: "on" },
      }),
    );
    expect(entry.elevatedLevel).toBe("on");
  });

  test("clears elevatedLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { elevatedLevel: "off" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, elevatedLevel: null },
      }),
    );
    expect(entry.elevatedLevel).toBeUndefined();
  });

  test("rejects invalid elevatedLevel values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, elevatedLevel: "maybe" },
    });
    expectPatchError(result, "invalid elevatedLevel");
  });

  test("clears auth overrides when model patch changes", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        authProfileOverride: "anthropic:default",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 3,
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, model: "anthropic/claude-sonnet-4-6" },
        loadGatewayModelCatalog: async () => [
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
        ],
      }),
    );
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.authProfileOverride).toBeUndefined();
    expect(entry.authProfileOverrideSource).toBeUndefined();
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  test("marks explicit model patches as pending live model switches", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        sessionId: "sess-live",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        cfg: createAllowlistedAnthropicModelCfg(),
        patch: { key: MAIN_SESSION_KEY, model: "anthropic/claude-sonnet-4-6" },
        loadGatewayModelCatalog: async () => [
          { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
        ],
      }),
    );

    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  test("marks model reset patches as pending live model switches", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        sessionId: "sess-live-reset",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        cfg: createAllowlistedAnthropicModelCfg(),
        patch: { key: MAIN_SESSION_KEY, model: null },
      }),
    );

    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  test.each([
    {
      name: "accepts explicit allowlisted provider/model refs from sessions.patch",
      catalog: [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5" },
      ],
    },
    {
      name: "accepts explicit allowlisted refs absent from bundled catalog",
      catalog: [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.2" },
      ],
    },
  ])("$name", async ({ catalog }) => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: createAllowlistedAnthropicModelCfg(),
        patch: { key: MAIN_SESSION_KEY, model: "anthropic/claude-sonnet-4-6" },
        loadGatewayModelCatalog: async () => catalog,
      }),
    );
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
  });

  test("sets spawnDepth for subagent sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:subagent:child",
        patch: { key: "agent:main:subagent:child", spawnDepth: 2 },
      }),
    );
    expect(entry.spawnDepth).toBe(2);
  });

  test("validates thinking patches with live catalog reasoning metadata", async () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "ollama",
      source: "test",
      provider: {
        id: "ollama",
        label: "Ollama",
        auth: [],
        resolveThinkingProfile: ({ reasoning }) => ({
          levels:
            reasoning === true
              ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }]
              : [{ id: "off" }],
          defaultLevel: "off",
        }),
      },
    });
    setActivePluginRegistry(registry);

    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "ollama/qwen3:0.6b" },
            },
          },
        } as OpenClawConfig,
        patch: {
          key: MAIN_SESSION_KEY,
          thinkingLevel: "medium",
        },
        loadGatewayModelCatalog: async () => [
          {
            provider: "ollama",
            id: "qwen3:0.6b",
            name: "qwen3:0.6b",
            reasoning: true,
          },
        ],
      }),
    );

    expect(entry.thinkingLevel).toBe("medium");
  });

  test("accepts xhigh thinking patches from configured catalog compat", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "gmn/gpt-5.4" },
            },
          },
        } as OpenClawConfig,
        patch: {
          key: MAIN_SESSION_KEY,
          thinkingLevel: "xhigh",
        },
        loadGatewayModelCatalog: async () => [
          {
            provider: "gmn",
            id: "gpt-5.4",
            name: "GPT 5.4 via GMN",
            reasoning: true,
            compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
          },
        ],
      }),
    );

    expect(entry.thinkingLevel).toBe("xhigh");
  });

  test("accepts xhigh thinking patches from bundled startup-lazy provider policy without catalog", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai-codex/gpt-5.5" },
            },
          },
        } as OpenClawConfig,
        patch: {
          key: MAIN_SESSION_KEY,
          thinkingLevel: "xhigh",
        },
        loadGatewayModelCatalog: async () => [],
      }),
    );

    expect(entry.thinkingLevel).toBe("xhigh");
  });

  test("sets spawnedBy for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:acp:child",
        patch: {
          key: "agent:main:acp:child",
          spawnedBy: "agent:main:main",
        },
      }),
    );
    expect(entry.spawnedBy).toBe("agent:main:main");
  });

  test("sets spawnedWorkspaceDir for subagent sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:subagent:child",
        patch: {
          key: "agent:main:subagent:child",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
        },
      }),
    );
    expect(entry.spawnedWorkspaceDir).toBe("/tmp/subagent-workspace");
  });

  test("sets spawnDepth for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:acp:child",
        patch: { key: "agent:main:acp:child", spawnDepth: 2 },
      }),
    );
    expect(entry.spawnDepth).toBe(2);
  });

  test("rejects spawnDepth on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, spawnDepth: 1 },
    });
    expectPatchError(result, "spawnDepth is only supported");
  });

  test("rejects spawnedWorkspaceDir on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, spawnedWorkspaceDir: "/tmp/nope" },
    });
    expectPatchError(result, "spawnedWorkspaceDir is only supported");
  });

  test("normalizes exec/send/group patches", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: {
          key: MAIN_SESSION_KEY,
          execHost: " AUTO ",
          execSecurity: " ALLOWLIST ",
          execAsk: " ON-MISS ",
          execNode: " worker-1 ",
          sendPolicy: "DENY" as unknown as "allow",
          groupActivation: "Always" as unknown as "mention",
        },
      }),
    );
    expect(entry.execHost).toBe("auto");
    expect(entry.execSecurity).toBe("allowlist");
    expect(entry.execAsk).toBe("on-miss");
    expect(entry.execNode).toBe("worker-1");
    expect(entry.sendPolicy).toBe("deny");
    expect(entry.groupActivation).toBe("always");
  });

  test("rejects invalid execHost values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, execHost: "edge" },
    });
    expectPatchError(result, "invalid execHost");
  });

  test("rejects invalid sendPolicy values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, sendPolicy: "ask" as unknown as "allow" },
    });
    expectPatchError(result, "invalid sendPolicy");
  });

  test("rejects invalid groupActivation values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, groupActivation: "never" as unknown as "mention" },
    });
    expectPatchError(result, "invalid groupActivation");
  });

  test("allows target agent own model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: "synthetic/hf:moonshotai/Kimi-K2.5",
    });

    const entry = await applySubagentModelPatch(cfg);
    // Selected model matches the target agent default, so no override is stored.
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
  });

  test("allows target agent subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: "anthropic/claude-sonnet-4-6",
      agentSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expect(entry.providerOverride).toBe("synthetic");
    expect(entry.modelOverride).toBe("hf:moonshotai/Kimi-K2.5");
  });

  test("allows global defaults.subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      defaultsSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expect(entry.providerOverride).toBe("synthetic");
    expect(entry.modelOverride).toBe("hf:moonshotai/Kimi-K2.5");
  });
});
