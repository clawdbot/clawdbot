// Context engine host compatibility tests cover doctor warnings for host/context mismatches.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getContextEngineRegistration,
  registerContextEngineForOwner,
} from "../../../context-engine/registry.js";
import type { ContextEngine, ContextEngineHostCapability } from "../../../context-engine/types.js";
import {
  collectContextEngineHostCompatibilityWarnings,
  maybeRepairContextEngineHostCompatibility,
} from "./context-engine-host-compat.js";

vi.mock("../../../agents/agent-scope-config.js", () => ({
  resolveDefaultAgentDir: vi.fn(() => "/tmp/openclaw-doctor-host-compat"),
}));

vi.mock("../../../agents/cli-backends.js", () => ({
  resolveCliBackendConfig: vi.fn((runtimeId: string) => ({ id: runtimeId })),
}));

vi.mock("../../../agents/harness/policy.js", () => ({
  resolveAgentHarnessPolicy: vi.fn(
    (params: { config: OpenClawConfig; modelId: string; provider: string }) => ({
      runtime:
        params.config.agents?.defaults?.models?.[`${params.provider}/${params.modelId}`]
          ?.agentRuntime?.id ?? "openclaw",
    }),
  ),
}));

vi.mock("../../../agents/harness/registry.js", () => ({
  getRegisteredAgentHarness: vi.fn(() => undefined),
}));

vi.mock("../../../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
}));

vi.mock("../../../plugins/runtime/runtime-registry-loader.js", () => ({
  ensurePluginRegistryLoaded: vi.fn(),
}));

let engineCounter = 0;

function uniqueEngineId(): string {
  engineCounter += 1;
  return `doctor-host-compat-${engineCounter}`;
}

function registerTestContextEngine(
  id: string,
  factory: Parameters<typeof registerContextEngineForOwner>[1],
) {
  return registerContextEngineForOwner(id, factory, `doctor-test-owner-${id}`, {
    allowSameOwnerRefresh: true,
  });
}

function registerEngine(requiredCapabilities: ContextEngineHostCapability[]): string {
  const id = uniqueEngineId();
  const engine: ContextEngine = {
    info: {
      id,
      name: "Doctor Host Compat",
      hostRequirements:
        requiredCapabilities.length > 0
          ? {
              "agent-run": {
                requiredCapabilities,
                unsupportedMessage: "Use a compatible runtime or switch to legacy.",
              },
            }
          : undefined,
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  };
  registerTestContextEngine(id, () => engine);
  return id;
}

function configWithEngine(engineId: string, cfg: OpenClawConfig = {}): OpenClawConfig {
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      slots: {
        ...cfg.plugins?.slots,
        contextEngine: engineId,
      },
    },
  };
}

describe("doctor context-engine host compatibility", () => {
  it("distinguishes read-only discovery registrations from runtime entries", () => {
    const id = uniqueEngineId();
    const factory = () => {
      throw new Error("discovery-only");
    };
    const result = registerContextEngineForOwner(id, factory, `doctor-test-owner-${id}`, {
      lifecycle: "readOnlyDiscovery",
    });

    expect(result).toEqual({ ok: true });
    expect(getContextEngineRegistration(id)).toMatchObject({
      factory,
      lifecycle: "readOnlyDiscovery",
    });
  });

  it("evaluates native Codex and OpenClaw agent-run hosts", async () => {
    const engineId = registerEngine(["thread-bootstrap-projection"]);
    const warnings = await collectContextEngineHostCompatibilityWarnings({
      cfg: configWithEngine(engineId, {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      }),
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings.join("\n")).toContain("OpenClaw embedded runner");
    expect(warnings.join("\n")).toContain("Some configured runtimes support");
    expect(warnings.join("\n")).not.toContain("Codex app-server harness (");
  });

  it("does not warn for context engines without host requirements", async () => {
    const engineId = registerEngine([]);
    const warnings = await collectContextEngineHostCompatibilityWarnings({
      cfg: configWithEngine(engineId, {
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            models: {
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      }),
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([]);
  });

  it("repairs an incompatible context engine by switching the global slot to legacy", async () => {
    const engineId = registerEngine(["assemble-before-prompt"]);
    const result = await maybeRepairContextEngineHostCompatibility({
      cfg: configWithEngine(engineId, {
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            models: {
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      }),
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.config.plugins?.slots?.contextEngine).toBe("legacy");
    expect(result.changes).toEqual([
      `Set plugins.slots.contextEngine to "legacy" because context engine "${engineId}" is incompatible with every configured agent-run host.`,
    ]);
  });

  it("leaves compatible native runtimes unchanged", async () => {
    const engineId = registerEngine(["assemble-before-prompt", "runtime-llm-complete"]);
    const cfg = configWithEngine(engineId, {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
    });
    const result = await maybeRepairContextEngineHostCompatibility({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });

  it("warns but does not auto-repair mixed compatible and incompatible runtimes", async () => {
    const engineId = registerEngine(["assemble-before-prompt"]);
    const cfg = configWithEngine(engineId, {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    });
    const result = await maybeRepairContextEngineHostCompatibility({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings?.join("\n")).toContain(
      "Some configured runtimes support context engine",
    );
  });
});
