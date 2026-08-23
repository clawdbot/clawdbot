// Plugin extension import boundary tests enforce plugin extension import rules.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../scripts/check-plugin-extension-import-boundary.mts";
import { createCapturedIo } from "./helpers/captured-io.js";

const repoRoot = process.cwd();
const baselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "plugin-extension-import-boundary-inventory.json",
);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

describe("plugin extension import boundary inventory", () => {
  it("script json output matches the baseline exactly", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual(baseline);
  });
});
