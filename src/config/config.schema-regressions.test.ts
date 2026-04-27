import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("config schema regressions", () => {
  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch provider "mistral"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "mistral",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch provider "bedrock"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "bedrock",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts memorySearch.qmd.extraCollections", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            qmd: {
              extraCollections: [
                { path: "/shared/team-notes", name: "team-notes", pattern: "**/*.md" },
              ],
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts agents.list[].memorySearch.qmd.extraCollections", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            memorySearch: {
              qmd: {
                extraCollections: [
                  { path: "/shared/team-notes", name: "team-notes", pattern: "**/*.md" },
                ],
              },
            },
          },
        ],
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

  it("accepts agents.defaults and agents.list contextLimits overrides", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          contextLimits: {
            memoryGetMaxChars: 20_000,
            memoryGetDefaultLines: 180,
            toolResultMaxChars: 24_000,
            postCompactionMaxChars: 4_000,
          },
        },
        list: [
          {
            id: "writer",
            skillsLimits: {
              maxSkillsPromptChars: 30_000,
            },
            contextLimits: {
              memoryGetMaxChars: 24_000,
            },
          },
        ],
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
          pdfMaxBytesMb: 12,
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
          pdfMaxBytesMb: 0,
          pdfMaxPages: 0,
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path.includes("agents.defaults.pdfMax"))).toBe(true);
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

  it("accepts browser local startup timeout settings", () => {
    const res = validateConfigObject({
      browser: {
        localLaunchTimeoutMs: 45_000,
        localCdpReadyTimeoutMs: 30_000,
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects out-of-range browser local startup timeout settings", () => {
    const res = validateConfigObject({
      browser: {
        localLaunchTimeoutMs: 120_001,
        localCdpReadyTimeoutMs: 0,
      },
    });

    expect(res.ok).toBe(false);
  });

  it("rejects browser.extraArgs with non-array value", () => {
    const res = validateConfigObject({
      browser: {
        extraArgs: "--proxy-server=http://127.0.0.1:7890" as unknown,
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts tools.media.asyncCompletion.directSend", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          asyncCompletion: {
            directSend: true,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
  it("accepts discovery.wideArea.domain for unicast DNS-SD", () => {
    const res = validateConfigObject({
      discovery: {
        wideArea: {
          enabled: true,
          domain: "openclaw.internal",
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
