// iOS release plan CLI resolves pure App Store state supplied by the Fastlane adapter.
import { readFileSync } from "node:fs";
import { resolveIosReleasePlan, type IosReleasePlanInput } from "./lib/ios-release-plan.ts";

const inputIndex = process.argv.indexOf("--input");
const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
if (!inputPath) {
  console.error("Usage: node --import tsx scripts/ios-release-plan.ts --input <json-file>");
  process.exit(1);
}

try {
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as IosReleasePlanInput;
  process.stdout.write(`${JSON.stringify(resolveIosReleasePlan(input), null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
