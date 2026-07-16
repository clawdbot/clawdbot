#!/usr/bin/env node

/**
 * Verifies that the root plugin-sdk runtime surface is present in the compiled
 * dist output.
 *
 * Run after `pnpm build` to catch missing root exports or leaked repo-only type
 * aliases before release.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
  MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
  PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
  evaluatePluginSdkDeclarationBudget,
  isPrivateQaPluginSdkBuild,
} from "./lib/plugin-sdk-declaration-budget.mjs";
import { publicPluginSdkEntrypoints, publicPluginSdkSubpaths } from "./lib/plugin-sdk-entries.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distFile = resolve(scriptDir, "..", "dist", "plugin-sdk", "index.js");
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
const forbiddenPublicDeclarationSpecifiers = ["@openclaw/llm-core"];
const FORBIDDEN_PUBLIC_PROTOCOL_REGISTRY_RE = /\bdeclare\s+const\s+ProtocolSchemas(?:\$\d+)?\b/u;
const RELATIVE_DECLARATION_SPECIFIER_RE = /\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/gu;
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

for (const entry of publicPluginSdkSubpaths) {
  const jsPath = resolve(scriptDir, "..", "dist", "plugin-sdk", `${entry}.js`);
  const dtsPath = resolve(scriptDir, "..", "dist", "plugin-sdk", `${entry}.d.ts`);
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
  const shimPath = resolve(scriptDir, "..", "dist", "plugin-sdk", entry);
  if (!existsSync(shimPath)) {
    console.error(`MISSING RUNTIME SHIM: dist/plugin-sdk/${entry}`);
    missing += 1;
  }
}

for (const [entry, names] of Object.entries(requiredSubpathExports)) {
  const jsPath = resolve(scriptDir, "..", "dist", "plugin-sdk", `${entry}.js`);
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

const distDir = resolve(scriptDir, "..", "dist");
const declarationPaths = new Set();
// Publication checks always start at public roots. Private QA entries are local-only,
// but their unified-build chunk topology can still change declarations reachable here.
const declarationQueue = publicPluginSdkEntrypoints.map((entry) =>
  resolve(distDir, "plugin-sdk", `${entry}.d.ts`),
);
while (declarationQueue.length > 0) {
  const dtsPath = declarationQueue.pop();
  if (!dtsPath || declarationPaths.has(dtsPath)) {
    continue;
  }
  if (!existsSync(dtsPath)) {
    console.error(`MISSING PUBLIC DTS DEPENDENCY: ${relative(resolve(scriptDir, ".."), dtsPath)}`);
    missing += 1;
    continue;
  }
  declarationPaths.add(dtsPath);
  const dtsContent = readFileSync(dtsPath, "utf8");
  if (FORBIDDEN_PUBLIC_PROTOCOL_REGISTRY_RE.test(dtsContent)) {
    console.error(
      `FORBIDDEN PUBLIC DTS REGISTRY: ${relative(resolve(scriptDir, ".."), dtsPath)} retains ProtocolSchemas`,
    );
    missing += 1;
  }
  for (const match of dtsContent.matchAll(RELATIVE_DECLARATION_SPECIFIER_RE)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) {
      continue;
    }
    const declarationSpecifier = specifier.endsWith(".js")
      ? `${specifier.slice(0, -3)}.d.ts`
      : `${specifier}.d.ts`;
    const importedPath = resolve(dirname(dtsPath), declarationSpecifier);
    if (importedPath.startsWith(`${distDir}${sep}`)) {
      declarationQueue.push(importedPath);
    }
  }
  for (const specifier of forbiddenPublicDeclarationSpecifiers) {
    if (dtsContent.includes(`"${specifier}`) || dtsContent.includes(`'${specifier}`)) {
      console.error(
        `FORBIDDEN PUBLIC DTS SPECIFIER: ${relative(resolve(scriptDir, ".."), dtsPath)} imports ${specifier}`,
      );
      missing += 1;
    }
  }
}

const declarationBytes = Array.from(declarationPaths).reduce(
  (total, dtsPath) => total + statSync(dtsPath).size,
  0,
);
const declarationBudget = evaluatePluginSdkDeclarationBudget({
  buildPrivateQa: isPrivateQaPluginSdkBuild(process.env),
  declarationBytes,
});
if (declarationBudget.shouldFail) {
  const budgetLabel =
    declarationBudget.budgetKind === "private-qa-public-entry"
      ? "PRIVATE QA PUBLIC-ENTRY PLUGIN SDK"
      : "PLUGIN SDK";
  console.error(
    `${budgetLabel} DTS TOO LARGE: ${declarationBytes} bytes exceeds ${declarationBudget.budgetBytes} bytes.`,
  );
  console.error(
    `Budget: ${declarationBudget.ratchetBytes}-byte ratchet + ${declarationBudget.varianceBytes}-byte Rolldown output variance.`,
  );
  console.error("Keep plugin SDK declarations in the canonical unified tsdown graph.");
  missing += 1;
} else if (declarationBudget.budgetKind === "private-qa-public-entry") {
  console.log(
    `Private QA build public-entry declaration graph: ${declarationBytes}/${declarationBudget.budgetBytes} bytes (${MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES}-byte ratchet + ${PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES}-byte output variance); publication ratchet ${MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES} bytes is not applied.`,
  );
} else {
  console.log(
    `Public plugin SDK declaration graph: ${declarationBytes}/${declarationBudget.budgetBytes} bytes (${MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES}-byte ratchet + ${PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES}-byte output variance).`,
  );
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
