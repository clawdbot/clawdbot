#!/usr/bin/env node

// Reports transitive npm package manifest risks such as lifecycle scripts,
// exotic specs, and recently published versions.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import YAML from "yaml";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import { escapeRegExp } from "./lib/regexp.mjs";
import { parseReportCliArgs, writeReportArtifact } from "./lib/report-cli-helpers.mts";
import {
  collectAllResolvedPackagesFromLockfile,
  createBulkAdvisoryPayload,
} from "./pre-commit/pnpm-audit-prod.mjs";

const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const EXACT_NPM_ALIAS_PATTERN =
  /^npm:(?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const PINNED_GIT_PATTERN = /(?:#|\/commit\/)[0-9a-f]{40}$/iu;
const PINNED_GITHUB_TARBALL_PATTERN =
  /^https:\/\/codeload\.github\.com\/[^/\s]+\/[^/\s]+\/tar\.gz\/[0-9a-f]{40}$/iu;
const EXOTIC_SPEC_PATTERN = /^(?:git\+|github:|gitlab:|bitbucket:|https?:)/iu;
const RECENTLY_PUBLISHED_VERSION_TYPE = "recently-published-version";
const NPM_PACKUMENT_ACCEPT_HEADER = "application/json";
/** Maximum npm packument response size accepted by the risk scanner. */
const NPM_PACKUMENT_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const NPM_PACKUMENT_FETCH_TIMEOUT_MS = 60_000;

type PackageVersion = { packageName: string; version: string };
type ManifestFinding = PackageVersion & {
  type: string;
  dependency?: { name: string; spec: unknown; section: string };
  source?: string;
  script?: string;
  publishedAt?: string;
  minimumReleaseAgeMinutes?: number;
  workspaceExcluded?: boolean;
  workspaceExclusion?: string;
};
type ManifestLoadResult = { manifest: Record<string, unknown>; publishedAt: string | null };
type ManifestFindingsOptions = PackageVersion &
  ManifestLoadResult & {
    now: Date;
    minimumReleaseAgeMinutes: number | null;
    minimumReleaseAgeExclude?: string[];
  };

function isAllowedPinnedSpec(spec: unknown) {
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
  if (PINNED_GITHUB_TARBALL_PATTERN.test(spec)) {
    return true;
  }
  return false;
}

function encodePackageName(name: string) {
  return encodeURIComponent(name).replace(/^%40/u, "@");
}

function resolveRegistryBaseUrl() {
  const configured =
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    process.env.npm_config_userconfig_registry ??
    "https://registry.npmjs.org";
  return configured.replace(/\/+$/u, "");
}

export async function readBoundedNpmRegistryText(
  response: Response,
  maxBytes = NPM_PACKUMENT_RESPONSE_MAX_BYTES,
  options: { signal?: AbortSignal } = {},
) {
  return await readBoundedResponseText(response, "npm registry", maxBytes, {
    signal: options.signal,
    formatTooLargeMessage: (_label: string, bytes: number) =>
      `npm registry response exceeded ${bytes} bytes`,
  });
}

function packageVersionsFromPayload(payload: unknown): PackageVersion[] {
  return Object.entries(asRecord(payload)).flatMap(([packageName, versions]) =>
    Array.isArray(versions)
      ? versions.flatMap((version) =>
          typeof version === "string" ? [{ packageName, version }] : [],
        )
      : [],
  );
}

async function loadWorkspaceRiskSettings(rootDir: string) {
  const workspacePath = path.join(rootDir, "pnpm-workspace.yaml");
  try {
    const workspace = asRecord(YAML.parse(await readFile(workspacePath, "utf8")));
    const { minimumReleaseAge, minimumReleaseAgeExclude } = workspace;
    return {
      minimumReleaseAgeMinutes: typeof minimumReleaseAge === "number" ? minimumReleaseAge : null,
      minimumReleaseAgeExclude: Array.isArray(minimumReleaseAgeExclude)
        ? minimumReleaseAgeExclude.filter((entry) => typeof entry === "string")
        : [],
    };
  } catch {
    return { minimumReleaseAgeMinutes: null, minimumReleaseAgeExclude: [] };
  }
}

function splitMinimumReleaseAgeExcludeSelector(selector: string) {
  const trimmed = selector.trim();
  if (!trimmed) {
    return null;
  }
  let versionSeparatorIndex;
  if (trimmed.startsWith("@")) {
    const scopeSeparatorIndex = trimmed.indexOf("/");
    versionSeparatorIndex =
      scopeSeparatorIndex === -1 ? -1 : trimmed.indexOf("@", scopeSeparatorIndex + 1);
  } else {
    versionSeparatorIndex = trimmed.indexOf("@");
  }
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

function countFindingTypes(findings: ManifestFinding[]) {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.type] = (counts[finding.type] ?? 0) + 1;
  }
  return counts;
}

function compareManifestFindings(left: ManifestFinding, right: ManifestFinding) {
  if (left.type !== right.type) {
    return left.type.localeCompare(right.type);
  }
  if (left.packageName !== right.packageName) {
    return left.packageName.localeCompare(right.packageName);
  }
  return left.version.localeCompare(right.version);
}

function packagePatternMatches(pattern: string, packageName: string) {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "u");
  return regex.test(packageName);
}

function matchesMinimumReleaseAgeExclude(selector: string, packageName: string, version: string) {
  const parsed = splitMinimumReleaseAgeExcludeSelector(selector);
  if (!parsed || !packagePatternMatches(parsed.packagePattern, packageName)) {
    return false;
  }
  return parsed.versionSelectors.length === 0 || parsed.versionSelectors.includes(version);
}

function collectManifestFindings({
  packageName,
  version,
  manifest,
  publishedAt,
  now,
  minimumReleaseAgeMinutes,
  minimumReleaseAgeExclude = [],
}: ManifestFindingsOptions) {
  const findings: ManifestFinding[] = [];
  const workspaceExcludedFindings: ManifestFinding[] = [];
  for (const section of ["dependencies", "optionalDependencies"] as const) {
    const dependencies = asRecord(manifest[section]);
    for (const [dependencyName, spec] of Object.entries(dependencies)) {
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

  const scripts = asRecord(manifest.scripts);
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
      const exclusion = minimumReleaseAgeExclude.find((selector) =>
        matchesMinimumReleaseAgeExclude(selector, packageName, version),
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

export async function fetchNpmManifest({
  packageName,
  version,
  fetchImpl,
  registryBaseUrl,
  maxBytes = NPM_PACKUMENT_RESPONSE_MAX_BYTES,
  timeoutMs = NPM_PACKUMENT_FETCH_TIMEOUT_MS,
}: {
  packageName: string;
  version: string;
  fetchImpl: typeof fetch;
  registryBaseUrl: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<ManifestLoadResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(`${registryBaseUrl}/${encodePackageName(packageName)}`, {
    headers: {
      Accept: NPM_PACKUMENT_ACCEPT_HEADER,
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const packumentText = await readBoundedNpmRegistryText(response, maxBytes, { signal });
  const packument: unknown = JSON.parse(packumentText);
  if (!isRecord(packument)) {
    throw new Error("invalid packument payload");
  }
  const versions = asRecord(packument.versions);
  const manifest = versions[version];
  if (!isRecord(manifest)) {
    throw new Error(`version ${version} not found`);
  }
  const times = asRecord(packument.time);
  return {
    manifest,
    publishedAt: typeof times[version] === "string" ? times[version] : null,
  };
}

export async function createTransitiveManifestRiskReport({
  packageVersions,
  manifestLoader,
  now = new Date(),
  minimumReleaseAgeMinutes = null,
  minimumReleaseAgeExclude = [],
}: {
  packageVersions: PackageVersion[];
  manifestLoader: (entry: PackageVersion) => Promise<ManifestLoadResult>;
  now?: Date;
  minimumReleaseAgeMinutes?: number | null;
  minimumReleaseAgeExclude?: string[];
}) {
  const findings: ManifestFinding[] = [];
  const workspaceExcludedFindings: ManifestFinding[] = [];
  const metadataFailures: Array<PackageVersion & { error: string }> = [];
  for (const { packageName, version } of packageVersions) {
    if (EXOTIC_SPEC_PATTERN.test(version)) {
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
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const sortedFindings = findings.toSorted(compareManifestFindings);
  const byType = countFindingTypes(sortedFindings);
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
    workspaceExcludedByType: countFindingTypes(workspaceExcludedFindings),
    workspaceExcludedFindings: workspaceExcludedFindings.toSorted(compareManifestFindings),
    metadataFailures,
    findings: sortedFindings,
  };
}

type ManifestRiskReport = Awaited<ReturnType<typeof createTransitiveManifestRiskReport>>;

function markdownCode(value: string) {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function findingPackageKey(finding: PackageVersion) {
  return `${finding.packageName}@${finding.version}`;
}

function typeBreakdown(findings: ManifestFinding[]) {
  return Object.entries(countFindingTypes(findings))
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
}

const createFloatingTarget = () => ({
  declarations: 0,
  sourcePackages: new Set<string>(),
  specifiers: new Map<string, number>(),
});

function collectMarkdownRollups(findings: ManifestFinding[]) {
  const packageFindings = new Map<string, ManifestFinding[]>();
  const floatingTargets = new Map<string, ReturnType<typeof createFloatingTarget>>();
  const lifecyclePackages = new Map<string, Set<string>>();
  const recentlyPublishedVersions: ManifestFinding[] = [];
  const exoticSources: ManifestFinding[] = [];

  for (const finding of findings) {
    const packageKey = findingPackageKey(finding);
    const packageList = packageFindings.get(packageKey) ?? [];
    packageList.push(finding);
    packageFindings.set(packageKey, packageList);

    if (finding.type === "floating-transitive-spec" && finding.dependency?.name) {
      const target = floatingTargets.get(finding.dependency.name) ?? createFloatingTarget();
      target.declarations += 1;
      target.sourcePackages.add(packageKey);
      const specifier =
        typeof finding.dependency.spec === "string" ? finding.dependency.spec : "unknown";
      target.specifiers.set(specifier, (target.specifiers.get(specifier) ?? 0) + 1);
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

type PackageFindings = ReturnType<typeof collectMarkdownRollups>["packageFindings"];
type FloatingTargets = ReturnType<typeof collectMarkdownRollups>["floatingTargets"];
type LifecyclePackages = ReturnType<typeof collectMarkdownRollups>["lifecyclePackages"];

function renderPackageFindingSummary(lines: string[], packageFindings: PackageFindings) {
  lines.push("## Published Package Manifests With Risk Findings", "");
  for (const [packageKey, findings] of [...packageFindings.entries()].toSorted((left, right) => {
    if (right[1].length !== left[1].length) {
      return right[1].length - left[1].length;
    }
    return left[0].localeCompare(right[0]);
  })) {
    lines.push(
      `- ${markdownCode(packageKey)}: ${findings.length} manifest finding${findings.length === 1 ? "" : "s"} ` +
        `(${typeBreakdown(findings)})`,
    );
  }
  lines.push("");
}

function renderFloatingDependencyTargets(lines: string[], floatingTargets: FloatingTargets) {
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
    const specifiers = [...detail.specifiers.entries()]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([specifier, count]) => `${specifier}: ${count}`)
      .join(", ");
    lines.push(
      `- ${markdownCode(dependencyName)}: ${detail.declarations} declarations from ` +
        `${detail.sourcePackages.size} resolved packages; specifiers: ${specifiers}`,
    );
  }
  lines.push("");
}

function renderLifecycleScriptPackages(lines: string[], lifecyclePackages: LifecyclePackages) {
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

function renderRecentlyPublishedVersions(
  lines: string[],
  findings: ManifestFinding[],
  heading: string,
) {
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

function renderExoticSources(lines: string[], exoticSources: ManifestFinding[]) {
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

export function renderTransitiveManifestRiskMarkdownReport(report: ManifestRiskReport) {
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

  lines.push(
    "## Complete Evidence",
    "",
    "The complete reported signal list is available in the JSON report, including every package, version, dependency, and specifier. Recently published versions covered by pnpm workspace release-age exclusions are listed separately under workspaceExcludedFindings. The sections below summarize the same data by package, dependency target, and finding class for human review.",
    "",
  );

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

async function runTransitiveManifestRiskReport(
  rootDir = process.cwd(),
  fetchImpl = fetch,
  now = new Date(),
) {
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
  const options = parseReportCliArgs(argv);
  const report = await runTransitiveManifestRiskReport(options.rootDir);
  await writeReportArtifact(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeReportArtifact(
    options.markdownPath,
    renderTransitiveManifestRiskMarkdownReport(report),
  );
  const artifactHint =
    typeof options.markdownPath === "string" ? " See ".concat(options.markdownPath, ".") : "";
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
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
