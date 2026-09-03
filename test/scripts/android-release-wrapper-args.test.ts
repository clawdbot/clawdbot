// Android release wrapper tests keep release args fail-closed before Fastlane work.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const gemfilePath = path.join(process.cwd(), "apps", "android", "Gemfile");

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
    const stdout = Buffer.isBuffer(e.stdout)
      ? e.stdout.toString("utf8")
      : ((e.stdout ?? "") as string);
    const stderr = Buffer.isBuffer(e.stderr)
      ? e.stderr.toString("utf8")
      : ((e.stderr ?? "") as string);
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

  function runSharedFastlane(options: {
    bundleGemfile?: string;
    changeDirectoryAfterSource?: boolean;
    fastlaneExit: number;
  }) {
    const binDir = tempDirs.make("openclaw-android-fastlane-test-");
    const tracePath = path.join(binDir, "trace.log");
    const bundle = path.join(binDir, "bundle");
    const fastlane = path.join(binDir, "fastlane");
    writeFileSync(
      bundle,
      "#!/usr/bin/env bash\n" +
        '[[ "$BUNDLE_GEMFILE" == "$OPENCLAW_FASTLANE_EXPECTED_GEMFILE" ]] || exit 91\n' +
        '[[ "${1:-}" == "_2.6.9_" ]] || exit 92\n' +
        '[[ "${2:-}" != "check" ]] || exit 0\n' +
        '[[ "${2:-}" == "exec" && "${3:-}" == "fastlane" ]] || exit 93\n' +
        'printf "bundle:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n' +
        'exit "$OPENCLAW_FASTLANE_EXIT"\n',
    );
    writeFileSync(
      fastlane,
      '#!/usr/bin/env bash\nprintf "direct:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\nexit 97\n',
    );
    chmodSync(bundle, 0o755);
    chmodSync(fastlane, 0o755);
    const result = spawnSync(
      BASH_BIN,
      [
        "-c",
        options.changeDirectoryAfterSource
          ? "source scripts/lib/android-fastlane.sh; cd apps/android; run_android_fastlane android release_preflight"
          : "source scripts/lib/android-fastlane.sh; run_android_fastlane android release_preflight",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BUNDLE_GEMFILE: options.bundleGemfile ?? "",
          OPENCLAW_FASTLANE_EXIT: String(options.fastlaneExit),
          OPENCLAW_FASTLANE_EXPECTED_GEMFILE: gemfilePath,
          OPENCLAW_FASTLANE_TEST_TRACE: tracePath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );
    return {
      result,
      trace: existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "",
    };
  }

  it("preserves Fastlane failures through the locked Android bundle", () => {
    const { result, trace } = runSharedFastlane({ fastlaneExit: 37 });

    expect(result.status).toBe(37);
    expect(trace).toContain("bundle:_2.6.9_ exec fastlane android release_preflight");
    expect(trace).not.toContain("direct:");
  });

  it("overrides an inherited Gemfile and survives caller directory changes", () => {
    const { result, trace } = runSharedFastlane({
      bundleGemfile: "/tmp/hostile/Gemfile",
      changeDirectoryAfterSource: true,
      fastlaneExit: 0,
    });

    expect(result.status).toBe(0);
    expect(trace).toContain("bundle:_2.6.9_ exec fastlane android release_preflight");
    expect(trace).not.toContain("direct:");
  });

  it("has no direct Fastlane or rbenv fallback", () => {
    const source = readFileSync(
      path.join(process.cwd(), "scripts", "lib", "android-fastlane.sh"),
      "utf8",
    );

    expect(source).toContain('BUNDLE_GEMFILE="$gemfile" bundle _2.6.9_ exec fastlane "$@"');
    expect(source).not.toContain("command -v fastlane");
    expect(source).not.toContain("rbenv");
  });
});
