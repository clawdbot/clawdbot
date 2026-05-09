import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateEntryMetadataRequirements,
  evaluateEntryMetadataRequirementsForCurrentPlatform,
  evaluateEntryRequirementsForCurrentPlatform,
} from "./entry-status.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

describe("shared/entry-status", () => {
  it("combines metadata presentation fields with evaluated requirements", () => {
    const result = evaluateEntryMetadataRequirements({
      always: false,
      metadata: {
        emoji: "🦀",
        homepage: "https://openclaw.ai",
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
      hasLocalBin: (bin) => bin === "bun",
      localPlatform: "linux",
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

  it("uses process.platform in the current-platform wrapper", () => {
    setPlatform("darwin");

    const result = evaluateEntryMetadataRequirementsForCurrentPlatform({
      always: false,
      metadata: {
        os: ["darwin"],
      },
      hasLocalBin: () => false,
      isEnvSatisfied: () => true,
      isConfigSatisfied: () => true,
    });

    expect(result.requirementsSatisfied).toBe(true);
    expect(result.missing.os).toStrictEqual([]);
  });

  it("pulls metadata and frontmatter from entry objects in the entry wrapper", () => {
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
    const result = evaluateEntryMetadataRequirements({
      always: false,
      hasLocalBin: () => false,
      localPlatform: "linux",
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
});
