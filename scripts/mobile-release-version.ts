import fs from "node:fs";
import path from "node:path";
import {
  canonicalAndroidVersionCode,
  renderAndroidReleaseNotes,
  renderAndroidVersionManifest,
  renderAndroidVersionProperties,
  resolveAndroidVersion,
} from "./lib/android-version.ts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { cutIosReleaseChangelog, type IosReleasePlan } from "./lib/ios-release-plan.ts";
import { encodeIosAppStoreVersion, normalizeIosAppStoreRevision } from "./lib/ios-version.ts";
import {
  normalizeMobileVersion,
  readMobileVersionManifest,
  renderMobileVersionManifest,
} from "./lib/mobile-version.ts";
import { compareReleaseVersions } from "./lib/release-version.mjs";

export const MOBILE_RELEASE_PATHS = [
  "apps/mobile/version.json",
  "apps/android/version.json",
  "apps/android/Config/Version.properties",
  "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
  "apps/ios/CHANGELOG.md",
] as const;

type MobileReleaseMode = "check" | "write";
type MobileReleasePhase = "prepare" | "finalize";

type MobileReleaseArgs = {
  help: boolean;
  iosPlanPath: string | null;
  mode: MobileReleaseMode;
  phase: MobileReleasePhase | null;
  rootDir: string;
  version: string | null;
};

type MobileReleaseChange = {
  currentContent: string;
  nextContent: string;
  path: string;
};

export type MobileReleasePlan = {
  androidVersionCode: number;
  changes: MobileReleaseChange[];
  gatewayVersion: string;
  iosAppStoreVersion: string | null;
  iosBuildNumber: number | null;
  phase: MobileReleasePhase;
  releasePaths: readonly string[];
  wearVersionCode: number;
};

function wearVersionCode(phoneVersionCode: number): number {
  const buildNumber = phoneVersionCode % 100;
  if (buildNumber < 1 || buildNumber > 49) {
    throw new Error(
      `Android phone versionCode ${phoneVersionCode} must use build number 01 through 49; Wear reserves 51 through 99.`,
    );
  }
  const versionCode = phoneVersionCode + 50;
  if (versionCode > 2_100_000_000) {
    throw new Error(`Android Wear versionCode ${versionCode} exceeds the platform maximum.`);
  }
  return versionCode;
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parseMobileReleaseArgs(argv: string[]): MobileReleaseArgs {
  let help = false;
  let iosPlanPath: string | null = null;
  let mode: MobileReleaseMode = "check";
  let phase: MobileReleasePhase | null = null;
  let rootDir = path.resolve(".");
  let version: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--check":
        mode = "check";
        break;
      case "--finalize":
        if (phase) {
          throw new Error("Choose exactly one of --prepare or --finalize.");
        }
        phase = "finalize";
        break;
      case "--plan":
        iosPlanPath = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--prepare":
        if (phase) {
          throw new Error("Choose exactly one of --prepare or --finalize.");
        }
        phase = "prepare";
        break;
      case "--root":
        rootDir = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--version":
        version = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--write":
        mode = "write";
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!help && !phase) {
    throw new Error("Choose exactly one of --prepare or --finalize.");
  }
  if (!help && !version) {
    throw new Error("Missing required --version.");
  }
  if (phase === "finalize" && !iosPlanPath) {
    throw new Error("--finalize requires --plan <ios-release-plan.json>.");
  }
  if (phase === "prepare" && iosPlanPath) {
    throw new Error("--plan is valid only with --finalize.");
  }
  return { help, iosPlanPath, mode, phase, rootDir, version };
}

function compareVersions(left: string, right: string): number {
  const result = compareReleaseVersions(
    normalizeMobileVersion(left),
    normalizeMobileVersion(right),
  );
  if (result === null) {
    throw new Error(`Unable to compare mobile versions ${left} and ${right}.`);
  }
  return result;
}

function validateIosPlan(
  plan: IosReleasePlan,
  gatewayVersion: string,
): {
  appStoreVersion: string;
  buildNumber: number;
} {
  if (plan.gatewayVersion !== gatewayVersion) {
    throw new Error(
      `iOS release plan gateway ${plan.gatewayVersion} does not match mobile gateway ${gatewayVersion}.`,
    );
  }
  const revision = normalizeIosAppStoreRevision(plan.appStoreRevision);
  const appStoreVersion = encodeIosAppStoreVersion(gatewayVersion, revision);
  if (plan.appStoreVersion !== appStoreVersion) {
    throw new Error(
      `iOS release plan version ${plan.appStoreVersion} does not match encoded version ${appStoreVersion}.`,
    );
  }
  if (!Number.isSafeInteger(plan.buildNumber) || plan.buildNumber < 1) {
    throw new Error(
      `Invalid iOS release plan build '${plan.buildNumber}'. Expected a positive integer.`,
    );
  }
  return { appStoreVersion, buildNumber: plan.buildNumber };
}

function releaseChange(
  rootDir: string,
  relativePath: string,
  nextContent: string,
): MobileReleaseChange {
  const filePath = path.join(rootDir, relativePath);
  return {
    currentContent: fs.readFileSync(filePath, "utf8"),
    nextContent,
    path: filePath,
  };
}

function expectedPreparedChanges(params: {
  gatewayVersion: string;
  releaseNotes: string;
  rootDir: string;
}): {
  androidVersionCode: number;
  changes: MobileReleaseChange[];
} {
  // Google Play counts uploaded Unicode characters, including the generated newline.
  if (Array.from(params.releaseNotes).length > 500) {
    throw new Error(
      "Android release notes exceed Google Play's 500 Unicode character limit. Shorten the shared notes in apps/ios/CHANGELOG.md before preparing or finalizing the mobile release.",
    );
  }
  const currentMobileVersion = readMobileVersionManifest(params.rootDir).version;
  if (compareVersions(params.gatewayVersion, currentMobileVersion) < 0) {
    throw new Error(
      `Mobile gateway version cannot move backward from ${currentMobileVersion} to ${params.gatewayVersion}.`,
    );
  }

  const currentAndroid = resolveAndroidVersion(params.rootDir);
  if (compareVersions(params.gatewayVersion, currentAndroid.canonicalVersion) < 0) {
    throw new Error(
      `Android version cannot move backward from ${currentAndroid.canonicalVersion} to ${params.gatewayVersion}.`,
    );
  }
  const androidVersionCode =
    currentAndroid.canonicalVersion === params.gatewayVersion
      ? currentAndroid.versionCode
      : canonicalAndroidVersionCode(params.gatewayVersion);
  return {
    androidVersionCode,
    changes: [
      releaseChange(
        params.rootDir,
        MOBILE_RELEASE_PATHS[0],
        renderMobileVersionManifest(params.gatewayVersion),
      ),
      releaseChange(
        params.rootDir,
        MOBILE_RELEASE_PATHS[1],
        renderAndroidVersionManifest(params.gatewayVersion, androidVersionCode),
      ),
      releaseChange(
        params.rootDir,
        MOBILE_RELEASE_PATHS[2],
        renderAndroidVersionProperties({
          canonicalVersion: params.gatewayVersion,
          versionCode: androidVersionCode,
        }),
      ),
      releaseChange(params.rootDir, MOBILE_RELEASE_PATHS[3], params.releaseNotes),
    ],
  };
}

export function planMobileRelease(params: {
  gatewayVersion: string;
  iosPlan?: IosReleasePlan | null;
  phase: MobileReleasePhase;
  rootDir?: string;
}): MobileReleasePlan {
  const rootDir = path.resolve(params.rootDir ?? ".");
  const gatewayVersion = normalizeMobileVersion(params.gatewayVersion);
  const iosChangelogPath = path.join(rootDir, MOBILE_RELEASE_PATHS[4]);
  const iosChangelog = fs.readFileSync(iosChangelogPath, "utf8");
  let prepared: ReturnType<typeof expectedPreparedChanges>;
  let iosAppStoreVersion: string | null = null;
  let iosBuildNumber: number | null = null;

  if (params.phase === "prepare") {
    const releaseNotes = renderAndroidReleaseNotes(
      { canonicalVersion: gatewayVersion },
      iosChangelog,
      {
        candidateHeadings: ["Unreleased"],
        sourcePath: "apps/ios/CHANGELOG.md",
      },
    );
    prepared = expectedPreparedChanges({ gatewayVersion, releaseNotes, rootDir });
  } else {
    if (!params.iosPlan) {
      throw new Error("Finalize requires an iOS release plan.");
    }
    const iosSelection = validateIosPlan(params.iosPlan, gatewayVersion);
    iosAppStoreVersion = iosSelection.appStoreVersion;
    iosBuildNumber = iosSelection.buildNumber;
    const nextIosChangelog = cutIosReleaseChangelog(iosChangelog, iosAppStoreVersion);
    const releaseNotes = renderAndroidReleaseNotes(
      { canonicalVersion: gatewayVersion },
      nextIosChangelog,
      {
        candidateHeadings: [iosAppStoreVersion],
        sourcePath: "apps/ios/CHANGELOG.md",
      },
    );
    prepared = expectedPreparedChanges({
      gatewayVersion,
      releaseNotes,
      rootDir,
    });
    const stalePreparedPaths = prepared.changes
      .slice(0, 3)
      .filter((change) => change.currentContent !== change.nextContent)
      .map((change) => path.relative(rootDir, change.path));
    if (stalePreparedPaths.length > 0) {
      throw new Error(
        `Mobile release prepare state is stale:\n- ${stalePreparedPaths.join("\n- ")}`,
      );
    }
    prepared.changes.push(releaseChange(rootDir, MOBILE_RELEASE_PATHS[4], nextIosChangelog));
  }

  return {
    androidVersionCode: prepared.androidVersionCode,
    changes: prepared.changes.filter((change) => change.currentContent !== change.nextContent),
    gatewayVersion,
    iosAppStoreVersion,
    iosBuildNumber,
    phase: params.phase,
    releasePaths: MOBILE_RELEASE_PATHS,
    wearVersionCode: wearVersionCode(prepared.androidVersionCode),
  };
}

export function applyMobileReleasePlan(plan: MobileReleasePlan): void {
  const tempPaths: string[] = [];
  try {
    for (const [index, change] of plan.changes.entries()) {
      const tempPath = `${change.path}.mobile-release-${process.pid}-${index}.tmp`;
      fs.writeFileSync(tempPath, change.nextContent, "utf8");
      tempPaths.push(tempPath);
    }
    for (const [index, change] of plan.changes.entries()) {
      const tempPath = tempPaths[index];
      if (!tempPath) {
        throw new Error(`Missing mobile release temp path at index ${index}.`);
      }
      fs.renameSync(tempPath, change.path);
    }
  } finally {
    for (const tempPath of tempPaths) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  node --import tsx scripts/mobile-release-version.ts --prepare --version YYYY.M.PATCH [--check|--write] [--root dir]",
      "  node --import tsx scripts/mobile-release-version.ts --finalize --version YYYY.M.PATCH --plan ios-plan.json [--check|--write] [--root dir]",
      "",
    ].join("\n"),
  );
}

function readIosPlan(planPath: string): IosReleasePlan {
  return JSON.parse(fs.readFileSync(planPath, "utf8")) as IosReleasePlan;
}

function main(argv = process.argv.slice(2)): number {
  const args = parseMobileReleaseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  const plan = planMobileRelease({
    gatewayVersion: args.version ?? "",
    iosPlan: args.iosPlanPath ? readIosPlan(args.iosPlanPath) : null,
    phase: args.phase ?? "prepare",
    rootDir: args.rootDir,
  });
  if (plan.changes.length === 0) {
    process.stdout.write(
      `Mobile release ${plan.gatewayVersion} ${plan.phase} state is already aligned.\n`,
    );
    return 0;
  }

  const relativePaths = plan.changes.map((change) => path.relative(args.rootDir, change.path));
  if (args.mode === "check") {
    process.stderr.write(
      `Mobile release ${plan.gatewayVersion} ${plan.phase} requires updates:\n- ${relativePaths.join("\n- ")}\n`,
    );
    return 1;
  }

  applyMobileReleasePlan(plan);
  process.stdout.write(
    [
      `Updated mobile release ${plan.gatewayVersion} ${plan.phase}:`,
      `- Android phone ${plan.androidVersionCode}`,
      `- Android Wear ${plan.wearVersionCode}`,
      ...(plan.iosAppStoreVersion
        ? [`- iOS ${plan.iosAppStoreVersion} build ${plan.iosBuildNumber}`]
        : []),
      `- ${relativePaths.join("\n- ")}`,
      "",
    ].join("\n"),
  );
  return 0;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
