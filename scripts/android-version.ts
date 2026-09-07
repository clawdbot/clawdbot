// Android Version script supports OpenClaw repository automation.
import { resolveAndroidVersion } from "./lib/android-version.ts";
import { parseVersionQueryArgs } from "./lib/version-script-args.ts";

function printUsage(): void {
  process.stdout.write(
    "Usage: node --import tsx scripts/android-version.ts [--json|--shell] [--field name] [--root dir]\n\n",
  );
}

function main(argv = process.argv.slice(2)): number {
  const options = parseVersionQueryArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }

  const version = resolveAndroidVersion(options.rootDir);

  if (options.field) {
    const value = version[options.field as keyof typeof version];
    if (value === undefined) {
      throw new Error(`Unknown Android version field '${options.field}'.`);
    }
    process.stdout.write(`${value}\n`);
    return 0;
  }

  if (options.format === "shell") {
    process.stdout.write(
      [
        `OPENCLAW_ANDROID_VERSION_NAME=${version.canonicalVersion}`,
        `OPENCLAW_ANDROID_VERSION_CODE=${version.versionCode}`,
      ].join("\n") + "\n",
    );
  } else {
    process.stdout.write(`${JSON.stringify(version, null, 2)}\n`);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
