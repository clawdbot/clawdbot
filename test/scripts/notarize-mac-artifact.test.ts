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
  it("prints help without checking artifact or notary tools", () => {
    const result = spawnSync("bash", [scriptPath, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: scripts/notarize-mac-artifact.sh <artifact>");
    expect(result.stdout).toContain("NOTARYTOOL_PROFILE");
    expect(result.stderr).toBe("");
  });

  it("rejects unknown options before artifact validation", () => {
    const result = spawnSync("bash", [scriptPath, "--wat"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Error: unknown notarization option: --wat");
  });

  it("rejects extra artifact arguments before notarization", () => {
    const tempRoot = makeTempDir("openclaw-notary-extra-");
    const artifact = path.join(tempRoot, "OpenClaw.zip");
    writeFileSync(artifact, "placeholder", "utf8");

    const result = spawnSync("bash", [scriptPath, artifact, "extra"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Error: unexpected notarization argument: extra");
  });

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
