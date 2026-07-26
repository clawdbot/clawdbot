import process from "node:process";
import { describe, expect, it } from "vitest";
import { runUtf8CommandWithTimeout } from "./exec.js";

describe("runUtf8CommandWithTimeout Windows integration", () => {
  it.runIf(process.platform === "win32")(
    "keeps truncated UTF-8 head output on a code point boundary",
    async () => {
      const result = await runUtf8CommandWithTimeout(
        [process.execPath, "-e", "process.stdout.write('a😀z'); process.stderr.write('b😀y')"],
        {
          maxOutputBytes: 3,
          outputCapture: "head",
          timeoutMs: 3_000,
        },
      );

      expect(result.stdout).toBe("a");
      expect(result.stderr).toBe("b");
      expect(result.stdoutTruncatedBytes).toBe(5);
      expect(result.stderrTruncatedBytes).toBe(5);
    },
  );
});
