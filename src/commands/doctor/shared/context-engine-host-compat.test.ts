// Context engine host compatibility tests cover doctor warnings for host/context mismatches.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { registerContextEngine } from "../../../context-engine/registry.js";
import type { ContextEngine, ContextEngineHostCapability } from "../../../context-engine/types.js";
import {
  collectConfiguredContextEngineAgentRunHosts,
  collectContextEngineHostCompatibilityWarnings,
  maybeRepairContextEngineHostCompatibility,
} from "./context-engine-host-compat.js";

let engineCounter = 0;

function uniqueEngineId(): string {
  engineCounter += 1;
  return `doctor-host-compat-${engineCounter}`;
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
  registerContextEngine(id, () => engine);
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
  it("collects native Codex and OpenClaw as compatible agent-run hosts", () => {
    const hosts = collectConfiguredContextEngineAgentRunHosts({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
    });

    expect(hosts.map((host) => host.host.id).toSorted()).toEqual([
      "codex-app-server",
      "openclaw-embedded",
    ]);
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
