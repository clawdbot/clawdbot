import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { isUnitConfigTestFile } from "./vitest/vitest.unit-paths.mjs";

describe("isUnitConfigTestFile", () => {
  it("accepts unit-config package tests", () => {
    expect(isUnitConfigTestFile("packages/plugin-package-contract/src/index.test.ts")).toBe(true);
  });

  it("rejects files excluded from the unit config", () => {
    expect(
      isUnitConfigTestFile(
        bundledPluginFile("imessage", "src/monitor.shutdown.unhandled-rejection.test.ts"),
      ),
    ).toBe(false);
    expect(isUnitConfigTestFile("src/infra/matrix-plugin-helper.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/boundary-path.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/git-root.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/home-dir.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/openclaw-exec-env.test.ts")).toBe(false);
    expect(
      isUnitConfigTestFile(bundledPluginFile("matrix", "src/migration-snapshot.test.ts")),
    ).toBe(false);
    expect(isUnitConfigTestFile("src/infra/openclaw-root.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/package-json.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/path-env.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/plugin-sdk/facade-runtime.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/plugins/loader.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/stable-node-path.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("test/format-error.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("test/extension-test-boundary.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/agents/pi-embedded-runner.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/commands/onboard.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("ui/src/ui/views/channels.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("ui/src/ui/views/chat.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("ui/src/ui/views/other.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/git-commit.live.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/git-commit.e2e.test.ts")).toBe(false);
  });
});
