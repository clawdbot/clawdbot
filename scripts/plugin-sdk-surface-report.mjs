#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  deprecatedBarrelPluginSdkEntrypoints,
  deprecatedPublicPluginSdkEntrypoints,
  pluginSdkEntrypoints,
  privateLocalOnlyPluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const publicEntrypointSet = new Set(publicPluginSdkEntrypoints);
const localOnlyEntrypointSet = new Set(privateLocalOnlyPluginSdkEntrypoints);
const deprecatedPublicEntrypointSet = new Set(deprecatedPublicPluginSdkEntrypoints);
const deprecatedBarrelEntrypointSet = new Set(deprecatedBarrelPluginSdkEntrypoints);
const forbiddenPublicSubpaths = new Set(["test-utils"]);

const budgets = {
  publicEntrypoints: Number(process.env.OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS ?? 303),
  publicExports: Number(process.env.OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS ?? 8449),
  publicFunctionExports: Number(
    process.env.OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS ?? 4656,
  ),
  publicDeprecatedExports: Number(
    process.env.OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS ?? 2800,
  ),
  publicWildcardReexports: Number(
    process.env.OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_WILDCARD_REEXPORTS ?? 207,
  ),
};

function entrypointPath(entrypoint) {
  return path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`);
}

function readPackageExportedSubpaths() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return Object.keys(packageJson.exports ?? {})
    .filter((key) => key.startsWith("./plugin-sdk/"))
    .map((key) => key.slice("./plugin-sdk/".length))
    .toSorted();
}

function unwrapAlias(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function hasDeprecatedTag(symbol) {
  return symbol.getJsDocTags().some((tag) => tag.name === "deprecated");
}

function isCallableExport(checker, symbol, sourceFile) {
  const target = unwrapAlias(checker, symbol);
  const declaration = target.valueDeclaration ?? target.declarations?.[0] ?? sourceFile;
  const type = checker.getTypeOfSymbolAtLocation(target, declaration);
  return checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0;
}

function countWildcardReexports(entrypoints) {
  let count = 0;
  const matches = [];
  for (const entrypoint of entrypoints) {
    const sourcePath = entrypointPath(entrypoint);
    const source = fs.readFileSync(sourcePath, "utf8");
    const lines = source.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (/^\s*export\s+(?:type\s+)?\*\s+from\s+["'][^"']+["']/u.test(line)) {
        count += 1;
        matches.push(`${path.relative(repoRoot, sourcePath)}:${index + 1}`);
      }
    }
  }
  return { count, matches };
}

function collectExportStats(entrypoints) {
  const files = entrypoints.map(entrypointPath);
  const program = ts.createProgram(files, {
    allowJs: false,
    declaration: true,
    emitDeclarationOnly: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    types: [],
  });
  const checker = program.getTypeChecker();
  const byEntrypoint = new Map();
  const uniqueNames = new Set();
  const uniqueCallableNames = new Set();

  for (const entrypoint of entrypoints) {
    const sourceFile = program.getSourceFile(entrypointPath(entrypoint));
    if (!sourceFile) {
      byEntrypoint.set(entrypoint, {
        exports: 0,
        callableExports: 0,
        deprecatedExports: 0,
        deprecatedCallableExports: 0,
      });
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    const symbols = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    let callableExports = 0;
    let deprecatedExports = 0;
    let deprecatedCallableExports = 0;
    const deprecatedEntrypoint = deprecatedPublicEntrypointSet.has(entrypoint);
    for (const symbol of symbols) {
      const exportName = `${entrypoint}:${symbol.getName()}`;
      uniqueNames.add(exportName);
      const callable = isCallableExport(checker, symbol, sourceFile);
      const deprecated =
        deprecatedEntrypoint ||
        hasDeprecatedTag(symbol) ||
        hasDeprecatedTag(unwrapAlias(checker, symbol));
      if (callable) {
        callableExports += 1;
        uniqueCallableNames.add(exportName);
      }
      if (deprecated) {
        deprecatedExports += 1;
        if (callable) {
          deprecatedCallableExports += 1;
        }
      }
    }
    byEntrypoint.set(entrypoint, {
      exports: symbols.length,
      callableExports,
      deprecatedExports,
      deprecatedCallableExports,
    });
  }

  const totals = {
    entrypoints: entrypoints.length,
    exports: 0,
    callableExports: 0,
    deprecatedExports: 0,
    deprecatedCallableExports: 0,
    uniqueExports: uniqueNames.size,
    uniqueCallableExports: uniqueCallableNames.size,
  };
  for (const stats of byEntrypoint.values()) {
    totals.exports += stats.exports;
    totals.callableExports += stats.callableExports;
    totals.deprecatedExports += stats.deprecatedExports;
    totals.deprecatedCallableExports += stats.deprecatedCallableExports;
  }
  return { byEntrypoint, totals };
}

function formatStats(label, stats) {
  return [
    `${label}:`,
    `  entrypoints: ${stats.entrypoints}`,
    `  exports: ${stats.exports}`,
    `  callable exports: ${stats.callableExports}`,
    `  deprecated exports: ${stats.deprecatedExports}`,
    `  deprecated callable exports: ${stats.deprecatedCallableExports}`,
    `  unique entrypoint-qualified exports: ${stats.uniqueExports}`,
  ].join("\n");
}

const allStats = collectExportStats(pluginSdkEntrypoints);
const publicStats = collectExportStats(publicPluginSdkEntrypoints);
const localOnlyStats = collectExportStats(privateLocalOnlyPluginSdkEntrypoints);
const publicWildcards = countWildcardReexports(publicPluginSdkEntrypoints);
const packageExportedSubpaths = readPackageExportedSubpaths();
const leakedForbiddenExports = packageExportedSubpaths.filter((subpath) =>
  forbiddenPublicSubpaths.has(subpath),
);
const localOnlyStillPublic = privateLocalOnlyPluginSdkEntrypoints.filter((entrypoint) =>
  publicEntrypointSet.has(entrypoint),
);
const localOnlyMissingFromInventory = [...localOnlyEntrypointSet].filter(
  (entrypoint) => !pluginSdkEntrypoints.includes(entrypoint),
);
const deprecatedMissingFromPublic = [...deprecatedPublicEntrypointSet].filter(
  (entrypoint) => !publicEntrypointSet.has(entrypoint),
);
const deprecatedBarrelMissingFromInventory = [...deprecatedBarrelEntrypointSet].filter(
  (entrypoint) => !pluginSdkEntrypoints.includes(entrypoint),
);
const deprecatedBarrelWithoutWildcard = [...deprecatedBarrelEntrypointSet].filter((entrypoint) => {
  const source = fs.readFileSync(entrypointPath(entrypoint), "utf8");
  return !/^\s*export\s+(?:type\s+)?\*\s+from\s+["'][^"']+["']/mu.test(source);
});

console.log(formatStats("all SDK entrypoints", allStats.totals));
console.log(formatStats("public package SDK entrypoints", publicStats.totals));
console.log(formatStats("local-only SDK entrypoints", localOnlyStats.totals));
console.log(`deprecated public subpaths: ${deprecatedPublicPluginSdkEntrypoints.length}`);
console.log(`deprecated barrel subpaths: ${deprecatedBarrelPluginSdkEntrypoints.length}`);
console.log(`public wildcard reexports: ${publicWildcards.count}`);
console.log(`package-exported forbidden subpaths: ${leakedForbiddenExports.length}`);

const failures = [];
if (publicPluginSdkEntrypoints.length > budgets.publicEntrypoints) {
  failures.push(
    `public entrypoints ${publicPluginSdkEntrypoints.length} > ${budgets.publicEntrypoints}`,
  );
}
if (publicStats.totals.exports > budgets.publicExports) {
  failures.push(`public exports ${publicStats.totals.exports} > ${budgets.publicExports}`);
}
if (publicStats.totals.callableExports > budgets.publicFunctionExports) {
  failures.push(
    `public callable exports ${publicStats.totals.callableExports} > ${budgets.publicFunctionExports}`,
  );
}
if (publicStats.totals.deprecatedExports > budgets.publicDeprecatedExports) {
  failures.push(
    `public deprecated exports ${publicStats.totals.deprecatedExports} > ${budgets.publicDeprecatedExports}`,
  );
}
if (publicWildcards.count > budgets.publicWildcardReexports) {
  failures.push(
    `public wildcard reexports ${publicWildcards.count} > ${budgets.publicWildcardReexports}`,
  );
}
if (leakedForbiddenExports.length > 0) {
  failures.push(`forbidden public subpaths: ${leakedForbiddenExports.join(", ")}`);
}
if (localOnlyStillPublic.length > 0) {
  failures.push(`local-only entrypoints still public: ${localOnlyStillPublic.join(", ")}`);
}
if (localOnlyMissingFromInventory.length > 0) {
  failures.push(
    `local-only entrypoints missing from inventory: ${localOnlyMissingFromInventory.join(", ")}`,
  );
}
if (deprecatedMissingFromPublic.length > 0) {
  failures.push(
    `deprecated public entrypoints missing from package surface: ${deprecatedMissingFromPublic.join(", ")}`,
  );
}
if (deprecatedBarrelMissingFromInventory.length > 0) {
  failures.push(
    `deprecated barrel entrypoints missing from inventory: ${deprecatedBarrelMissingFromInventory.join(", ")}`,
  );
}
if (deprecatedBarrelWithoutWildcard.length > 0) {
  failures.push(
    `deprecated barrel entrypoints without wildcard exports: ${deprecatedBarrelWithoutWildcard.join(", ")}`,
  );
}

if (checkOnly && failures.length > 0) {
  console.error("plugin SDK surface budget failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
