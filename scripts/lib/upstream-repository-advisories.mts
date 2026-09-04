// Checks published public repository advisories independently of aggregate advisory feeds.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import semver from "semver";
import { runTasksWithConcurrency } from "../../src/utils/run-with-concurrency.js";
import { withAdvisoryRequestTimeout } from "../pre-commit/pnpm-audit-prod.mjs";
import { readBoundedResponseText } from "./bounded-response.mjs";

const GITHUB_API = "https://api.github.com";
const MAX_PACKAGE_VERSIONS = 2500;
const MAX_REQUESTS = 4000;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const MAX_ADVISORIES = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const CONCURRENCY = 4;
const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u;
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

type CoverageReason =
  | "budget-exhausted"
  | "rate-limited"
  | "request-failed"
  | "invalid-response"
  | "unsupported-version"
  | "unsupported-repository"
  | "repository-not-public"
  | "invalid-advisory"
  | "invalid-range"
  | "invalid-pagination";
type CoverageIssue = { subject: string; reason: CoverageReason };
type PackageVersions = Record<string, string[]>;
type RepositoryPackages = Map<string, Set<string>>;
type AdvisoryReconciliation = {
  id: string;
  packageName: string;
  repositoryRange: string;
  reviewedRanges: string[];
  matchedVersions: string[];
};
type JsonResponse = { data: unknown; link: string | null };

export type PublishedRepositoryAdvisory = {
  packageName: string;
  id: string;
  severity: string;
  title: string;
  url: string;
  vulnerable_versions: string;
  matchedVersions: string[];
};

function githubRepository(repository: unknown) {
  const value = isRecord(repository) ? repository.url : repository;
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value.replace(/^github:/u, "https://github.com/").replace(/^git\+/u, ""));
    if (
      url.hostname !== "github.com" ||
      !["https:", "ssh:", "git:"].includes(url.protocol) ||
      url.port ||
      url.password ||
      url.search ||
      url.hash ||
      (url.username && !(url.protocol === "ssh:" && url.username === "git"))
    ) {
      return null;
    }
    const match = /^\/([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(url.pathname);
    return match && match[2] !== "." && match[2] !== ".."
      ? `${match[1]}/${match[2]}`.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function githubRange(value: unknown) {
  if (typeof value !== "string" || value.length > 256) {
    return null;
  }
  // GitHub documents one comparator or a lower/upper pair separated by ", ".
  // Do not guess at legacy prose or semicolon ranges: absence of a match is not clearance.
  const bounds = value.split(", ");
  const validBounds =
    bounds.length <= 2 &&
    bounds.every(
      (bound, index) =>
        /^(?:>=|>|=|<=|<) \d[^\s,]*$/u.test(bound) &&
        (bounds.length === 1 || bound.startsWith(index === 0 ? ">" : "<")),
    );
  if (!validBounds) {
    return null;
  }
  try {
    return bounds.map((bound) => {
      // GitHub's zero floor is not npm's partial-version ">0" (which means >=1.0.0).
      const normalized = bound === ">= 0" ? ">= 0.0.0-0" : bound.replace(/ 0$/u, " 0.0.0");
      return new semver.Comparator(normalized);
    });
  } catch {
    return null;
  }
}

function nextCursor(
  link: string | null,
  repository: string,
  repositoryId: number,
): Result<string | null, CoverageReason> {
  const next = link?.split(",").find((part) => /;\s*rel="next"/u.test(part));
  if (!next) {
    return { ok: true, value: null };
  }
  try {
    const url = new URL(/<([^>]+)>/u.exec(next)?.[1] ?? "");
    const cursor = url.searchParams.get("after");
    const sameRepository =
      url.pathname === `/repos/${repository}/security-advisories` ||
      url.pathname === `/repositories/${repositoryId}/security-advisories`;
    if (
      url.origin === GITHUB_API &&
      !url.username &&
      !url.password &&
      !url.hash &&
      sameRepository &&
      url.searchParams.get("state") === "published" &&
      cursor &&
      cursor.length <= 2048
    ) {
      return { ok: true, value: cursor };
    }
  } catch {
    // Invalid continuation is incomplete coverage, never permission to follow another host.
  }
  return { ok: false, error: "invalid-pagination" };
}

function collectRepositoryMatches(
  rows: unknown[],
  repository: string,
  packages: RepositoryPackages,
  advisories: PublishedRepositoryAdvisory[],
  issues: CoverageIssue[],
) {
  for (const row of rows) {
    if (!isRecord(row)) {
      issues.push({ subject: repository, reason: "invalid-advisory" });
      continue;
    }
    if (typeof row.withdrawn_at === "string") {
      continue;
    }
    if (row.state !== "published" || row.withdrawn_at !== null) {
      issues.push({ subject: repository, reason: "invalid-advisory" });
      continue;
    }
    if (
      typeof row.ghsa_id !== "string" ||
      !GHSA_ID.test(row.ghsa_id) ||
      typeof row.severity !== "string" ||
      !SEVERITIES.has(row.severity) ||
      typeof row.summary !== "string" ||
      row.summary.length > 512 ||
      !Array.isArray(row.vulnerabilities)
    ) {
      issues.push({ subject: repository, reason: "invalid-advisory" });
      continue;
    }
    const matches = new Map<string, { ranges: Set<string>; versions: Set<string> }>();
    for (const vulnerability of row.vulnerabilities) {
      if (!isRecord(vulnerability) || !isRecord(vulnerability.package)) {
        issues.push({ subject: `${repository}#${row.ghsa_id}`, reason: "invalid-advisory" });
        continue;
      }
      const { ecosystem, name } = vulnerability.package;
      if (typeof ecosystem !== "string" || (ecosystem === "npm" && typeof name !== "string")) {
        issues.push({ subject: `${repository}#${row.ghsa_id}`, reason: "invalid-advisory" });
        continue;
      }
      if (ecosystem !== "npm" || typeof name !== "string") {
        continue;
      }
      const versions = packages.get(name);
      if (!versions) {
        continue;
      }
      const range = githubRange(vulnerability.vulnerable_version_range);
      if (!range) {
        issues.push({ subject: `${name}#${row.ghsa_id}`, reason: "invalid-range" });
        continue;
      }
      const affected = [...versions].filter((version) =>
        range.every((bound) => bound.test(version)),
      );
      if (affected.length === 0) {
        continue;
      }
      const match = matches.get(name) ?? { ranges: new Set<string>(), versions: new Set<string>() };
      match.ranges.add(range.map((bound) => bound.value).join(" "));
      for (const version of affected) {
        match.versions.add(version);
      }
      matches.set(name, match);
    }
    for (const [packageName, match] of matches) {
      advisories.push({
        packageName,
        id: row.ghsa_id,
        severity: row.severity === "medium" ? "moderate" : row.severity,
        title: row.summary,
        url: `https://github.com/${repository}/security/advisories/${row.ghsa_id}`,
        vulnerable_versions: [...match.ranges].toSorted().join(" || "),
        matchedVersions: [...match.versions].toSorted(),
      });
    }
  }
}

function reviewedPackageRanges(data: unknown, advisory: PublishedRepositoryAdvisory) {
  if (
    !isRecord(data) ||
    data.ghsa_id !== advisory.id ||
    data.withdrawn_at !== null ||
    typeof data.published_at !== "string" ||
    !Number.isFinite(Date.parse(data.published_at)) ||
    typeof data.github_reviewed_at !== "string" ||
    !Number.isFinite(Date.parse(data.github_reviewed_at)) ||
    !Array.isArray(data.vulnerabilities)
  ) {
    return null;
  }
  const ranges: semver.Comparator[][] = [];
  for (const vulnerability of data.vulnerabilities) {
    if (!isRecord(vulnerability) || !isRecord(vulnerability.package)) {
      return null;
    }
    if (
      vulnerability.package.ecosystem !== "npm" ||
      vulnerability.package.name !== advisory.packageName
    ) {
      continue;
    }
    const range = githubRange(vulnerability.vulnerable_version_range);
    if (!range) {
      return null;
    }
    ranges.push(range);
  }
  return ranges.length > 0 ? ranges : null;
}

export async function fetchPublishedRepositoryAdvisories({
  payload,
  registryBaseUrl,
  fetchImpl,
}: {
  payload: PackageVersions;
  registryBaseUrl: string;
  fetchImpl: typeof fetch;
}) {
  const issues: CoverageIssue[] = [];
  const advisories: PublishedRepositoryAdvisory[] = [];
  const repositories = new Map<string, RepositoryPackages>();
  const deadline = performance.now() + RUN_TIMEOUT_MS;
  const token = process.env.GH_TOKEN;
  let requests = 0;
  let githubFailure: "rate-limited" | "request-failed" | null = null;
  let advisoryCount = 0;
  let mappedPackageVersions = 0;
  let checkedRepositories = 0;

  async function request(
    url: string,
    source: "registry" | "github",
  ): Promise<Result<JsonResponse, CoverageReason>> {
    const github = source === "github";
    const remainingMs = deadline - performance.now();
    if (github && githubFailure) {
      return { ok: false, error: githubFailure };
    }
    if (remainingMs <= 0 || requests >= MAX_REQUESTS || advisoryCount >= MAX_ADVISORIES) {
      return { ok: false, error: "budget-exhausted" };
    }
    requests += 1;
    try {
      return await withAdvisoryRequestTimeout({
        label: "Upstream advisory request",
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remainingMs),
        run: async ({ signal, timeoutPromise }): Promise<Result<JsonResponse, CoverageReason>> => {
          // Source role owns credentials; registry metadata and redirects never receive the token.
          const headers: Record<string, string> = { accept: "application/json" };
          if (github) {
            headers["x-github-api-version"] = "2022-11-28";
            if (token) {
              headers.authorization = `Bearer ${token}`;
            }
          }
          const response = await fetchImpl(url, { headers, signal, redirect: "error" });
          if (!response.ok) {
            const rateLimited =
              github &&
              (response.status === 429 ||
                (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0"));
            const reason = rateLimited ? "rate-limited" : "request-failed";
            let resourceDenied = false;
            if (
              github &&
              response.status === 403 &&
              !rateLimited &&
              !response.headers.has("retry-after")
            ) {
              try {
                const error: unknown = JSON.parse(
                  await readBoundedResponseText(
                    response,
                    "GitHub advisory denial",
                    MAX_RESPONSE_BYTES,
                    { signal, timeoutPromise },
                  ),
                );
                // GitHub documents these as resource-scoped permission failures, not throttling.
                // Keep that advisory unresolved without poisoning unrelated reviewed requests.
                resourceDenied =
                  isRecord(error) &&
                  (error.message === "Resource not accessible by integration" ||
                    error.message === "Resource not accessible by personal access token");
              } catch {
                // Unknown or unreadable 403 responses may be secondary limits: stop globally.
              }
            }
            if (github && [401, 403, 429].includes(response.status) && !resourceDenied) {
              githubFailure = reason;
            }
            void response.body?.cancel().catch(() => undefined);
            return { ok: false, error: reason };
          }
          const text = await readBoundedResponseText(
            response,
            "upstream advisory source",
            MAX_RESPONSE_BYTES,
            { signal, timeoutPromise },
          );
          return {
            ok: true,
            value: { data: JSON.parse(text), link: response.headers.get("link") },
          };
        },
      });
    } catch {
      return {
        ok: false,
        error: performance.now() >= deadline ? "budget-exhausted" : "request-failed",
      };
    }
  }

  const entries = Object.entries(payload)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([packageName, versions]) =>
      [...new Set(versions)].toSorted().map((version) => ({ packageName, version })),
    );
  if (entries.length > MAX_PACKAGE_VERSIONS) {
    issues.push({
      subject: `${entries.length - MAX_PACKAGE_VERSIONS} package versions not inspected`,
      reason: "budget-exhausted",
    });
  }
  await runTasksWithConcurrency({
    limit: CONCURRENCY,
    throwOnError: true,
    tasks: entries.slice(0, MAX_PACKAGE_VERSIONS).map(({ packageName, version }) => async () => {
      const subject = `${packageName}@${version}`;
      if (!semver.valid(version)) {
        issues.push({ subject, reason: "unsupported-version" });
        return;
      }
      const url = `${registryBaseUrl}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
      const response = await request(url, "registry");
      if (!response.ok) {
        issues.push({ subject, reason: response.error });
        return;
      }
      const manifest = response.value.data;
      if (!isRecord(manifest) || manifest.name !== packageName || manifest.version !== version) {
        issues.push({ subject, reason: "invalid-response" });
        return;
      }
      const repository = githubRepository(manifest.repository);
      if (!repository) {
        issues.push({ subject, reason: "unsupported-repository" });
        return;
      }
      const packages = repositories.get(repository) ?? new Map<string, Set<string>>();
      const versions = packages.get(packageName) ?? new Set<string>();
      versions.add(version);
      packages.set(packageName, versions);
      repositories.set(repository, packages);
      mappedPackageVersions += 1;
    }),
  });

  await runTasksWithConcurrency({
    limit: CONCURRENCY,
    throwOnError: true,
    tasks: [...repositories]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([repository, packages]) => async () => {
        const base = `${GITHUB_API}/repos/${repository}`;
        const metadata = await request(base, "github");
        if (!metadata.ok) {
          issues.push({ subject: repository, reason: metadata.error });
          return;
        }
        // An authenticated token may see private repositories; their advisories are outside this check.
        if (!isRecord(metadata.value.data) || metadata.value.data.private !== false) {
          issues.push({ subject: repository, reason: "repository-not-public" });
          return;
        }
        const repositoryId = metadata.value.data.id;
        if (
          typeof repositoryId !== "number" ||
          !Number.isSafeInteger(repositoryId) ||
          repositoryId <= 0
        ) {
          issues.push({ subject: repository, reason: "invalid-response" });
          return;
        }
        let cursor: string | null = null;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const query = new URLSearchParams({ state: "published", per_page: String(PAGE_SIZE) });
          if (cursor) {
            query.set("after", cursor);
          }
          const response = await request(`${base}/security-advisories?${query}`, "github");
          if (!response.ok) {
            issues.push({ subject: repository, reason: response.error });
            return;
          }
          const rows = response.value.data;
          if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
            issues.push({ subject: repository, reason: "invalid-response" });
            return;
          }
          const remaining = MAX_ADVISORIES - advisoryCount;
          advisoryCount += Math.min(rows.length, remaining);
          collectRepositoryMatches(
            rows.slice(0, remaining),
            repository,
            packages,
            advisories,
            issues,
          );
          if (rows.length > remaining) {
            issues.push({ subject: repository, reason: "budget-exhausted" });
            return;
          }
          const next = nextCursor(response.value.link, repository, repositoryId);
          if (!next.ok) {
            issues.push({ subject: repository, reason: next.error });
            return;
          }
          if (!next.value) {
            checkedRepositories += 1;
            return;
          }
          if (next.value === cursor) {
            issues.push({ subject: repository, reason: "invalid-pagination" });
            return;
          }
          cursor = next.value;
        }
        issues.push({ subject: repository, reason: "budget-exhausted" });
      }),
  });

  const reconciliations: AdvisoryReconciliation[] = [];
  const reconciled = await runTasksWithConcurrency({
    limit: CONCURRENCY,
    throwOnError: true,
    tasks: advisories.map((advisory) => async () => {
      // Repository ranges can remain stale after GitHub reviews the same GHSA.
      // Only exact reviewed package ranges may replace them; missing proof retains the blocker.
      const response = await request(`${GITHUB_API}/advisories/${advisory.id}`, "github");
      const ranges = response.ok ? reviewedPackageRanges(response.value.data, advisory) : null;
      if (!ranges) {
        issues.push({
          subject: `${advisory.packageName}#${advisory.id}`,
          reason: response.ok ? "invalid-advisory" : response.error,
        });
        return advisory;
      }
      const reviewedRanges = ranges.map((range) => range.map((bound) => bound.value).join(" "));
      const matchedVersions = [...new Set(payload[advisory.packageName] ?? [])]
        .filter((version) => ranges.some((range) => range.every((bound) => bound.test(version))))
        .toSorted();
      reconciliations.push({
        id: advisory.id,
        packageName: advisory.packageName,
        repositoryRange: advisory.vulnerable_versions,
        reviewedRanges,
        matchedVersions,
      });
      return matchedVersions.length > 0
        ? { ...advisory, vulnerable_versions: reviewedRanges.join(" || "), matchedVersions }
        : null;
    }),
  });

  return {
    advisories: reconciled.results
      .filter((entry): entry is PublishedRepositoryAdvisory => entry !== null)
      .toSorted(
        (left, right) =>
          left.packageName.localeCompare(right.packageName) || left.id.localeCompare(right.id),
      ),
    coverage: {
      source: "github-public-repository-advisories" as const,
      reconciliations: reconciliations.toSorted(
        (left, right) =>
          left.packageName.localeCompare(right.packageName) || left.id.localeCompare(right.id),
      ),
      status: issues.length === 0 ? ("checked" as const) : ("partial" as const),
      packageVersions: entries.length,
      mappedPackageVersions,
      repositories: repositories.size,
      checkedRepositories,
      issues: issues.toSorted(
        (left, right) =>
          left.subject.localeCompare(right.subject) || left.reason.localeCompare(right.reason),
      ),
    },
  };
}
