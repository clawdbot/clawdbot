import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/package-mac-app.sh";

function makePlist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-plistbuddy-"));
  tempDirs.push(dir);
  const plist = path.join(dir, "Info.plist");
  writeFileSync(
    plist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "<key>CFBundleIdentifier</key>",
      "<string>old.bundle</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
    "utf8",
  );
  return plist;
}

function runHelper(script: string) {
  return spawnSync("bash", ["-lc", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function getPackageManagerHelperBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("PNPM_CMD=()");
  const end = script.indexOf("merge_framework_machos()");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("package-mac-app plist stamping", () => {
  it("keeps dependency installation lockfile-safe", () => {
    const script = readFileSync(scriptPath, "utf8");
    const installBlock = script.slice(
      script.indexOf('if [[ "${SKIP_PNPM_INSTALL:-0}" != "1" ]]'),
      script.indexOf('if [[ -z "${APP_BUILD:-}" ]]'),
    );

    expect(installBlock).toContain("run_pnpm install --frozen-lockfile");
    expect(installBlock).toContain("--config.node-linker=hoisted");
    expect(installBlock).not.toContain("--no-frozen-lockfile");
  });

  it("falls back to corepack pnpm when the pnpm shim is absent", () => {
    const helperBlock = getPackageManagerHelperBlock();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-package-pnpm-root-"));
    const toolsDir = mkdtempSync(path.join(tmpdir(), "openclaw-package-pnpm-tools-"));
    const logPath = path.join(tempRoot, "corepack.log");
    tempDirs.push(tempRoot, toolsDir);

    const corepackPath = path.join(toolsDir, "corepack");
    writeFileSync(
      corepackPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s|%s\\n' \"$PWD\" \"$*\" >> \"$OPENCLAW_TEST_LOG\"",
        "if [[ \"${1:-}\" == \"pnpm\" && \"${2:-}\" == \"--version\" ]]; then",
        "  echo '11.2.2'",
        "fi",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(corepackPath, 0o755);

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      OPENCLAW_TEST_LOG=${JSON.stringify(logPath)}
      export OPENCLAW_TEST_LOG
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      ${helperBlock}
      run_pnpm install --frozen-lockfile --config.node-linker=hoisted
      run_pnpm build
    `);

    expect(result.status).toBe(0);
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      `${tempRoot}|pnpm --version`,
      `${tempRoot}|pnpm install --frozen-lockfile --config.node-linker=hoisted`,
      `${tempRoot}|pnpm build`,
    ]);
  });

  it("fails with an actionable error when neither pnpm nor corepack pnpm is available", () => {
    const helperBlock = getPackageManagerHelperBlock();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-package-pnpm-root-"));
    const toolsDir = mkdtempSync(path.join(tmpdir(), "openclaw-package-pnpm-tools-"));
    tempDirs.push(tempRoot, toolsDir);

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      ${helperBlock}
      run_pnpm build
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm is not on PATH and corepack pnpm is unavailable");
  });

  it("does not kill unrelated OpenClaw processes during packaging", () => {
    const script = readFileSync(scriptPath, "utf8");
    const stopBlock = script.slice(
      script.indexOf("running_packaged_app_pids()"),
      script.indexOf('echo "🔏 Signing bundle'),
    );

    expect(script).not.toContain("killall -q OpenClaw");
    expect(stopBlock).toContain('local app_binary="$APP_ROOT/Contents/MacOS/OpenClaw"');
    expect(stopBlock).toContain('pgrep -x "$PRODUCT"');
    expect(stopBlock).toContain('grep -Fx "$app_binary"');
    expect(stopBlock).toContain(
      '[[ "$command_line" == "$app_binary" || "$command_line" == "$app_binary "* ]]',
    );
  });

  it("keeps mac packaging script checks in the macOS CI lane", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const macosCi = pkg.scripts?.["test:macos:ci"] ?? "";

    expect(macosCi).toContain("test/scripts/package-mac-app.test.ts");
    expect(macosCi).toContain("test/scripts/package-mac-dist.test.ts");
    expect(macosCi).toContain("test/scripts/create-dmg.test.ts");
  });

  it("fails closed when required Swift resources are missing", () => {
    const script = readFileSync(scriptPath, "utf8");
    const openClawKitBlock = script.slice(
      script.indexOf(
        'OPENCLAWKIT_BUNDLE="$(build_path_for_arch "$PRIMARY_ARCH")/$BUILD_CONFIG/OpenClawKit_OpenClawKit.bundle"',
      ),
      script.indexOf('echo "📦 Copying Textual resources"'),
    );

    expect(openClawKitBlock).toContain("ERROR: OpenClawKit resource bundle not found");
    expect(openClawKitBlock).toContain("exit 1");
    expect(openClawKitBlock).not.toContain("WARN:");
    expect(openClawKitBlock).not.toContain("continuing");
  });

  it("does not mask required Info.plist stamp failures", () => {
    const script = readFileSync(scriptPath, "utf8");
    const stampBlock = script.slice(
      script.indexOf("plist_set_string_required"),
      script.indexOf('echo "🚚 Copying binary"'),
    );

    expect(stampBlock).toContain("plist_set_string_required");
    expect(stampBlock).not.toContain("|| true");
  });

  it.runIf(process.platform === "darwin")(
    "sets required strings and fails when the plist cannot be stamped",
    () => {
      const plist = makePlist();
      const result = runHelper(`
        set -euo pipefail
        source scripts/lib/plistbuddy.sh
        plist_set_string_required ${JSON.stringify(plist)} CFBundleIdentifier 'ai.openclaw.test'
        /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' ${JSON.stringify(plist)}
        broken="$(mktemp -d)"
        plist_set_string_required "$broken" CFBundleIdentifier broken
      `);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("ai.openclaw.test");
      expect(result.stderr).toContain("Error Reading File");
    },
  );

  it.runIf(process.platform === "darwin")("adds optional strings and booleans", () => {
    const plist = makePlist();
    const result = runHelper(`
      set -euo pipefail
      source scripts/lib/plistbuddy.sh
      plist_set_or_add_string ${JSON.stringify(plist)} SUFeedURL ''
      plist_set_or_add_string ${JSON.stringify(plist)} SUPublicEDKey 'key"with\\\\slashes'
      plist_set_or_add_bool ${JSON.stringify(plist)} SUEnableAutomaticChecks false
      /usr/libexec/PlistBuddy -c 'Print :SUFeedURL' ${JSON.stringify(plist)}
      /usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' ${JSON.stringify(plist)}
      /usr/libexec/PlistBuddy -c 'Print :SUEnableAutomaticChecks' ${JSON.stringify(plist)}
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('key"with\\\\slashes');
    expect(result.stdout).toContain("false");
  });
});
