import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./test-support/bus-server-shutdown.ts", import.meta.url),
);

// Vitest's own handles would keep an unreferenced shutdown timer alive.
it.each(["bus", "provider"])("finishes %s shutdown after rejecting an upload", async (kind) => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", fixturePath, kind],
    { cwd: repoRoot, encoding: "utf8", timeout: 20_000 },
  );
  expect(stdout.trim()).toBe("shutdown-complete");
  expect(stderr).toBe("");
});
