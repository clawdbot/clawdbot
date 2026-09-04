import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import type { ContextRetentionResult } from "./agent-loop.retention.test-support.js";

it("releases replaced histories while the next model request is pending", async ({ signal }) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      "--import",
      "tsx",
      fileURLToPath(new URL("./agent-loop.retention.test-support.ts", import.meta.url)),
    ],
    { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
    15_000,
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      signal,
      maxBuffer: 64 * 1024,
      requireProcessTreeExit: process.platform !== "win32",
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const observed: ContextRetentionResult = JSON.parse(result.stdout);
  expect(observed).toEqual({
    calls: 5,
    replacements: 4,
    observedHistories: 4,
    retained: [],
    completed: true,
  });
}, 30_000);
