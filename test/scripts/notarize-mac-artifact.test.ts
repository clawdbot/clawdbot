// Notarize Mac Artifact tests cover notarize mac artifact script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/notarize-mac-artifact.sh";

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
    const tempRoot = tempDirs.make("openclaw-notary-extra-");
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
    const tempRoot = tempDirs.make("openclaw-notary-staple-");
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

  it("records the accepted notarization id before stapling", () => {
    const tempRoot = tempDirs.make("openclaw-notary-result-");
    const artifact = path.join(tempRoot, "OpenClaw.zip");
    const app = path.join(tempRoot, "OpenClaw.app");
    const binDir = path.join(tempRoot, "bin");
    const resultPath = path.join(tempRoot, "notary-result.json");
    const accepted = {
      id: "11111111-2222-3333-4444-555555555555",
      status: "Accepted",
      message: "Processing complete",
    };
    writeFileSync(artifact, "placeholder", "utf8");
    mkdirSync(app);
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "xcrun"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "${1:-}" == "notarytool" ]]; then',
        `  printf '%s\\n' '${JSON.stringify(accepted)}'`,
        "  exit 0",
        "fi",
        '[[ "${1:-}" == "stapler" ]]',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(binDir, "xcrun"), 0o755);

    const result = spawnSync("bash", [scriptPath, artifact], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NOTARYTOOL_PROFILE: "test-profile",
        NOTARY_RESULT_FILE: resultPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        STAPLE_APP_PATH: app,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual(accepted);
    expect(statSync(resultPath).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain(accepted.id);
    expect(result.stdout).toContain("Notarization complete");
  });
});
