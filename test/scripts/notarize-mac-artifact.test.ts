// Notarize Mac Artifact tests cover notarize mac artifact script behavior.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/notarize-mac-artifact.sh";

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("notarize-mac-artifact input validation", () => {
  it("fails before notarization when an explicit staple app path is missing", () => {
    const tempRoot = makeTempDir("openclaw-notary-staple-");
    const artifact = path.join(tempRoot, "OpenClaw.zip");
    const missingApp = path.join(tempRoot, "Missing.app");
    writeFileSync(artifact, "placeholder", "utf8");

    const result = spawnSync("bash", [scriptPath, artifact], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        STAPLE_APP_PATH: missingApp,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error: STAPLE_APP_PATH not found");
    expect(result.stderr).not.toContain("xcrun not found");
    expect(result.stderr).not.toContain("Notary auth missing");
    expect(result.stdout).not.toContain("Notarizing:");
  });
});
