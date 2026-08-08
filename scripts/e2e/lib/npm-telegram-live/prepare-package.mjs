// Prepares the trusted harness manifest for npm Telegram live E2E scenarios.
import fs from "node:fs";
import { privateLocalOnlyPluginSdkEntrypoints } from "../../../lib/plugin-sdk-entries.mjs";

const packageJsonPaths = process.argv.slice(2);
if (packageJsonPaths.length !== 1) {
  throw new Error("expected exactly one trusted harness package.json path");
}

const packageJsonPath = packageJsonPaths[0];
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
pkg.exports = pkg.exports && typeof pkg.exports === "object" ? pkg.exports : {};

for (const subpath of privateLocalOnlyPluginSdkEntrypoints) {
  const exportPath = `./plugin-sdk/${subpath}`;
  if (!pkg.exports[exportPath]) {
    pkg.exports[exportPath] = {
      default: `./dist/plugin-sdk/${subpath}.js`,
    };
  }
}

fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
