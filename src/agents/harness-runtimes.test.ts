// Covers config scanning for agent harness runtime requirements.
import { describe, expect, it } from "vitest";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectConfiguredAgentHarnessRuntimes as collectConfiguredAgentHarnessRuntimesBase } from "./harness-runtimes.js";

function countRosterReads(config: OpenClawConfig): () => number {
  const agents = (config as { agents: Record<string, unknown> }).agents;
  const entries = agents.entries;
  let reads = 0;
  Object.defineProperty(agents, "entries", {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      return entries;
    },
  });
  return () => reads;
}

function collectConfiguredAgentHarnessRuntimes(
  config: OpenClawConfig,
  options?: Parameters<typeof collectConfiguredAgentHarnessRuntimesBase>[1],
) {
  return collectConfiguredAgentHarnessRuntimesBase(
    migratePersistedImplicitMainRoster(config).config as OpenClawConfig,
    options,
  );
}

describe("collectConfiguredAgentHarnessRuntimes", () => {
  it("requires Codex for selectable default OpenAI agent models", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "openai/gpt-5.5": {},
          },
        },
      },
    } as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config)).toEqual(["codex"]);
  });

  it("requires Codex when OpenAI is only a default model fallback", () => {
    const config = {
      agents: {
        defaults: {
          model: { fallbacks: ["openai/gpt-5.5"] },
        },
      },
    } as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config)).toEqual(["codex"]);
  });

  it("can ignore implicit OpenAI Codex runtime preferences", () => {
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: {
            "openai/gpt-5.4": {},
            "anthropic/claude-opus-4-7": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      collectConfiguredAgentHarnessRuntimes(config, {
        includeImplicitRuntimePreferences: false,
      }),
    ).toEqual(["codex"]);
  });

  it("requires Codex for selectable per-agent OpenAI models", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
        },
        list: [
          {
            id: "worker",
            models: {
              "openai/gpt-5.5": {},
            },
          },
        ],
      },
    } as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config)).toEqual(["codex"]);
  });

  it("respects explicit OpenClaw runtime policy on selectable OpenAI agent models", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config)).toEqual([]);
  });

  it("does not infer Codex for custom OpenAI-compatible base URLs", () => {
    // OpenAI provider id alone is not enough: custom compatible endpoints may
    // not support Codex runtime assumptions or model contracts.
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://openai-compatible.example.test/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {},
          },
        },
      },
    } as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config)).toEqual([]);
  });

  it("ignores a malformed legacy list when canonical entries are available", () => {
    // Runtime collection is diagnostic/setup support, so malformed optional
    // agent lists should not hide valid defaults-level runtime requirements.
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {
              agentRuntime: { id: "claude" },
            },
          },
        },
        entries: { main: { default: true } },
        list: {
          ops: {
            id: "ops",
            agentRuntime: { id: "codex" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config)).toEqual(["claude"]);
  });

  it("bounds roster reads per collection batch on large fleets (#135743)", () => {
    // The collector must not multiply full-roster reads by model-reference count.
    const agentCount = 300;
    const modelsPerAgent = 40;
    const entries: Record<string, { models: Record<string, Record<string, never>> }> = {};
    for (let i = 0; i < agentCount; i++) {
      const models: Record<string, Record<string, never>> = {};
      for (let m = 0; m < modelsPerAgent; m++) {
        models[`openai/proof-model-${m}`] = {};
      }
      entries[`agent-${i}`] = { models };
    }
    const config = {
      agents: {
        entries,
        defaults: {
          models: { "anthropic/claude-opus-4-7": {} } as Record<string, Record<string, never>>,
        },
      },
    } as unknown as OpenClawConfig;
    const migrated = migratePersistedImplicitMainRoster(config).config as OpenClawConfig;
    const rosterReads = countRosterReads(migrated);

    const runtimes = collectConfiguredAgentHarnessRuntimesBase(migrated);

    expect(runtimes).toEqual(["codex"]);
    expect(rosterReads()).toBeLessThanOrEqual(16);
  });

  it("observes roster mutations made between collection batches (#135743)", () => {
    const config = { agents: { entries: { main: {} } } } as unknown as OpenClawConfig;
    const migrated = migratePersistedImplicitMainRoster(config).config as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimesBase(migrated)).toEqual([]);

    const roster = (migrated as { agents: { entries: Record<string, unknown> } }).agents.entries;
    roster.worker = { models: { "openai/gpt-5.5": {} } };

    expect(collectConfiguredAgentHarnessRuntimesBase(migrated)).toEqual(["codex"]);
  });
});
