// Entry status tests cover shared presentation metadata and requirement evaluation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "./entry-status.js";

function setPlatform(platform: NodeJS.Platform): void {
  mockProcessPlatform(platform);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared/entry-status", () => {
  it("combines metadata presentation fields with evaluated requirements", () => {
    setPlatform("linux");

    const result = evaluateEntryRequirementsForCurrentPlatform({
      always: false,
      entry: {
        metadata: {
          emoji: "🦀",
          homepage: " https://openclaw.ai ",
          requires: {
            bins: ["bun"],
            anyBins: ["ffmpeg", "sox"],
            env: ["OPENCLAW_TOKEN"],
            config: ["gateway.bind"],
          },
          os: ["darwin"],
        },
        frontmatter: {
          emoji: "🙂",
          homepage: "https://docs.openclaw.ai",
        },
      },
      hasLocalBin: (bin) => bin === "bun",
      remote: {
        hasAnyBin: (bins) => bins.includes("sox"),
      },
      isEnvSatisfied: () => false,
      isConfigSatisfied: (path) => path === "gateway.bind",
    });

    expect(result).toEqual({
      emoji: "🦀",
      homepage: "https://openclaw.ai",
      required: {
        bins: ["bun"],
        anyBins: ["ffmpeg", "sox"],
        env: ["OPENCLAW_TOKEN"],
        config: ["gateway.bind"],
        os: ["darwin"],
      },
      missing: {
        bins: [],
        anyBins: [],
        env: ["OPENCLAW_TOKEN"],
        config: [],
        os: ["darwin"],
      },
      requirementsSatisfied: false,
      configChecks: [{ path: "gateway.bind", satisfied: true }],
    });
  });

  it("evaluates OS requirements against process.platform", () => {
    setPlatform("darwin");

    const result = evaluateEntryRequirementsForCurrentPlatform({
      always: false,
      entry: {
        metadata: {
          os: ["darwin"],
        },
      },
      hasLocalBin: () => false,
      isEnvSatisfied: () => true,
      isConfigSatisfied: () => true,
    });

    expect(result.requirementsSatisfied).toBe(true);
    expect(result.missing.os).toStrictEqual([]);
  });

  it("combines frontmatter presentation with always-on requirements", () => {
    setPlatform("linux");

    const result = evaluateEntryRequirementsForCurrentPlatform({
      always: true,
      entry: {
        metadata: {
          requires: {
            bins: ["missing-bin"],
          },
        },
        frontmatter: {
          website: " https://docs.openclaw.ai ",
          emoji: "🙂",
        },
      },
      hasLocalBin: () => false,
      isEnvSatisfied: () => false,
      isConfigSatisfied: () => false,
    });

    expect(result).toEqual({
      emoji: "🙂",
      homepage: "https://docs.openclaw.ai",
      required: {
        bins: ["missing-bin"],
        anyBins: [],
        env: [],
        config: [],
        os: [],
      },
      missing: {
        bins: [],
        anyBins: [],
        env: [],
        config: [],
        os: [],
      },
      requirementsSatisfied: true,
      configChecks: [],
    });
  });

  it("returns empty requirements when metadata and frontmatter are missing", () => {
    setPlatform("linux");

    const result = evaluateEntryRequirementsForCurrentPlatform({
      always: false,
      entry: {},
      hasLocalBin: () => false,
      isEnvSatisfied: () => false,
      isConfigSatisfied: () => false,
    });

    expect(result).toEqual({
      required: {
        bins: [],
        anyBins: [],
        env: [],
        config: [],
        os: [],
      },
      missing: {
        bins: [],
        anyBins: [],
        env: [],
        config: [],
        os: [],
      },
      requirementsSatisfied: true,
      configChecks: [],
    });
  });

  it.each([
    {
      name: "blank metadata suppresses frontmatter",
      entry: {
        metadata: { emoji: "", homepage: "   " },
        frontmatter: { emoji: "🙂", homepage: "https://example.com" },
      },
      emoji: undefined,
      homepage: undefined,
    },
    {
      name: "URL alias is trimmed when higher-priority fields are absent",
      entry: { frontmatter: { emoji: " ", url: " https://openclaw.ai/install " } },
      emoji: " ",
      homepage: "https://openclaw.ai/install",
    },
    {
      name: "blank homepage suppresses lower-priority aliases",
      entry: {
        frontmatter: {
          homepage: " ",
          website: "https://docs.openclaw.ai",
          url: "https://openclaw.ai/install",
        },
      },
      emoji: undefined,
      homepage: undefined,
    },
  ])("preserves presentation precedence: $name", ({ entry, emoji, homepage }) => {
    const result = evaluateEntryRequirementsForCurrentPlatform({
      always: false,
      entry,
      hasLocalBin: () => false,
      isEnvSatisfied: () => false,
      isConfigSatisfied: () => false,
    });

    expect(result.emoji).toBe(emoji);
    expect(result.homepage).toBe(homepage);
    expect(Object.hasOwn(result, "emoji")).toBe(emoji !== undefined);
    expect(Object.hasOwn(result, "homepage")).toBe(homepage !== undefined);
  });
});
