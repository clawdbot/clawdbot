// Context engine host compatibility tests cover doctor warnings for host/context mismatches.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getContextEngineRegistration,
  registerContextEngineForOwner,
} from "../../../context-engine/registry.js";
import type { ContextEngine, ContextEngineHostCapability } from "../../../context-engine/types.js";
import { acquirePluginRegistryForInspection } from "../../../plugins/loader.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  collectContextEngineHostCompatibilityWarnings,
  maybeRepairContextEngineHostCompatibility,
} from "./context-engine-host-compat.js";

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

vi.mock("../../../plugins/loader.js", () => ({
  acquirePluginRegistryForInspection: vi.fn(),
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
  it.each([true, false])(
    "reports offline inspection availability without activating or repairing an engine (discovered=%s)",
    async (discovered) => {
      const id = uniqueEngineId();
      const factory = vi.fn(() => {
        throw new Error("Doctor must not initialize an engine to inspect its metadata");
      });
      const registry = createEmptyPluginRegistry();
      if (discovered) {
        registry.contextEngines.set(id, {
          factory,
          owner: `plugin:${id}`,
          lifecycle: "readOnlyDiscovery",
        });
      }
      vi.mocked(acquirePluginRegistryForInspection).mockImplementation(async () => ({
        registry,
        release: async () => undefined,
      }));
      const cfg = configWithEngine(id);
      const params = { cfg, doctorFixCommand: "openclaw doctor --fix" };
      const warnings = await collectContextEngineHostCompatibilityWarnings(params);
      expect(warnings.join("\n")).toContain(
        discovered
          ? "registered for read-only discovery; offline host compatibility inspection is unavailable"
          : "because it is not registered",
      );
      const repair = await maybeRepairContextEngineHostCompatibility(params);
      expect(repair).toEqual({ config: cfg, changes: [], warnings });
      expect(repair.config).toBe(cfg);
      expect(factory).not.toHaveBeenCalled();
    },
  );

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

  it("uses the system agent when inspecting an explicit multi-agent roster", async () => {
    const engineId = registerEngine([]);
    const warnings = await collectContextEngineHostCompatibilityWarnings({
      cfg: configWithEngine(engineId, {
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "main" },
            model: "anthropic/claude-sonnet-4-6",
          },
          entries: {
            main: { agentDir: "/tmp/openclaw-doctor-host-compat" },
            helper: {},
            third: {},
          },
        },
      }),
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([]);
  });

  it("repairs an incompatible context engine by resetting the global slot to legacy", async () => {
    const engineId = registerEngine(["assemble-before-prompt"]);
    const cfg = configWithEngine(engineId, {
      plugins: {
        slots: {
          memory: "custom-memory",
        },
      },
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    });
    const warnings = await collectContextEngineHostCompatibilityWarnings({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
    });
    const result = await maybeRepairContextEngineHostCompatibility({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings.join("\n")).toContain(
      'remove the plugins.slots.contextEngine override and restore the default "legacy"',
    );
    expect(result.config.plugins?.slots).toEqual({ memory: "custom-memory" });
    expect(result.changes).toEqual([
      `Reset plugins.slots.contextEngine to the default "legacy" because context engine "${engineId}" is incompatible with every configured agent-run host.`,
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
