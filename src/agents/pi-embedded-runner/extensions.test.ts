import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { buildEmbeddedExtensionPaths } from "./extensions.js";

function makeMinimalParams(cfg?: ClawdbotConfig) {
  return {
    cfg,
    sessionManager: {} as never,
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    model: undefined,
  };
}

describe("buildEmbeddedExtensionPaths", () => {
  it("includes compaction-safeguard by default (no config)", () => {
    const paths = buildEmbeddedExtensionPaths(makeMinimalParams());
    expect(paths.some((p) => p.includes("compaction-safeguard"))).toBe(true);
  });

  it("includes compaction-safeguard when mode is undefined", () => {
    const cfg: ClawdbotConfig = { agents: { defaults: { compaction: {} } } };
    const paths = buildEmbeddedExtensionPaths(makeMinimalParams(cfg));
    expect(paths.some((p) => p.includes("compaction-safeguard"))).toBe(true);
  });

  it("includes compaction-safeguard when mode is explicitly 'safeguard'", () => {
    const cfg: ClawdbotConfig = {
      agents: { defaults: { compaction: { mode: "safeguard" } } },
    };
    const paths = buildEmbeddedExtensionPaths(makeMinimalParams(cfg));
    expect(paths.some((p) => p.includes("compaction-safeguard"))).toBe(true);
  });

  it("excludes compaction-safeguard when mode is 'basic'", () => {
    const cfg: ClawdbotConfig = {
      agents: { defaults: { compaction: { mode: "basic" } } },
    };
    const paths = buildEmbeddedExtensionPaths(makeMinimalParams(cfg));
    expect(paths.some((p) => p.includes("compaction-safeguard"))).toBe(false);
  });

  it("always includes transcript-sanitize extension", () => {
    const paths = buildEmbeddedExtensionPaths(makeMinimalParams());
    expect(paths.some((p) => p.includes("transcript-sanitize"))).toBe(true);
  });
});
