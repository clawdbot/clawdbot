// iOS release cutter promotes Unreleased notes into the planned App Store version.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cutIosReleaseChangelog, type IosReleasePlan } from "./lib/ios-release-plan.ts";

const planIndex = process.argv.indexOf("--plan");
const planPath = planIndex >= 0 ? process.argv[planIndex + 1] : undefined;
if (!planPath) {
  console.error("Usage: node --import tsx scripts/ios-release-cut.ts --plan <plan-json-file>");
  process.exit(1);
}

try {
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as IosReleasePlan;
  const changelogPath = path.resolve("apps/ios/CHANGELOG.md");
  const current = readFileSync(changelogPath, "utf8");
  const updated = cutIosReleaseChangelog(current, plan.appStoreVersion);
  if (updated !== current) {
    writeFileSync(changelogPath, updated);
    process.stdout.write(`Cut iOS App Store release notes for ${plan.appStoreVersion}.\n`);
  } else {
    process.stdout.write(
      `iOS App Store release notes for ${plan.appStoreVersion} are already cut.\n`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
