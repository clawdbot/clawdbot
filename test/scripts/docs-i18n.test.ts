// Docs i18n tests cover the Go module and behavior fixtures backing docs translation.
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const hasGoToolchain = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasGoToolchain)("docs-i18n Go module", () => {
  let binaryPath = "";
  let tempDir = "";

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-docs-i18n-test-"));
    binaryPath = path.join(
      tempDir,
      process.platform === "win32" ? "docs-i18n.test.exe" : "docs-i18n.test",
    );
    const result = spawnSync("go", ["test", "-modcacherw", "-c", "-o", binaryPath, "."], {
      cwd: "scripts/docs-i18n",
      encoding: "utf8",
      // Go's default read-only module directories prevent recursive teardown.
      // Keep this build's writable module cache inside the suite-owned root.
      env: {
        ...process.env,
        GOMODCACHE: path.join(tempDir, "gomodcache"),
        GOTOOLCHAIN: "local",
      },
    });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(result.stderr || result.stdout || "failed to build Go tests");
    }
  });

  afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it.concurrent.each([
    ["A-F", "^Test[A-F]"],
    ["G-L", "^Test[G-L]"],
    ["M-R", "^Test[M-R]"],
    ["S-Z", "^Test[S-Z]"],
  ])("passes Go tests in the %s partition", async (partition, pattern) => {
    await execFileAsync(binaryPath, ["-test.count=1", `-test.run=${pattern}`], {
      cwd: "scripts/docs-i18n",
      encoding: "utf8",
      // The user cache can be under /tmp when the test invocation owns it.
      env: { ...process.env, XDG_CACHE_HOME: path.join(tempDir, "cache", partition) },
    });
  });
});
