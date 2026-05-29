import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  resolveCronFallbacksOverride,
  resolveCronPreflightCandidates,
} from "./run-fallback-policy.js";

function makeJob(payload: CronJob["payload"]): CronJob {
  return {
    id: "cron-fallback-policy",
    name: "Cron fallback policy",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload,
    state: {},
  } as CronJob;
}

function makeConfig(fallbacks?: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-opus-4-6",
          ...(fallbacks !== undefined ? { fallbacks } : {}),
        },
      },
    },
  };
}

describe("resolveCronFallbacksOverride", () => {
  it("keeps configured fallbacks for cron payload model overrides", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: makeConfig(["openai/gpt-5.4", "google/gemini-3-pro"]),
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          model: "google/gemini-2.0-flash",
        }),
      }),
    ).toEqual(["openai/gpt-5.4", "google/gemini-3-pro"]);
  });

  it("returns an empty override for payload model overrides without configured fallbacks", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: makeConfig(),
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          model: "google/gemini-2.0-flash",
        }),
      }),
    ).toStrictEqual([]);
  });

  it("lets payload fallbacks override the configured fallback policy", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: makeConfig(["openai/gpt-5.4"]),
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          model: "google/gemini-2.0-flash",
          fallbacks: [],
        }),
      }),
    ).toStrictEqual([]);
  });

  it("uses subagent model fallbacks when cron selects the configured subagent model", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["openai/gpt-5.4"],
              },
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai-codex/gpt-5.2", "zai/glm-5"],
                },
              },
            },
          },
        },
        agentId: "main",
        useSubagentFallbacks: true,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toEqual(["openai-codex/gpt-5.2", "zai/glm-5"]);
  });

  it("keeps a selected agent primary model strict ahead of default subagent fallbacks", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai-codex/gpt-5.2"],
                },
              },
            },
            list: [
              {
                id: "research",
                model: {
                  primary: "anthropic/claude-opus-4-6",
                },
              },
            ],
          },
        },
        agentId: "research",
        useSubagentFallbacks: true,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toStrictEqual([]);
  });

  it("keeps explicit empty subagent fallbacks as a fallback override", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["openai/gpt-5.4"],
              },
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: [],
                },
              },
            },
          },
        },
        agentId: "main",
        useSubagentFallbacks: true,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toStrictEqual([]);
  });

  it("ignores subagent fallbacks when cron did not select the subagent model", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
              },
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai-codex/gpt-5.2"],
                },
              },
            },
          },
        },
        agentId: "main",
        useSubagentFallbacks: false,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toBeUndefined();
  });

  it("treats string subagent model selection as strict when no fallbacks are configured", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["openai/gpt-5.4"],
              },
              subagents: {
                model: "kimi/kimi-code",
              },
            },
          },
        },
        agentId: "main",
        useSubagentFallbacks: true,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toStrictEqual([]);
  });

  it("keeps payload model overrides on the configured model fallback policy", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["openai/gpt-5.4"],
              },
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai-codex/gpt-5.4", "zai/glm-5"],
                },
              },
            },
          },
        },
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          model: "google/gemini-3-pro",
        }),
      }),
    ).toEqual(["openai/gpt-5.4"]);
  });

  it("leaves the default model path to the fallback runner when no payload model is set", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: makeConfig(["openai/gpt-5.4"]),
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toBeUndefined();
  });

  it("plans the full configured candidate chain for cron preflight", () => {
    expect(
      resolveCronPreflightCandidates({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "ollama/qwen3:32b",
                fallbacks: ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-5.4"],
              },
            },
          },
        },
        agentId: "main",
        provider: "ollama",
        model: "qwen3:32b",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toEqual([
      { provider: "ollama", model: "qwen3:32b" },
      { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" },
      { provider: "openai", model: "gpt-5.4" },
    ]);
  });

  it("keeps cron preflight strict when payload fallbacks are explicitly empty", () => {
    expect(
      resolveCronPreflightCandidates({
        cfg: makeConfig(["openai/gpt-5.4"]),
        agentId: "main",
        provider: "ollama",
        model: "qwen3:32b",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          fallbacks: [],
        }),
      }),
    ).toStrictEqual([{ provider: "ollama", model: "qwen3:32b" }]);
  });

  it("documents that cron preflight walks fallbacks before skipping", () => {
    const cliDocs = readFileSync("docs/cli/cron.md", "utf8");
    const automationDocs = readFileSync("docs/automation/cron-jobs.md", "utf8");

    expect(cliDocs).toContain("Local-provider preflight checks walk configured fallbacks");
    expect(automationDocs).toContain("Local-provider preflight checks walk configured fallbacks");
  });
});
