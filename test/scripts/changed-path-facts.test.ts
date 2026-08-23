import { describe, expect, it } from "vitest";
import {
  getChangedPathFacts,
  normalizeChangedPath,
} from "../../scripts/lib/changed-path-facts.mjs";

describe("changed path facts", () => {
  it("preserves the existing surface classifications", () => {
    const cases = [
      ["docs/ci.md", "docs"],
      ["README.md", "docs"],
      ["src/config/defaults.ts", "source"],
      ["packages/gateway-client/src/client.ts", "package"],
      ["extensions/slack/src/index.ts", "extension"],
      ["ui/src/app.ts", "ui"],
      ["apps/macos/Sources/OpenClaw/AppDelegate.swift", "app"],
      ["test/scripts/changed-lanes.test.ts", "rootTest"],
      ["test-fixtures/sample.ts", "testFixture"],
      ["scripts/check-changed.mjs", "rootTooling"],
      [".github/workflows/ci.yml", "rootTooling"],
      ["package.json", "rootGlobal"],
      ["assets/legacy.png", "legacyRootAsset"],
      [".crabbox.yaml", "unknown"],
    ] as const;

    for (const [changedPath, surface] of cases) {
      expect(getChangedPathFacts(changedPath).surface, changedPath).toBe(surface);
    }
  });

  it("preserves test and native-only predicates independently from surfaces", () => {
    expect(getChangedPathFacts("extensions/slack/src/index.test-support.ts")).toMatchObject({
      surface: "extension",
      isChangedLaneTest: true,
      isTestOnly: true,
      isNativeOnly: false,
    });
    expect(getChangedPathFacts("test/helpers/fixture.ts")).toMatchObject({
      surface: "rootTest",
      isChangedLaneTest: true,
      isTestOnly: true,
      isNativeOnly: false,
    });
    expect(getChangedPathFacts("apps/shared/OpenClawKit/Sources/Foo.swift")).toMatchObject({
      surface: "app",
      isChangedLaneTest: false,
      isTestOnly: false,
      isNativeOnly: true,
    });
    expect(getChangedPathFacts("apps/web/index.ts")).toMatchObject({
      surface: "app",
      isNativeOnly: false,
    });
  });

  it("keeps normalization separate from classification", () => {
    expect(normalizeChangedPath("  .\\extensions\\slack\\src\\index.test.ts  ")).toBe(
      "extensions/slack/src/index.test.ts",
    );
    expect(getChangedPathFacts("./src/config/defaults.ts").surface).toBe("unknown");
  });
});
