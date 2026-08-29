#!/usr/bin/env node
// Audits repo ownership seams, optional plugin leaks, and nearby test coverage signals.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";
import { visitModuleSpecifiers } from "./lib/guard-inventory-utils.mjs";
import { optionalBundledClusterSet } from "./lib/optional-bundled-clusters.mjs";
import { escapeRegExp } from "./lib/regexp.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { toLine } from "./lib/ts-guard-utils.mts";

type ImportEntry = {
  family: string;
  file: string;
  kind: string;
  line: number;
  resolvedPath: string;
  specifier: string;
};
type OptionalClusterImportEntry = Omit<ImportEntry, "family"> & { cluster: string };
type ModuleSpecifierVisit = {
  kind: string;
  specifierNode: ts.Node;
  specifier: string;
};
const MATCH_QUALITY_RANK = {
  "exact-stem": 0,
  "path-nearby": 1,
  "direct-import": 2,
  "dir-token": 3,
} as const satisfies Record<string, number>;
type MatchQuality = keyof typeof MATCH_QUALITY_RANK;
type RelatedTestMatch = { file: string; matchQuality: MatchQuality };
type PackageJson = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  private?: boolean;
  openclaw?: { install?: { npmSpec?: string } };
};

const repoRoot = resolveRepoRoot(import.meta.url);
const srcRoot = path.join(repoRoot, "src");
const extensionsRoot = path.join(repoRoot, BUNDLED_PLUGIN_ROOT_DIR);
const testRoot = path.join(repoRoot, "test");
const workspacePackagePaths = ["ui/package.json"];
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const compareStrings = (left: string, right: string) => left.localeCompare(right);
const HELP_TEXT = `Usage: node --import tsx scripts/audit-seams.mts [--help]

Audit repo seam inventory and emit JSON to stdout.

Sections:
  duplicatedSeamFamilies       Plugin SDK seam families imported from multiple production files
  overlapFiles                 Production files that touch multiple seam families
  optionalClusterStaticLeaks   Optional extension/plugin clusters referenced from the static graph
  missingPackages              Workspace packages whose deps are not mirrored at the root
  seamTestInventory            High-signal seam candidates with nearby-test gap signals,
                               including cron orchestration seams for agent handoff,
                               outbound/media delivery, heartbeat/followup handoff,
                               and scheduler state crossings, plus subagent seams
                               for spawn/session handoff, announce delivery,
                               lifecycle registry, cleanup, and parent streaming

Notes:
  - Output is JSON only.
  - For clean redirected JSON through package scripts, prefer:
      pnpm --silent audit:seams > seam-inventory.json
`;

async function collectWorkspacePackagePaths() {
  const entries = await fs.readdir(extensionsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      workspacePackagePaths.push(path.join("extensions", entry.name, "package.json"));
    }
  }
}

function normalizePath(filePath: string) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function readScannableText(filePath: string, maxBytes = MAX_SCAN_BYTES) {
  const stat = await fs.stat(filePath);
  if (stat.size <= maxBytes) {
    return fs.readFile(filePath, "utf8");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function redactNpmSpec(npmSpec: unknown) {
  if (typeof npmSpec !== "string") {
    return npmSpec ?? null;
  }
  return npmSpec
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1***:***@")
    .replace(/(https?:\/\/)([^/\s:@]+)@/gi, "$1***@");
}

function isCodeFile(fileName: string) {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(fileName);
}

function isTestLikePath(relativePath: string) {
  return (
    /(^|\/)(__tests__|fixtures|test-utils|test-fixtures)\//.test(relativePath) ||
    /(?:^|\/)[^/]*(?:[.-](?:test|spec))(?:[.-][^/]+)?\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(
      relativePath,
    )
  );
}

function isProductionLikeFile(relativePath: string) {
  return !isTestLikePath(relativePath);
}

async function walkCodeFiles(rootDir: string) {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !isCodeFile(entry.name)) {
        continue;
      }
      const relativePath = normalizePath(fullPath);
      if (!isProductionLikeFile(relativePath)) {
        continue;
      }
      out.push(fullPath);
    }
  }
  await walk(rootDir);
  return out.toSorted((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

async function walkAllCodeFiles(rootDir: string, options: { includeTests?: boolean } = {}) {
  const out: string[] = [];
  const includeTests = options.includeTests === true;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !isCodeFile(entry.name)) {
        continue;
      }
      const relativePath = normalizePath(fullPath);
      if (!includeTests && !isProductionLikeFile(relativePath)) {
        continue;
      }
      out.push(fullPath);
    }
  }

  await walk(rootDir);
  return out.toSorted((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

function resolveRelativeSpecifier(specifier: string, importerFile: string) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  return normalizePath(path.resolve(path.dirname(importerFile), specifier));
}

function normalizePluginSdkFamily(resolvedPath: string) {
  const relative = resolvedPath.replace(/^src\/plugin-sdk\//, "");
  return relative.replace(/\.(m|c)?[jt]sx?$/, "");
}

function resolveOptionalClusterFromPath(resolvedPath: string) {
  if (resolvedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    const [, cluster] = resolvedPath.split("/");
    return cluster && optionalBundledClusterSet.has(cluster) ? cluster : null;
  }
  if (resolvedPath.startsWith("src/plugin-sdk/")) {
    const [cluster] = normalizePluginSdkFamily(resolvedPath).split("/");
    return cluster && optionalBundledClusterSet.has(cluster) ? cluster : null;
  }
  return null;
}

function compareImports(left: ImportEntry, right: ImportEntry) {
  return (
    left.family.localeCompare(right.family) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier)
  );
}

function collectPluginSdkImports(filePath: string, sourceFile: ts.SourceFile): ImportEntry[] {
  const entries: ImportEntry[] = [];

  function push(kind: string, specifierNode: ts.Node, specifier: string) {
    const resolvedPath = resolveRelativeSpecifier(specifier, filePath);
    if (!resolvedPath?.startsWith("src/plugin-sdk/")) {
      return;
    }
    entries.push({
      family: normalizePluginSdkFamily(resolvedPath),
      file: normalizePath(filePath),
      kind,
      line: toLine(sourceFile, specifierNode),
      resolvedPath,
      specifier,
    });
  }

  const visit = ({ kind, specifierNode, specifier }: ModuleSpecifierVisit) =>
    push(kind, specifierNode, specifier);
  visitModuleSpecifiers(ts, sourceFile, visit);
  return entries;
}

async function collectCorePluginSdkImports() {
  const files = await walkCodeFiles(srcRoot);
  const inventory: ImportEntry[] = [];
  for (const filePath of files) {
    if (normalizePath(filePath).startsWith("src/plugin-sdk/")) {
      continue;
    }
    const source = await fs.readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    inventory.push(...collectPluginSdkImports(filePath, sourceFile));
  }
  return inventory.toSorted(compareImports);
}

function collectOptionalClusterStaticImports(
  filePath: string,
  sourceFile: ts.SourceFile,
): OptionalClusterImportEntry[] {
  const entries: OptionalClusterImportEntry[] = [];

  function push(kind: string, specifierNode: ts.Node, specifier: string) {
    if (!specifier.startsWith(".")) {
      return;
    }
    const resolvedPath = resolveRelativeSpecifier(specifier, filePath);
    if (!resolvedPath) {
      return;
    }
    const cluster = resolveOptionalClusterFromPath(resolvedPath);
    if (!cluster) {
      return;
    }
    entries.push({
      cluster,
      file: normalizePath(filePath),
      kind,
      line: toLine(sourceFile, specifierNode),
      resolvedPath,
      specifier,
    });
  }

  const visit = ({ kind, specifierNode, specifier }: ModuleSpecifierVisit) => {
    if (kind !== "dynamic-import") {
      push(kind, specifierNode, specifier);
    }
  };
  visitModuleSpecifiers(ts, sourceFile, visit);
  return entries;
}

async function collectOptionalClusterStaticLeaks() {
  const files = await walkCodeFiles(srcRoot);
  const inventory: OptionalClusterImportEntry[] = [];
  for (const filePath of files) {
    const relativePath = normalizePath(filePath);
    if (relativePath.startsWith("src/plugin-sdk/")) {
      continue;
    }
    const source = await fs.readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    inventory.push(...collectOptionalClusterStaticImports(filePath, sourceFile));
  }
  return inventory.toSorted((left, right) => {
    return (
      left.cluster.localeCompare(right.cluster) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind) ||
      left.specifier.localeCompare(right.specifier)
    );
  });
}

function buildDuplicatedSeamFamilies(inventory: ImportEntry[]) {
  const grouped = new Map<string, ImportEntry[]>();
  for (const entry of inventory) {
    const bucket = grouped.get(entry.family) ?? [];
    bucket.push(entry);
    grouped.set(entry.family, bucket);
  }

  const duplicated = Object.fromEntries(
    [...grouped.entries()]
      .map(([family, entries]) => {
        const files = [...new Set(entries.map((entry) => entry.file))].toSorted(compareStrings);
        return [
          family,
          {
            count: files.length,
            importCount: entries.length,
            files,
            imports: entries,
          },
        ] as const;
      })
      .filter(([, value]) => value.files.length > 1)
      .toSorted((left, right) => {
        return (
          right[1].count - left[1].count ||
          right[1].importCount - left[1].importCount ||
          left[0].localeCompare(right[0])
        );
      }),
  );

  return duplicated;
}

function buildOverlapFiles(inventory: ImportEntry[]) {
  const byFile = new Map<string, ImportEntry[]>();
  for (const entry of inventory) {
    const bucket = byFile.get(entry.file) ?? [];
    bucket.push(entry);
    byFile.set(entry.file, bucket);
  }

  return [...byFile.entries()]
    .map(([file, entries]) => {
      const families = [...new Set(entries.map((entry) => entry.family))].toSorted(compareStrings);
      return {
        file,
        families,
        imports: entries,
      };
    })
    .filter((entry) => entry.families.length > 1)
    .toSorted((left, right) => {
      return (
        right.families.length - left.families.length ||
        right.imports.length - left.imports.length ||
        left.file.localeCompare(right.file)
      );
    });
}

function buildOptionalClusterStaticLeaks(inventory: OptionalClusterImportEntry[]) {
  const grouped = new Map<string, OptionalClusterImportEntry[]>();
  for (const entry of inventory) {
    const bucket = grouped.get(entry.cluster) ?? [];
    bucket.push(entry);
    grouped.set(entry.cluster, bucket);
  }

  return Object.fromEntries(
    [...grouped.entries()]
      .map(
        ([cluster, entries]) =>
          [
            cluster,
            {
              count: entries.length,
              files: [...new Set(entries.map((entry) => entry.file))].toSorted(compareStrings),
              imports: entries,
            },
          ] as const,
      )
      .toSorted((left, right) => {
        return right[1].count - left[1].count || left[0].localeCompare(right[0]);
      }),
  );
}

function packageClusterMeta(relativePackagePath: string) {
  if (relativePackagePath === "ui/package.json") {
    return {
      cluster: "ui",
      packageName: "openclaw-control-ui",
      packagePath: relativePackagePath,
      reachability: "workspace-ui",
    };
  }
  const cluster = path.basename(path.dirname(relativePackagePath));
  return {
    cluster,
    packageName: null,
    packagePath: relativePackagePath,
    reachability: relativePackagePath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)
      ? "extension-workspace"
      : "workspace",
  };
}

function classifyMissingPackageCluster(params: {
  cluster: string;
  pluginSdkEntries: string[];
  hasStaticLeak: boolean;
}) {
  if (params.hasStaticLeak) {
    return {
      decision: "required",
      reason:
        "Cluster already appears in the static graph in this audit run, so treating it as optional would be misleading.",
    };
  }
  if (optionalBundledClusterSet.has(params.cluster)) {
    if (params.cluster === "ui") {
      return {
        decision: "optional",
        reason:
          "Private UI workspace. Repo-wide CLI/plugin CI should not require UI-only packages.",
      };
    }
    if (params.pluginSdkEntries.length > 0) {
      return {
        decision: "optional",
        reason:
          "Public plugin-sdk entry exists, but repo-wide default check/build should isolate this optional cluster from the static graph.",
      };
    }
    return {
      decision: "optional",
      reason:
        "Workspace package is intentionally not mirrored into the root dependency set by default CI policy.",
    };
  }
  return {
    decision: "required",
    reason:
      "Cluster is statically visible to repo-wide check/build and has not been classified optional.",
  };
}

async function buildMissingPackages(params: { staticLeakClusters?: Set<string> } = {}) {
  const rootPackage: PackageJson = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const rootDeps = new Set([
    ...Object.keys(rootPackage.dependencies ?? {}),
    ...Object.keys(rootPackage.optionalDependencies ?? {}),
    ...Object.keys(rootPackage.devDependencies ?? {}),
  ]);

  const pluginSdkEntrySources = await walkCodeFiles(path.join(repoRoot, "src", "plugin-sdk"));
  const pluginSdkReachability = new Map<string, Set<string>>();
  for (const filePath of pluginSdkEntrySources) {
    const source = await fs.readFile(filePath, "utf8");
    const matches = [...source.matchAll(/from\s+"(\.\.\/\.\.\/extensions\/([^/]+)\/[^"]+)"/g)];
    for (const match of matches) {
      const cluster = match[2];
      if (!cluster) {
        continue;
      }
      const bucket = pluginSdkReachability.get(cluster) ?? new Set();
      bucket.add(normalizePath(filePath));
      pluginSdkReachability.set(cluster, bucket);
    }
  }

  const output = [];
  for (const relativePackagePath of workspacePackagePaths.toSorted(compareStrings)) {
    const packagePath = path.join(repoRoot, relativePackagePath);
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
    } catch {
      continue;
    }
    const missing = Object.keys(pkg.dependencies ?? {})
      .filter((dep) => dep !== "openclaw" && !rootDeps.has(dep))
      .toSorted(compareStrings);
    if (missing.length === 0) {
      continue;
    }
    const meta = packageClusterMeta(relativePackagePath);
    const pluginSdkEntries = [...(pluginSdkReachability.get(meta.cluster) ?? new Set())].toSorted(
      compareStrings,
    );
    const classification = classifyMissingPackageCluster({
      cluster: meta.cluster,
      pluginSdkEntries,
      hasStaticLeak: params.staticLeakClusters?.has(meta.cluster) === true,
    });
    output.push({
      cluster: meta.cluster,
      decision: classification.decision,
      decisionReason: classification.reason,
      packageName: pkg.name ?? meta.packageName,
      packagePath: relativePackagePath,
      npmSpec: redactNpmSpec(pkg.openclaw?.install?.npmSpec),
      private: pkg.private === true,
      pluginSdkReachability:
        pluginSdkEntries.length > 0 ? { staticEntryPoints: pluginSdkEntries } : undefined,
      missing,
    });
  }

  return output.toSorted((left, right) => {
    return right.missing.length - left.missing.length || left.cluster.localeCompare(right.cluster);
  });
}

function stemFromRelativePath(relativePath: string) {
  return relativePath.replace(/\.(m|c)?[jt]sx?$/, "");
}

function splitNameTokens(name: string) {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function hasImportSource(source: string, specifier: string, matchSuffix = false) {
  const escaped = escapeRegExp(specifier);
  const importSource = matchSuffix ? `(?:[^"']*/)?${escaped}` : escaped;
  return new RegExp(
    `from\\s+["']${importSource}["']|import\\s*\\(\\s*["']${importSource}["']\\s*\\)`,
  ).test(source);
}

function hasAnyImportSource(source: string, specifiers: string[]) {
  return specifiers.some((specifier) => hasImportSource(source, specifier));
}

function isCronProductionPath(relativePath: string) {
  return relativePath.startsWith("src/cron/") && isProductionLikeFile(relativePath);
}

function isSubagentProductionPath(relativePath: string) {
  return (
    (relativePath.startsWith("src/agents/") || relativePath.startsWith("src/cron/")) &&
    isProductionLikeFile(relativePath) &&
    (/subagent|sessions-spawn|acp-spawn/.test(relativePath) ||
      relativePath === "src/agents/tools/sessions-spawn-tool.ts" ||
      relativePath === "src/agents/tools/subagents-tool.ts")
  );
}

function describeCronSeamKinds(relativePath: string, source: string) {
  if (!isCronProductionPath(relativePath)) {
    return [];
  }

  const seamKinds = [];
  const importsAgentRunner = hasAnyImportSource(source, [
    "../../agents/cli-runner.js",
    "../../agents/embedded-agent.js",
    "../../agents/model-fallback.js",
    "../../agents/subagent-registry.js",
    "../../infra/agent-events.js",
  ]);
  const importsOutboundDelivery = hasAnyImportSource(source, [
    "../infra/outbound/deliver.js",
    "../../infra/outbound/deliver.js",
    "../infra/outbound/session-context.js",
    "../../infra/outbound/session-context.js",
    "../infra/outbound/identity.js",
    "../../infra/outbound/identity.js",
    "../cli/outbound-send-deps.js",
    "../../cli/outbound-send-deps.js",
  ]);
  const importsHeartbeat = hasAnyImportSource(source, [
    "../auto-reply/heartbeat.js",
    "../../auto-reply/heartbeat.js",
    "../infra/heartbeat-wake.js",
    "../../infra/heartbeat-wake.js",
  ]);
  const importsFollowup = hasAnyImportSource(source, [
    "./subagent-followup.js",
    "../../agents/subagent-registry.js",
    "../../agents/tools/agent-step.js",
    "../../gateway/call.js",
  ]);
  const importsSchedulerModules =
    relativePath.startsWith("src/cron/service/") &&
    hasAnyImportSource(source, [
      "./jobs.js",
      "./store.js",
      "./timer.js",
      "./state.js",
      "../schedule.js",
      "../store.js",
    ]);

  if (
    importsAgentRunner &&
    /\brunCliAgent\b|\brunEmbeddedAgent\b|\brunWithModelFallback\b|\bregisterAgentRunContext\b/.test(
      source,
    )
  ) {
    seamKinds.push("cron-agent-handoff");
  }

  if (
    importsOutboundDelivery &&
    /\bdeliverOutboundPayloads\b|\bbuildOutboundSessionContext\b|\bresolveAgentOutboundIdentity\b/.test(
      source,
    )
  ) {
    seamKinds.push("cron-outbound-delivery");
  }

  if (
    importsHeartbeat &&
    /\bstripHeartbeatToken\b|\bHeartbeat\b|\bheartbeat\b|\bnext-heartbeat\b/.test(source)
  ) {
    seamKinds.push("cron-heartbeat-handoff");
  }

  if (
    importsSchedulerModules &&
    /\bensureLoaded\b|\bpersist\b|\barmTimer\b|\brunMissedJobs\b|\bcomputeJobNextRunAtMs\b|\brecomputeNextRuns\b|\bnextWakeAtMs\b/.test(
      source,
    )
  ) {
    seamKinds.push("cron-scheduler-state");
  }

  if (
    importsOutboundDelivery &&
    /\bmediaUrl\b|\bmediaUrls\b|\bfilename\b|\baudioAsVoice\b|\bdeliveryPayloads\b|\bdeliveryPayloadHasStructuredContent\b/.test(
      source,
    )
  ) {
    seamKinds.push("cron-media-delivery");
  }

  if (
    importsFollowup &&
    /\bwaitForDescendantSubagentSummary\b|\breadDescendantSubagentFallbackReply\b|\bexpectsSubagentFollowup\b|\bcallGateway\b|\blistDescendantRunsForRequester\b/.test(
      source,
    )
  ) {
    seamKinds.push("cron-followup-handoff");
  }

  return seamKinds;
}

function describeSubagentSeamKinds(relativePath: string, source: string) {
  if (!isSubagentProductionPath(relativePath)) {
    return [];
  }

  const seamKinds = [];
  const isAnnounceDispatchPath =
    relativePath === "src/agents/subagents/announce/subagent-announce.ts" ||
    relativePath === "src/agents/subagents/announce/subagent-announce-dispatch.ts";
  const importsSpawnRuntime = hasAnyImportSource(source, [
    "./subagent-spawn.js",
    "./acp-spawn.js",
    "./subagents/spawn/subagent-spawn.js",
    "../subagents/spawn/subagent-spawn.js",
    "./subagents/spawn/acp-spawn.js",
    "../subagents/spawn/acp-spawn.js",
    "./subagent-registry.js",
    "../subagent-registry.js",
    "../../subagent-registry.js",
    "../acp/control-plane/manager.js",
    "../../../acp/control-plane/manager.js",
  ]);
  const importsLifecycleRegistry =
    hasImportSource(source, "subagent-registry.js", true) ||
    hasAnyImportSource(source, [
      "./subagent-registry-completion.js",
      "./subagent-registry-cleanup.js",
      "./subagent-registry-state.js",
      "./subagent-lifecycle-events.js",
      "../context-engine/init.js",
      "../context-engine/registry.js",
      "../sessions/session-lifecycle-events.js",
      "../../../context-engine/init.js",
      "../../../context-engine/registry.js",
      "../../../sessions/session-lifecycle-events.js",
    ]);
  const importsAnnounceDelivery = hasAnyImportSource(source, [
    "./subagent-announce.js",
    "./subagent-announce-dispatch.js",
    "../announce/subagent-announce.js",
    "../announce/subagent-announce-dispatch.js",
    "./subagent-announce-queue.js",
    "../infra/outbound/bound-delivery-router.js",
    "../utils/delivery-context.shared.js",
    "../gateway/call.js",
    "../../../infra/outbound/bound-delivery-router.js",
    "../../../utils/delivery-context.shared.js",
    "../../../gateway/call.js",
  ]);
  const importsCleanup = hasAnyImportSource(source, [
    "../gateway/call.js",
    "./subagent-registry-cleanup.js",
    "../acp/control-plane/spawn.js",
    "../../../gateway/call.js",
    "../../../acp/control-plane/spawn.js",
  ]);
  const importsParentStream = hasAnyImportSource(source, [
    "./acp-spawn-parent-stream.js",
    "../infra/heartbeat-wake.js",
    "../infra/system-events.js",
    "../infra/agent-events.js",
    "../../../infra/heartbeat-wake.js",
    "../../../infra/system-events.js",
    "../../../infra/agent-events.js",
  ]);

  if (
    importsSpawnRuntime &&
    /\bspawnSubagentDirect\b|\bspawnAcpDirect\b|\bregisterSubagentRun\b|\bgetAcpSessionManager\b|\bspawnSubagent\b|\bspawnAcp\b/.test(
      source,
    )
  ) {
    seamKinds.push("subagent-session-spawn");
  }

  if (
    importsLifecycleRegistry &&
    /\bemitSubagentEndedHookOnce\b|\bresolveDeferredCleanupDecision\b|\bpersistSubagentRunsToDisk\b|\brestoreSubagentRunsFromDisk\b|\bresolveContextEngine\b|\bemitSessionLifecycleEvent\b|\bcaptureSubagentCompletionReply\b/.test(
      source,
    )
  ) {
    seamKinds.push("subagent-lifecycle-registry");
  }

  if (
    (importsAnnounceDelivery || isAnnounceDispatchPath) &&
    /\brunSubagentAnnounceFlow\b|\brunSubagentAnnounceDispatch\b|\benqueueAnnounce\b|\bcreateBoundDeliveryRouter\b|\bqueueEmbeddedAgentMessage\b|\bwaitForEmbeddedAgentRunEnd\b|\bqueue-fallback\b|\bdirect-primary\b/.test(
      source,
    )
  ) {
    seamKinds.push("subagent-announce-delivery");
  }

  if (
    importsCleanup &&
    /\bsessions\.delete\b|\bdeleteTranscript\b|\bcleanupFailedAcpSpawn\b|\bcleanupProvisionalSession\b|\bcleanupFailedSpawnBeforeAgentStart\b|\bresolveDeferredCleanupDecision\b/.test(
      source,
    )
  ) {
    seamKinds.push("subagent-session-cleanup");
  }

  if (
    importsParentStream &&
    /\bstartAcpSpawnParentStreamRelay\b|\brequestHeartbeatNow\b|\benqueueSystemEvent\b|\bonAgentEvent\b|\bstreamTo\b/.test(
      source,
    )
  ) {
    seamKinds.push("subagent-parent-stream");
  }

  return seamKinds;
}

export function describeSeamKinds(relativePath: string, source: string) {
  const seamKinds = [];
  const isReplyDeliveryPath =
    /reply-delivery|reply-dispatcher|deliver-reply|reply\/.*delivery|monitor\/(?:replies|deliver|native-command)|outbound\/deliver|outbound\/message/.test(
      relativePath,
    );
  const isChannelMediaAdapterPath =
    (relativePath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX) &&
      /(outbound|outbound-adapter|reply-delivery|send|delivery|messenger|channel(?:\.runtime)?)\.ts$/.test(
        relativePath,
      )) ||
    /^src\/channels\/plugins\/outbound\/[^/]+\.ts$/.test(relativePath);
  if (
    relativePath.startsWith("src/agents/tools/") &&
    source.includes("details") &&
    source.includes("media") &&
    /details\s*:\s*{[\s\S]*\bmedia\b\s*:/.test(source)
  ) {
    seamKinds.push("tool-result-media");
  }
  if (
    isReplyDeliveryPath &&
    /\bmediaUrl\b|\bmediaUrls\b|resolveSendableOutboundReplyParts/.test(source)
  ) {
    seamKinds.push("reply-delivery-media");
  }
  if (
    isChannelMediaAdapterPath &&
    (/sendMedia\b/.test(source) || /\bmediaUrl\b|\bmediaUrls\b|filename|audioAsVoice/.test(source))
  ) {
    seamKinds.push("channel-media-adapter");
  }
  if (
    isReplyDeliveryPath &&
    /blockStreamingEnabled|directlySentBlockKeys|resolveSendableOutboundReplyParts/.test(source) &&
    /\bmediaUrl\b|\bmediaUrls\b/.test(source)
  ) {
    seamKinds.push("streaming-media-handoff");
  }
  seamKinds.push(...describeCronSeamKinds(relativePath, source));
  seamKinds.push(...describeSubagentSeamKinds(relativePath, source));
  return [...new Set(seamKinds)].toSorted(compareStrings);
}

async function buildTestIndex(testFiles: string[]) {
  return Promise.all(
    testFiles.map(async (filePath) => {
      const relativePath = normalizePath(filePath);
      const stem = stemFromRelativePath(relativePath)
        .replace(/\.test$/, "")
        .replace(/\.spec$/, "");
      const baseName = path.basename(stem);
      const source = await readScannableText(filePath);
      return {
        filePath,
        relativePath,
        stem,
        baseName,
        source,
      };
    }),
  );
}

type TestIndexEntry = Awaited<ReturnType<typeof buildTestIndex>>[number];

function hasExecutableImportReference(source: string, importPath: string) {
  const escapedImportPath = escapeRegExp(importPath);
  const suffix = String.raw`(?:\.[^"'\\\`]+)?`;
  const patterns = [
    new RegExp(String.raw`\bfrom\s*["'\`]${escapedImportPath}${suffix}["'\`]`),
    new RegExp(String.raw`\bimport\s*["'\`]${escapedImportPath}${suffix}["'\`]`),
    new RegExp(String.raw`\brequire\s*\(\s*["'\`]${escapedImportPath}${suffix}["'\`]\s*\)`),
    new RegExp(String.raw`\bimport\s*\(\s*["'\`]${escapedImportPath}${suffix}["'\`]\s*\)`),
  ];
  return patterns.some((pattern) => pattern.test(source));
}

function hasModuleMockReference(source: string, importPath: string) {
  const escapedImportPath = escapeRegExp(importPath);
  const suffix = String.raw`(?:\.[^"'\\\`]+)?`;
  const patterns = [
    new RegExp(String.raw`\bvi\.mock\s*\(\s*["'\`]${escapedImportPath}${suffix}["'\`]`),
    new RegExp(String.raw`\bjest\.mock\s*\(\s*["'\`]${escapedImportPath}${suffix}["'\`]`),
  ];
  return patterns.some((pattern) => pattern.test(source));
}

const matchQualityRank = (quality: MatchQuality) => MATCH_QUALITY_RANK[quality] ?? 4;

function findRelatedTests(relativePath: string, testIndex: TestIndexEntry[]): RelatedTestMatch[] {
  const stem = stemFromRelativePath(relativePath);
  const baseName = path.basename(stem);
  const dirName = path.dirname(relativePath);
  const normalizedDir = dirName.split(path.sep).join("/");
  const baseTokens = new Set(splitNameTokens(baseName).filter((token) => token.length >= 7));

  const matches: RelatedTestMatch[] = testIndex.flatMap((entry): RelatedTestMatch[] => {
    if (entry.stem === stem) {
      return [{ file: entry.relativePath, matchQuality: "exact-stem" }];
    }
    if (entry.stem.startsWith(`${stem}.`)) {
      return [{ file: entry.relativePath, matchQuality: "path-nearby" }];
    }
    const entryDir = path.dirname(entry.relativePath).split(path.sep).join("/");
    const importPath =
      path.posix.relative(entryDir, stem) === path.basename(stem)
        ? `./${path.basename(stem)}`
        : path.posix.relative(entryDir, stem).startsWith(".")
          ? path.posix.relative(entryDir, stem)
          : `./${path.posix.relative(entryDir, stem)}`;
    if (
      hasExecutableImportReference(entry.source, importPath) &&
      !hasModuleMockReference(entry.source, importPath)
    ) {
      return [{ file: entry.relativePath, matchQuality: "direct-import" }];
    }
    if (entryDir === normalizedDir && baseTokens.size > 0) {
      const entryTokens = splitNameTokens(entry.baseName);
      const sharedToken = entryTokens.find((token) => baseTokens.has(token));
      if (sharedToken) {
        return [{ file: entry.relativePath, matchQuality: "dir-token" }];
      }
    }
    return [];
  });

  const byFile = new Map<string, RelatedTestMatch>();
  for (const match of matches) {
    const existing = byFile.get(match.file);
    if (
      !existing ||
      matchQualityRank(match.matchQuality) < matchQualityRank(existing.matchQuality)
    ) {
      byFile.set(match.file, match);
    }
  }

  return [...byFile.values()].toSorted((left, right) => {
    return (
      matchQualityRank(left.matchQuality) - matchQualityRank(right.matchQuality) ||
      left.file.localeCompare(right.file)
    );
  });
}

export function determineSeamTestStatus(
  seamKinds: string[],
  relatedTestMatches: RelatedTestMatch[],
) {
  if (relatedTestMatches.length === 0) {
    return {
      status: "gap",
      reason: "No nearby test file references this seam candidate.",
    };
  }

  const bestMatch = relatedTestMatches[0]?.matchQuality ?? "unknown";
  if (
    seamKinds.includes("reply-delivery-media") ||
    seamKinds.includes("streaming-media-handoff") ||
    seamKinds.includes("tool-result-media") ||
    seamKinds.includes("cron-agent-handoff") ||
    seamKinds.includes("cron-outbound-delivery") ||
    seamKinds.includes("cron-heartbeat-handoff") ||
    seamKinds.includes("cron-scheduler-state") ||
    seamKinds.includes("cron-media-delivery") ||
    seamKinds.includes("cron-followup-handoff") ||
    seamKinds.includes("subagent-session-spawn") ||
    seamKinds.includes("subagent-lifecycle-registry") ||
    seamKinds.includes("subagent-announce-delivery") ||
    seamKinds.includes("subagent-session-cleanup") ||
    seamKinds.includes("subagent-parent-stream")
  ) {
    return {
      status: "partial",
      reason: `Nearby tests exist (best match: ${bestMatch}), but this inventory does not prove cross-layer seam coverage end to end.`,
    };
  }
  return {
    status: "heuristic-nearby",
    reason: `Nearby tests exist (best match: ${bestMatch}), but this remains a filename/path heuristic rather than proof of seam assertions.`,
  };
}

async function buildSeamTestInventory() {
  const productionFiles = [
    ...(await walkCodeFiles(srcRoot)),
    ...(await walkCodeFiles(extensionsRoot)),
  ].toSorted((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  const testFiles = [
    ...(await walkAllCodeFiles(srcRoot, { includeTests: true })),
    ...(await walkAllCodeFiles(extensionsRoot, { includeTests: true })),
    ...(await walkAllCodeFiles(testRoot, { includeTests: true })),
  ]
    .filter((filePath) => /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(filePath))
    .toSorted((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  const testIndex = await buildTestIndex(testFiles);
  const inventory = [];

  for (const filePath of productionFiles) {
    const relativePath = normalizePath(filePath);
    const source = await readScannableText(filePath);
    const seamKinds = describeSeamKinds(relativePath, source);
    if (seamKinds.length === 0) {
      continue;
    }
    const relatedTestMatches = findRelatedTests(relativePath, testIndex);
    const status = determineSeamTestStatus(seamKinds, relatedTestMatches);
    inventory.push({
      file: relativePath,
      seamKinds,
      relatedTests: relatedTestMatches.map((entry) => entry.file),
      relatedTestMatches,
      status: status.status,
      reason: status.reason,
    });
  }

  return inventory.toSorted((left, right) => {
    return (
      left.status.localeCompare(right.status) ||
      left.file.localeCompare(right.file) ||
      left.seamKinds.join(",").localeCompare(right.seamKinds.join(","))
    );
  });
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  await collectWorkspacePackagePaths();
  const inventory = await collectCorePluginSdkImports();
  const optionalClusterStaticLeaks = await collectOptionalClusterStaticLeaks();
  const staticLeakClusters = new Set(optionalClusterStaticLeaks.map((entry) => entry.cluster));
  const result = {
    duplicatedSeamFamilies: buildDuplicatedSeamFamilies(inventory),
    overlapFiles: buildOverlapFiles(inventory),
    optionalClusterStaticLeaks: buildOptionalClusterStaticLeaks(optionalClusterStaticLeaks),
    missingPackages: await buildMissingPackages({ staticLeakClusters }),
    seamTestInventory: await buildSeamTestInventory(),
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryFilePath === fileURLToPath(import.meta.url)) {
  await main();
}
