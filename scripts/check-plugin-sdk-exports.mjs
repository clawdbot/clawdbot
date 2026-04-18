#!/usr/bin/env node

/**
 * Verifies that the root plugin-sdk runtime surface is present in the compiled
 * dist output.
 *
 * Run after `pnpm build` to catch missing root exports or leaked repo-only type
 * aliases before release.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pluginSdkSubpaths } from "./lib/plugin-sdk-entries.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distFile = resolve(__dirname, "..", "dist", "plugin-sdk", "index.js");
if (!existsSync(distFile)) {
  console.error("ERROR: dist/plugin-sdk/index.js not found. Run `pnpm build` first.");
  process.exit(1);
}

const content = readFileSync(distFile, "utf-8");

// Extract the final export statement from the compiled output.
// tsdown/rolldown emits a single `export { ... }` at the end of the file.
const exportMatch = content.match(/export\s*\{([^}]+)\}\s*;?\s*$/);
if (!exportMatch) {
  console.error("ERROR: Could not find export statement in dist/plugin-sdk/index.js");
  process.exit(1);
}

const exportedNames = exportMatch[1]
  .split(",")
  .map((s) => {
    // Handle `foo as bar` aliases — the exported name is the `bar` part
    const parts = s.trim().split(/\s+as\s+/);
    return (parts[parts.length - 1] || "").trim();
  })
  .filter(Boolean);

const exportSet = new Set(exportedNames);

const requiredRuntimeShimEntries = ["compat.js", "root-alias.cjs"];
const requiredSubpathExports = {
  "secret-input-runtime": [
    "coerceSecretRef",
    "hasConfiguredSecretInput",
    "isSecretRef",
    "normalizeResolvedSecretInputString",
    "normalizeSecretInputString",
    "resolveSecretInputString",
  ],
};

// The root plugin-sdk entry intentionally stays tiny. Keep this list aligned
// with src/plugin-sdk/index.ts runtime exports.
const requiredExports = [
  "emptyPluginConfigSchema",
  "onDiagnosticEvent",
  "registerContextEngine",
  "delegateCompactionToRuntime",
];

let missing = 0;
for (const name of requiredExports) {
  if (!exportSet.has(name)) {
    console.error(`MISSING EXPORT: ${name}`);
    missing += 1;
  }
}

for (const entry of pluginSdkSubpaths) {
  const jsPath = resolve(__dirname, "..", "dist", "plugin-sdk", `${entry}.js`);
  const dtsPath = resolve(__dirname, "..", "dist", "plugin-sdk", `${entry}.d.ts`);
  if (!existsSync(jsPath)) {
    console.error(`MISSING SUBPATH JS: dist/plugin-sdk/${entry}.js`);
    missing += 1;
  }
  if (!existsSync(dtsPath)) {
    console.error(`MISSING SUBPATH DTS: dist/plugin-sdk/${entry}.d.ts`);
    missing += 1;
  }
}

for (const entry of requiredRuntimeShimEntries) {
  const shimPath = resolve(__dirname, "..", "dist", "plugin-sdk", entry);
  if (!existsSync(shimPath)) {
    console.error(`MISSING RUNTIME SHIM: dist/plugin-sdk/${entry}`);
    missing += 1;
  }
}

for (const [entry, names] of Object.entries(requiredSubpathExports)) {
  const jsPath = resolve(__dirname, "..", "dist", "plugin-sdk", `${entry}.js`);
  if (!existsSync(jsPath)) {
    continue;
  }
  let runtime;
  try {
    runtime = await import(pathToFileURL(jsPath).href);
  } catch (err) {
    console.error(`BROKEN SUBPATH JS: dist/plugin-sdk/${entry}.js`);
    console.error(err instanceof Error ? err.message : String(err));
    missing += 1;
    continue;
  }
  for (const name of names) {
    if (typeof runtime[name] !== "function") {
      console.error(`MISSING SUBPATH EXPORT: dist/plugin-sdk/${entry}.js#${name}`);
      missing += 1;
    }
  }
}

if (missing > 0) {
  console.error(
    `\nERROR: ${missing} required plugin-sdk artifact(s) missing (named exports or subpath files).`,
  );
  console.error("This will break published plugin-sdk artifacts.");
  console.error(
    "Check src/plugin-sdk/index.ts, generated d.ts rewrites, subpath entries, and rebuild.",
  );
  process.exit(1);
}

console.log(`OK: All ${requiredExports.length} required plugin-sdk exports verified.`);
