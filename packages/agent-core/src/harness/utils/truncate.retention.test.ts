import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../../../../test/helpers/run-node-script.js";

it.for(
  ["head", "tail", "partial-tail", "line"].flatMap((mode) =>
    [64, 4096].map((limit) => ({ mode, limit })),
  ),
)(
  "owns $mode output with a $limit limit",
  { timeout: 30_000 },
  async ({ mode, limit }, { signal }) => {
    const result = await runNodeScript(
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./truncate.retention.test-support.ts", import.meta.url)),
        mode,
        String(limit),
      ],
      { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
      15_000,
      {
        cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
        signal,
        maxBuffer: 64 * 1024,
        requireProcessTreeExit: process.platform !== "win32",
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.results).toHaveLength(8);
    // Eight small outputs may allocate, but must not retain eight 2MiB sources.
    expect(observed.heapUsedIncrease).toBeLessThan(1024 * 1024);
    expect(observed.externalIncrease).toBeLessThan(1024 * 1024);
  },
);
