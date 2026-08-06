#!/usr/bin/env node

// Reports plugin SDK export surface metadata.
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
function usage() {
  return `Usage: node scripts/plugin-sdk-surface-report.mjs [--check]

Reports plugin SDK export surface metadata.

Options:
  --check     Fail when SDK surface budgets are exceeded.
  -h, --help  Show this help.
`;
}

function parseArgs(argv) {
  const args = { check: false, help: false };
  for (const arg of argv) {
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown plugin SDK surface report option: ${arg}`);
  }
  return args;
}

let cliArgs;
try {
  cliArgs = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (cliArgs.help) {
  process.stdout.write(usage());
  process.exit(0);
}

const checkOnly = cliArgs.check;
const publicEntrypointSet = new Set(publicPluginSdkEntrypoints);
const localOnlyEntrypointSet = new Set(privateLocalOnlyPluginSdkEntrypoints);
const deprecatedPublicEntrypointSet = new Set(deprecatedPublicPluginSdkEntrypoints);
const deprecatedBarrelEntrypointSet = new Set(deprecatedBarrelPluginSdkEntrypoints);
const forbiddenPublicSubpaths = new Set(["test-utils"]);

function readBudgetEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return parsed;
}

function readEntrypointBudgetEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object of entrypoint integer budgets`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of entrypoint integer budgets`);
  }

  const overrides = {};
  for (const [entrypoint, value] of Object.entries(parsed)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name}.${entrypoint} must be a safe non-negative integer`);
    }
    overrides[entrypoint] = value;
  }
  return Object.freeze({ ...fallback, ...overrides });
}

const defaultPublicDeprecatedExportsByEntrypointBudget = Object.freeze({
  core: 2,
  health: 1,
  lmstudio: 1,
  "provider-setup": 1,
  "self-hosted-provider-setup": 14,
  routing: 1,
  runtime: 3,
  "runtime-logger": 3,
  "runtime-secret-resolution": 5,
  "setup-adapter-runtime": 1,
  "channel-streaming": 47,
  "approval-reply-runtime": 1,
  "config-runtime": 123,
  "config-contracts": 1,
  "config-types": 416,
  "config-schema": 3,
  "reply-dedupe": 1,
  "inbound-reply-dispatch": 33,
  "channel-reply-pipeline": 12,
  "channel-reply-options-runtime": 2,
  "channel-runtime": 144,
  "interactive-runtime": 13,
  "outbound-send-deps": 4,
  "outbound-runtime": 16,
  "file-access-runtime": 2,
  "infra-runtime": 584,
  "ssrf-policy": 1,
  "ssrf-runtime": 1,
  "media-runtime": 2,
  "text-runtime": 189,
  "agent-runtime": 7,
  "plugin-runtime": 13,
  "channel-secret-runtime": 23,
  "secret-file-runtime": 1,
  "security-runtime": 7,
  "agent-harness": 7,
  "agent-harness-runtime": 7,
  types: 6,
  "agent-config-primitives": 2,
  "command-auth": 81,
  compat: 152,
  "direct-dm": 9,
  "direct-dm-access": 5,
  discord: 48,
  mattermost: 7,
  matrix: 1,
  "channel-config-schema-legacy": 22,
  "channel-actions": 2,
  "channel-envelope": 3,
  "channel-inbound": 21,
  "channel-inbound-roots": 1,
  "channel-logging": 4,
  "channel-location": 4,
  "channel-mention-gating": 7,
  "channel-lifecycle": 23,
  "channel-ingress": 8,
  "channel-message": 229,
  "channel-message-runtime": 226,
  "channel-pairing-paths": 1,
  "channel-policy": 8,
  "channel-route": 5,
  "session-store-runtime": 1,
  "session-transcript-runtime": 1,
  "group-access": 13,
  "media-generation-runtime-shared": 3,
  "music-generation-core": 20,
  "reply-history": 8,
  "messaging-targets": 12,
  "memory-core": 45,
  "memory-core-engine-runtime": 15,
  "memory-core-host-multimodal": 3,
  "memory-core-host-query": 2,
  "memory-core-host-events": 11,
  "memory-core-host-status": 1,
  "memory-core-host-runtime-core": 1,
  "memory-host-core": 1,
  "memory-host-files": 7,
  "memory-host-status": 72,
  "provider-auth": 20,
  "provider-oauth-runtime": 2,
  "provider-auth-login": 3,
  "provider-model-shared": 29,
  "provider-stream-family": 40,
  "provider-stream-shared": 29,
  "provider-stream": 40,
  "provider-web-search": 1,
  "provider-zai-endpoint": 3,
  "telegram-account": 3,
  "telegram-command-config": 7,
  "webhook-ingress": 2,
  "webhook-path": 2,
  zalouser: 5,
  zod: 282,
});

let budgets;
let publicDeprecatedExportsByEntrypointBudget;
try {
  budgets = {
    publicEntrypoints: readBudgetEnv("OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS", 322),
    // +2: image response-cap helper through its focused entrypoint and SDK index.
    publicExports: readBudgetEnv("OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS", 10383),
    publicFunctionExports: readBudgetEnv("OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS", 5209),
    publicDeprecatedExports: readBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS",
      3249,
    ),
    publicWildcardReexports: readBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_WILDCARD_REEXPORTS",
      215,
    ),
  };
  publicDeprecatedExportsByEntrypointBudget = readEntrypointBudgetEnv(
    "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT",
    defaultPublicDeprecatedExportsByEntrypointBudget,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

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

const generatedLlmCoreValidatorExports = new Set(["validateToolArguments", "validateToolCall"]);

function isGeneratedLlmCoreValidatorDeclaration(exportName, declaration) {
  if (!generatedLlmCoreValidatorExports.has(exportName)) {
    return false;
  }
  const relative = path.relative(repoRoot, declaration.getSourceFile().fileName);
  const relativePath = relative.split(path.sep).join(path.posix.sep);
  // Build artifacts can make agent-core's package-name validator reexports look
  // newly callable. Keep this source report independent of generated dist state.
  return relativePath.includes("llm-core/dist/validation.d.");
}

function isCallableExport(checker, symbol, sourceFile) {
  const target = unwrapAlias(checker, symbol);
  const declaration = target.valueDeclaration ?? target.declarations?.[0] ?? sourceFile;
  if (isGeneratedLlmCoreValidatorDeclaration(symbol.getName(), declaration)) {
    return false;
  }
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

function collectDeprecatedEntrypointBudgetFailures(byEntrypoint) {
  const failures = [];
  for (const [entrypoint, stats] of byEntrypoint) {
    const budget = publicDeprecatedExportsByEntrypointBudget[entrypoint] ?? 0;
    if (stats.deprecatedExports > budget) {
      failures.push(
        `public deprecated exports in ${entrypoint} ${stats.deprecatedExports} > ${budget}`,
      );
    }
  }
  return failures;
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
failures.push(...collectDeprecatedEntrypointBudgetFailures(publicStats.byEntrypoint));
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
