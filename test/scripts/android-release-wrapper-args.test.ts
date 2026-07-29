// Android release wrapper tests keep release args fail-closed before Fastlane work.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";

function runScript(
  scriptPath: string,
  args: readonly string[],
): { ok: boolean; stdout: string; stderr: string } {
  const scriptArgs =
    process.platform === "win32" ? [scriptPath] : ["--noprofile", "--norc", scriptPath];
  try {
    const stdout = execFileSync(BASH_BIN, [...scriptArgs, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf8") : String(e.stdout ?? "");
    const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : String(e.stderr ?? "");
    return { ok: false, stdout, stderr };
  }
}

describe("Android release shell wrapper arguments", () => {
  it.each(["scripts/android-release-upload.sh", "scripts/android-release.sh"])(
    "prints help without release work for %s",
    (scriptPath) => {
      const result = runScript(path.join(process.cwd(), scriptPath), ["--help"]);

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("Uploads Android Play metadata");
      expect(result.stderr).toBe("");
    },
  );

  it.each(["scripts/android-release-upload.sh", "scripts/android-release.sh"])(
    "rejects unknown args before release work for %s",
    (scriptPath) => {
      const result = runScript(path.join(process.cwd(), scriptPath), ["--bogus"]);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Unknown argument: --bogus");
      expect(result.stderr).not.toContain("fastlane");
      expect(result.stdout).toContain("Uploads Android Play metadata");
    },
  );
});
