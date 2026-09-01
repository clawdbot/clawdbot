#!/usr/bin/env node

// Reports plugin SDK export surface metadata.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type tsTypes from "typescript";
import { booleanFlag, parseFlagArgs } from "./lib/arg-utils.mts";
import {
  deprecatedBarrelPluginSdkEntrypoints,
  deprecatedPublicPluginSdkEntrypoints,
  packagedPrivatePluginSdkRuntimeEntrypoints,
  pluginSdkEntrypoints,
  privateLocalOnlyPluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const require = createRequire(import.meta.url);
let ts: typeof tsTypes;

type ExportEntryStats = {
  callableExports: number;
  deprecatedCallableExports: number;
  deprecatedExports: number;
  exports: number;
};

function usage() {
  return `Usage: node --import tsx scripts/plugin-sdk-surface-report.mts [--check]

Reports plugin SDK export surface metadata.

Options:
  --check     Fail when SDK surface budgets are exceeded.
  -h, --help  Show this help.
`;
}

function parsePluginSdkSurfaceReportArgs(argv: string[]) {
  return parseFlagArgs(
    argv,
    { check: false, help: false },
    [
      booleanFlag("--check", "check", true, { repeatable: true }),
      booleanFlag("--help", "help", true, { repeatable: true }),
      booleanFlag("-h", "help", true, { repeatable: true }),
    ],
    {
      ignoreDoubleDash: false,
      onUnhandledArg(arg: string) {
        throw new Error(`Unknown plugin SDK surface report option: ${arg}`);
      },
    },
  );
}
const publicEntrypointSet = new Set(publicPluginSdkEntrypoints);
const localOnlyEntrypointSet = new Set(privateLocalOnlyPluginSdkEntrypoints);
const packagedPrivateRuntimeEntrypointSet = new Set(packagedPrivatePluginSdkRuntimeEntrypoints);
const deprecatedPublicEntrypointSet = new Set(deprecatedPublicPluginSdkEntrypoints);
const deprecatedBarrelEntrypointSet = new Set(deprecatedBarrelPluginSdkEntrypoints);
const forbiddenPublicSubpaths = new Set(["test-utils"]);

function readPluginSdkSurfaceBudgetEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
) {
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

function readPluginSdkEntrypointBudgetEnv(
  name: string,
  fallback: Readonly<Record<string, number>>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object of entrypoint integer budgets`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${name} must be a JSON object of entrypoint integer budgets`);
  }

  const overrides: Record<string, number> = {};
  for (const [entrypoint, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name}.${entrypoint} must be a safe non-negative integer`);
    }
    overrides[entrypoint] = value;
  }
  return Object.freeze({ ...fallback, ...overrides });
}

const defaultPublicDeprecatedExportsByEntrypointBudget = Object.freeze({
  // +1 each: legacy AgentHarness remains projected through the core and plugin-entry
  // compatibility barrels while external harnesses migrate to AgentHarnessV2.
  core: 3,
  "plugin-entry": 1,
  routing: 1,
  // +4: shipped default/session-agent resolvers remain available through
  // compatibility barrels while callers migrate to explicit/sole selection.
  health: 1,
  "agent-scope-runtime": 4,
  // +1: shipped channel setup state-migration declaration during its migration window.
  "channel-entry-contract": 1,
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
  // +1: deprecated agent media projection re-export during the media migration window.
  "media-runtime": 3,
  // +3: deprecated media projection type, builder, and local-roots compatibility re-export.
  "agent-media-payload": 3,
  // +2: deprecated media projection type and builder.
  "reply-payload": 2,
  "agent-runtime": 4,
  "memory-host-core": 2,
  // +4: session-write lease no-op compatibility stubs through the 2026.10 train.
  // +4: legacy AgentHarness, attempt, embedded-run, and side-question contracts remain
  // deprecated while external harnesses migrate to required-capability V2 contracts.
  // +1: bounded structured-input compiler/executor for native harness protocol adapters.
  "agent-harness": 2,
  "agent-harness-runtime": 10,
  "command-auth": 78,
  discord: 47,
  // +4: deprecated media projection type, builder, and turn aliases.
  "channel-inbound": 18,
  "channel-lifecycle": 23,
  // +1: shared ingress error factory projected through the deprecated message barrel.
  // +1: shared ingress retention defaults projected through the deprecated message barrel.
  // +1: WhatsApp ack-policy bridge counted via channel-message's wildcard re-export.
  "channel-message": 132,
  // +2: Slack progress-draft render bridge (function + mode type).
  "channel-outbound": 2,
  // +2: WhatsApp ack-policy bridge (function + mode type).
  "channel-feedback": 2,
  "channel-pairing": 0,
  "channel-policy": 7,
  "channel-send-result": 1,
  "reply-runtime": 1,
  "security-runtime": 1,
  "session-store-runtime": 4,
  // +2: shipped Slack and Discord setup helpers retained through their package migration window.
  "setup-runtime": 2,
  "reply-history": 6,
  "provider-auth": 19,
  "telegram-account": 3,
} satisfies Record<string, number>);

export function readPluginSdkSurfaceBudgets(env: NodeJS.ProcessEnv = process.env) {
  const budgets = {
    publicEntrypoints: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS",
      // +1: session-discussion binds one external discussion provider to sessions.
      // +1: focused media-local-roots replacement for the legacy agent-media facade.
      // +1: account-aware channel DM policy setup descriptors.
      // +1: dependency-light CLI argv parsing for machine-output metadata.
      // +1: bounded archive extraction and single-entry reads.
      // +1: budgeted root-bounded directory walking.
      // +1: pinned secret reads and first-writer-wins creation.
      // +2: restore the documented session-catalog and tool-results plugin contracts.
      // +1: focused inbound-event delivery correlation for channel plugins.
      // +1: dependency-light agent scope helpers for doctor migration enumeration.
      // +1: dependency-light channel streaming config readers for doctor closures
      //     (realtime-voice-activation is private-local and not counted here).
      // +1: registry-bound plugin command planning and exact selected execution.
      // +1: canonical Computer Use wire contract and node-host provider seam.
      // -1: retire the deprecated messaging-targets subpath.
      // +2: bounded provider streams and read-only SecretRef resolution.
      // +1: diagnostic flag checks without event, trace, or redaction initialization.
      147,
      env,
    ),
    publicExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS",
      // +5: session discussion state, info, provider, registration, and Control UI path contracts.
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
      // +3: typed channel partial-delivery error, creator, and structural guard.
      // +1: closed attempt-terminal merge, normalization, and projection helper.
      // +3: harness-native MCP App preview helper and its runtime/catalog contracts.
      // +1: canonical unknown-value to Error coercion.
      // +6: canonical session delivery normalization, access, and projection helpers.
      // +5: focused media-local-roots helpers and typed hook media contracts.
      // +1: model-independent agent-harness preflight failure contract.
      // +3: channel DM policy factory and its account/patch callback contracts.
      // +1: typed owner-required error for session store path resolution.
      // +1: native approval messaging target resolver.
      // +1: shared plugin SecretRef setup plan helper.
      // +2: shared low-cardinality diagnostic dimension normalizers.
      // +1: shared plugin SecretRef setup CLI factory.
      // +1: shared multi-claim ingress lifecycle fan-in.
      // +3: channel prompt-context entry/compat types and channel metadata builder.
      // +4: focused CLI root-option constants and parsers.
      // +6: model-picker action/capability and authoritative session-apply contracts.
      // +1: logger file-transport flush for graceful shutdown drains.
      // +1: process-local sessions.changed plugin notification payload.
      // +1: loopback-only host classifier for plugin local-machine boundaries.
      // +7: bounded archive extraction, entry reads, errors, and policy types.
      // +3: root-bounded walk iterator, options, and entry contract.
      // +5: pinned secret create/read functions and their options contract.
      // +1: canonical Gateway browser-origin acceptance for browser-facing plugin routes.
      // +1: watched-sessions prompt block for plugin-owned harness runtimes.
      // +11: attributed skill proposal evaluation and committed skill lifecycle contracts.
      // +1: inbound media-fact metadata projection for plugin-owned channel ingestion.
      // +2: shared ingress error factory through channel-outbound and channel-message.
      // +2: shared ingress retention defaults through channel-outbound and channel-message.
      // +1: standard raw-event ingress profile replacing two channel-local shells.
      // +1: collision-safe MCP server-name assignment for native harness catalogs.
      // +45: restore typed session-catalog and tool-results exports promised to plugins.
      // +1: forwarding-routed approver-restricted native approval capability factory.
      // +1: shared inbound-event delivery correlation factory for channel plugins.
      // +1: canonical webhook route identity for plugin-owned target registries.
      // +3: canonical ready, blocked, and stopped channel lifecycle patch factories.
      // +1: bounded external-content sanitizer for plugin-owned untrusted projections.
      // +1: auth-profile preservation decision for native model pickers.
      // +2: shared channel question-reaction store and preflight-audio factories.
      // +1: shared channel interactive dispatcher with canonical binding authorization.
      // +1: simple channel secret contract factory replacing repeated collectors.
      // +4: focused agent scope functions for doctor migration enumeration.
      // +1: shared transcript credential-safety prompt for plugin-owned agent harnesses.
      // +3: channel streaming config reader re-exports and session-agent scope resolver.
      // +3: session-catalog terminal-start provider request and Gateway params/result contracts.
      // +1: worker desktop endpoint contract for desktop-capable worker leases.
      // +1: closed worker desktop app metadata for provider-advertised launchers.
      // +1: provider-authored machine option metadata for cloud-session sizing.
      // +1: native command spec merger through the native-command-registry facade.
      // +8: focused plugin command runtime factory, dispatch symbol, and six readonly contracts.
      // -2: remove unused WhatsApp-specific ack policy exports from channel-feedback.
      // -7: retire unused and duplicate inbound-dispatch compatibility exports.
      // +7: restore still-existing deprecated inbound-dispatch compatibility re-exports.
      // +1: channel-account-bound native approval request selection.
      // +6: required-capability V2 harness contracts through the focused and runtime barrels,
      // including the side-question compatibility split.
      // +1: add the account-aware native approval request selector.
      // +3: add canonical coercion exports while retaining the shipped asString compatibility name.
      // +2: add high-use coercion primitives while retaining shipped object-record exports.
      // +2: channel-neutral location and provider-update hook contracts.
      // +1: QQBot 2.0.1 operator-approval Gateway client compatibility export.
      // +2: narrow channel agent-run terminal reader and outcome contract.
      // +5: narrow string, record, and error coercion helpers.
      // +1: normalized Gateway public origin resolver for plugin-generated links.
      // -2: retire the dead progress-draft render reader; it counted twice via
      // channel-outbound and channel-message's wildcard re-export of it.
      // +11: Computer Use schemas/types plus parsers, compiler, and provider registration.
      // +6: Computer Use v2 action, result, and capability contracts.
      // +1: opaque channel participant evidence preservation without mint authority.
      // +6: load-only bridges for published pre-split plugin artifacts
      //     (voice-call/matrix runtime-doctor repair names, WhatsApp ack policy,
      //     Slack progress-draft render) so installed plugins survive upgrade (#124041 class).
      // -1: remove the orphan diagnostic traceparent propagation export.
      // +4: registry-owned native compaction registration contracts for Codex harnesses.
      // -17: retire the messaging-targets subpath, embedded Pi aliases, and shipped
      // channel setup compatibility helpers.
      // +1: concrete plugin side-effect owner resolution for agent harness runtimes.
      // +1: strict explicit agent-id normalization without default-agent fallback.
      // +5: session-catalog paging capability, family/node-host composers, and option contracts.
      // +3: two focused primitives and the closed read-only SecretRef result contract.
      // -2: remove obsolete transcript display helper exports.
      // +2: lightweight agent config resolution and nonthrowing default-agent lookup.
      // +1: focused media-store URL/path ingestion (saveMediaSource) off the deprecated barrel.
      // +2: structural Gateway transport and request-error guards for plugin CLI routing.
      // +1: canonical sensitive-URL redactor so plugin CLI errors never print URL userinfo.
      // +1: account-scoped model catalog discovery for native agent harnesses.
      // +2: shared delegation policy (mode resolver + section builder) so harness
      //     runtimes render the same guidance instead of diverging prompt copies.
      // +1: shared harness visible-source-reply guidance.
      // +1: typed guarded-fetch redirect error for direct-only plugin delivery.
      // -1: remove the test-only channel activity reset export.
      // +1: named bounded structured-input surface for native harness protocol adapters.
      // +1: OpenAI-compatible video execution in the existing media-understanding owner.
      // -2: retire the uncalled secret-plan target resolver and its result type.
      // +2: restore shipped channel setup helpers until stable packages migrate.
      // +1: canonical untrusted audio-transcript formatter for channel plugins.
      // +2: embedded foreground prompt context builder and its public context type.
      // +1: typed owner-declared approval-scope contract for plugin-authored approvals.
      // -5: approval display sanitizers moved to a non-public leaf module
      //     (exec-approval-text-sanitize) to break the exec-approvals cycle.
      // +3: typed ask_user option-index contract and two bounded owner-order resolvers.
      // +2: exact-session deletion parameters and synchronous companion mutation contract.
      // +2: canonical session-model selection and auxiliary runtime-auth preparation.
      // +1: identifier authentication input type for external channel plugins.
      // +1: shared channel-account logout config cleanup.
      // +1: descriptor-based allowFrom authentication classifier for channel security audits.
      // +1: downstream strength mappers need canonical ordering instead of duplicate rank tables.
      // +1: focused account media-limit resolver avoids the deprecated barrel on startup.
      // +1: shared bounded HTTP rejection transport replaces plugin-local close policies.
      // +1: prepared model-provider builder preserves the stable builder's return contract.
      // +1: canonical SecretRef default-alias predicate for plugin binding parity.
      // +2: strict session-agent resolution aliases preserve shipped Plugin SDK behavior.
      // +1: manifest-owned plugin capability secret availability guard.
      // +1: canonical diagnostic flag checker through its focused subpath.
      // +2: focused provider-auth routes for shipped auth ordering and provider-map lookup.
      4355,
      env,
    ),
    publicFunctionExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS",
      // +2: session discussion provider registration and canonical Control UI path building.
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
      // +2: channel partial-delivery error creator and structural guard.
      // +1: harness-native MCP App preview helper.
      // +1: canonical unknown-value to Error coercion.
      // +6: canonical session delivery normalization, access, and projection helpers.
      // +2: focused media-local-roots helpers.
      // +3: channel DM policy factory and its account/patch callbacks.
      // +1: native approval messaging target resolver.
      // +2: shared low-cardinality diagnostic dimension normalizers.
      // +1: shared plugin SecretRef setup CLI factory.
      // +1: shared multi-claim ingress lifecycle fan-in.
      // +1: channel metadata builder.
      // +3: focused CLI root-option parsers.
      // +1: authoritative model-picker session-apply operation.
      // +1: logger file-transport flush for graceful shutdown drains.
      // +1: loopback-only host classifier for plugin local-machine boundaries.
      // +2: bounded archive extraction and single-entry reads.
      // +1: root-bounded directory walk iterator.
      // +4: pinned secret create and synchronous/asynchronous reads.
      // +1: canonical Gateway browser-origin acceptance for browser-facing plugin routes.
      // +1: watched-sessions prompt block for plugin-owned harness runtimes.
      // +1: inbound media-fact metadata projection for plugin-owned channel ingestion.
      // +2: shared ingress error factory through channel-outbound and channel-message.
      // +1: standard raw-event ingress profile replacing two channel-local shells.
      // +1: collision-safe MCP server-name assignment for native harness catalogs.
      // +14: restore callable session-catalog and tool-results helpers promised to plugins.
      // +1: forwarding-routed approver-restricted native approval capability factory.
      // +1: shared inbound-event delivery correlation factory for channel plugins.
      // +1: canonical webhook route identity for plugin-owned target registries.
      // +3: canonical ready, blocked, and stopped channel lifecycle patch factories.
      // +1: bounded external-content sanitizer for plugin-owned untrusted projections.
      // +1: auth-profile preservation decision for native model pickers.
      // +2: shared channel question-reaction store and preflight-audio factories.
      // +1: shared channel interactive dispatcher with canonical binding authorization.
      // +1: simple channel secret contract factory replacing repeated collectors.
      // +4: focused agent scope functions for doctor migration enumeration.
      // +3: channel streaming config reader functions and session-agent scope resolver.
      // +1: native command spec merger through the native-command-registry facade.
      // +1: focused registry-bound plugin command runtime factory.
      // -1: remove the unused WhatsApp-specific ack policy helper.
      // -10: collapse inbound-dispatch callable aliases and wrappers.
      // +7: restore still-existing deprecated inbound-dispatch callable re-exports.
      // -3: keep the generic plugin-command reply carrier opaque and non-callable.
      // +1: channel-account-bound native approval request selection.
      // +1: add the account-aware native approval request selector.
      // +3: add canonical coercion exports while retaining the shipped asString compatibility name.
      // +2: add high-use callable coercion primitives while retaining shipped object-record exports.
      // +1: QQBot 2.0.1 operator-approval Gateway client compatibility export.
      // +1: narrow channel agent-run terminal reader.
      // +5: narrow string, record, and error coercion helpers.
      // +1: normalized Gateway public origin resolver for plugin-generated links.
      // -2: retire the dead progress-draft render reader; it counted twice via
      // channel-outbound and channel-message's wildcard re-export of it.
      // +4: Computer Use wire parsers, validator compiler, and provider registration.
      // +3: load-only bridges for published pre-split plugin artifacts
      //     (voice-call/matrix runtime-doctor repair names, WhatsApp ack policy,
      //     Slack progress-draft render) so installed plugins survive upgrade (#124041 class).
      // -1: remove the orphan diagnostic traceparent propagation export.
      // -12: retire the callable messaging-targets, embedded Pi, and channel setup helpers.
      // +1: concrete plugin side-effect owner resolution for agent harness runtimes.
      // +1: strict explicit agent-id normalization without default-agent fallback.
      // +2: session-catalog family and node-host binding composers.
      // +2: bounded provider stream and read-only SecretRef resolver.
      // -1: remove the obsolete transcript tool-call predicate.
      // +2: lightweight agent config resolution and nonthrowing default-agent lookup.
      // +1: focused media-store URL/path ingestion (saveMediaSource) off the deprecated barrel.
      // +2: structural Gateway transport and request-error guards for plugin CLI routing.
      // +1: canonical sensitive-URL redactor so plugin CLI errors never print URL userinfo.
      // +2: shared delegation policy (mode resolver + section builder) so harness
      //     runtimes render the same guidance instead of diverging prompt copies.
      // +1: shared harness visible-source-reply guidance.
      // -1: remove the test-only channel activity reset export.
      // +1: OpenAI-compatible video execution in the existing media-understanding owner.
      // -1: retire the uncalled secret-plan target resolver.
      // +2: restore shipped channel setup helpers until stable packages migrate.
      // +1: canonical untrusted audio-transcript formatter for channel plugins.
      // +1: embedded foreground prompt context builder.
      // -4: approval display sanitizers moved to a non-public leaf module
      //     (exec-approval-text-sanitize) to break the exec-approvals cycle.
      // +2: bounded ask_user owner-order map builder and option resolver.
      // +2: canonical session-model selection and auxiliary runtime-auth preparation.
      // +1: shared channel-account logout config cleanup.
      // +1: descriptor-based allowFrom authentication classifier for channel security audits.
      // +1: downstream strength mappers need canonical ordering instead of duplicate rank tables.
      // +1: focused account media-limit resolver avoids the deprecated barrel on startup.
      // +1: shared bounded HTTP rejection transport replaces plugin-local close policies.
      // +1: prepared model-provider builder preserves the stable builder's return contract.
      // +1: canonical SecretRef default-alias predicate for plugin binding parity.
      // +2: strict session-agent resolution aliases preserve shipped Plugin SDK behavior.
      // +1: manifest-owned plugin capability secret availability guard.
      // +1: canonical diagnostic flag checker through its focused subpath.
      // +2: focused provider-auth routes for shipped auth ordering and provider-map lookup.
      2593,
      env,
    ),
    publicDeprecatedExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS",
      // +3: canonical incognito classifier projected through deprecated compatibility barrels.
      // +10: named media legacy projection deprecations across public compatibility barrels.
      // +2: channel prompt-context type and metadata builder compatibility aliases.
      // +1: shared ingress error factory projected through channel-message.
      // +1: shared ingress retention defaults projected through channel-message.
      // +1: shipped channel setup state-migration declaration during its migration window.
      // +4: session-write lease no-op compatibility stubs through the 2026.10 train.
      // +7: restore still-existing deprecated inbound-dispatch compatibility re-exports.
      // +6: source-compatible harness contracts retained during the V2 migration window.
      // +5: shipped default-agent resolver projections retained during explicit-owner migration.
      // +5: load-only bridges for published pre-split plugin artifacts
      //     (voice-call/matrix runtime-doctor repair names, WhatsApp ack policy,
      //     Slack progress-draft render) so installed plugins survive upgrade (#124041 class).
      // -18: retire the expired August compatibility exports and messaging-targets subpath.
      1134,
      env,
    ),
    publicWildcardReexports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_WILDCARD_REEXPORTS",
      // -1: infra-runtime now names its error exports explicitly.
      // -1: infra-runtime excludes the internal system-event receipt API.
      // -1: infra-runtime re-exports number coercion directly from its canonical owner.
      50,
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

function entrypointPath(entrypoint: string) {
  return path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`);
}

function readPackageExportedSubpaths() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return Object.keys(packageJson.exports ?? {})
    .filter((key) => key.startsWith("./plugin-sdk/"))
    .map((key) => key.slice("./plugin-sdk/".length))
    .toSorted();
}

function unwrapAlias(checker: tsTypes.TypeChecker, symbol: tsTypes.Symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function hasDeprecatedTag(symbol: tsTypes.Symbol) {
  return symbol.getJsDocTags().some((tag) => tag.name === "deprecated");
}

function isCallableExport(
  checker: tsTypes.TypeChecker,
  symbol: tsTypes.Symbol,
  sourceFile: tsTypes.SourceFile,
) {
  const target = unwrapAlias(checker, symbol);
  const declaration = target.valueDeclaration ?? target.declarations?.[0] ?? sourceFile;
  const type = checker.getTypeOfSymbolAtLocation(target, declaration);
  return checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0;
}

function countWildcardReexports(entrypoints: string[]) {
  let count = 0;
  const matches: string[] = [];
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
let exportStatsProgram: tsTypes.Program | undefined;

function collectExportStats(entrypoints: string[]) {
  // CLI validation and help do not need the compiler's startup cost.
  const typescript = (ts ??= require("typescript"));
  const configPath = path.join(repoRoot, "tsconfig.json");
  const config = typescript.readConfigFile(configPath, (filePath) =>
    typescript.sys.readFile(filePath),
  );
  if (config.error) {
    throw new Error(typescript.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  exportStatsProgram ??= typescript.createProgram(pluginSdkEntrypoints.map(entrypointPath), {
    allowJs: false,
    baseUrl: repoRoot,
    declaration: true,
    emitDeclarationOnly: true,
    module: typescript.ModuleKind.ESNext,
    moduleResolution: typescript.ModuleResolutionKind.Bundler,
    noEmit: true,
    paths: config.config.compilerOptions?.paths,
    skipLibCheck: true,
    strict: false,
    target: typescript.ScriptTarget.ES2022,
    types: [],
  });
  const program = exportStatsProgram;
  const checker = program.getTypeChecker();
  const byEntrypoint = new Map<string, ExportEntryStats>();
  const uniqueNames = new Set<string>();
  const uniqueCallableNames = new Set<string>();

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

function selectExportStats(
  scannedStats: ReturnType<typeof collectExportStats>,
  entrypoints: string[],
) {
  const byEntrypoint = new Map<string, ExportEntryStats>();
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

function formatStats(label: string, stats: ReturnType<typeof collectExportStats>["totals"]) {
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

function collectDeprecatedEntrypointBudgetFailures(
  byEntrypoint: ReturnType<typeof collectExportStats>["byEntrypoint"],
  entrypointBudgets: Readonly<Record<string, number>>,
) {
  const failures: string[] = [];
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
  report: ReturnType<typeof collectPluginSdkSurfaceReport>,
  {
    budgets,
    publicDeprecatedExportsByEntrypointBudget,
  }: ReturnType<typeof readPluginSdkSurfaceBudgets>,
) {
  const failures: string[] = [];
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

function renderPluginSdkSurfaceReport(report: ReturnType<typeof collectPluginSdkSurfaceReport>) {
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

function main(argv: string[] = process.argv.slice(2), env = process.env) {
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
