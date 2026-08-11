// Prepares the trusted harness manifest for npm Telegram live E2E scenarios.
import fs from "node:fs";
import { privateLocalOnlyPluginSdkEntrypoints } from "../../../lib/plugin-sdk-entries.mts";

function isPackageJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const packageJsonPaths = process.argv.slice(2);
if (packageJsonPaths.length !== 1) {
  throw new Error("expected exactly one trusted harness package.json path");
}

const packageJsonPath = packageJsonPaths[0];
if (!packageJsonPath) {
  throw new Error("trusted harness package.json path is missing");
}
const parsedPackageJson: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (!isPackageJsonRecord(parsedPackageJson)) {
  throw new Error("trusted harness package.json must be an object");
}
const packageExports = isPackageJsonRecord(parsedPackageJson.exports)
  ? parsedPackageJson.exports
  : {};
parsedPackageJson.exports = packageExports;

// Private QA builds emit these two harness-only facades outside the regular SDK inventory.
for (const subpath of [...privateLocalOnlyPluginSdkEntrypoints, "qa-lab", "qa-runtime"]) {
  const exportPath = `./plugin-sdk/${subpath}`;
  if (!packageExports[exportPath]) {
    packageExports[exportPath] = {
      default: `./dist/plugin-sdk/${subpath}.js`,
    };
  }
}

fs.writeFileSync(packageJsonPath, `${JSON.stringify(parsedPackageJson, null, 2)}\n`);
