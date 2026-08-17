// Codesign Mac App tests cover codesign mac app script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/codesign-mac-app.sh";

function entitlementTemps(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("openclaw-entitlements"));
}

function runCodesign(args: string[], tempRoot: string) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: tempRoot,
    },
  });
}

function installFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

entitlements=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --entitlements)
      shift
      entitlements="$1"
      ;;
  esac
  target="$1"
  shift || true
done

if [ -z "$target" ]; then
  echo "missing codesign target" >&2
  exit 2
fi

if [ -n "$entitlements" ]; then
  count_file="$CODESIGN_CAPTURE_DIR/count"
  count=0
  if [ -f "$count_file" ]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" >"$count_file"
  copy="$CODESIGN_CAPTURE_DIR/entitlements-$count.plist"
  cp "$entitlements" "$copy"
  printf 'entitled\\t%s\\t%s\\t%s\\n' "$target" "$entitlements" "$copy" >>"$CODESIGN_LOG"
else
  printf 'plain\\t%s\\n' "$target" >>"$CODESIGN_LOG"
fi
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

function installTransientFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

count=0
if [ -f "$CODESIGN_COUNT_FILE" ]; then
  count="$(cat "$CODESIGN_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s' "$count" >"$CODESIGN_COUNT_FILE"
if [ "\${CODESIGN_PERMANENT_FAILURE:-0}" = "1" ]; then
  echo "signing identity is not available" >&2
  exit 7
fi
if [ "$count" -le "$CODESIGN_TRANSIENT_FAILURES" ]; then
  echo "A timestamp was expected but was not found" >&2
  exit 1
fi
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

function installElevationFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

for arg in "$@"; do
  if [ "$arg" = "-dv" ]; then
    printf '%s\n' 'TeamIdentifier=FWJYW4S8P8' >&2
    if [ "\${CODESIGN_FAKE_NO_AUTHORITY:-0}" != "1" ]; then
      printf '%s\n' 'Authority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)' >&2
    fi
    if [ "\${CODESIGN_FAKE_SECOND_AUTHORITY:-0}" = "1" ]; then
      printf '%s\n' 'Authority=Unexpected Secondary Authority' >&2
    fi
    for i in $(seq 1 20000); do
      printf 'Metadata-%s=value\n' "$i" >&2
    done
    if [ "\${CODESIGN_FAKE_FAIL_AFTER_METADATA:-0}" = "1" ]; then
      exit 7
    fi
    exit 0
  fi
done
exit 0
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

describe("codesign-mac-app temp file hygiene", () => {
  it("does not generate unused entitlement plist files", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('ENT_TMP_APP="$ENT_TMP_DIR/app.plist"');
    expect(script).not.toContain("ENT_TMP_BASE");
    expect(script).not.toContain("ENT_TMP_RUNTIME");
    expect(script).not.toContain("base.plist");
    expect(script).not.toContain("runtime.plist");
  });

  it("does not allocate entitlement temp files for help output", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-help-");
    const result = runCodesign(["--help"], tempRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: scripts/codesign-mac-app.sh");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("does not allocate entitlement temp files before app validation", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-missing-");
    const missingApp = path.join(tempRoot, "Missing.app");
    const result = runCodesign([missingApp], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("App bundle not found");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects unknown options before app validation", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-unknown-");
    const result = runCodesign(["--wat"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unknown codesign option: --wat");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects extra app bundle arguments before signing", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-extra-");
    const app = path.join(tempRoot, "Fake.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    const result = runCodesign([app, "extra"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unexpected codesign argument: extra");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("cleans entitlement temp files when signing fails", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-fail-");
    const app = path.join(tempRoot, "Fake.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOW_ADHOC_SIGNING: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).not.toBe(0);
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("keeps helper signing plain and limits app entitlements to app code", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-success-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const captureDir = path.join(tempRoot, "capture");
    const logPath = path.join(captureDir, "codesign.log");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    mkdirSync(captureDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "openclaw-mlx-tts"), "#!/bin/sh\n");
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_CAPTURE_DIR: captureDir,
        CODESIGN_LOG: logPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "-",
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Codesign complete for ${app}`);

    const signLines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(signLines).toHaveLength(3);
    expect(signLines[0]).toBe(`plain\t${path.join(app, "Contents", "MacOS", "openclaw-mlx-tts")}`);
    expect(signLines[1]).toContain(
      `entitled\t${path.join(app, "Contents", "MacOS", "OpenClaw")}\t`,
    );
    expect(signLines[2]).toContain(`entitled\t${app}\t`);
    for (const line of signLines.slice(1)) {
      const columns = line.split("\t");
      const entitlementPath = columns[2];
      const copiedEntitlementsPath = columns[3];
      const entitlementSource = expectDefined(entitlementPath, "codesign entitlement source path");
      const copiedEntitlementSource = expectDefined(
        copiedEntitlementsPath,
        "copied codesign entitlement path",
      );
      const copiedEntitlements = readFileSync(copiedEntitlementSource, "utf8");
      expect(entitlementSource).toContain("openclaw-entitlements");
      expect(existsSync(entitlementSource)).toBe(false);
      expect(copiedEntitlements).toContain("com.apple.security.automation.apple-events");
      expect(copiedEntitlements).toContain("com.apple.security.device.camera");
    }
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it.each([
    ["DISABLE_LIBRARY_VALIDATION", "forbids DISABLE_LIBRARY_VALIDATION=1"],
    ["SKIP_TEAM_ID_CHECK", "forbids SKIP_TEAM_ID_CHECK=1"],
  ])("rejects elevation-host %s bypasses before app validation", (key, diagnostic) => {
    const tempRoot = tempDirs.make("openclaw-codesign-elevation-bypass-");
    const result = spawnSync("bash", [scriptPath, path.join(tempRoot, "Missing.app")], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
        [key]: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("defines a closed Foundation elevation-host signing profile", () => {
    const script = readFileSync(scriptPath, "utf8");
    const elevationProfile = script.slice(
      script.indexOf('if [[ "$SIGNING_VARIANT" == "elevation-host" ]]'),
      script.indexOf("else", script.indexOf('if [[ "$SIGNING_VARIANT" == "elevation-host" ]]')),
    );

    expect(script).toContain(
      'ELEVATION_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)"',
    );
    expect(script).toContain('ELEVATION_TEAM_ID="FWJYW4S8P8"');
    expect(elevationProfile).toContain("<dict/>");
    expect(elevationProfile).not.toContain("com.apple.security.automation.apple-events");
    expect(script).toContain("verify_elevation_signature");
    expect(script).toContain('assert_no_apple_events_entitlement "$APP_BUNDLE"');
  });

  it("consumes complete codesign metadata under pipefail before validating authority", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-elevation-metadata-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installElevationFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_FAKE_SECOND_AUTHORITY: "1",
        OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain(`Codesign complete for ${app}`);
    expect(result.stderr).not.toContain("Elevation host requires");
  });

  it("preserves the precise diagnostic when codesign omits Authority", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-elevation-no-authority-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installElevationFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_FAKE_NO_AUTHORITY: "1",
        OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("got 'not set'");
  });

  it("preserves a codesign failure after metadata output", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-elevation-failed-metadata-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installElevationFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_FAKE_FAIL_AFTER_METADATA: "1",
        OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).not.toContain(`Codesign complete for ${app}`);
    expect(result.stderr).toContain("got 'not set'");
  });

  it("retries only transient Apple timestamp failures", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-retry-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const countFile = path.join(tempRoot, "codesign-count");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "openclaw-mlx-tts"), "#!/bin/sh\n");
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installTransientFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_COUNT_FILE: countFile,
        CODESIGN_TIMESTAMP_RETRY_ATTEMPTS: "3",
        CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS: "0",
        CODESIGN_TRANSIENT_FAILURES: "2",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Transient Apple timestamp failure");
    expect(readFileSync(countFile, "utf8")).toBe("5");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("does not retry non-timestamp signing failures", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-permanent-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const countFile = path.join(tempRoot, "codesign-count");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installTransientFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_COUNT_FILE: countFile,
        CODESIGN_PERMANENT_FAILURE: "1",
        CODESIGN_TIMESTAMP_RETRY_ATTEMPTS: "3",
        CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS: "0",
        CODESIGN_TRANSIENT_FAILURES: "0",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(7);
    expect(result.stderr).not.toContain("Transient Apple timestamp failure");
    expect(readFileSync(countFile, "utf8")).toBe("1");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });
});
