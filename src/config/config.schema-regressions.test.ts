// Regresses known config schema edge cases and compatibility expectations.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("config schema regressions", () => {
  it.each([0, 3_000])(
    "accepts the documented global exec approval running notice delay %i",
    (approvalRunningNoticeMs) => {
      const result = validateConfigObject({
        tools: {
          exec: {
            approvalRunningNoticeMs,
          },
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.tools?.exec?.approvalRunningNoticeMs).toBe(approvalRunningNoticeMs);
      }
    },
  );

  it.each([0, 3_000])(
    "preserves the per-agent exec approval running notice delay %i",
    (approvalRunningNoticeMs) => {
      const result = validateConfigObject({
        agents: {
          entries: {
            main: {
              tools: {
                exec: {
                  approvalRunningNoticeMs,
                },
              },
            },
          },
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.agents?.entries?.main?.tools?.exec?.approvalRunningNoticeMs).toBe(
          approvalRunningNoticeMs,
        );
      }
    },
  );

  it.each([-1, 1.5, "3000"])(
    "rejects invalid global exec approval running notice delay %s",
    (approvalRunningNoticeMs) => {
      const result = validateConfigObject({
        tools: {
          exec: {
            approvalRunningNoticeMs,
          },
        },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.map((issue) => issue.path)).toContain(
          "tools.exec.approvalRunningNoticeMs",
        );
      }
    },
  );

  it.each([-1, 1.5, "3000"])(
    "rejects invalid per-agent exec approval running notice delay %s",
    (approvalRunningNoticeMs) => {
      const result = validateConfigObject({
        agents: {
          entries: {
            main: {
              tools: {
                exec: {
                  approvalRunningNoticeMs,
                },
              },
            },
          },
        },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.map((issue) => issue.path)).toContain(
          "agents.entries.main.tools.exec.approvalRunningNoticeMs",
        );
      }
    },
  );

  it.each([
    {
      scope: "global",
      config: {
        tools: {
          exec: {
            approvalRunningNoticeMs: 0,
            unknownApprovalRunningNoticeMs: 0,
          },
        },
      },
    },
    {
      scope: "per-agent",
      config: {
        agents: {
          entries: {
            main: {
              tools: {
                exec: {
                  approvalRunningNoticeMs: 0,
                  unknownApprovalRunningNoticeMs: 0,
                },
              },
            },
          },
        },
      },
    },
  ])("keeps $scope exec configuration strict", ({ config }) => {
    expect(validateConfigObject(config).ok).toBe(false);
  });

  it.each([
    { field: "fallback", value: "voyage" },
    { field: "provider", value: "mistral" },
    { field: "provider", value: "bedrock" },
  ])('accepts memorySearch $field "$value"', ({ field, value }) => {
    expect(
      validateConfigObject({
        memory: { search: { [field]: value } },
        agents: { defaults: {} },
      }).ok,
    ).toBe(true);
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

  it.each([
    { name: "accepts Matrix queue byChannel overrides", mode: "steer" },
    { name: "accepts Matrix interrupt queue byChannel overrides", mode: "interrupt" },
  ])("$name", ({ mode }) => {
    expect(validateConfigObject({ messages: { queue: { byChannel: { matrix: mode } } } }).ok).toBe(
      true,
    );
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

  it("accepts the browser extension relay legacy-auth migration gate", () => {
    const res = validateConfigObject({
      browser: {
        extensionRelay: {
          allowLegacyAuth: false,
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unknown keys under browser.extensionRelay", () => {
    const res = validateConfigObject({
      browser: {
        extensionRelay: {
          allowLegacyAuth: true,
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

  it("accepts exact main bindings when agents.entries omits the implicit main agent", () => {
    const res = validateConfigObject({
      agents: {
        entries: { alpha: { model: "anthropic/claude-3-5-sonnet" } },
      },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
        },
      ],
    });

    expect(res.ok).toBe(true);
  });

  it("rejects normalized main binding variants when agents.entries omits them", () => {
    const res = validateConfigObject({
      agents: {
        entries: { alpha: { model: "anthropic/claude-3-5-sonnet" } },
      },
      bindings: [
        {
          type: "route",
          agentId: "MAIN",
          match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
        },
      ],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((iss) => iss.message.includes('Unknown agent id "MAIN"'))).toBe(true);
    }
  });

  it("accepts a normalized main binding variant when that agent is explicitly configured", () => {
    const res = validateConfigObject({
      agents: {
        entries: { MAIN: { model: "anthropic/claude-3-5-sonnet" } },
      },
      bindings: [
        {
          type: "route",
          agentId: "MAIN",
          match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
        },
      ],
    });

    expect(res.ok).toBe(true);
  });

  it("rejects non-default bindings when the implicit-main roster is materialized", () => {
    const res = validateConfigObject({
      bindings: [
        {
          type: "route",
          agentId: "alpha",
          match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
        },
      ],
    });

    expect(res.ok).toBe(false);
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
