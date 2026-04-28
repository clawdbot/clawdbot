import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { loadIncludePatternsFromEnv } from "./vitest/vitest.extensions.config.ts";

const patternFiles = createPatternFileHelper("openclaw-vitest-extensions-config-");

afterEach(() => {
  patternFiles.cleanup();
});

describe("extensions vitest include patterns", () => {
  it("returns null when no include file is configured", () => {
    expect(loadIncludePatternsFromEnv({})).toBeNull();
  });

  it("loads include patterns from a JSON file", () => {
    const filePath = patternFiles.writePatternFile("include.json", [
      bundledPluginFile("feishu", "index.test.ts"),
      42,
      "",
      bundledPluginFile("msteams", "src/monitor.test.ts"),
    ]);

    expect(
      loadIncludePatternsFromEnv({
        OPENCLAW_VITEST_INCLUDE_FILE: filePath,
      }),
    ).toEqual([
      bundledPluginFile("feishu", "index.test.ts"),
      bundledPluginFile("msteams", "src/monitor.test.ts"),
    ]);
  });

  it("throws when the configured file is not a JSON array", () => {
    const filePath = patternFiles.writePatternFile("include.json", {
      include: [bundledPluginFile("feishu", "index.test.ts")],
    });

    expect(() =>
      loadIncludePatternsFromEnv({
        OPENCLAW_VITEST_INCLUDE_FILE: filePath,
      }),
    ).toThrow(/JSON array/u);
  });
});
