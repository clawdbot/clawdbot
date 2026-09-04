import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAndroidVersioning } from "../../scripts/lib/android-version.ts";
import { resolveIosReleasePlan, type IosReleasePlan } from "../../scripts/lib/ios-release-plan.ts";
import {
  readMobileVersionManifest,
  renderMobileVersionManifest,
} from "../../scripts/lib/mobile-version.ts";
import {
  applyMobileReleasePlan,
  MOBILE_RELEASE_PATHS,
  planMobileRelease,
} from "../../scripts/mobile-release-version.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SCRIPT = path.resolve("scripts/mobile-release-version.ts");

function writeFile(rootDir: string, relativePath: string, content: string): void {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function fixture(params?: {
  androidVersion?: string;
  androidVersionCode?: number;
  mobileVersion?: string;
}): string {
  const rootDir = tempDirs.make("openclaw-mobile-release-");
  const mobileVersion = params?.mobileVersion ?? "2026.8.1";
  const androidVersion = params?.androidVersion ?? "2026.7.4";
  const androidVersionCode = params?.androidVersionCode ?? 2026070401;
  const files: Record<string, string> = {
    "package.json": '{\n  "version": "2026.9.9"\n}\n',
    "CHANGELOG.md": "# Project changelog\n\nuntouched\n",
    "apps/mobile/version.json": renderMobileVersionManifest(mobileVersion),
    "apps/android/version.json": `${JSON.stringify(
      { version: androidVersion, versionCode: androidVersionCode },
      null,
      2,
    )}\n`,
    "apps/android/Config/Version.properties": "old properties\n",
    "apps/android/fastlane/metadata/android/en-US/release_notes.txt": "old notes\n",
    "apps/android/CHANGELOG.md": "# Android changelog\n\nuntouched\n",
    "apps/android/fastlane/Fastfile": "# untouched android fastfile\n",
    "apps/ios/CHANGELOG.md":
      "# OpenClaw iOS Changelog\n\n## Unreleased\n\n- Shared mobile release notes.\n\n## 2026.8.10\n\n- Previous notes.\n",
    "apps/ios/fastlane/Fastfile": "# untouched ios fastfile\n",
    "apps/macos/Sources/OpenClaw/Resources/Info.plist": "<plist>untouched</plist>\n",
    ".github/workflows/release.yml": "name: untouched\n",
  };
  for (const [relativePath, content] of Object.entries(files)) {
    writeFile(rootDir, relativePath, content);
  }
  return rootDir;
}

function snapshot(rootDir: string): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else {
        result.set(path.relative(rootDir, absolutePath), fs.readFileSync(absolutePath, "utf8"));
      }
    }
  };
  visit(rootDir);
  return result;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((relativePath) => before.get(relativePath) !== after.get(relativePath))
    .toSorted();
}

function iosPlan(overrides: Partial<IosReleasePlan> = {}): IosReleasePlan {
  return {
    appStoreRevision: 0,
    appStoreVersion: "2026.8.20",
    appStoreVersionId: null,
    appStoreVersionState: null,
    buildNumber: 1,
    buildUploads: [],
    changelogStatus: "needs-cut",
    decision: "new-revision",
    gatewayVersion: "2026.8.2",
    sourceClean: true,
    sourceSha: "0123456789abcdef",
    ...overrides,
  };
}

describe("mobile version owner", () => {
  it("renders and reads exact stable gateway bytes", () => {
    const expected = '{\n  "version": "2026.8.1"\n}\n';
    expect(renderMobileVersionManifest("2026.8.1")).toBe(expected);
    const repositoryVersion = readMobileVersionManifest();
    expect(fs.readFileSync("apps/mobile/version.json", "utf8")).toBe(
      renderMobileVersionManifest(repositoryVersion.version),
    );
    const rootDir = fixture();
    expect(readMobileVersionManifest(rootDir)).toEqual({ version: "2026.8.1" });
  });

  it("rejects prerelease and correction versions", () => {
    expect(() => renderMobileVersionManifest("2026.8.2-beta.1")).toThrow("stable release");
    expect(() => renderMobileVersionManifest("2026.8.2-1")).toThrow("stable release");
  });
});

describe("mobile release cutter", () => {
  it("prepares and finalizes the exact five release paths", () => {
    const rootDir = fixture();
    const before = snapshot(rootDir);
    const prepare = planMobileRelease({
      gatewayVersion: "2026.8.2",
      phase: "prepare",
      rootDir,
    });

    expect(prepare.androidVersionCode).toBe(2026080201);
    expect(prepare.wearVersionCode).toBe(2026080251);
    applyMobileReleasePlan(prepare);

    const livePlan = resolveIosReleasePlan({
      appStoreVersions: [],
      buildUploads: [],
      gatewayVersion: "2026.8.2",
      rootDir,
    });
    expect(livePlan).toMatchObject({
      appStoreRevision: 0,
      appStoreVersion: "2026.8.20",
      buildNumber: 1,
    });
    const finalize = planMobileRelease({
      gatewayVersion: "2026.8.2",
      iosPlan: livePlan,
      phase: "finalize",
      rootDir,
    });
    expect(finalize.iosAppStoreVersion).toBe("2026.8.20");
    expect(finalize.iosBuildNumber).toBe(1);
    applyMobileReleasePlan(finalize);

    const after = snapshot(rootDir);
    expect(changedPaths(before, after)).toEqual([...MOBILE_RELEASE_PATHS].toSorted());
    expect(after.get("apps/mobile/version.json")).toBe('{\n  "version": "2026.8.2"\n}\n');
    expect(after.get("apps/android/version.json")).toBe(
      '{\n  "version": "2026.8.2",\n  "versionCode": 2026080201\n}\n',
    );
    expect(after.get("apps/android/Config/Version.properties")).toContain(
      "OPENCLAW_ANDROID_VERSION_CODE=2026080201",
    );
    expect(after.get("apps/android/fastlane/metadata/android/en-US/release_notes.txt")).toBe(
      "- Shared mobile release notes.\n",
    );
    expect(after.get("apps/ios/CHANGELOG.md")).toContain(
      "## 2026.8.20\n\n- Shared mobile release notes.",
    );
    expect(() => checkAndroidVersioning({ requireMobileRelease: true, rootDir })).not.toThrow();

    expect(
      planMobileRelease({
        gatewayVersion: "2026.8.2",
        iosPlan: iosPlan({ changelogStatus: "ready" }),
        phase: "finalize",
        rootDir,
      }).changes,
    ).toEqual([]);
  });

  it.each(["prepare", "finalize"] as const)(
    "bounds %s notes by uploaded Unicode characters before writing",
    (phase) => {
      const rootDir = fixture();
      if (phase === "finalize") {
        applyMobileReleasePlan(
          planMobileRelease({ gatewayVersion: "2026.8.2", phase: "prepare", rootDir }),
        );
      }
      for (const characterCount of [500, 501]) {
        const notes = `${"🦞".repeat(characterCount - 1)}\n`;
        writeFile(rootDir, "apps/ios/CHANGELOG.md", `# iOS Changelog\n\n## Unreleased\n\n${notes}`);
        const before = snapshot(rootDir);
        const apply = () =>
          applyMobileReleasePlan(
            planMobileRelease({
              gatewayVersion: "2026.8.2",
              iosPlan: phase === "finalize" ? iosPlan() : null,
              phase,
              rootDir,
            }),
          );
        if (characterCount === 501) {
          expect(apply).toThrow("500 Unicode character limit");
          expect(snapshot(rootDir)).toEqual(before);
        } else {
          apply();
          expect(
            fs.readFileSync(
              path.join(rootDir, "apps/android/fastlane/metadata/android/en-US/release_notes.txt"),
              "utf8",
            ),
          ).toBe(notes);
        }
      }
    },
  );

  it("keeps forbidden release surfaces byte-identical", () => {
    const rootDir = fixture();
    const forbiddenPaths = [
      "package.json",
      "CHANGELOG.md",
      "apps/macos/Sources/OpenClaw/Resources/Info.plist",
      "apps/android/CHANGELOG.md",
      "apps/android/fastlane/Fastfile",
      "apps/ios/fastlane/Fastfile",
      ".github/workflows/release.yml",
    ];
    const before = new Map(
      forbiddenPaths.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(rootDir, relativePath), "utf8"),
      ]),
    );

    applyMobileReleasePlan(
      planMobileRelease({ gatewayVersion: "2026.8.2", phase: "prepare", rootDir }),
    );
    applyMobileReleasePlan(
      planMobileRelease({
        gatewayVersion: "2026.8.2",
        iosPlan: iosPlan(),
        phase: "finalize",
        rootDir,
      }),
    );

    for (const relativePath of forbiddenPaths) {
      expect(fs.readFileSync(path.join(rootDir, relativePath), "utf8")).toBe(
        before.get(relativePath),
      );
    }
  });

  it("merges retry notes once and remains idempotent", () => {
    const rootDir = fixture();
    writeFile(
      rootDir,
      "apps/ios/CHANGELOG.md",
      "# OpenClaw iOS Changelog\n\n## Unreleased\n\n- Retry fix.\n\n## 2026.8.20\n\n- Existing release note.\n",
    );
    applyMobileReleasePlan(
      planMobileRelease({ gatewayVersion: "2026.8.2", phase: "prepare", rootDir }),
    );
    const finalize = planMobileRelease({
      gatewayVersion: "2026.8.2",
      iosPlan: iosPlan(),
      phase: "finalize",
      rootDir,
    });
    applyMobileReleasePlan(finalize);

    expect(
      fs.readFileSync(
        path.join(rootDir, "apps/android/fastlane/metadata/android/en-US/release_notes.txt"),
        "utf8",
      ),
    ).toBe("- Retry fix.\n\n- Existing release note.\n");
    expect(
      planMobileRelease({
        gatewayVersion: "2026.8.2",
        iosPlan: iosPlan({ changelogStatus: "ready" }),
        phase: "finalize",
        rootDir,
      }).changes,
    ).toEqual([]);
  });

  it("preserves same-train Android codes and rejects version regressions", () => {
    const sameTrain = fixture({
      androidVersion: "2026.8.2",
      androidVersionCode: 2026080207,
      mobileVersion: "2026.8.2",
    });
    const plan = planMobileRelease({
      gatewayVersion: "2026.8.2",
      phase: "prepare",
      rootDir: sameTrain,
    });
    expect(plan.androidVersionCode).toBe(2026080207);
    expect(plan.wearVersionCode).toBe(2026080257);

    expect(() =>
      planMobileRelease({
        gatewayVersion: "2026.8.1",
        phase: "prepare",
        rootDir: sameTrain,
      }),
    ).toThrow("cannot move backward");

    const exhaustedPhoneRange = fixture({
      androidVersion: "2026.8.2",
      androidVersionCode: 2026080250,
      mobileVersion: "2026.8.2",
    });
    expect(() =>
      planMobileRelease({
        gatewayVersion: "2026.8.2",
        phase: "prepare",
        rootDir: exhaustedPhoneRange,
      }),
    ).toThrow("build number 01 through 49");
  });

  it("rejects mismatched or malformed iOS plans before finalization", () => {
    const rootDir = fixture();
    applyMobileReleasePlan(
      planMobileRelease({ gatewayVersion: "2026.8.2", phase: "prepare", rootDir }),
    );

    expect(() =>
      planMobileRelease({
        gatewayVersion: "2026.8.2",
        iosPlan: iosPlan({ gatewayVersion: "2026.8.3" }),
        phase: "finalize",
        rootDir,
      }),
    ).toThrow("does not match mobile gateway");
    expect(() =>
      planMobileRelease({
        gatewayVersion: "2026.8.2",
        iosPlan: iosPlan({ appStoreVersion: "2026.8.21" }),
        phase: "finalize",
        rootDir,
      }),
    ).toThrow("does not match encoded version");
    expect(() =>
      planMobileRelease({
        gatewayVersion: "2026.8.2",
        iosPlan: iosPlan({ buildNumber: 0 }),
        phase: "finalize",
        rootDir,
      }),
    ).toThrow("positive integer");
  });

  it("checks, writes, and rechecks both CLI phases", () => {
    const rootDir = fixture();
    const prepareCheck = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--prepare", "--version", "2026.8.2", "--root", rootDir],
      { encoding: "utf8" },
    );
    expect(prepareCheck.status).toBe(1);
    expect(prepareCheck.stderr).toContain("prepare requires updates");

    const prepareWrite = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        SCRIPT,
        "--prepare",
        "--version",
        "2026.8.2",
        "--root",
        rootDir,
        "--write",
      ],
      { encoding: "utf8" },
    );
    expect(prepareWrite.status).toBe(0);
    expect(prepareWrite.stdout).toContain("Android phone 2026080201");

    const planPath = path.join(rootDir, "ios-plan.json");
    fs.writeFileSync(planPath, `${JSON.stringify(iosPlan(), null, 2)}\n`, "utf8");
    const finalizeWrite = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        SCRIPT,
        "--finalize",
        "--version",
        "2026.8.2",
        "--plan",
        planPath,
        "--root",
        rootDir,
        "--write",
      ],
      { encoding: "utf8" },
    );
    expect(finalizeWrite.status).toBe(0);
    expect(finalizeWrite.stdout).toContain("iOS 2026.8.20 build 1");

    const finalizeCheck = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        SCRIPT,
        "--finalize",
        "--version",
        "2026.8.2",
        "--plan",
        planPath,
        "--root",
        rootDir,
      ],
      { encoding: "utf8" },
    );
    expect(finalizeCheck.status).toBe(0);
    expect(finalizeCheck.stdout).toBe(
      "Mobile release 2026.8.2 finalize state is already aligned.\n",
    );
  });
});
