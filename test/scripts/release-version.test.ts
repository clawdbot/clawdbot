// Release version tests cover one-command core and native version alignment.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyReleaseVersionPlan,
  parseReleaseVersionArgs,
  planReleaseVersion,
} from "../../scripts/release-version.ts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT = path.resolve("scripts/release-version.ts");
const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeFixture(params?: {
  androidVersion?: string;
  androidVersionCode?: number;
  packageVersion?: string;
}): string {
  const root = makeTempDir(tempDirs, "openclaw-release-version-");
  fs.mkdirSync(path.join(root, "apps", "macos", "Sources", "OpenClaw", "Resources"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, "apps", "android", "Config"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps", "android", "fastlane", "metadata", "android", "en-US"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: params?.packageVersion ?? "2026.6.11",
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "apps", "macos", "Sources", "OpenClaw", "Resources", "Info.plist"),
    [
      "<plist>",
      "<dict>",
      "  <key>CFBundleShortVersionString</key>",
      "  <string>2026.6.11</string>",
      "  <key>CFBundleVersion</key>",
      "  <string>2026061100</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "apps", "android", "version.json"),
    `${JSON.stringify(
      {
        version: params?.androidVersion ?? "2026.7.1",
        versionCode: params?.androidVersionCode ?? 2026070102,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(root, "apps", "android", "Config", "Version.properties"), "stale\n");
  fs.writeFileSync(
    path.join(root, "apps", "android", "CHANGELOG.md"),
    [
      "# Android Changelog",
      "",
      "## 2026.7.2",
      "",
      "- New release notes.",
      "",
      "## 2026.7.1",
      "",
      "- Previous release notes.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(
      root,
      "apps",
      "android",
      "fastlane",
      "metadata",
      "android",
      "en-US",
      "release_notes.txt",
    ),
    "- Previous release notes.\n",
  );
  return root;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

describe("release version argument parsing", () => {
  it("defaults to check mode and keeps Android opt-in", () => {
    expect(parseReleaseVersionArgs(["--version", "2026.7.2-beta.1"])).toMatchObject({
      android: false,
      mode: "check",
      version: "2026.7.2-beta.1",
    });
  });
});

describe("release version planning", () => {
  it("aligns root and macOS metadata to a prerelease without moving Android", () => {
    const root = writeFixture();
    const plan = planReleaseVersion({
      rootDir: root,
      version: "2026.7.2-beta.1",
    });

    expect(plan.changes.map((change) => path.relative(root, change.path))).toEqual([
      "package.json",
      "apps/macos/Sources/OpenClaw/Resources/Info.plist",
    ]);
    applyReleaseVersionPlan(plan);

    expect(readJson(path.join(root, "package.json"))).toMatchObject({
      name: "openclaw",
      private: true,
      version: "2026.7.2-beta.1",
    });
    expect(
      fs.readFileSync(
        path.join(root, "apps", "macos", "Sources", "OpenClaw", "Resources", "Info.plist"),
        "utf8",
      ),
    ).toContain("<string>2026070200</string>");
    expect(readJson(path.join(root, "apps", "android", "version.json"))).toMatchObject({
      version: "2026.7.1",
      versionCode: 2026070102,
    });
  });

  it("keeps repository versions at the base version for correction tags", () => {
    const root = writeFixture();
    const plan = planReleaseVersion({
      rootDir: root,
      version: "2026.7.2-3",
    });
    applyReleaseVersionPlan(plan);

    expect(plan.version).toBe("2026.7.2-3");
    expect(readJson(path.join(root, "package.json"))).toMatchObject({
      version: "2026.7.2",
    });
    expect(
      fs.readFileSync(
        path.join(root, "apps", "macos", "Sources", "OpenClaw", "Resources", "Info.plist"),
        "utf8",
      ),
    ).toContain("<string>2026.7.2</string>");
  });

  it("keeps an existing Android build increment on the same release train", () => {
    const root = writeFixture();
    const plan = planReleaseVersion({
      android: true,
      rootDir: root,
      version: "2026.7.1-beta.4",
    });
    applyReleaseVersionPlan(plan);

    expect(readJson(path.join(root, "apps", "android", "version.json"))).toEqual({
      version: "2026.7.1",
      versionCode: 2026070102,
    });
    expect(
      fs.readFileSync(path.join(root, "apps", "android", "Config", "Version.properties"), "utf8"),
    ).toContain("OPENCLAW_ANDROID_VERSION_CODE=2026070102");
    expect(
      fs.readFileSync(
        path.join(
          root,
          "apps",
          "android",
          "fastlane",
          "metadata",
          "android",
          "en-US",
          "release_notes.txt",
        ),
        "utf8",
      ),
    ).toBe("- Previous release notes.\n");
  });

  it("starts a new Android train at its canonical build code", () => {
    const root = writeFixture();
    const plan = planReleaseVersion({
      android: true,
      rootDir: root,
      version: "2026.7.2-3",
    });
    applyReleaseVersionPlan(plan);

    expect(readJson(path.join(root, "apps", "android", "version.json"))).toEqual({
      version: "2026.7.2",
      versionCode: 2026070201,
    });
    expect(
      fs.readFileSync(
        path.join(
          root,
          "apps",
          "android",
          "fastlane",
          "metadata",
          "android",
          "en-US",
          "release_notes.txt",
        ),
        "utf8",
      ),
    ).toBe("- New release notes.\n");
  });

  it("validates every selected file before writing any changes", () => {
    const root = writeFixture();
    const packagePath = path.join(root, "package.json");
    const before = fs.readFileSync(packagePath, "utf8");
    fs.writeFileSync(
      path.join(root, "apps", "macos", "Sources", "OpenClaw", "Resources", "Info.plist"),
      "<plist><dict></dict></plist>\n",
    );

    expect(() =>
      planReleaseVersion({
        rootDir: root,
        version: "2026.7.2-beta.1",
      }),
    ).toThrow("must contain exactly one string value for CFBundleShortVersionString");
    expect(fs.readFileSync(packagePath, "utf8")).toBe(before);
  });
});

describe("release version CLI", () => {
  it("reports drift in check mode, writes it once, then passes", () => {
    const root = writeFixture();
    const check = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--root", root, "--version", "2026.7.2-beta.1"],
      { encoding: "utf8" },
    );
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("Release version 2026.7.2-beta.1 requires updates:");
    expect(check.stderr).toContain("- package.json");

    const write = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--root", root, "--version", "2026.7.2-beta.1", "--write"],
      { encoding: "utf8" },
    );
    expect(write.status).toBe(0);
    expect(write.stdout).toContain("Updated release version 2026.7.2-beta.1:");

    const recheck = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--root", root, "--version", "2026.7.2-beta.1"],
      { encoding: "utf8" },
    );
    expect(recheck.status).toBe(0);
    expect(recheck.stdout).toBe("Release version 2026.7.2-beta.1 is already aligned.\n");
  });

  it("rejects invalid versions without changing the fixture", () => {
    const root = writeFixture();
    const packagePath = path.join(root, "package.json");
    const before = fs.readFileSync(packagePath, "utf8");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--root", root, "--version", "7.2.0", "--write"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid release version '7.2.0'");
    expect(fs.readFileSync(packagePath, "utf8")).toBe(before);
  });
});
