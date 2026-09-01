#!/usr/bin/env node
// Scans source files for usage of deprecated API markers.
import fs from "node:fs";
import path from "node:path";
import { collectDeprecatedInternalConfigApiViolations } from "./lib/config-boundary-guard.mts";
import {
  BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES,
  buildDeprecatedPluginSdkModuleSpecifiers,
} from "./lib/deprecated-plugin-sdk-usage.mts";
import { escapeRegExp } from "./lib/regexp.mjs";

const repoRoot = process.cwd();

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".mts"]);
const skippedSegments = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);
const skippedFilePatterns = [
  /\.test\.[cm]?[jt]sx?$/u,
  /\.spec\.[cm]?[jt]sx?$/u,
  /\.e2e\.[cm]?[jt]sx?$/u,
  /\.test-(?:harness|loader|support)\.[cm]?[jt]sx?$/u,
  /\.contract-test-support\.[cm]?[jt]sx?$/u,
  /(?:^|\/)test-(?:helpers|support)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)(?:test-helpers|test-support)\//u,
  /^extensions\/test-support\//u,
  /^src\/channels\/plugins\/contracts\/test-helpers\//u,
  /^src\/plugins\/contracts\/tts-contract-suites\.ts$/u,
  /\.d\.ts$/u,
];

type RuleSource = { repoPath: string; source: string };

type DeprecatedRule = {
  allowedFiles?: string[];
  collect?: () => string[];
  collectFile?: (file: RuleSource) => string[];
  id?: string;
  message?: string;
  moduleSpecifiers?: string[];
  names?: string[];
  roots?: string[];
};

function toRepoPath(filePath: string) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skippedSegments.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) {
      continue;
    }
    const repoPath = toRepoPath(entryPath);
    if (!skippedFilePatterns.some((pattern) => pattern.test(repoPath))) {
      yield entryPath;
    }
  }
}

function createIdentifierRuleCollector(rule: DeprecatedRule) {
  const pattern = new RegExp(
    `\\b(?:${(rule.names ?? []).map((name) => escapeRegExp(name)).join("|")})\\b`,
    "gu",
  );
  return ({ repoPath, source }: RuleSource) => {
    const violations: string[] = [];
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${repoPath}:${line}: ${match[0]} (${rule.message ?? "deprecated API"})`);
    }
    return violations;
  };
}

function createModuleSpecifierRuleCollector(rule: DeprecatedRule) {
  const specifierPattern = (rule.moduleSpecifiers ?? [])
    .map((specifier) => escapeRegExp(specifier))
    .join("|");
  const patterns = [
    new RegExp(
      `\\bimport\\s+(?:type\\s+)?(?:[^"']+?\\s+from\\s+)?["'](${specifierPattern})["']`,
      "gu",
    ),
    new RegExp(
      `\\bexport\\s+(?:type\\s+)?(?:\\*\\s+from\\s+|[^"']+?\\s+from\\s+)["'](${specifierPattern})["']`,
      "gu",
    ),
    new RegExp(`\\bimport\\s*\\(\\s*["'](${specifierPattern})["']\\s*[,)]`, "gu"),
  ];
  return ({ repoPath, source }: RuleSource) => {
    const violations: string[] = [];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${repoPath}:${line}: ${match[1]} (${rule.message})`);
      }
    }
    return violations;
  };
}

const internalFacadeImportPatterns = [
  /\bimport\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/gu,
  /\bexport\s+(?:type\s+)?(?:\*\s+(?:as\s+\w+\s+)?from\s+|[^"']+?\s+from\s+)["']([^"']+)["']/gu,
  // Trailing [,)] keeps `import("spec", { with: ... })` attribute forms covered.
  /\bimport\s*\(\s*["']([^"']+)["']\s*[,)]/gu,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
];

// Maps any import form (package specifier or relative path) to an extension-less
// repo module path so banned facades cannot be reached through any spelling.
// tsconfig aliases both openclaw/plugin-sdk/* and @openclaw/plugin-sdk/* to src/plugin-sdk/*.
function resolveInternalFacadeModulePath(repoPath: string, specifier: string) {
  const stripped = specifier.replace(/\.[cm]?[jt]sx?$/u, "");
  const packageSubpath = stripped.replace(/^@?openclaw\/plugin-sdk\//u, "");
  if (packageSubpath !== stripped) {
    return `src/plugin-sdk/${packageSubpath}`;
  }
  if (!stripped.startsWith(".")) {
    return null;
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), stripped));
}

const bansByModulePath = new Map(
  BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES.map((ban) => [ban.modulePath, ban]),
);

function collectBannedInternalFacadeImportViolations({ repoPath, source }: RuleSource) {
  const violations: string[] = [];
  for (const pattern of internalFacadeImportPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      const resolved = resolveInternalFacadeModulePath(repoPath, specifier);
      const ban = resolved ? bansByModulePath.get(resolved) : undefined;
      if (!ban || (ban.allowedImporters ?? []).includes(repoPath)) {
        continue;
      }
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${repoPath}:${line}: ${match[1]} (use ${ban.canonical})`);
    }
  }
  return violations;
}

const rules: Array<DeprecatedRule & { id: string }> = [
  {
    id: "internal-config-api",
    collect: () => collectDeprecatedInternalConfigApiViolations(),
  },
  {
    id: "plugin-sdk-compat-subpaths",
    roots: ["src", "packages"],
    moduleSpecifiers: buildDeprecatedPluginSdkModuleSpecifiers(),
    message: "use focused non-deprecated plugin SDK subpaths",
  },
  {
    id: "extension-plugin-sdk-compat-subpaths",
    roots: ["extensions"],
    moduleSpecifiers: buildDeprecatedPluginSdkModuleSpecifiers(),
    message: "extensions must use focused non-deprecated plugin SDK subpaths",
  },
  {
    // Deprecated facades stay exported for third-party plugins, but internal code
    // must not reach them via package specifier or relative import.
    id: "facade-internal-imports",
    roots: ["src", "extensions"],
    collectFile: collectBannedInternalFacadeImportViolations,
  },
  {
    id: "message-api",
    roots: ["src", "extensions", "packages"],
    names: ["deliverOutboundPayloads"],
    allowedFiles: [
      "src/infra/outbound/deliver-runtime.ts",
      "src/infra/outbound/deliver.ts",
      "src/plugin-sdk/channel-message.ts",
      "src/plugin-sdk/inbound-reply-dispatch.ts",
    ],
    message: "use sendDurableMessageBatch or deliverInboundReplyWithMessageSendContext",
  },
];

const selectedRuleIds = new Set(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--rule="))
    .map((arg) => arg.slice("--rule=".length)),
);

const selectedRules =
  selectedRuleIds.size === 0 ? rules : rules.filter((rule) => selectedRuleIds.has(rule.id));
const unknownRuleIds = [...selectedRuleIds].filter((id) => !rules.some((rule) => rule.id === id));

if (unknownRuleIds.length > 0) {
  console.error(`Unknown deprecated API usage rule(s): ${unknownRuleIds.join(", ")}`);
  process.exit(1);
}

const scans = selectedRules.map((rule) => ({
  rule,
  violations: rule.collect?.(),
  byRoot: new Map<string, string[]>((rule.roots ?? []).map((root) => [root, []])),
  allowedFiles: new Set(rule.allowedFiles ?? []),
  collectFile:
    rule.collectFile ??
    (rule.moduleSpecifiers
      ? createModuleSpecifierRuleCollector(rule)
      : createIdentifierRuleCollector(rule)),
}));

for (const root of new Set(scans.flatMap((scan) => [...scan.byRoot.keys()]))) {
  const rootScans = scans.filter((scan) => scan.byRoot.has(root));
  for (const filePath of walk(path.join(repoRoot, root))) {
    const repoPath = toRepoPath(filePath);
    const fileScans = rootScans.filter((scan) => !scan.allowedFiles.has(repoPath));
    if (fileScans.length === 0) {
      continue;
    }
    const source = fs.readFileSync(filePath, "utf8");
    for (const scan of fileScans) {
      scan.byRoot.get(root)!.push(...scan.collectFile({ repoPath, source }));
    }
  }
}

// Keep rule and root diagnostic order while each source is read only once.
const violations = scans.flatMap(({ rule, violations: collected, byRoot }) =>
  (collected ?? [...byRoot.values()].flat()).map((violation) => `${rule.id}: ${violation}`),
);

if (violations.length > 0) {
  console.error("Deprecated API usage guard failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("deprecated API usage guard passed");
