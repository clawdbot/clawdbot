// Android Sync Versioning script supports OpenClaw repository automation.
import { checkAndroidVersioning } from "./lib/android-version.ts";
import { parseVersionSyncArgs } from "./lib/version-script-args.ts";

export { parseVersionSyncArgs as parseArgs } from "./lib/version-script-args.ts";

function printUsage(): void {
  process.stdout.write(
    "Usage: node --import tsx scripts/android-sync-versioning.ts --check [--require-mobile-release] [--revision n] [--root dir]\n",
  );
}

function main(argv = process.argv.slice(2)): number {
  const requireMobileRelease = argv.includes("--require-mobile-release");
  const options = parseVersionSyncArgs(
    argv.filter((arg) => arg !== "--require-mobile-release"),
    { allowAppStoreRevision: true },
  );
  if (options.help) {
    printUsage();
    return 0;
  }

  if (options.mode !== "check") {
    throw new Error(
      "Android version sync is retired. Run the shared mobile cutter in scripts/mobile-release-version.ts.",
    );
  }
  checkAndroidVersioning({
    appStoreRevision: options.appStoreRevision ?? undefined,
    requireMobileRelease,
    rootDir: options.rootDir,
  });
  process.stdout.write("Android versioning artifacts match committed release metadata.\n");
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
