// Covers the include-permission scanner's use of the shared nesting guard.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { collectIncludePathsRecursive } from "./includes-scan.js";
import { MAX_CONFIG_JSON_NESTING_DEPTH } from "./nesting-limit.js";

// Spy on the JSON5 compatibility parser so scanner regressions can prove that
// over-limit include text never reaches the native parser.
vi.mock("../utils/parse-json-compat.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../utils/parse-json-compat.js")>();
  return {
    ...mod,
    parseJsonWithJson5Fallback: vi.fn(mod.parseJsonWithJson5Fallback),
  };
});

describe("include permission scanner nesting guard", () => {
  it("returns a controlled outcome for deeply-nested included files without invoking the parser", async () => {
    await withTestDir({ prefix: "openclaw-include-scan-nesting-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const deepIncludePath = path.join(configDir, "deep.json5");
      await fs.mkdir(configDir, { recursive: true });
      const deepRaw =
        "[".repeat(MAX_CONFIG_JSON_NESTING_DEPTH + 1) +
        "]".repeat(MAX_CONFIG_JSON_NESTING_DEPTH + 1);
      await fs.writeFile(deepIncludePath, `${deepRaw}\n`, "utf-8");

      const parserSpy = vi.mocked(parseJsonWithJson5Fallback);
      parserSpy.mockClear();

      const includePaths = await collectIncludePathsRecursive({
        configPath: path.join(configDir, "openclaw.json"),
        parsed: { $include: "./deep.json5" },
      });

      // Controlled outcome: the guarded file is still reported for permission
      // auditing, but the over-limit text never reaches the native parser.
      expect(parserSpy).not.toHaveBeenCalled();
      expect(includePaths).toEqual([await fs.realpath(deepIncludePath)]);
    });
  });
});
