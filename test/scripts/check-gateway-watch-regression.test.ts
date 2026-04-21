import { describe, expect, it } from "vitest";
import { isIgnoredDistRuntimeWatchPath } from "../../scripts/check-gateway-watch-regression.mjs";

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
});
