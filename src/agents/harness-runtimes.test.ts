import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes.js";

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

    expect(collectConfiguredAgentHarnessRuntimes(config, {}, { includeEnvRuntime: false })).toEqual(
      ["codex"],
    );
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

    expect(collectConfiguredAgentHarnessRuntimes(config, {}, { includeEnvRuntime: false })).toEqual(
      ["codex"],
    );
  });

  it("respects explicit Pi runtime policy on selectable OpenAI agent models", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "pi" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config, {}, { includeEnvRuntime: false })).toEqual(
      [],
    );
  });

  it("does not infer Codex for custom OpenAI-compatible base URLs", () => {
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

    expect(collectConfiguredAgentHarnessRuntimes(config, {}, { includeEnvRuntime: false })).toEqual(
      [],
    );
  });

  it("ignores malformed agents.list while scanning best-effort config", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {
              agentRuntime: { id: "claude" },
            },
          },
        },
        list: {
          ops: {
            id: "ops",
            agentRuntime: { id: "codex" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentHarnessRuntimes(config, {}, { includeEnvRuntime: false })).toEqual(
      ["claude"],
    );
  });
});
