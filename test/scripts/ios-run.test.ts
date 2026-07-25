// iOS run tests cover simulator launch orchestration without touching Xcode.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-run.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";

const tempDirs: string[] = [];

function bashArgs(scriptPath: string): string[] {
  return process.platform === "win32" ? [scriptPath] : ["--noprofile", "--norc", scriptPath];
}

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
}

function makeFixture(bundleId: string): { root: string; script: string; logFile: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-run-"));
  tempDirs.push(root);

  const scriptsDir = path.join(root, "scripts");
  const iosDir = path.join(root, "apps", "ios");
  const binDir = path.join(root, "bin");
  const logFile = path.join(root, "commands.log");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(iosDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const script = path.join(scriptsDir, "ios-run.sh");
  writeFileSync(script, readFileSync(SCRIPT, "utf8"), "utf8");
  chmodSync(script, 0o755);

  writeExecutable(
    path.join(scriptsDir, "ios-configure-signing.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET:-}" || -n "\${CUSTOM_SIMULATOR_PUSH_PROOF_SECRET:-}" ]]; then
  printf 'configure-signing-proof-env leaked\\n' >>"${logFile}"
fi
`,
  );
  writeExecutable(
    path.join(scriptsDir, "ios-write-version-xcconfig.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET:-}" || -n "\${CUSTOM_SIMULATOR_PUSH_PROOF_SECRET:-}" ]]; then
  printf 'write-version-proof-env leaked\\n' >>"${logFile}"
fi
`,
  );
  writeFileSync(
    path.join(scriptsDir, "ios-write-swift-filelist.mjs"),
    `import { appendFileSync } from "node:fs";
if (process.env.OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET || process.env.CUSTOM_SIMULATOR_PUSH_PROOF_SECRET) {
  appendFileSync(${JSON.stringify(logFile)}, "write-swift-filelist-proof-env leaked\\n");
}
appendFileSync(${JSON.stringify(logFile)}, "write-swift-filelist\\n");
`,
    "utf8",
  );
  writeExecutable(
    path.join(binDir, "xcodegen"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'xcodegen %s\\n' "$*" >>"${logFile}"
if [[ -n "\${OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET:-}" ]]; then
  printf 'xcodegen-proof-env leaked\\n' >>"${logFile}"
fi
if [[ -n "\${CUSTOM_SIMULATOR_PUSH_PROOF_SECRET:-}" ]]; then
  printf 'xcodegen-custom-proof-env leaked\\n' >>"${logFile}"
fi
`,
  );
  writeExecutable(
    path.join(binDir, "xcodebuild"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'xcodebuild %s\\n' "$*" >>"${logFile}"
if [[ -n "\${OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET:-}" ]]; then
  printf 'xcodebuild-proof-env leaked\\n' >>"${logFile}"
fi
if [[ -n "\${CUSTOM_SIMULATOR_PUSH_PROOF_SECRET:-}" ]]; then
  printf 'xcodebuild-custom-proof-env leaked\\n' >>"${logFile}"
fi
derived=""
configuration="Debug"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -derivedDataPath)
      derived="$2"
      shift 2
      ;;
    -configuration)
      configuration="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
app_dir="$derived/Build/Products/$configuration-iphonesimulator/OpenClaw.app"
mkdir -p "$app_dir"
cat >"$app_dir/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>
PLIST
`,
  );
  writeExecutable(
    path.join(binDir, "simctl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'simctl %s\\n' "$*" >>"${logFile}"
if [[ "$1" == "launch" ]]; then
  if [[ -n "\${SIMCTL_CHILD_OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET:-}" ]]; then
    printf 'simctl-launch-proof set\\n' >>"${logFile}"
  else
    printf 'simctl-launch-proof unset\\n' >>"${logFile}"
  fi
fi
if [[ "$1" == "boot" ]]; then
  if [[ "\${SIMCTL_BOOT_MODE:-}" == "booted" ]]; then
    echo "Unable to boot device in current state: Booted" >&2
    exit 1
  fi
  if [[ "\${SIMCTL_BOOT_MODE:-}" == "fail" ]]; then
    echo "Unable to boot device in current state: Shutdown" >&2
    exit 1
  fi
fi
`,
  );
  writeExecutable(
    path.join(binDir, "plistbuddy"),
    `#!/usr/bin/env bash
set -euo pipefail
sed -n 's:.*<key>CFBundleIdentifier</key><string>\\([^<]*\\)</string>.*:\\1:p' "$3"
`,
  );

  return { root, script, logFile };
}

function runIosRun(
  fixture: { root: string; script: string },
  extraEnv = {},
  args: string[] = [],
): string {
  return execFileSync(BASH_BIN, [...bashArgs(fixture.script), ...args], {
    env: {
      ...process.env,
      IOS_DERIVED_DATA_DIR: path.join(fixture.root, "DerivedData"),
      IOS_RUN_XCODEBUILD_BIN: path.join(fixture.root, "bin", "xcodebuild"),
      IOS_RUN_XCODEGEN_BIN: path.join(fixture.root, "bin", "xcodegen"),
      IOS_RUN_SIMCTL_BIN: path.join(fixture.root, "bin", "simctl"),
      IOS_RUN_PLIST_BUDDY_BIN: path.join(fixture.root, "bin", "plistbuddy"),
      ...extraEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("scripts/ios-run.sh", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs and launches the configured app bundle identifier", () => {
    const fixture = makeFixture("ai.openclawfoundation.app");

    runIosRun(fixture, { SIMCTL_BOOT_MODE: "booted" });

    expect(readFileSync(fixture.logFile, "utf8")).toContain(
      "simctl launch iPhone 17 ai.openclawfoundation.app",
    );
  });

  it("builds simulator sandbox relay mode and injects proof secret only at launch", () => {
    const fixture = makeFixture("ai.openclawfoundation.app");
    const proofSecret = "x".repeat(32);

    runIosRun(
      fixture,
      {
        OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET: proofSecret,
        SIMCTL_BOOT_MODE: "booted",
      },
      ["--push-sandbox-simulator"],
    );

    const log = readFileSync(fixture.logFile, "utf8");
    expect(log).toContain("OPENCLAW_PUSH_MODE=simulatorSandbox");
    expect(log).toContain(
      "OPENCLAW_PUSH_RELAY_BASE_URL=https://ios-push-relay-sandbox.openclaw.ai",
    );
    expect(log).toContain("simctl launch iPhone 17 ai.openclawfoundation.app");
    expect(log).toContain("simctl-launch-proof set");
    expect(log).not.toContain("proof-env leaked");
    expect(log).not.toContain(proofSecret);
  });

  it("scrubs exported simulator proof secrets from normal build helpers", () => {
    const fixture = makeFixture("ai.openclawfoundation.app");
    const proofSecret = "x".repeat(32);
    const customProofSecret = "y".repeat(32);

    runIosRun(fixture, {
      OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET: proofSecret,
      OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET_ENV: "CUSTOM_SIMULATOR_PUSH_PROOF_SECRET",
      CUSTOM_SIMULATOR_PUSH_PROOF_SECRET: customProofSecret,
      SIMCTL_BOOT_MODE: "booted",
    });

    const log = readFileSync(fixture.logFile, "utf8");
    expect(log).toContain("simctl launch iPhone 17 ai.openclawfoundation.app");
    expect(log).toContain("simctl-launch-proof unset");
    expect(log).not.toContain("proof-env leaked");
    expect(log).not.toContain(proofSecret);
    expect(log).not.toContain(customProofSecret);
  });

  it("does not ignore simulator boot failures other than already booted", () => {
    const fixture = makeFixture("ai.openclawfoundation.app");

    expect(() => runIosRun(fixture, { SIMCTL_BOOT_MODE: "fail" })).toThrow();
    expect(readFileSync(fixture.logFile, "utf8")).not.toContain("simctl launch");
  });
});
