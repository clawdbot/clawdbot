#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";
import {
  collectAllResolvedPackagesFromLockfile,
  createBulkAdvisoryPayload,
} from "./pre-commit/pnpm-audit-prod.mjs";

const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const EXACT_NPM_ALIAS_PATTERN =
  /^npm:(?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const PINNED_GIT_PATTERN = /(?:#|\/commit\/)[0-9a-f]{40}$/iu;
const EXOTIC_SPEC_PATTERN = /^(?:git\+|github:|gitlab:|bitbucket:|https?:)/iu;
const RECENTLY_PUBLISHED_VERSION_TYPE = "recently-published-version";

function isAllowedPinnedSpec(spec) {
  if (typeof spec !== "string") {
    return false;
  }
  if (EXACT_SEMVER_PATTERN.test(spec) || EXACT_NPM_ALIAS_PATTERN.test(spec)) {
    return true;
  }
  if (spec === "workspace:*" || spec.startsWith("file:") || spec.startsWith("link:")) {
    return true;
  }
  if (/^(?:git\+|github:|gitlab:|bitbucket:)/u.test(spec)) {
    return PINNED_GIT_PATTERN.test(spec);
  }
  return false;
}

function encodePackageName(name) {
  return name.startsWith("@") ? name.replace("/", "%2f") : name;
}

function resolveRegistryBaseUrl() {
  const configured =
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    process.env.npm_config_userconfig_registry ??
    "https://registry.npmjs.org";
  return configured.replace(/\/+$/u, "");
}

function isExoticResolvedVersion(version) {
  return EXOTIC_SPEC_PATTERN.test(version);
}

function packageVersionsFromPayload(payload) {
  return Object.entries(payload).flatMap(([packageName, versions]) =>
    versions.map((version) => ({ packageName, version })),
  );
}

async function loadWorkspaceRiskSettings(rootDir) {
  const workspacePath = path.join(rootDir, "pnpm-workspace.yaml");
  try {
    const workspace = YAML.parse(await readFile(workspacePath, "utf8"));
    return {
      minimumReleaseAgeMinutes:
        typeof workspace?.minimumReleaseAge === "number" ? workspace.minimumReleaseAge : null,
      minimumReleaseAgeExclude: Array.isArray(workspace?.minimumReleaseAgeExclude)
        ? workspace.minimumReleaseAgeExclude.filter((entry) => typeof entry === "string")
        : [],
    };
  } catch {
    return { minimumReleaseAgeMinutes: null, minimumReleaseAgeExclude: [] };
  }
}

function splitMinimumReleaseAgeExcludeSelector(selector) {
  const trimmed = selector.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("@")) {
    const scopeSeparatorIndex = trimmed.indexOf("/");
    const versionSeparatorIndex =
      scopeSeparatorIndex === -1 ? -1 : trimmed.indexOf("@", scopeSeparatorIndex + 1);
    if (versionSeparatorIndex === -1) {
      return { packagePattern: trimmed, versionSelectors: [] };
    }
    return {
      packagePattern: trimmed.slice(0, versionSeparatorIndex),
      versionSelectors: trimmed
        .slice(versionSeparatorIndex + 1)
        .split("||")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  }

  const versionSeparatorIndex = trimmed.indexOf("@");
  if (versionSeparatorIndex === -1) {
    return { packagePattern: trimmed, versionSelectors: [] };
  }
  return {
    packagePattern: trimmed.slice(0, versionSeparatorIndex),
    versionSelectors: trimmed
      .slice(versionSeparatorIndex + 1)
      .split("||")
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function packagePatternMatches(pattern, packageName) {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "u");
  return regex.test(packageName);
}

function matchesMinimumReleaseAgeExclude(selector, packageName, version) {
  const parsed = splitMinimumReleaseAgeExcludeSelector(selector);
  if (!parsed || !packagePatternMatches(parsed.packagePattern, packageName)) {
    return false;
  }
  return parsed.versionSelectors.length === 0 || parsed.versionSelectors.includes(version);
}

function findMinimumReleaseAgeExcludeSelector(selectors, packageName, version) {
  return selectors.find((selector) =>
    matchesMinimumReleaseAgeExclude(selector, packageName, version),
  );
}

function collectManifestFindings({
  packageName,
  version,
  manifest,
  publishedAt,
  now,
  minimumReleaseAgeMinutes,
  minimumReleaseAgeExclude = [],
}) {
  const findings = [];
  const workspaceExcludedFindings = [];
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [dependencyName, spec] of Object.entries(manifest[section] ?? {})) {
      if (!isAllowedPinnedSpec(spec)) {
        findings.push({
          type: "floating-transitive-spec",
          packageName,
          version,
          dependency: { name: dependencyName, spec, section },
        });
      }
      if (typeof spec === "string" && EXOTIC_SPEC_PATTERN.test(spec)) {
        findings.push({
          type: "exotic-source",
          packageName,
          version,
          source: spec,
          dependency: { name: dependencyName, spec, section },
        });
      }
    }
  }

  const scripts = manifest.scripts ?? {};
  for (const script of INSTALL_LIFECYCLE_SCRIPTS) {
    if (typeof scripts[script] === "string") {
      findings.push({ type: "lifecycle-script", packageName, version, script });
    }
  }

  if (!publishedAt) {
    findings.push({ type: "missing-publish-time", packageName, version });
  } else if (typeof minimumReleaseAgeMinutes === "number") {
    const ageMs = now.getTime() - Date.parse(publishedAt);
    if (Number.isFinite(ageMs) && ageMs < minimumReleaseAgeMinutes * 60_000) {
      const finding = {
        type: RECENTLY_PUBLISHED_VERSION_TYPE,
        packageName,
        version,
        publishedAt,
        minimumReleaseAgeMinutes,
      };
      const exclusion = findMinimumReleaseAgeExcludeSelector(
        minimumReleaseAgeExclude,
        packageName,
        version,
      );
      if (exclusion) {
        workspaceExcludedFindings.push({
          ...finding,
          workspaceExcluded: true,
          workspaceExclusion: exclusion,
        });
      } else {
        findings.push(finding);
      }
    }
  }

  return { findings, workspaceExcludedFindings };
}

async function fetchNpmManifest({ packageName, version, fetchImpl, registryBaseUrl }) {
  const response = await fetchImpl(`${registryBaseUrl}/${encodePackageName(packageName)}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const packument = await response.json();
  const manifest = packument.versions?.[version];
  if (!manifest) {
    throw new Error(`version ${version} not found`);
  }
  return {
    manifest,
    publishedAt: typeof packument.time?.[version] === "string" ? packument.time[version] : null,
  };
}

export async function createTransitiveManifestRiskReport({
  packageVersions,
  manifestLoader,
  now = new Date(),
  minimumReleaseAgeMinutes = null,
  minimumReleaseAgeExclude = [],
}) {
  const findings = [];
  const workspaceExcludedFindings = [];
  const metadataFailures = [];
  for (const { packageName, version } of packageVersions) {
    if (isExoticResolvedVersion(version)) {
      findings.push({
        type: "exotic-source",
        packageName,
        version,
        source: version,
      });
      continue;
    }
    try {
      const { manifest, publishedAt } = await manifestLoader({ packageName, version });
      const manifestFindings = collectManifestFindings({
        packageName,
        version,
        manifest,
        publishedAt,
        now,
        minimumReleaseAgeMinutes,
        minimumReleaseAgeExclude,
      });
      findings.push(...manifestFindings.findings);
      workspaceExcludedFindings.push(...manifestFindings.workspaceExcludedFindings);
    } catch (error) {
      metadataFailures.push({
        packageName,
        version,
        error: String(error?.message ?? error),
      });
    }
  }
  const sortedFindings = findings.toSorted((left, right) => {
    if (left.type !== right.type) {
      return left.type.localeCompare(right.type);
    }
    if (left.packageName !== right.packageName) {
      return left.packageName.localeCompare(right.packageName);
    }
    return left.version.localeCompare(right.version);
  });
  const byType = sortedFindings.reduce((counts, finding) => {
    counts[finding.type] = (counts[finding.type] ?? 0) + 1;
    return counts;
  }, {});
  return {
    generatedAt: now.toISOString(),
    packageVersions: packageVersions.length,
    findingCount: sortedFindings.length,
    byType,
    workspacePolicy: {
      minimumReleaseAgeMinutes,
      minimumReleaseAgeExclude,
    },
    workspaceExcludedFindingCount: workspaceExcludedFindings.length,
    workspaceExcludedByType: workspaceExcludedFindings.reduce((counts, finding) => {
      counts[finding.type] = (counts[finding.type] ?? 0) + 1;
      return counts;
    }, {}),
    workspaceExcludedFindings: workspaceExcludedFindings.toSorted((left, right) => {
      if (left.type !== right.type) {
        return left.type.localeCompare(right.type);
      }
      if (left.packageName !== right.packageName) {
        return left.packageName.localeCompare(right.packageName);
      }
      return left.version.localeCompare(right.version);
    }),
    metadataFailures,
    findings: sortedFindings,
  };
}

function markdownCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function findingPackageKey(finding) {
  return `${finding.packageName}@${finding.version}`;
}

function incrementMapCount(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCountEntries(map) {
  return [...map.entries()].toSorted((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });
}

function typeBreakdown(findings) {
  const counts = new Map();
  for (const finding of findings) {
    incrementMapCount(counts, finding.type);
  }
  return [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
}

function collectMarkdownRollups(findings) {
  const packageFindings = new Map();
  const floatingTargets = new Map();
  const lifecyclePackages = new Map();
  const recentlyPublishedVersions = [];
  const exoticSources = [];

  for (const finding of findings) {
    const packageKey = findingPackageKey(finding);
    const packageList = packageFindings.get(packageKey) ?? [];
    packageList.push(finding);
    packageFindings.set(packageKey, packageList);

    if (finding.type === "floating-transitive-spec" && finding.dependency?.name) {
      const target = floatingTargets.get(finding.dependency.name) ?? {
        declarations: 0,
        sourcePackages: new Set(),
        specifiers: new Map(),
      };
      target.declarations += 1;
      target.sourcePackages.add(packageKey);
      incrementMapCount(target.specifiers, finding.dependency.spec ?? "unknown");
      floatingTargets.set(finding.dependency.name, target);
    }

    if (finding.type === "lifecycle-script") {
      const scripts = lifecyclePackages.get(packageKey) ?? new Set();
      scripts.add(finding.script ?? "unknown");
      lifecyclePackages.set(packageKey, scripts);
    }

    if (finding.type === RECENTLY_PUBLISHED_VERSION_TYPE) {
      recentlyPublishedVersions.push(finding);
    }

    if (finding.type === "exotic-source") {
      exoticSources.push(finding);
    }
  }

  return {
    packageFindings,
    floatingTargets,
    lifecyclePackages,
    recentlyPublishedVersions,
    exoticSources,
  };
}

function renderCompleteEvidence(lines) {
  lines.push("## Complete Evidence", "");
  lines.push(
    "The complete reported signal list is available in the JSON report, including every package, version, dependency, and specifier. Recently published versions covered by pnpm workspace release-age exclusions are listed separately under workspaceExcludedFindings. The sections below summarize the same data by package, dependency target, and finding class for human review.",
  );
  lines.push("");
}

function renderPackageFindingSummary(lines, packageFindings) {
  lines.push("## Published Package Manifests With Risk Findings", "");
  for (const [packageKey, findings] of [...packageFindings.entries()].toSorted((left, right) => {
    if (right[1].length !== left[1].length) {
      return right[1].length - left[1].length;
    }
    return left[0].localeCompare(right[0]);
  })) {
    lines.push(
      `- ${markdownCode(packageKey)}: ${pluralize(findings.length, "manifest finding")} ` +
        `(${typeBreakdown(findings)})`,
    );
  }
  lines.push("");
}

function renderFloatingDependencyTargets(lines, floatingTargets) {
  if (floatingTargets.size === 0) {
    return;
  }

  lines.push("## Floating Dependency Targets", "");
  for (const [dependencyName, detail] of [...floatingTargets.entries()].toSorted((left, right) => {
    if (right[1].declarations !== left[1].declarations) {
      return right[1].declarations - left[1].declarations;
    }
    return left[0].localeCompare(right[0]);
  })) {
    const specifiers = sortedCountEntries(detail.specifiers)
      .map(([specifier, count]) => `${specifier}: ${count}`)
      .join(", ");
    lines.push(
      `- ${markdownCode(dependencyName)}: ${detail.declarations} declarations from ` +
        `${detail.sourcePackages.size} resolved packages; specifiers: ${specifiers}`,
    );
  }
  lines.push("");
}

function renderLifecycleScriptPackages(lines, lifecyclePackages) {
  if (lifecyclePackages.size === 0) {
    return;
  }

  lines.push("## Lifecycle Script Packages", "");
  for (const [packageKey, scripts] of [...lifecyclePackages.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(
      `- ${markdownCode(packageKey)}: ${[...scripts]
        .toSorted((left, right) => left.localeCompare(right))
        .join(", ")}`,
    );
  }
  lines.push("");
}

function renderRecentlyPublishedVersions(lines, findings, heading) {
  if (findings.length === 0) {
    return;
  }

  lines.push(`## ${heading}`, "");
  const minimumReleaseAgeMinutes = findings.find(
    (finding) => typeof finding.minimumReleaseAgeMinutes === "number",
  )?.minimumReleaseAgeMinutes;
  if (typeof minimumReleaseAgeMinutes === "number") {
    lines.push(`Workspace minimum release age: ${minimumReleaseAgeMinutes} minutes.`, "");
  }
  for (const finding of findings.toSorted((left, right) => {
    const dateDelta = Date.parse(right.publishedAt ?? "") - Date.parse(left.publishedAt ?? "");
    if (Number.isFinite(dateDelta) && dateDelta !== 0) {
      return dateDelta;
    }
    return findingPackageKey(left).localeCompare(findingPackageKey(right));
  })) {
    const suffix = finding.workspaceExclusion
      ? `; workspace exclusion ${markdownCode(finding.workspaceExclusion)}`
      : "";
    lines.push(
      `- ${markdownCode(findingPackageKey(finding))}: published ${finding.publishedAt}${suffix}`,
    );
  }
  lines.push("");
}

function renderExoticSources(lines, exoticSources) {
  if (exoticSources.length === 0) {
    return;
  }

  lines.push("## Exotic Sources", "");
  for (const finding of exoticSources.toSorted((left, right) =>
    findingPackageKey(left).localeCompare(findingPackageKey(right)),
  )) {
    lines.push(`- ${markdownCode(findingPackageKey(finding))}: source ${finding.source}`);
  }
  lines.push("");
}

export function renderTransitiveManifestRiskMarkdownReport(report) {
  const lines = [
    "# Transitive Manifest Risk Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Scope",
    "",
    "This report inspects published package manifests for resolved packages in the lockfile. It looks for supply-chain risk signals such as floating dependency specs, lifecycle scripts, exotic sources, recently published versions, and missing publish time metadata. It is report-only.",
    "",
    "## Summary",
    "",
    `- Resolved package versions inspected: ${report.packageVersions}`,
    `- Reported risk signals: ${report.findingCount}`,
    `- Signals covered by workspace policy exclusions: ${report.workspaceExcludedFindingCount ?? 0}`,
    `- Metadata failures: ${report.metadataFailures.length}`,
    "",
    "## Reported Risk Signals By Type",
    "",
  ];
  for (const [type, count] of Object.entries(report.byType).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`- ${type}: ${count}`);
  }
  lines.push("");

  if (Object.keys(report.workspaceExcludedByType ?? {}).length > 0) {
    lines.push("## Signals Covered By Workspace Policy Exclusions", "");
    lines.push(
      "These are not included in the reported risk signal totals above. They are tracked separately because the workspace package-manager policy already excludes them.",
    );
    lines.push("");
    for (const [type, count] of Object.entries(report.workspaceExcludedByType ?? {}).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      lines.push(`- ${type}: ${count}`);
    }
    lines.push("");
  }

  renderCompleteEvidence(lines);

  if (report.findings.length > 0) {
    const rollups = collectMarkdownRollups(report.findings);
    renderPackageFindingSummary(lines, rollups.packageFindings);
    renderFloatingDependencyTargets(lines, rollups.floatingTargets);
    renderLifecycleScriptPackages(lines, rollups.lifecyclePackages);
    renderExoticSources(lines, rollups.exoticSources);
    renderRecentlyPublishedVersions(
      lines,
      rollups.recentlyPublishedVersions,
      "Recently Published Versions Not Covered By Workspace Exclusions",
    );
  }

  renderRecentlyPublishedVersions(
    lines,
    report.workspaceExcludedFindings ?? [],
    "Recently Published Versions Covered By Workspace Exclusions",
  );

  if (report.metadataFailures.length > 0) {
    lines.push("## Metadata Failures", "");
    for (const failure of report.metadataFailures) {
      lines.push(
        `- ${markdownCode(`${failure.packageName}@${failure.version}`)}: ${failure.error}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

const renderMarkdownReport = renderTransitiveManifestRiskMarkdownReport;

function parseArgs(argv) {
  const options = {
    rootDir: process.cwd(),
    jsonPath: null,
    markdownPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--root") {
      options.rootDir = argv[++index];
      continue;
    }
    if (arg === "--json") {
      options.jsonPath = argv[++index];
      continue;
    }
    if (arg === "--markdown") {
      options.markdownPath = argv[++index];
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

async function writeArtifact(filePath, content) {
  if (!filePath) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function runTransitiveManifestRiskReport({
  rootDir = process.cwd(),
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const lockfileText = await readFile(path.join(rootDir, "pnpm-lock.yaml"), "utf8");
  const payload = createBulkAdvisoryPayload(collectAllResolvedPackagesFromLockfile(lockfileText));
  const packageVersions = packageVersionsFromPayload(payload);
  const settings = await loadWorkspaceRiskSettings(rootDir);
  return createTransitiveManifestRiskReport({
    packageVersions,
    now,
    minimumReleaseAgeMinutes: settings.minimumReleaseAgeMinutes,
    minimumReleaseAgeExclude: settings.minimumReleaseAgeExclude,
    manifestLoader: ({ packageName, version }) =>
      fetchNpmManifest({
        packageName,
        version,
        fetchImpl,
        registryBaseUrl: resolveRegistryBaseUrl(),
      }),
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = await runTransitiveManifestRiskReport({
    rootDir: options.rootDir,
  });
  await writeArtifact(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeArtifact(options.markdownPath, renderMarkdownReport(report));
  const artifactHint =
    typeof options.markdownPath === "string" ? " See " + options.markdownPath + "." : "";
  process.stdout.write(
    `INFO transitive manifest risk report: inspected ${report.packageVersions} resolved ` +
      `package manifests; ${report.findingCount} reported risk signals, ` +
      `${report.metadataFailures.length} metadata failures; release not blocked.${artifactHint}\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
