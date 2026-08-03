// Ios Version script supports OpenClaw repository automation.
import { renderIosReleaseNotesForVersion, resolveIosVersion } from "./lib/ios-version.ts";
import { parseVersionQueryArgs } from "./lib/version-script-args.ts";

function printUsage(): void {
  process.stdout.write(
    "Usage: node --import tsx scripts/ios-version.ts [--json|--shell] [--field name] [--version YYYY.M.D] [--revision 0-9] [--root dir]\n\n",
  );
}

function main(argv = process.argv.slice(2)): number {
  const options = parseVersionQueryArgs(argv, { allowAppStoreRevision: true });
  if (options.help) {
    printUsage();
    return 0;
  }

  const version = resolveIosVersion(options.rootDir, {
    appStoreRevision: options.appStoreRevision,
    releaseVersion: options.releaseVersion,
  });

  if (options.field) {
    if (options.field === "releaseNotes") {
      process.stdout.write(
        renderIosReleaseNotesForVersion({
          appStoreRevision: options.appStoreRevision,
          releaseVersion: options.releaseVersion,
          rootDir: options.rootDir,
        }),
      );
      return 0;
    }

    const value = version[options.field as keyof typeof version];
    if (value === undefined) {
      throw new Error(`Unknown iOS version field '${options.field}'.`);
    }
    process.stdout.write(`${value}\n`);
    return 0;
  }

  if (options.format === "shell") {
    process.stdout.write(
      [
        `OPENCLAW_IOS_VERSION=${version.canonicalVersion}`,
        `OPENCLAW_APP_STORE_REVISION=${version.appStoreRevision ?? ""}`,
        `OPENCLAW_APP_STORE_VERSION=${version.appStoreVersion ?? ""}`,
        `OPENCLAW_MARKETING_VERSION=${version.marketingVersion}`,
        `OPENCLAW_BUILD_VERSION=${version.buildVersion}`,
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
