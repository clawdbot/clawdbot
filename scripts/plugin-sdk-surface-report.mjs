#!/usr/bin/env node

// Reports plugin SDK export surface metadata.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  deprecatedBarrelPluginSdkEntrypoints,
  deprecatedPublicPluginSdkEntrypoints,
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
  health: 1,
  "command-gating": 5,
  lmstudio: 37,
  "lmstudio-runtime": 27,
  "provider-setup": 1,
  "self-hosted-provider-setup": 14,
  routing: 1,
  runtime: 3,
  // Deprecated Telegram-named alias retained for plugin SDK compatibility.
  "retry-runtime": 1,
  "runtime-logger": 3,
  "runtime-secret-resolution": 5,
  "secret-provider-integration": 4,
  "setup-adapter-runtime": 1,
  "skills-runtime": 5,
  "channel-streaming": 55,
  "approval-gateway-runtime": 1,
  "approval-handler-runtime": 1,
  "approval-reply-runtime": 3,
  "approval-runtime": 1,
  "config-runtime": 123,
  "config-contracts": 1,
  // +1: unified implicit-mention config type.
  "config-types": 426,
  "config-schema": 3,
  "reply-dedupe": 1,
  "inbound-reply-dispatch": 26,
  "channel-reply-pipeline": 12,
  "channel-reply-options-runtime": 2,
  "channel-runtime": 144,
  "interactive-runtime": 13,
  "outbound-send-deps": 4,
  "outbound-runtime": 16,
  "file-access-runtime": 2,
  "infra-runtime": 595,
  "ssrf-policy": 1,
  "ssrf-runtime": 1,
  "media-runtime": 2,
  "text-runtime": 191,
  "agent-core": 1,
  "agent-runtime": 7,
  "plugin-runtime": 13,
  "channel-secret-runtime": 23,
  "secret-file-runtime": 1,
  "security-runtime": 7,
  "agent-harness": 7,
  "agent-harness-runtime": 11,
  types: 6,
  "agent-config-primitives": 2,
  "command-auth": 81,
  // +2: group scope encoder/key builder mirrored by deprecated compat.
  // +5: shared channel setup, policy, and config schema helpers.
  compat: 167,
  "direct-dm": 9,
  "direct-dm-access": 5,
  discord: 48,
  mattermost: 7,
  matrix: 1,
  // +3: shared multi-account and group-entry schema builders.
  "channel-config-schema-legacy": 25,
  "channel-actions": 2,
  "channel-envelope": 3,
  "channel-inbound": 21,
  "channel-inbound-roots": 1,
  "channel-logging": 4,
  "channel-location": 4,
  "channel-mention-gating": 7,
  "channel-lifecycle": 23,
  // Registry sweep: 77 packages, zero fetch failures; channel-ingress and dead aliases
  // had zero consumers.
  // +11 each: durable channel-ingress drain seam (drain/lifecycle/claim/retry) mirrored by compat (#108656).
  "channel-message": 241,
  "channel-message-runtime": 238,
  "channel-pairing-paths": 1,
  // Deprecated pairing/conversation exports from the SQLite pairing migration
  // landed on main (#105802) without entrypoint pins; not touched by this PR.
  "channel-pairing": 1,
  "conversation-runtime": 4,
  "channel-send-result": 1,
  "channel-policy": 15,
  "channel-route": 5,
  "session-store-runtime": 4,
  "session-transcript-runtime": 2,
  "group-access": 13,
  "media-generation-runtime-shared": 3,
  "music-generation-core": 20,
  "reply-history": 8,
  "messaging-targets": 12,
  "memory-core": 45,
  "memory-core-engine-runtime": 15,
  "memory-core-host-multimodal": 3,
  "memory-core-host-query": 2,
  "memory-core-host-events": 12,
  "memory-core-host-status": 1,
  "memory-core-host-runtime-core": 1,
  "memory-host-core": 1,
  "memory-host-files": 7,
  "memory-host-status": 72,
  "provider-auth": 20,
  "provider-oauth-runtime": 2,
  "provider-auth-login": 3,
  "provider-model-shared": 30,
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

export function readPluginSdkSurfaceBudgets(env = process.env) {
  const budgets = {
    publicEntrypoints: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS",
      // Registry sweep: 77 packages, zero fetch failures; retired dead channel-ingress facade.
      // +1: speech-settings keeps agent prompt imports off the synthesis/runtime graph.
      // +1: meeting-runtime barrel: browser meeting-bot core behind MeetingPlatformAdapter.
      // +1: question-gateway-runtime resolves ask_user choices for channel plugins.
      331,
      env,
    ),
    // ScopeTree adds six channel-policy exports, mirrored by compat, including three functions.
    // Its flat channel-groups builder adds one function, also mirrored by compat.
    // Its case-insensitive scope-key resolver adds one function, also mirrored by compat.
    // Its length-prefixed segment encoder and scope-key builder add two functions, also mirrored.
    // The focused HTML entity runtime and quote-aware HTML tokenizer add one public function each.
    // Plugin service Gateway event scope and emitter types add four facade exports.
    publicExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS",
      // +4: registerMcpServerConnectionResolver context/result/resolver/registration types (#106229).
      // +2: materializeRequesterScopedMcpToolsForHarnessRun (agent-harness-runtime + compat mirror).
      // +1: matchesNoProxy exposes canonical Undici-compatible bypass selection to plugins.
      // +4: group scope encoder/key builder (channel-policy + compat mirror).
      // +1: runDetachedWebhookWork gives post-ack work an independently tracked admission root.
      // +9: app-guided provider setup context/candidate/hook types and their public mirrors.
      // +3: atomic SQLite STRICT migration function, options, and result for plugin stores.
      // Harvest: channel-ingress -64; dead channel-message dispatch aliases -23.
      // Harvest: retired qa-live-transport-scenarios subpath -6.
      // +12: typed plan step/status and checklist formatter across channel barrels.
      // +8: plan-step ingress union and normalizer across channel barrels.
      // Harvest: retired dual-field plan payload builder -1.
      // +12: active plan-step consumers pinned through channel-outbound and mirrors.
      // +6: app-guided provider setup types retained by plugin-entry and mirrors.
      // +3: widget HTML validation helpers and tool input error.
      // Used-union narrowing: 31 wildcard barrels drop to explicit used exports;
      // proxy stream API and codex marker/scaffold pins retained.
      // +2: generic channel retry runner and Retry-After parser.
      // +1: shared speech-provider API key resolver.
      // +32: shared channel setup, config-schema, policy, and status helpers.
      // +2: shared channel replay-guard factory and claim handle.
      // +6: lightweight speech settings types, normalizers, and config resolver.
      // +4: unified implicit-mention config, schema, resolved policy, and resolver.
      // Harvest: retired AudioConfig type -1.
      // +4: bounded plugin blob store options, entry, entry info, and store types.
      // +6: shared progress receipt tracker + compositor snapshot across channel barrels.
      // +1: selectPreferredLocalModelId shares app-guided local model ranking across providers.
      // +4: shared audio-energy stats and speech-threshold gate through realtime-voice.
      // +2: supplemental sender decision and outbound text chunk sequencer.
      // +2: shared realtime voice session harness through realtime-voice.
      // +24: narrowed durable channel-ingress drain seam — factory, lifecycle binding,
      // tuning constants, and telegram-consumed claim helpers with compat mirrors,
      // after harvesting exports orphaned by the split-out WhatsApp adapter (#108656).
      // +10: supplemental sender helpers plus host-owned SQLite lease contracts.
      // Harvest: retired dual-field plan payload builder -1.
      // +23: core channel, envelope, direct-DM, feedback, legacy-payload, and memory contracts.
      // +81: meeting-runtime barrel: browser meeting-bot core behind MeetingPlatformAdapter.
      // +3: question-gateway-runtime resolver plus request/result types.
      // +1: async memory prompt preparation registration.
      8153,
      env,
    ),
    publicFunctionExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS",
      // +2: materializeRequesterScopedMcpToolsForHarnessRun (agent-harness-runtime + compat mirror).
      // +4: group scope encoder/key builder (channel-policy + compat mirror).
      // +1: atomic SQLite STRICT migration for plugin stores.
      // +1: runDetachedWebhookWork gives post-ack work an independently tracked admission root.
      // Harvest: channel-ingress -19; dead channel-message dispatch aliases -23.
      // Harvest: retired qa-live-transport-scenarios subpath -3.
      // +4: shared plan checklist formatter across channel barrels.
      // +4: plan-step normalizer across channel barrels.
      // Harvest: retired dual-field plan payload builder -1.
      // +6: active plan-step helpers pinned through channel-outbound and mirrors.
      // +2: widget HTML document detection and size assertion.
      // Used-union narrowing of the 31 wildcard barrels.
      // +2: generic channel retry runner and Retry-After parser.
      // +1: shared speech-provider API key resolver.
      // +24: shared channel setup, config-schema, policy, and status helpers.
      // +1: shared channel replay-guard factory.
      // +3: receipt tracker/snapshot callables across channel barrels.
      // +3: lightweight speech settings normalizers and config resolver.
      // +1: unified implicit-mention policy resolver.
      // +1: selectPreferredLocalModelId shares app-guided local model ranking across providers.
      // +3: PCM16/mu-law energy readers and speech-threshold gate factory.
      // +2: supplemental sender decision and outbound text chunk sequencer.
      // +1: shared realtime voice session harness through realtime-voice.
      // +9: narrowed drain seam functions and compat mirrors after the
      // WhatsApp-split harvest (#108656).
      // +3: supplemental sender helpers plus the PluginStateLeaseRunner callback.
      // Harvest: retired dual-field plan payload builder -1.
      // +13: core channel, envelope, direct-DM, feedback, legacy-payload, and memory operations.
      // +32: meeting-runtime barrel: browser meeting-bot core behind MeetingPlatformAdapter.
      // +1: question-gateway-runtime resolver.
      // +1: async memory prompt preparation registration.
      4535,
      env,
    ),
    publicDeprecatedExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS",
      // +2: group scope encoder/key builder mirrored by deprecated compat.
      // Harvest: channel-ingress -8; dead channel-message dispatch aliases -23.
      // +77: five zero-consumer subpaths enter their removal window.
      // +9: typed plan exports and formatter through deprecated channel barrels.
      // +6: plan-step ingress union and normalizer through deprecated channel barrels.
      // +8: channel-outbound plan pins mirrored through deprecated barrels.
      // Used-union narrowing drops inherited deprecated exports.
      // +1: Telegram runner alias retained for plugin SDK compatibility.
      // +8: shared channel helpers mirrored by deprecated barrels.
      // +3: receipt/snapshot exports through deprecated channel barrels.
      // +1: unified implicit-mention config type through deprecated config-types.
      // +24: narrowed drain seam compat mirrors in the channel-message
      // deprecation-window barrels (#108656).
      // Harvest: retired dual-field plan payload builder -1; lower-only drift -8.
      3005,
      env,
    ),
    publicWildcardReexports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_WILDCARD_REEXPORTS",
      // Used-union narrowing removes 103 wildcard re-exports.
      // Harvest: freeze the compat config-schema barrel to explicit exports -1.
      104,
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
