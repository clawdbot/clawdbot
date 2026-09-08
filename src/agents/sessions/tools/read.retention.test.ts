import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../../../test/helpers/run-node-script.js";

it.for(["line", "range", "cursor"])(
  "owns both output channels for a partial-file %s page",
  { timeout: 30_000 },
  async (mode, { signal }) => {
    const result = await runNodeScript(
      [
        "--expose-gc",
        "--import",
        "./scripts/tsx.mjs",
        fileURLToPath(new URL("./read.retention.test-support.ts", import.meta.url)),
        mode,
      ],
      { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
      20_000,
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        signal,
        maxBuffer: 64 * 1024,
        requireProcessTreeExit: process.platform !== "win32",
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.resultCount).toBe(8);
    // Small retained pages must not retain eight multi-megabyte decoded sources.
    expect(observed.heapUsedIncrease).toBeLessThan(1024 * 1024);
    expect(observed.externalIncrease).toBeLessThan(1024 * 1024);
  },
);
