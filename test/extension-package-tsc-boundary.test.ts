import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CHECK_EXTENSION_PACKAGE_BOUNDARY_BIN = resolve(
  REPO_ROOT,
  "scripts/check-extension-package-tsc-boundary.mjs",
);
const SHOULD_RUN_BOUNDARY_SCRIPT_WRAPPER =
  process.env.OPENCLAW_RUN_EXTENSION_PACKAGE_BOUNDARY_TEST === "1";

function runNode(args: string[], timeout: number) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
}

// The CI check-additional job and package scripts run this script directly. Keep this
// wrapper opt-in so full Vitest runs do not duplicate the cold extension compile.
describe.skipIf(!SHOULD_RUN_BOUNDARY_SCRIPT_WRAPPER)(
  "opt-in extension package TypeScript boundaries",
  () => {
    it("typechecks each opt-in extension cleanly through @openclaw/plugin-sdk", () => {
      const result = runNode([CHECK_EXTENSION_PACKAGE_BOUNDARY_BIN, "--mode=compile"], 420_000);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 300_000);

    it("fails when opt-in extensions import src/cli through a relative path", () => {
      const result = runNode([CHECK_EXTENSION_PACKAGE_BOUNDARY_BIN, "--mode=canary"], 180_000);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    });
  },
);
