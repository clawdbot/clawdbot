// Codesign Mac App tests cover codesign mac app script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPLE_CLASS_LOOKALIKE_LISTING,
  DEVELOPER_ID_LISTING,
  NON_APPLE_ONLY_LISTING,
  installFakeSecurity,
} from "./mac-signing-identity.test-support.ts";

const tempDirs: string[] = [];
const scriptPath = "scripts/codesign-mac-app.sh";

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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

# Opt-in argv capture: only cases asserting on signing flags set CODESIGN_ARGS_LOG,
# so the entitlement-focused cases keep their existing CODESIGN_LOG shape.
if [ -n "\${CODESIGN_ARGS_LOG:-}" ]; then
  printf '%s\\t' "$@" >>"$CODESIGN_ARGS_LOG"
  printf '\\n' >>"$CODESIGN_ARGS_LOG"
fi

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

function runCodesignWithKeychain(listing: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const tempRoot = makeTempDir("openclaw-codesign-identity-");
  const app = path.join(tempRoot, "Fake.app");
  const binDir = path.join(tempRoot, "bin");
  const captureDir = path.join(tempRoot, "capture");
  const argsLogPath = path.join(captureDir, "codesign-args.log");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(binDir);
  mkdirSync(captureDir);
  writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
  installFakeCodesign(binDir);
  installFakeSecurity(binDir, listing);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODESIGN_ARGS_LOG: argsLogPath,
    CODESIGN_CAPTURE_DIR: captureDir,
    CODESIGN_LOG: path.join(captureDir, "codesign.log"),
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SKIP_TEAM_ID_CHECK: "1",
    TMPDIR: tempRoot,
  };
  delete env.SIGN_IDENTITY;
  delete env.ALLOW_ADHOC_SIGNING;
  Object.assign(env, extraEnv);

  const result = spawnSync("bash", [scriptPath, app], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
  const signArgs = existsSync(argsLogPath) ? readFileSync(argsLogPath, "utf8") : "";
  return { result, signArgs };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("codesign-mac-app identity selection", () => {
  it("prefers Developer ID Application over the other Apple classes", () => {
    const { result } = runCodesignWithKeychain(DEVELOPER_ID_LISTING);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Using signing identity: Developer ID Application: Jane Doe (TEAM000001)",
    );
  });

  it("refuses to auto-select codesigning certificates outside the Apple classes", () => {
    // The lookalike only contains the class text; a substring match would sign it.
    for (const [listing, name] of [
      [NON_APPLE_ONLY_LISTING, "Acme Internal Self-Signed Dev"],
      [APPLE_CLASS_LOOKALIKE_LISTING, "Acme Developer ID Application Proxy"],
    ] as const) {
      const { result } = runCodesignWithKeychain(listing);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No signing identity found");
      expect(result.stdout).not.toContain(name);
    }
  });

  it("signs with a non-Apple certificate when SIGN_IDENTITY names it", () => {
    const { result } = runCodesignWithKeychain(NON_APPLE_ONLY_LISTING, {
      SIGN_IDENTITY: "Acme Internal Self-Signed Dev",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Using signing identity: Acme Internal Self-Signed Dev");
  });

  it("timestamps only the Developer ID Application class under auto", () => {
    // The timestamp service can reject non-Developer-ID certs, and a lookalike
    // name must not opt into one just by containing the class text.
    const developerId = runCodesignWithKeychain(DEVELOPER_ID_LISTING, {
      CODESIGN_TIMESTAMP: "auto",
    });
    const lookalike = runCodesignWithKeychain(APPLE_CLASS_LOOKALIKE_LISTING, {
      CODESIGN_TIMESTAMP: "auto",
      SIGN_IDENTITY: "Acme Developer ID Application Proxy",
    });

    expect(developerId.result.status).toBe(0);
    expect(developerId.signArgs).toContain("--timestamp\t");
    expect(developerId.signArgs).not.toContain("--timestamp=none");
    expect(lookalike.result.status).toBe(0);
    expect(lookalike.signArgs).toContain("--timestamp=none");
    expect(lookalike.signArgs).not.toContain("--timestamp\t");
  });
});

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
    const tempRoot = makeTempDir("openclaw-codesign-help-");
    const result = runCodesign(["--help"], tempRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: scripts/codesign-mac-app.sh");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("does not allocate entitlement temp files before app validation", () => {
    const tempRoot = makeTempDir("openclaw-codesign-missing-");
    const missingApp = path.join(tempRoot, "Missing.app");
    const result = runCodesign([missingApp], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("App bundle not found");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects unknown options before app validation", () => {
    const tempRoot = makeTempDir("openclaw-codesign-unknown-");
    const result = runCodesign(["--wat"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unknown codesign option: --wat");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects extra app bundle arguments before signing", () => {
    const tempRoot = makeTempDir("openclaw-codesign-extra-");
    const app = path.join(tempRoot, "Fake.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    const result = runCodesign([app, "extra"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unexpected codesign argument: extra");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("cleans entitlement temp files when signing fails", () => {
    const tempRoot = makeTempDir("openclaw-codesign-fail-");
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

  it("passes generated app entitlements to signing commands and cleans them", () => {
    const tempRoot = makeTempDir("openclaw-codesign-success-");
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
    expect(signLines[0]).toContain(`${path.join(app, "Contents", "MacOS", "openclaw-mlx-tts")}\t`);
    expect(signLines[1]).toContain(`${path.join(app, "Contents", "MacOS", "OpenClaw")}\t`);
    expect(signLines[2]).toContain(`${app}\t`);
    for (const line of signLines) {
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
});
