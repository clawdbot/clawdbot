// Create Dmg tests cover create dmg script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/create-dmg.sh";

function makeApp(plistEntries: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-"));
  tempDirs.push(dir);
  const app = path.join(dir, "OpenClaw.app");
  const contents = path.join(app, "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(
    path.join(contents, "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      ...plistEntries,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
    "utf8",
  );
  return app;
}

function makeValidApp(): string {
  return makeApp([
    "<key>CFBundleName</key>",
    "<string>OpenClaw</string>",
    "<key>CFBundleShortVersionString</key>",
    "<string>2026.6.16</string>",
  ]);
}

function makeFakeDmgTools() {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-tools-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "bin");
  const hdiutilLog = path.join(dir, "hdiutil.log");
  const osascriptLog = path.join(dir, "osascript.applescript");
  mkdirSync(bin, { recursive: true });
  const hdiutil = path.join(bin, "hdiutil");
  writeFileSync(
    hdiutil,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$HDIUTIL_LOG"
command_name="\${1:-}"
shift || true
if [[ "\${HDIUTIL_FAIL_ON:-}" == "$command_name" ]]; then
  exit 17
fi
case "$command_name" in
  create)
    : > "\${!#}"
    ;;
  attach)
    mountpoint=""
    while (($#)); do
      if [[ "$1" == "-mountpoint" ]]; then
        mountpoint="$2"
        break
      fi
      shift
    done
    if [[ "\${HDIUTIL_ATTACH_MARKER:-0}" == "1" && -n "$mountpoint" ]]; then
      mkdir -p "$mountpoint"
      printf mounted > "$mountpoint/live-volume-file"
    fi
    ;;
  detach)
    if [[ "\${HDIUTIL_DETACH_FAIL:-0}" == "1" ]]; then
      exit 9
    fi
    detach_attempts_file="\${HDIUTIL_LOG}.detach-attempts"
    detach_attempts=0
    if [[ -f "$detach_attempts_file" ]]; then
      detach_attempts="$(cat "$detach_attempts_file")"
    fi
    detach_attempts=$((detach_attempts + 1))
    printf '%s' "$detach_attempts" > "$detach_attempts_file"
    if (( detach_attempts <= \${HDIUTIL_DETACH_FAIL_COUNT:-0} )); then
      exit 9
    fi
    ;;
  resize)
    if [[ "\${1:-}" == "-limits" ]]; then
      printf '100 200 300\\n'
    fi
    ;;
  convert)
    output=""
    while (($#)); do
      if [[ "$1" == "-o" ]]; then
        output="$2"
        break
      fi
      shift
    done
    [[ -n "$output" ]]
    printf 'converted' > "$output"
    ;;
  verify)
    [[ -f "\${1:-}" ]]
    ;;
esac
`,
    "utf8",
  );
  chmodSync(hdiutil, 0o755);
  const osascript = path.join(bin, "osascript");
  writeFileSync(osascript, '#!/usr/bin/env bash\ncat > "$OSASCRIPT_LOG"\nexit 0\n', "utf8");
  chmodSync(osascript, 0o755);
  const sleep = path.join(bin, "sleep");
  writeFileSync(sleep, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  chmodSync(sleep, 0o755);
  return {
    env: {
      HDIUTIL_LOG: hdiutilLog,
      OSASCRIPT_LOG: osascriptLog,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SKIP_DMG_STYLE: "1",
    },
    hdiutilLog,
    osascriptLog,
  };
}

function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("create-dmg plist validation", () => {
  it("fails closed for required Info.plist reads", () => {
    const script = readFileSync(scriptPath, "utf8");
    const readBlock = script.slice(
      script.indexOf("APP_NAME="),
      script.indexOf('DMG_NAME="${APP_NAME}-${VERSION}.dmg"'),
    );

    expect(script).toContain('source "$ROOT_DIR/scripts/lib/plistbuddy.sh"');
    expect(readBlock).toContain(
      'APP_NAME="$(plist_print_required "$APP_PATH/Contents/Info.plist" CFBundleName)"',
    );
    expect(readBlock).toContain(
      'VERSION="$(plist_print_required "$APP_PATH/Contents/Info.plist" CFBundleShortVersionString)"',
    );
    expect(readBlock).not.toContain("PlistBuddy");
    expect(readBlock).not.toContain("|| echo");
  });

  it("keeps temporary DMG artifacts scoped to one run", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('DMG_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-dmg.XXXXXX")"');
    expect(script).toContain('DMG_SOURCE="$DMG_TEMP/source"');
    expect(script).toContain('MOUNT_POINT="$DMG_TEMP/mount"');
    expect(script).toContain('DMG_RW_PATH="$DMG_TEMP/image-rw.dmg"');
    expect(script).toContain('DMG_OUTPUT_TEMP=""');
    expect(script).toContain('DMG_FINAL_PATH=""');
    expect(script).toContain(
      'DMG_OUTPUT_TEMP="$(mktemp -d "$(dirname "$OUT_PATH")/.openclaw-dmg.XXXXXX")"',
    );
    expect(script).toContain('DMG_FINAL_PATH="$DMG_OUTPUT_TEMP/final.dmg"');
    expect(script).toContain('DMG_LIMITS_PATH="$DMG_TEMP/resize-limits.txt"');
    expect(script).toContain('hdiutil resize -limits "$DMG_RW_PATH" >"$DMG_LIMITS_PATH"');
    expect(script).not.toContain("/tmp/openclaw-dmg-limits.txt");
    expect(script).not.toContain('"/Volumes/$DMG_VOLUME_NAME"');
    expect(script).not.toContain('tell application "Finder" to close every window');
  });

  it("fails malformed DMG resize slack before creating images", () => {
    const script = readFileSync(scriptPath, "utf8");
    const validationBlock = script.slice(
      script.indexOf("require_integer_list()"),
      script.indexOf("to_applescript_list4()"),
    );

    expect(validationBlock).toContain("require_nonnegative_integer()");
    expect(validationBlock).toContain(
      'require_nonnegative_integer DMG_EXTRA_SECTORS "$DMG_EXTRA_SECTORS"',
    );
    expect(validationBlock).toContain("must be a finite non-negative integer");
  });

  it.runIf(process.platform === "darwin")(
    "fails before hdiutil when required plist keys are missing",
    () => {
      const app = makeApp(["<key>CFBundleName</key>", "<string>OpenClaw</string>"]);
      const result = runScript([app, path.join(path.dirname(app), "out.dmg")]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Does Not Exist");
      expect(result.stdout).not.toContain("Creating DMG:");
    },
  );
});

describe.runIf(process.platform === "darwin")("create-dmg ownership boundaries", () => {
  it("uses private intermediate paths without deleting caller-owned siblings", () => {
    const app = makeValidApp();
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
    tempDirs.push(outputDir);
    const output = path.join(outputDir, "OpenClaw.dmg");
    const sibling = path.join(outputDir, "OpenClaw-rw.dmg");
    writeFileSync(output, "previous output", "utf8");
    writeFileSync(sibling, "caller owned", "utf8");
    const tools = makeFakeDmgTools();

    const result = runScript([app, output], tools.env);

    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("converted");
    expect(readFileSync(sibling, "utf8")).toBe("caller owned");
    const log = readFileSync(tools.hdiutilLog, "utf8");
    expect(log).toContain("image-rw.dmg -mountpoint");
    expect(log).toContain("convert ");
    expect(log).toContain("final.dmg");
    expect(log).toContain(`${outputDir}${path.sep}.openclaw-dmg.`);
    expect(log).not.toContain("/Volumes/");
    expect(log).not.toContain(sibling);
  });

  it("creates a caller-provided output directory before finalizing the DMG", () => {
    const app = makeValidApp();
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
    tempDirs.push(root);
    const outputDir = path.join(root, "nested", "artifacts");
    const output = path.join(outputDir, "OpenClaw.dmg");
    const tools = makeFakeDmgTools();

    const result = runScript([app, output], tools.env);

    expect(result.status).toBe(0);
    expect(existsSync(outputDir)).toBe(true);
    expect(readFileSync(output, "utf8")).toBe("converted");
    const log = readFileSync(tools.hdiutilLog, "utf8");
    expect(log).toContain(`${outputDir}${path.sep}.openclaw-dmg.`);
  });

  it("preserves an existing output when image creation fails", () => {
    const app = makeValidApp();
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
    tempDirs.push(outputDir);
    const output = path.join(outputDir, "OpenClaw.dmg");
    writeFileSync(output, "previous output", "utf8");
    const tools = makeFakeDmgTools();

    const result = runScript([app, output], { ...tools.env, HDIUTIL_FAIL_ON: "create" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe("previous output");
    expect(readFileSync(tools.hdiutilLog, "utf8")).not.toContain("detach");
  });

  it("fails before image creation when Finder layout values are malformed", () => {
    const app = makeValidApp();
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
    tempDirs.push(outputDir);
    const output = path.join(outputDir, "OpenClaw.dmg");
    const tools = makeFakeDmgTools();

    const result = runScript([app, output], {
      ...tools.env,
      DMG_WINDOW_BOUNDS: "400 nope 900 420",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DMG_WINDOW_BOUNDS must contain only integer values");
    expect(existsSync(output)).toBe(false);
    expect(existsSync(tools.hdiutilLog) ? readFileSync(tools.hdiutilLog, "utf8") : "").toBe("");
  });

  it("fails before image creation when Finder layout values span multiple lines", () => {
    const app = makeValidApp();
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
    tempDirs.push(outputDir);
    const output = path.join(outputDir, "OpenClaw.dmg");
    const tools = makeFakeDmgTools();

    const result = runScript([app, output], {
      ...tools.env,
      DMG_WINDOW_BOUNDS: "400 100 900 420\nnope",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DMG_WINDOW_BOUNDS must be a single line");
    expect(existsSync(output)).toBe(false);
    expect(existsSync(tools.hdiutilLog) ? readFileSync(tools.hdiutilLog, "utf8") : "").toBe("");
  });

  it("preserves an existing output when verification fails", () => {
    const app = makeValidApp();
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
    tempDirs.push(outputDir);
    const output = path.join(outputDir, "OpenClaw.dmg");
    writeFileSync(output, "previous output", "utf8");
    const tools = makeFakeDmgTools();

    const result = runScript([app, output], { ...tools.env, HDIUTIL_FAIL_ON: "verify" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe("previous output");
    const log = readFileSync(tools.hdiutilLog, "utf8");
    expect(log).toContain("convert ");
    expect(log).toContain("final.dmg");
  });

  it("fails before resize and conversion when its private mount cannot detach", () => {
    const app = makeValidApp();
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
    tempDirs.push(outputDir);
    const output = path.join(outputDir, "OpenClaw.dmg");
    const tools = makeFakeDmgTools();

    const result = runScript([app, output], {
      ...tools.env,
      HDIUTIL_ATTACH_MARKER: "1",
      HDIUTIL_DETACH_FAIL: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Failed to detach DMG mount");
    expect(result.stderr).toContain("Preserving DMG temp root");
    const log = readFileSync(tools.hdiutilLog, "utf8");
    expect(log).not.toContain("resize");
    expect(log).not.toContain("convert");
    expect(log).not.toContain("/Volumes/");
    const mountPoint = log.match(/-mountpoint ([^ ]+)/)?.[1];
    expect(mountPoint).toBeTruthy();
    expect(readFileSync(path.join(mountPoint as string, "live-volume-file"), "utf8")).toBe(
      "mounted",
    );
    rmSync(path.dirname(mountPoint as string), { recursive: true, force: true });
  });

  it("retries a delayed DMG detach before finalizing the artifact", () => {
    const app = makeValidApp();
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
    tempDirs.push(outputDir);
    const output = path.join(outputDir, "OpenClaw.dmg");
    const tools = makeFakeDmgTools();

    const result = runScript([app, output], {
      ...tools.env,
      HDIUTIL_DETACH_FAIL_COUNT: "6",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("converted");
    const log = readFileSync(tools.hdiutilLog, "utf8");
    expect(log.match(/^detach /gm)).toHaveLength(7);
    expect(log).toContain("detach ");
    expect(log).toContain("-force");
    expect(log).toContain("resize");
    expect(log).toContain("convert ");
  });

  it("styles the private mount without closing unrelated Finder windows", () => {
    const app = makeValidApp();
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
    tempDirs.push(outputDir);
    const output = path.join(outputDir, "OpenClaw.dmg");
    const tools = makeFakeDmgTools();

    const result = runScript([app, output], { ...tools.env, SKIP_DMG_STYLE: "0" });

    expect(result.status).toBe(0);
    const applescript = readFileSync(tools.osascriptLog, "utf8");
    expect(applescript).toContain('set dmgRoot to POSIX file "');
    expect(applescript).toContain('/mount" as alias');
    expect(applescript).toContain("set dmgDisk to disk of dmgRoot");
    expect(applescript).not.toContain('tell disk "OpenClaw"');
    expect(applescript).not.toContain("close every window");
  });
});
