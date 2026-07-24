// Regresses known config schema edge cases and compatibility expectations.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("config schema regressions", () => {
  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      memory: {
        search: {
          fallback: "voyage",
        },
      },

      agents: {
        defaults: {},
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch provider "mistral"', () => {
    const res = validateConfigObject({
      memory: {
        search: {
          provider: "mistral",
        },
      },

      agents: {
        defaults: {},
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch provider "bedrock"', () => {
    const res = validateConfigObject({
      memory: {
        search: {
          provider: "bedrock",
        },
      },

      agents: {
        defaults: {},
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects local memorySearch GPU policy", () => {
    const res = validateConfigObject({
      memory: {
        search: {
          provider: "local",
          local: {
            gpu: "cpu",
          },
        },
      },

      agents: {
        defaults: {},
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts memorySearch.qmd.extraCollections", () => {
    const res = validateConfigObject({
      memory: {
        search: {
          qmd: {
            extraCollections: [
              { path: "/shared/team-notes", name: "team-notes", pattern: "**/*.md" },
            ],
          },
        },
      },

      agents: {
        defaults: {},
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts agents.entries.*.memory.search.qmd.extraCollections", () => {
    const res = validateConfigObject({
      agents: {
        entries: {
          main: {
            memory: {
              search: {
                qmd: {
                  extraCollections: [
                    { path: "/shared/team-notes", name: "team-notes", pattern: "**/*.md" },
                  ],
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts agents.defaults.startupContext overrides", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          startupContext: {
            enabled: true,
            applyOn: ["new"],
            dailyMemoryDays: 3,
            maxFileBytes: 8192,
            maxFileChars: 1000,
            maxTotalChars: 2500,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects oversized agents.defaults.startupContext overrides", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          startupContext: {
            dailyMemoryDays: 99,
            maxFileBytes: 999_999,
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts agents.defaults and agents.entries contextLimits overrides", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          contextLimits: {
            memoryGetMaxChars: 20_000,
            postCompactionMaxChars: 4_000,
          },
        },
        entries: {
          writer: {
            skillsLimits: {
              maxSkillsPromptChars: 30_000,
            },
            contextLimits: {
              memoryGetMaxChars: 24_000,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts agents.entries experimental localModelLean overrides", () => {
    const res = validateConfigObject({
      agents: {
        entries: {
          gemma: {
            experimental: {
              localModelLean: true,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts agents.defaults.compaction.truncateAfterCompaction", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          compaction: {
            truncateAfterCompaction: true,
            maxActiveTranscriptBytes: "20mb",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts Matrix queue byChannel overrides", () => {
    const res = validateConfigObject({
      messages: {
        queue: {
          byChannel: {
            matrix: "steer",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts Matrix interrupt queue byChannel overrides", () => {
    const res = validateConfigObject({
      messages: {
        queue: {
          byChannel: {
            matrix: "interrupt",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("keeps queue byChannel schema and config type providers aligned", () => {
    const res = validateConfigObject({
      messages: {
        queue: {
          byChannel: {
            googlechat: "followup",
            mattermost: "collect",
            matrix: "steer",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unknown queue byChannel providers", () => {
    const res = validateConfigObject({
      messages: {
        queue: {
          byChannel: {
            unknown: "steer",
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts string values for agents defaults model inputs", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          imageModel: "openai/gpt-4.1-mini",
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts pdf default model and limits", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          pdfModel: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.4-mini"],
          },
          pdfMaxMb: 12,
          pdfMaxPages: 25,
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects non-positive pdf limits", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          pdfModel: { primary: "openai/gpt-5.4-mini" },
          pdfMaxMb: 0,
          pdfMaxPages: 0,
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issuePaths = res.issues.map((issue) => issue.path);
      expect(issuePaths).toContain("agents.defaults.pdfMaxMb");
      expect(issuePaths).toContain("agents.defaults.pdfMaxPages");
    }
  });

  it("accepts browser.extraArgs for proxy and custom flags", () => {
    const res = validateConfigObject({
      browser: {
        extraArgs: ["--proxy-server=http://127.0.0.1:7890"],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects browser.extraArgs with non-array value", () => {
    const res = validateConfigObject({
      browser: {
        extraArgs: "--proxy-server=http://127.0.0.1:7890" as unknown,
      },
    });

    expect(res.ok).toBe(false);
  });

  it("rejects unknown keys under browser.tabCleanup", () => {
    const res = validateConfigObject({
      browser: {
        tabCleanup: {
          unknownKey: true as unknown,
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts discovery.wideArea.domain for unicast DNS-SD", () => {
    const res = validateConfigObject({
      discovery: {
        wideArea: {
          domain: "openclaw.internal",
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects bindings referencing an agentId missing from agents.entries (openclaw#84692)", () => {
    const res = validateConfigObject({
      agents: {
        entries: { alpha: { model: "anthropic/claude-3-5-sonnet" } },
      },
      bindings: [
        {
          type: "route",
          agentId: "ghost",
          match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
        },
      ],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((iss) => iss.message.includes('Unknown agent id "ghost"'))).toBe(true);
    }
  });

  it("accepts bindings whose agentId is present in agents.entries", () => {
    const res = validateConfigObject({
      agents: {
        entries: { alpha: { model: "anthropic/claude-3-5-sonnet" } },
      },
      bindings: [
        {
          type: "route",
          agentId: "alpha",
          match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
        },
      ],
    });

    expect(res.ok).toBe(true);
  });

  it("rejects non-addressable agents.entries keys", () => {
    const res = validateConfigObject({
      agents: {
        entries: { "Team Ops": { model: "anthropic/claude-3-5-sonnet" } },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("skips binding agentId check when agents.entries is absent", () => {
    const res = validateConfigObject({
      bindings: [
        {
          type: "route",
          agentId: "alpha",
          match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
        },
      ],
    });

    expect(res.ok).toBe(true);
  });

  it("accepts a microsoft-foundry model entry carrying thinkingLevelMap (openclaw#91011)", () => {
    // Foundry's writer (buildFoundryThinkingLevelMap) persists this during Entra ID onboarding; the
    // strict schema used to reject thinkingLevelMap, so updateConfig rolled the whole write back.
    const res = validateConfigObject({
      models: {
        providers: {
          "microsoft-foundry": {
            models: [
              {
                id: "gpt-5.1-chat",
                name: "gpt-5.1-chat",
                api: "openai-responses",
                reasoning: true,
                thinkingLevelMap: {
                  off: "none",
                  minimal: null,
                  low: "low",
                  medium: "medium",
                  high: "high",
                  xhigh: null,
                  max: null,
                },
              },
            ],
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects thinkingLevelMap keys outside the model thinking levels", () => {
    // "adaptive" is a valid agent thinkingDefault but not a ModelThinkingLevel; the map stays strict.
    const res = validateConfigObject({
      models: {
        providers: {
          "microsoft-foundry": {
            models: [
              {
                id: "gpt-5.1-chat",
                name: "gpt-5.1-chat",
                thinkingLevelMap: { adaptive: "high" },
              },
            ],
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });
});
