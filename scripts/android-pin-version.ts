// Android Pin Version script supports OpenClaw repository automation.
import path from "node:path";
import {
  canonicalAndroidVersionCode,
  normalizeAndroidVersionCode,
  normalizePinnedAndroidVersion,
  resolveAndroidVersion,
  resolveGatewayVersionForAndroidRelease,
  syncAndroidVersioning,
  writeAndroidVersionManifest,
} from "./lib/android-version.ts";

type CliOptions = {
  explicitVersion: string | null;
  explicitVersionCode: number | null;
  fromGateway: boolean;
  rootDir: string;
  sync: boolean;
};

type PinAndroidVersionResult = {
  previousVersion: string | null;
  previousVersionCode: number | null;
  nextVersion: string;
  nextVersionCode: number;
  packageVersion: string | null;
  versionFilePath: string;
  syncedPaths: string[];
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/android-pin-version.ts (--from-gateway | --version <YYYY.M.PATCH>) [--version-code <int>] [--no-sync] [--root dir]",
    "",
    "Examples:",
    "  node --import tsx scripts/android-pin-version.ts --from-gateway",
    "  node --import tsx scripts/android-pin-version.ts --version 2026.6.5",
    "  node --import tsx scripts/android-pin-version.ts --version 2026.6.5 --version-code 2026060502",
  ].join("\n");
}

function parseExplicitVersionCode(raw: string): number {
  const text = raw.trim();
  if (!/^[1-9]\d*$/u.test(text)) {
    throw new Error(`Invalid value for --version-code: ${raw}. Expected a positive integer.`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid value for --version-code: ${raw}. Expected a safe integer.`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  let explicitVersion: string | null = null;
  let explicitVersionCode: number | null = null;
  let fromGateway = false;
  let rootDir = path.resolve(".");
  let sync = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--from-gateway": {
        fromGateway = true;
        break;
      }
      case "--version": {
        explicitVersion = readOptionValue(argv, index, "--version");
        index += 1;
        break;
      }
      case "--version-code": {
        const value = readOptionValue(argv, index, "--version-code");
        explicitVersionCode = parseExplicitVersionCode(value);
        index += 1;
        break;
      }
      case "--no-sync": {
        sync = false;
        break;
      }
      case "--root": {
        const value = readOptionValue(argv, index, "--root");
        rootDir = path.resolve(value);
        index += 1;
        break;
      }
      case "-h":
      case "--help": {
        console.log(`${usage()}\n`);
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  if (fromGateway === (explicitVersion !== null)) {
    throw new Error("Choose exactly one of --from-gateway or --version <YYYY.M.PATCH>.");
  }

  if (explicitVersion !== null && !explicitVersion.trim()) {
    throw new Error("Missing value for --version.");
  }

  return { explicitVersion, explicitVersionCode, fromGateway, rootDir, sync };
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

export function pinAndroidVersion(params: CliOptions): PinAndroidVersionResult {
  const rootDir = path.resolve(params.rootDir);
  let previousVersion: string | null;
  let previousVersionCode: number | null;
  try {
    const currentVersion = resolveAndroidVersion(rootDir);
    previousVersion = currentVersion.canonicalVersion;
    previousVersionCode = currentVersion.versionCode;
  } catch {
    previousVersion = null;
    previousVersionCode = null;
  }

  const gatewayVersion = params.fromGateway
    ? resolveGatewayVersionForAndroidRelease(rootDir)
    : null;
  const packageVersion = gatewayVersion?.packageVersion ?? null;
  const nextVersion =
    gatewayVersion?.pinnedAndroidVersion ??
    normalizePinnedAndroidVersion(params.explicitVersion ?? "");
  const nextVersionCode =
    params.explicitVersionCode === null
      ? (gatewayVersion?.versionCode ?? canonicalAndroidVersionCode(nextVersion))
      : normalizeAndroidVersionCode(params.explicitVersionCode, nextVersion);
  const versionFilePath = writeAndroidVersionManifest(nextVersion, nextVersionCode, rootDir);
  const syncedPaths = params.sync
    ? syncAndroidVersioning({ mode: "write", rootDir }).updatedPaths
    : [];

  return {
    previousVersion,
    previousVersionCode,
    nextVersion,
    nextVersionCode,
    packageVersion,
    versionFilePath,
    syncedPaths,
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    const result = pinAndroidVersion(options);
    const sourceText = result.packageVersion
      ? ` from gateway version ${result.packageVersion}`
      : "";
    process.stdout.write(
      `Pinned Android version to ${result.nextVersion} (${result.nextVersionCode})${sourceText}.\n`,
    );
    if (
      result.previousVersion &&
      (result.previousVersion !== result.nextVersion ||
        result.previousVersionCode !== result.nextVersionCode)
    ) {
      process.stdout.write(
        `Previous pinned Android version: ${result.previousVersion} (${result.previousVersionCode}).\n`,
      );
    }
    process.stdout.write(
      `Updated version manifest: ${path.relative(process.cwd(), result.versionFilePath)}\n`,
    );
    if (options.sync) {
      if (result.syncedPaths.length === 0) {
        process.stdout.write("Android versioning artifacts already up to date.\n");
      } else {
        process.stdout.write(
          `Updated Android versioning artifacts:\n- ${result.syncedPaths.map((filePath) => path.relative(process.cwd(), filePath)).join("\n- ")}\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await main(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
