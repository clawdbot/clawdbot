// Android Sync Versioning script supports OpenClaw repository automation.
import path from "node:path";
import { syncAndroidVersioning } from "./lib/android-version.ts";
import { parseVersionSyncArgs } from "./lib/version-script-args.ts";

export { parseVersionSyncArgs as parseArgs } from "./lib/version-script-args.ts";

function printUsage(): void {
  process.stdout.write(
    "Usage: node --import tsx scripts/android-sync-versioning.ts [--write|--check] [--root dir]\n",
  );
}

function main(argv = process.argv.slice(2)): number {
  const options = parseVersionSyncArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }

  const result = syncAndroidVersioning({ mode: options.mode, rootDir: options.rootDir });

  if (options.mode === "check") {
    process.stdout.write("Android versioning artifacts are up to date.\n");
  } else if (result.updatedPaths.length === 0) {
    process.stdout.write("Android versioning artifacts already up to date.\n");
  } else {
    process.stdout.write(
      `Updated Android versioning artifacts:\n- ${result.updatedPaths.map((filePath) => path.relative(process.cwd(), filePath)).join("\n- ")}\n`,
    );
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
