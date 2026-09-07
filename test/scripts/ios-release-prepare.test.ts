// iOS release prepare tests cover release-signing guardrails.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-release-prepare.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BASH_ARGS = process.platform === "win32" ? [SCRIPT] : ["--noprofile", "--norc", SCRIPT];

function runPrepare(extraArgs: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(BASH_BIN, [...BASH_ARGS, ...extraArgs], {
      env: {
        ...process.env,
        IOS_DEVELOPMENT_TEAM: "Y3YUZP442G",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    const stdout =
      typeof e.stdout === "string"
        ? e.stdout
        : Buffer.isBuffer(e.stdout)
          ? e.stdout.toString("utf8")
          : "";
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString("utf8")
          : "";
    return { ok: false, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

describe("scripts/ios-release-prepare.sh", () => {
  it("rejects non-canonical signing teams before generating release inputs", () => {
    const result = runPrepare(["--version", "2026.7.2", "--revision", "1", "--build-number", "3"]);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(
      "iOS App Store release must use canonical OpenClaw Team ID FWJYW4S8P8",
    );
    expect(result.stderr).toContain("got Y3YUZP442G");
  });
});
