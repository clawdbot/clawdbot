// Release Version keeps the core and explicitly selected native release trains aligned.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import {
  canonicalAndroidVersionCode,
  normalizeAndroidVersionCode,
  normalizePinnedAndroidVersion,
  renderAndroidReleaseNotes,
  renderAndroidVersionProperties,
} from "./lib/android-version.ts";
import { parseReleaseVersion } from "./lib/release-version.mjs";

const MACOS_INFO_PLIST = "apps/macos/Sources/OpenClaw/Resources/Info.plist";
const ANDROID_CHANGELOG_FILE = "apps/android/CHANGELOG.md";
const ANDROID_RELEASE_NOTES_FILE = "apps/android/fastlane/metadata/android/en-US/release_notes.txt";
const ANDROID_VERSION_FILE = "apps/android/version.json";
const ANDROID_VERSION_PROPERTIES_FILE = "apps/android/Config/Version.properties";

type ReleaseVersionMode = "check" | "write";

type ReleaseVersionArgs = {
  android: boolean;
  help: boolean;
  mode: ReleaseVersionMode;
  rootDir: string;
  version: string | null;
};

type ReleaseVersionChange = {
  currentContent: string;
  nextContent: string;
  path: string;
};

type ReleaseVersionPlan = {
  changes: ReleaseVersionChange[];
  version: string;
};

type AndroidVersionManifest = {
  version?: unknown;
  versionCode?: unknown;
};

export function parseReleaseVersionArgs(argv: string[]): ReleaseVersionArgs {
  let android = false;
  let help = false;
  let mode: ReleaseVersionMode = "check";
  let rootDir = path.resolve(".");
  let version: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--": {
        break;
      }
      case "--android": {
        android = true;
        break;
      }
      case "--check": {
        mode = "check";
        break;
      }
      case "--root": {
        rootDir = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      }
      case "--version": {
        version = readOptionValue(argv, index, arg);
        index += 1;
        break;
      }
      case "--write": {
        mode = "write";
        break;
      }
      case "-h":
      case "--help": {
        help = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return { android, help, mode, rootDir, version };
}

export function planReleaseVersion(params: {
  android?: boolean;
  rootDir?: string;
  version: string;
}): ReleaseVersionPlan {
  const rootDir = path.resolve(params.rootDir ?? ".");
  const parsedVersion = parseReleaseVersion(params.version);
  if (!parsedVersion) {
    throw new Error(
      `Invalid release version '${params.version}'. Expected YYYY.M.PATCH, YYYY.M.PATCH-alpha.N, YYYY.M.PATCH-beta.N, or YYYY.M.PATCH-N.`,
    );
  }

  const packageVersion =
    parsedVersion.correctionNumber === undefined
      ? parsedVersion.version
      : parsedVersion.baseVersion;
  const changes = [
    planPackageJson(rootDir, packageVersion),
    planMacosInfoPlist(rootDir, parsedVersion),
  ];
  if (params.android) {
    changes.push(...planAndroidVersion(rootDir, parsedVersion.baseVersion));
  }

  return {
    changes: changes.filter((change) => change.currentContent !== change.nextContent),
    version: parsedVersion.version,
  };
}

export function applyReleaseVersionPlan(plan: ReleaseVersionPlan): void {
  const tempPaths: string[] = [];
  try {
    for (const [index, change] of plan.changes.entries()) {
      const tempPath = `${change.path}.release-version-${process.pid}-${index}.tmp`;
      fs.writeFileSync(tempPath, change.nextContent, "utf8");
      tempPaths.push(tempPath);
    }
    for (const [index, change] of plan.changes.entries()) {
      fs.renameSync(
        expectDefined(tempPaths[index], `release temp path at index ${index}`),
        change.path,
      );
    }
  } finally {
    for (const tempPath of tempPaths) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseReleaseVersionArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  if (!args.version) {
    throw new Error("Missing required --version.");
  }

  const plan = planReleaseVersion({
    android: args.android,
    rootDir: args.rootDir,
    version: args.version,
  });
  if (plan.changes.length === 0) {
    process.stdout.write(`Release version ${plan.version} is already aligned.\n`);
    return 0;
  }

  const relativePaths = plan.changes.map((change) => path.relative(args.rootDir, change.path));
  if (args.mode === "check") {
    process.stderr.write(
      `Release version ${plan.version} requires updates:\n- ${relativePaths.join("\n- ")}\n`,
    );
    return 1;
  }

  applyReleaseVersionPlan(plan);
  process.stdout.write(
    `Updated release version ${plan.version}:\n- ${relativePaths.join("\n- ")}\n`,
  );
  return 0;
}

function planPackageJson(rootDir: string, version: string): ReleaseVersionChange {
  const filePath = path.join(rootDir, "package.json");
  const currentContent = fs.readFileSync(filePath, "utf8");
  const packageJson = JSON.parse(currentContent) as Record<string, unknown>;
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error(`Missing package.json version in ${filePath}.`);
  }
  packageJson.version = version;
  return {
    currentContent,
    nextContent: `${JSON.stringify(packageJson, null, 2)}\n`,
    path: filePath,
  };
}

function planMacosInfoPlist(
  rootDir: string,
  releaseVersion: NonNullable<ReturnType<typeof parseReleaseVersion>>,
): ReleaseVersionChange {
  const filePath = path.join(rootDir, MACOS_INFO_PLIST);
  const currentContent = fs.readFileSync(filePath, "utf8");
  const buildVersion = [
    String(releaseVersion.year),
    String(releaseVersion.month).padStart(2, "0"),
    String(releaseVersion.patch).padStart(2, "0"),
    "00",
  ].join("");
  const shortVersionContent = replacePlistString(
    currentContent,
    "CFBundleShortVersionString",
    releaseVersion.baseVersion,
    MACOS_INFO_PLIST,
  );
  const nextContent = replacePlistString(
    shortVersionContent,
    "CFBundleVersion",
    buildVersion,
    MACOS_INFO_PLIST,
  );
  return { currentContent, nextContent, path: filePath };
}

function planAndroidVersion(rootDir: string, baseVersion: string): ReleaseVersionChange[] {
  const versionPath = path.join(rootDir, ANDROID_VERSION_FILE);
  const propertiesPath = path.join(rootDir, ANDROID_VERSION_PROPERTIES_FILE);
  const changelogPath = path.join(rootDir, ANDROID_CHANGELOG_FILE);
  const releaseNotesPath = path.join(rootDir, ANDROID_RELEASE_NOTES_FILE);
  const versionContent = fs.readFileSync(versionPath, "utf8");
  const propertiesContent = fs.readFileSync(propertiesPath, "utf8");
  const changelogContent = fs.readFileSync(changelogPath, "utf8");
  const releaseNotesContent = fs.readFileSync(releaseNotesPath, "utf8");
  const manifest = JSON.parse(versionContent) as AndroidVersionManifest;
  const currentVersion =
    typeof manifest.version === "string" ? normalizePinnedAndroidVersion(manifest.version) : null;
  const currentVersionCode =
    typeof manifest.versionCode === "number" ? manifest.versionCode : Number.NaN;
  const versionCode =
    currentVersion === baseVersion
      ? normalizeAndroidVersionCode(currentVersionCode, baseVersion)
      : canonicalAndroidVersionCode(baseVersion);
  const nextVersionContent = `${JSON.stringify({ version: baseVersion, versionCode }, null, 2)}\n`;
  const nextPropertiesContent = renderAndroidVersionProperties({
    canonicalVersion: baseVersion,
    versionCode,
  });
  const nextReleaseNotesContent = renderAndroidReleaseNotes(
    { canonicalVersion: baseVersion },
    changelogContent,
  );

  return [
    {
      currentContent: versionContent,
      nextContent: nextVersionContent,
      path: versionPath,
    },
    {
      currentContent: propertiesContent,
      nextContent: nextPropertiesContent,
      path: propertiesPath,
    },
    {
      currentContent: releaseNotesContent,
      nextContent: nextReleaseNotesContent,
      path: releaseNotesPath,
    },
  ];
}

function replacePlistString(content: string, key: string, value: string, filePath: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(<key>\\s*${escapedKey}\\s*</key>\\s*<string>)([^<]*)(</string>)`,
    "gu",
  );
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${filePath} must contain exactly one string value for ${key}.`);
  }
  return content.replace(pattern, `$1${value}$3`);
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: node --import tsx scripts/release-version.ts --version <version> [--check|--write] [--android] [--root dir]",
      "",
      "  --check    report release version drift without writing (default)",
      "  --write    update all selected version files after validating them",
      "  --android  also align the independently pinned Android release train",
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
