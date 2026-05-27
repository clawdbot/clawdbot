import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runScript(args: string[]) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
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

  it.runIf(process.platform === "darwin")(
    "fails before hdiutil when required plist keys are missing",
    () => {
      const app = makeApp([
        "<key>CFBundleName</key>",
        "<string>OpenClaw</string>",
      ]);
      const result = runScript([app, path.join(path.dirname(app), "out.dmg")]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Does Not Exist");
      expect(result.stdout).not.toContain("Creating DMG:");
    },
  );
});
