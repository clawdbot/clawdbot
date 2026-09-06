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
    bundleState?: "usable" | "unusable" | "missing";
    bundleGemfile?: string;
    bundleExit?: number;
    changeDirectoryAfterSource?: boolean;
    directState?: "usable" | "unusable" | "missing";
    directExit?: number;
    releaseRefMode?: string;
    rbenvState?: "usable" | "missing";
    rbenvExit?: number;
    expectedProvenance?: "locked" | "fallback";
    inheritedProvenance?: string;
  }) {
    const binDir = tempDirs.make("openclaw-android-fastlane-test-");
    const tracePath = path.join(binDir, "trace.log");
    const bundle = path.join(binDir, "bundle");
    const fastlane = path.join(binDir, "fastlane");
    const rbenv = path.join(binDir, "rbenv");
    const bundleState = options.bundleState ?? "usable";
    const directState = options.directState ?? "usable";
    const rbenvState = options.rbenvState ?? "missing";
    if (bundleState !== "missing") {
      writeFileSync(
        bundle,
        "#!/usr/bin/env bash\n" +
          '[[ "$BUNDLE_GEMFILE" == "$OPENCLAW_FASTLANE_EXPECTED_GEMFILE" ]] || exit 91\n' +
          '[[ "${1:-}" == "_2.6.9_" ]] || exit 92\n' +
          '[[ "${2:-}" != "check" ]] || exit "$OPENCLAW_BUNDLE_CHECK_EXIT"\n' +
          '[[ "${2:-}" == "exec" && "${3:-}" == "fastlane" ]] || exit 93\n' +
          '[[ -z "$OPENCLAW_EXPECTED_PROVENANCE" || "${_OPENCLAW_ANDROID_FASTLANE_EXECUTION_PROVENANCE:-}" == "$OPENCLAW_EXPECTED_PROVENANCE" ]] || exit 95\n' +
          'printf "bundle:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n' +
          'exit "$OPENCLAW_BUNDLE_EXIT"\n',
      );
      chmodSync(bundle, 0o755);
    }
    if (directState !== "missing") {
      writeFileSync(
        fastlane,
        "#!/usr/bin/env bash\n" +
          'if [[ "${1:-}" == "--version" ]]; then\n' +
          '  [[ "$OPENCLAW_DIRECT_STATE" == "usable" ]]\n' +
          "  exit\n" +
          "fi\n" +
          '[[ -z "$OPENCLAW_EXPECTED_PROVENANCE" || "${_OPENCLAW_ANDROID_FASTLANE_EXECUTION_PROVENANCE:-}" == "$OPENCLAW_EXPECTED_PROVENANCE" ]] || exit 95\n' +
          'printf "direct:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n' +
          'exit "$OPENCLAW_DIRECT_EXIT"\n',
      );
      chmodSync(fastlane, 0o755);
    }
    if (rbenvState !== "missing") {
      writeFileSync(
        rbenv,
        "#!/usr/bin/env bash\n" +
          'if [[ "${1:-}" == "versions" && "${2:-}" == "--bare" ]]; then\n' +
          '  printf "3.4.10\\n"\n' +
          "  exit 0\n" +
          "fi\n" +
          'if [[ "${1:-}" == "which" && "${2:-}" == "fastlane" ]]; then\n' +
          "  exit 0\n" +
          "fi\n" +
          '[[ "${1:-}" == "exec" && "${2:-}" == "fastlane" ]] || exit 94\n' +
          '[[ -z "$OPENCLAW_EXPECTED_PROVENANCE" || "${_OPENCLAW_ANDROID_FASTLANE_EXECUTION_PROVENANCE:-}" == "$OPENCLAW_EXPECTED_PROVENANCE" ]] || exit 95\n' +
          'printf "rbenv:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n' +
          'exit "$OPENCLAW_RBENV_EXIT"\n',
      );
      chmodSync(rbenv, 0o755);
    }
    const hiddenCommands = [
      bundleState === "missing" ? "bundle" : "",
      directState === "missing" ? "fastlane" : "",
      rbenvState === "missing" ? "rbenv" : "",
    ].filter(Boolean);
    const commandShim =
      hiddenCommands.length > 0
        ? `command() { if [[ "$1" == "-v" ]]; then case "\${2:-}" in ${hiddenCommands.join("|")}) return 1 ;; esac; fi; builtin command "$@"; }; `
        : "";
    const result = spawnSync(
      BASH_BIN,
      [
        "-c",
        options.changeDirectoryAfterSource
          ? `${commandShim}source scripts/lib/android-fastlane.sh; cd apps/android; run_android_fastlane android release_preflight`
          : `${commandShim}source scripts/lib/android-fastlane.sh; run_android_fastlane android release_preflight`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BUNDLE_GEMFILE: options.bundleGemfile ?? "",
          OPENCLAW_BUNDLE_CHECK_EXIT: bundleState === "usable" ? "0" : "1",
          OPENCLAW_BUNDLE_EXIT: String(options.bundleExit ?? 0),
          OPENCLAW_DIRECT_EXIT: String(options.directExit ?? 0),
          OPENCLAW_DIRECT_STATE: directState,
          OPENCLAW_EXPECTED_PROVENANCE: options.expectedProvenance ?? "",
          OPENCLAW_FASTLANE_EXPECTED_GEMFILE: gemfilePath,
          OPENCLAW_FASTLANE_TEST_TRACE: tracePath,
          OPENCLAW_MOBILE_RELEASE_REF_MODE: options.releaseRefMode ?? "",
          OPENCLAW_RBENV_EXIT: String(options.rbenvExit ?? 0),
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          _OPENCLAW_ANDROID_FASTLANE_EXECUTION_PROVENANCE: options.inheritedProvenance ?? "",
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
    const { result, trace } = runSharedFastlane({ bundleExit: 37 });

    expect(result.status).toBe(37);
    expect(trace).toContain("bundle:_2.6.9_ exec fastlane android release_preflight");
    expect(trace).not.toContain("direct:");
  });

  it("overrides an inherited Gemfile and survives caller directory changes", () => {
    const { result, trace } = runSharedFastlane({
      bundleGemfile: "/tmp/hostile/Gemfile",
      changeDirectoryAfterSource: true,
      expectedProvenance: "locked",
      inheritedProvenance: "fallback",
    });

    expect(result.status).toBe(0);
    expect(trace).toContain("bundle:_2.6.9_ exec fastlane android release_preflight");
    expect(trace).not.toContain("direct:");
  });

  it("uses a globally installed Fastlane when the local bundle is unusable", () => {
    const { result, trace } = runSharedFastlane({
      bundleState: "unusable",
      directState: "usable",
      expectedProvenance: "fallback",
      inheritedProvenance: "locked",
      rbenvState: "usable",
    });

    expect(result.status).toBe(0);
    expect(trace).toBe("direct:android release_preflight\n");
  });

  it("propagates failures from a globally installed Fastlane", () => {
    const { result, trace } = runSharedFastlane({
      bundleState: "unusable",
      directState: "usable",
      directExit: 41,
      rbenvState: "usable",
    });

    expect(result.status).toBe(41);
    expect(trace).toBe("direct:android release_preflight\n");
  });

  it("fails closed in intent mode when the locked bundle is unusable", () => {
    const { result, trace } = runSharedFastlane({
      bundleState: "unusable",
      directState: "usable",
      releaseRefMode: "intent",
      rbenvState: "usable",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Android Fastlane bundle is not installed");
    expect(trace).toBe("");
  });

  it("fails closed for padded intent mode when the locked bundle is missing", () => {
    const { result, trace } = runSharedFastlane({
      bundleState: "missing",
      directState: "usable",
      releaseRefMode: " \tintent \n",
      rbenvState: "usable",
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("bundle not found for the Android Fastlane bundle");
    expect(trace).toBe("");
  });

  it("prefers the locked bundle over direct and rbenv Fastlane", () => {
    const { result, trace } = runSharedFastlane({
      directState: "usable",
      rbenvState: "usable",
    });

    expect(result.status).toBe(0);
    expect(trace).toBe("bundle:_2.6.9_ exec fastlane android release_preflight\n");
  });

  it("falls back to rbenv when the bundle and direct Fastlane are unavailable", () => {
    const { result, trace } = runSharedFastlane({
      bundleState: "missing",
      directState: "missing",
      expectedProvenance: "fallback",
      inheritedProvenance: "locked",
      rbenvState: "usable",
    });

    expect(result.status).toBe(0);
    expect(trace).toBe("rbenv:exec fastlane android release_preflight\n");
  });

  it("propagates failures from the rbenv Fastlane fallback", () => {
    const { result, trace } = runSharedFastlane({
      bundleState: "missing",
      directState: "missing",
      rbenvState: "usable",
      rbenvExit: 43,
    });

    expect(result.status).toBe(43);
    expect(trace).toBe("rbenv:exec fastlane android release_preflight\n");
  });

  it("preserves an unusable bundle diagnostic and status after exhausted fallbacks", () => {
    const { result, trace } = runSharedFastlane({
      bundleState: "unusable",
      directState: "missing",
      rbenvState: "missing",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Android Fastlane bundle is not installed");
    expect(result.stderr).toContain("gem install bundler -v 2.6.9");
    expect(trace).toBe("");
  });

  it("preserves a missing bundle diagnostic and status after exhausted fallbacks", () => {
    const { result, trace } = runSharedFastlane({
      bundleState: "missing",
      directState: "missing",
      rbenvState: "missing",
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("bundle not found for the Android Fastlane bundle");
    expect(result.stderr).toContain("gem install bundler -v 2.6.9");
    expect(trace).toBe("");
  });
});
