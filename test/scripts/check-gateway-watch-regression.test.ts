import { describe, expect, it } from "vitest";
import {
  isIgnoredDistRuntimeWatchPath,
  shouldRefreshBuildStampForRestoredArtifacts,
} from "../../scripts/check-gateway-watch-regression.mjs";

describe("check-gateway-watch-regression", () => {
  it("ignores top-level dist-runtime extension dependency repairs", () => {
    expect(isIgnoredDistRuntimeWatchPath("dist-runtime/extensions/node_modules")).toBe(true);
    expect(
      isIgnoredDistRuntimeWatchPath(
        "dist-runtime/extensions/node_modules/playwright-core/index.js",
      ),
    ).toBe(true);
  });

  it("keeps plugin runtime graph paths counted", () => {
    expect(isIgnoredDistRuntimeWatchPath("dist-runtime/extensions/openai/index.js")).toBe(false);
    expect(
      isIgnoredDistRuntimeWatchPath(
        "dist-runtime/extensions/openai/node_modules/openclaw/index.js",
      ),
    ).toBe(false);
  });

  it("refreshes restored build stamps only for skip-build config mtime drift", () => {
    expect(
      shouldRefreshBuildStampForRestoredArtifacts({
        skipBuild: true,
        buildRequirement: { shouldBuild: true, reason: "config_newer" },
      }),
    ).toBe(true);
    expect(
      shouldRefreshBuildStampForRestoredArtifacts({
        skipBuild: false,
        buildRequirement: { shouldBuild: true, reason: "config_newer" },
      }),
    ).toBe(false);
    expect(
      shouldRefreshBuildStampForRestoredArtifacts({
        skipBuild: true,
        buildRequirement: { shouldBuild: true, reason: "source_mtime_newer" },
      }),
    ).toBe(false);
  });
});
