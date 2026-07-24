#!/usr/bin/env node

// Reports plugin SDK export surface metadata.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  deprecatedBarrelPluginSdkEntrypoints,
  deprecatedPublicPluginSdkEntrypoints,
  packagedPrivatePluginSdkRuntimeEntrypoints,
  pluginSdkEntrypoints,
  privateLocalOnlyPluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let ts;

function usage() {
  return `Usage: node scripts/plugin-sdk-surface-report.mjs [--check]

Reports plugin SDK export surface metadata.

Options:
  --check     Fail when SDK surface budgets are exceeded.
  -h, --help  Show this help.
`;
}

function parsePluginSdkSurfaceReportArgs(argv) {
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
const publicEntrypointSet = new Set(publicPluginSdkEntrypoints);
const localOnlyEntrypointSet = new Set(privateLocalOnlyPluginSdkEntrypoints);
const packagedPrivateRuntimeEntrypointSet = new Set(packagedPrivatePluginSdkRuntimeEntrypoints);
const deprecatedPublicEntrypointSet = new Set(deprecatedPublicPluginSdkEntrypoints);
const deprecatedBarrelEntrypointSet = new Set(deprecatedBarrelPluginSdkEntrypoints);
const forbiddenPublicSubpaths = new Set(["test-utils"]);

function readPluginSdkSurfaceBudgetEnv(name, fallback, env = process.env) {
  const raw = env[name];
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

function readPluginSdkEntrypointBudgetEnv(name, fallback, env = process.env) {
  const raw = env[name];
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
  routing: 1,
  health: 0,
  "channel-streaming": 54,
  "approval-gateway-runtime": 1,
  "approval-handler-runtime": 1,
  "approval-reply-runtime": 0,
  "config-runtime": 115,
  "config-contracts": 0,
  "inbound-reply-dispatch": 24,
  "channel-reply-pipeline": 12,
  "interactive-runtime": 11,
  // +3: canonical incognito classifier projected through deprecated compatibility barrels.
  "infra-runtime": 596,
  "ssrf-policy": 1,
  "ssrf-runtime": 1,
  "media-runtime": 2,
  "text-runtime": 191,
  "agent-runtime": 2,
  "channel-secret-runtime": 23,
  "agent-harness-runtime": 4,
  "agent-config-primitives": 2,
  "command-auth": 78,
  discord: 47,
  matrix: 1,
  "channel-inbound": 14,
  "channel-logging": 4,
  "channel-lifecycle": 23,
  "channel-message": 129,
  "channel-pairing": 0,
  "channel-policy": 7,
  "channel-send-result": 1,
  "session-store-runtime": 4,
  // +2: shipped Slack and Discord setup helpers retained through their package migration window.
  "setup-runtime": 2,
  "group-access": 13,
  "reply-history": 6,
  "messaging-targets": 12,
  "provider-auth": 19,
  "telegram-account": 3,
  zod: 282,
});

export function readPluginSdkSurfaceBudgets(env = process.env) {
  const budgets = {
    publicEntrypoints: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS",
      // +1: session-discussion binds one external discussion provider to sessions.
      140,
      env,
    ),
    publicExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS",
      // +4: session discussion state, info, provider, and registration contracts.
      // +2: structured media placeholder formatter and its text-fact contract.
      // +2: narrow settled-turn finalization result and safe full-attempt projector.
      // +1: channel-owned setup contract factory.
      // +18: generic schema primitives needed by plugin-owned channel config schemas.
      // +2: shared Teams reply-style and TTS schema leaves.
      // +2: generic inbound-root and SCP-host schema validators.
      // +2: attributed-range renderer and its options contract.
      // +1: agent-harness transcript visibility projector.
      // +1: outbound formatting capability profile.
      // +3: plugin approval reviewer-detail cap/truncator and sanitize-with-status variant.
      // +1: canonical incognito session classifier for storage-safe plugin behavior.
      // +2: shipped Slack and Discord setup compatibility helpers.
      // +3: typed channel partial-delivery error, creator, and structural guard.
      // +1: closed attempt-terminal merge, normalization, and projection helper.
      // +3: harness-native MCP App preview helper and its runtime/catalog contracts.
      // +1: canonical unknown-value to Error coercion.
      // +6: canonical session delivery normalization, access, and projection helpers.
      4711,
      env,
    ),
    publicFunctionExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS",
      // +1: session discussion provider registration.
      // +1: structured media placeholder formatter for text-only channel carriers.
      // +1: settled-turn full-attempt projector.
      // +1: channel-owned setup contract factory.
      // +4: generic channel schema shape builders.
      // +1: plugin-owned sensitive-schema registration.
      // +2: generic inbound-root and SCP-host schema validators.
      // +1: attributed-range renderer.
      // +1: agent-harness transcript visibility projector.
      // +2: plugin approval detail truncator and sanitize-with-status variant.
      // +1: canonical incognito session classifier for storage-safe plugin behavior.
      // +2: shipped Slack and Discord setup compatibility helpers.
      // +2: channel partial-delivery error creator and structural guard.
      // +1: harness-native MCP App preview helper.
      // +1: canonical unknown-value to Error coercion.
      // +6: canonical session delivery normalization, access, and projection helpers.
      2855,
      env,
    ),
    publicDeprecatedExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS",
      // +3: canonical incognito classifier projected through deprecated compatibility barrels.
      // +2: shipped Slack and Discord setup compatibility helpers.
      1688,
      env,
    ),
    publicWildcardReexports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_WILDCARD_REEXPORTS",
      83,
      env,
    ),
  };
  const publicDeprecatedExportsByEntrypointBudget = readPluginSdkEntrypointBudgetEnv(
    "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT",
    defaultPublicDeprecatedExportsByEntrypointBudget,
    env,
  );
  return { budgets, publicDeprecatedExportsByEntrypointBudget };
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

// All three inventories overlap. Lazily reuse one module graph so --help and
// invalid options avoid compiler work without tripling report time and heap.
let exportStatsProgram;

function collectExportStats(entrypoints) {
  // CLI validation and help do not need the compiler's startup cost.
  ts ??= require("typescript");
  const configPath = path.join(repoRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  exportStatsProgram ??= ts.createProgram(pluginSdkEntrypoints.map(entrypointPath), {
    allowJs: false,
    baseUrl: repoRoot,
    declaration: true,
    emitDeclarationOnly: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    paths: config.config.compilerOptions?.paths,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    types: [],
  });
  const program = exportStatsProgram;
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

function selectExportStats(scannedStats, entrypoints) {
  const byEntrypoint = new Map();
  const totals = {
    entrypoints: entrypoints.length,
    exports: 0,
    callableExports: 0,
    deprecatedExports: 0,
    deprecatedCallableExports: 0,
    uniqueExports: 0,
    uniqueCallableExports: 0,
  };
  for (const entrypoint of entrypoints) {
    const stats = scannedStats.byEntrypoint.get(entrypoint) ?? {
      exports: 0,
      callableExports: 0,
      deprecatedExports: 0,
      deprecatedCallableExports: 0,
    };
    byEntrypoint.set(entrypoint, stats);
    totals.exports += stats.exports;
    totals.callableExports += stats.callableExports;
    totals.deprecatedExports += stats.deprecatedExports;
    totals.deprecatedCallableExports += stats.deprecatedCallableExports;
  }
  // Export identities are entrypoint-qualified, so the selected totals are unique.
  totals.uniqueExports = totals.exports;
  totals.uniqueCallableExports = totals.callableExports;
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

function collectDeprecatedEntrypointBudgetFailures(byEntrypoint, entrypointBudgets) {
  const failures = [];
  for (const [entrypoint, stats] of byEntrypoint) {
    const budget = entrypointBudgets[entrypoint] ?? 0;
    if (stats.deprecatedExports > budget) {
      failures.push(
        `public deprecated exports in ${entrypoint} ${stats.deprecatedExports} > ${budget}`,
      );
    }
  }
  return failures;
}

export function collectPluginSdkSurfaceReport() {
  const scannedEntrypoints = [
    ...new Set([
      ...pluginSdkEntrypoints,
      ...publicPluginSdkEntrypoints,
      ...privateLocalOnlyPluginSdkEntrypoints,
    ]),
  ];
  const scannedStats = collectExportStats(scannedEntrypoints);
  const allStats = selectExportStats(scannedStats, pluginSdkEntrypoints);
  const publicStats = selectExportStats(scannedStats, publicPluginSdkEntrypoints);
  const localOnlyStats = selectExportStats(scannedStats, privateLocalOnlyPluginSdkEntrypoints);
  const publicWildcards = countWildcardReexports(publicPluginSdkEntrypoints);
  const leakedForbiddenExports = readPackageExportedSubpaths().filter((subpath) =>
    forbiddenPublicSubpaths.has(subpath),
  );
  const localOnlyStillPublic = privateLocalOnlyPluginSdkEntrypoints.filter(
    (entrypoint) =>
      publicEntrypointSet.has(entrypoint) && !packagedPrivateRuntimeEntrypointSet.has(entrypoint),
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
  const deprecatedBarrelWithoutWildcard = [...deprecatedBarrelEntrypointSet].filter(
    (entrypoint) => {
      const source = fs.readFileSync(entrypointPath(entrypoint), "utf8");
      return !/^\s*export\s+(?:type\s+)?\*\s+from\s+["'][^"']+["']/mu.test(source);
    },
  );
  return {
    allStats,
    deprecatedBarrelMissingFromInventory,
    deprecatedBarrelWithoutWildcard,
    deprecatedMissingFromPublic,
    leakedForbiddenExports,
    localOnlyMissingFromInventory,
    localOnlyStats,
    localOnlyStillPublic,
    publicStats,
    publicWildcards,
  };
}

export function evaluatePluginSdkSurfaceReport(
  report,
  { budgets, publicDeprecatedExportsByEntrypointBudget },
) {
  const failures = [];
  if (publicPluginSdkEntrypoints.length > budgets.publicEntrypoints) {
    failures.push(
      `public entrypoints ${publicPluginSdkEntrypoints.length} > ${budgets.publicEntrypoints}`,
    );
  }
  if (report.publicStats.totals.exports > budgets.publicExports) {
    failures.push(`public exports ${report.publicStats.totals.exports} > ${budgets.publicExports}`);
  }
  if (report.publicStats.totals.callableExports > budgets.publicFunctionExports) {
    failures.push(
      `public callable exports ${report.publicStats.totals.callableExports} > ${budgets.publicFunctionExports}`,
    );
  }
  if (report.publicStats.totals.deprecatedExports > budgets.publicDeprecatedExports) {
    failures.push(
      `public deprecated exports ${report.publicStats.totals.deprecatedExports} > ${budgets.publicDeprecatedExports}`,
    );
  }
  failures.push(
    ...collectDeprecatedEntrypointBudgetFailures(
      report.publicStats.byEntrypoint,
      publicDeprecatedExportsByEntrypointBudget,
    ),
  );
  if (report.publicWildcards.count > budgets.publicWildcardReexports) {
    failures.push(
      `public wildcard reexports ${report.publicWildcards.count} > ${budgets.publicWildcardReexports}`,
    );
  }
  if (report.leakedForbiddenExports.length > 0) {
    failures.push(`forbidden public subpaths: ${report.leakedForbiddenExports.join(", ")}`);
  }
  if (report.localOnlyStillPublic.length > 0) {
    failures.push(`local-only entrypoints still public: ${report.localOnlyStillPublic.join(", ")}`);
  }
  if (report.localOnlyMissingFromInventory.length > 0) {
    failures.push(
      `local-only entrypoints missing from inventory: ${report.localOnlyMissingFromInventory.join(", ")}`,
    );
  }
  if (report.deprecatedMissingFromPublic.length > 0) {
    failures.push(
      `deprecated public entrypoints missing from package surface: ${report.deprecatedMissingFromPublic.join(", ")}`,
    );
  }
  if (report.deprecatedBarrelMissingFromInventory.length > 0) {
    failures.push(
      `deprecated barrel entrypoints missing from inventory: ${report.deprecatedBarrelMissingFromInventory.join(", ")}`,
    );
  }
  if (report.deprecatedBarrelWithoutWildcard.length > 0) {
    failures.push(
      `deprecated barrel entrypoints without wildcard exports: ${report.deprecatedBarrelWithoutWildcard.join(", ")}`,
    );
  }
  return failures;
}

function renderPluginSdkSurfaceReport(report) {
  return [
    formatStats("all SDK entrypoints", report.allStats.totals),
    formatStats("public package SDK entrypoints", report.publicStats.totals),
    formatStats("local-only SDK entrypoints", report.localOnlyStats.totals),
    `deprecated public subpaths: ${deprecatedPublicPluginSdkEntrypoints.length}`,
    `deprecated barrel subpaths: ${deprecatedBarrelPluginSdkEntrypoints.length}`,
    `public wildcard reexports: ${report.publicWildcards.count}`,
    `package-exported forbidden subpaths: ${report.leakedForbiddenExports.length}`,
  ].join("\n");
}

function main(argv = process.argv.slice(2), env = process.env) {
  const cliArgs = parsePluginSdkSurfaceReportArgs(argv);
  if (cliArgs.help) {
    process.stdout.write(usage());
    return 0;
  }
  const budgetConfig = readPluginSdkSurfaceBudgets(env);
  const report = collectPluginSdkSurfaceReport();
  process.stdout.write(`${renderPluginSdkSurfaceReport(report)}\n`);
  const failures = evaluatePluginSdkSurfaceReport(report, budgetConfig);
  if (cliArgs.check && failures.length > 0) {
    process.stderr.write(`plugin SDK surface budget failed:\n`);
    for (const failure of failures) {
      process.stderr.write(`- ${failure}\n`);
    }
    return 1;
  }
  return 0;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].length > 0 &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
