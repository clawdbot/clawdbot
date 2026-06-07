// Ios Pin Version script supports OpenClaw repository automation.
import path from "node:path";
import {
  normalizePinnedIosVersion,
  resolveGatewayVersionForIosRelease,
  resolveIosVersion,
  syncIosVersioning,
  writeIosVersionManifest,
} from "./lib/ios-version.ts";

type CliOptions = {
  explicitVersion: string | null;
  fromGateway: boolean;
  rootDir: string;
  sync: boolean;
};

export type PinIosVersionResult = {
  previousVersion: string | null;
  nextVersion: string;
  packageVersion: string | null;
  versionFilePath: string;
  syncedPaths: string[];
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/ios-pin-version.ts (--from-gateway | --version <YYYY.M.PATCH>) [--no-sync] [--root dir]",
    "",
    "Examples:",
    "  node --import tsx scripts/ios-pin-version.ts --from-gateway",
    "  node --import tsx scripts/ios-pin-version.ts --version 2026.4.10",
  ].join("\n");
}

export function parseArgs(argv: string[]): CliOptions {
  let explicitVersion: string | null = null;
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
        explicitVersion = argv[index + 1] ?? null;
        index += 1;
        break;
      }
      case "--no-sync": {
        sync = false;
        break;
      }
      case "--root": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --root.");
        }
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

  return { explicitVersion, fromGateway, rootDir, sync };
}

export function pinIosVersion(params: CliOptions): PinIosVersionResult {
  const rootDir = path.resolve(params.rootDir);
  let previousVersion: string | null;
  try {
    previousVersion = resolveIosVersion(rootDir).canonicalVersion;
  } catch {
    previousVersion = null;
  }

  const gatewayVersion = params.fromGateway ? resolveGatewayVersionForIosRelease(rootDir) : null;
  const packageVersion = gatewayVersion?.packageVersion ?? null;
  const nextVersion =
    gatewayVersion?.pinnedIosVersion ?? normalizePinnedIosVersion(params.explicitVersion ?? "");
  const versionFilePath = writeIosVersionManifest(nextVersion, rootDir);
  const syncedPaths = params.sync ? syncIosVersioning({ mode: "write", rootDir }).updatedPaths : [];

  return {
    previousVersion,
    nextVersion,
    packageVersion,
    versionFilePath,
    syncedPaths,
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    const result = pinIosVersion(options);
    const sourceText = result.packageVersion
      ? ` from gateway version ${result.packageVersion}`
      : "";
    process.stdout.write(`Pinned iOS version to ${result.nextVersion}${sourceText}.\n`);
    if (result.previousVersion && result.previousVersion !== result.nextVersion) {
      process.stdout.write(`Previous pinned iOS version: ${result.previousVersion}.\n`);
    }
    process.stdout.write(
      `Updated version manifest: ${path.relative(process.cwd(), result.versionFilePath)}\n`,
    );
    if (options.sync) {
      if (result.syncedPaths.length === 0) {
        process.stdout.write("iOS versioning artifacts already up to date.\n");
      } else {
        process.stdout.write(
          `Updated iOS versioning artifacts:\n- ${result.syncedPaths.map((filePath) => path.relative(process.cwd(), filePath)).join("\n- ")}\n`,
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
