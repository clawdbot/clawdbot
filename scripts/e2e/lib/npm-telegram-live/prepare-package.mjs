// Prepares package manifests for npm Telegram live E2E scenarios.
import fs from "node:fs";

const packageJsonPaths = process.argv.slice(2);
if (packageJsonPaths.length !== 2) {
  throw new Error(
    `expected exactly two ephemeral package manifests, got ${packageJsonPaths.length}`,
  );
}

for (const packageJsonPath of packageJsonPaths) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  pkg.exports = pkg.exports && typeof pkg.exports === "object" ? pkg.exports : {};
  if (!pkg.exports["./plugin-sdk/gateway-runtime"]) {
    pkg.exports["./plugin-sdk/gateway-runtime"] = {
      types: "./dist/plugin-sdk/gateway-runtime.d.ts",
      default: "./dist/plugin-sdk/gateway-runtime.js",
    };
  }
  if (!pkg.exports["./plugin-sdk/qa-runtime"]) {
    pkg.exports["./plugin-sdk/qa-runtime"] = {
      default: "./.openclaw-qa-harness-dist/plugin-sdk/qa-runtime.js",
    };
  }
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
