#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  compactReleaseNotes,
  OPENCLAW_RELEASE_TAG_PATTERN,
  validateReleaseNotesRepository as validateRepository,
  validateReleaseNotesTag as validateTag,
} from "./lib/release-notes-compaction.mjs";

type ShippedBaselineExclusion = {
  ref: string;
  count: number;
  pullRequests: number[];
};

type ContributionRecordProvenance = {
  base: string;
  target: string;
  inRangePullRequests?: number;
  retainedSeedOnlyPullRequests?: number;
  uniquePullRequests: number;
};

export const GITHUB_RELEASE_BODY_MAX_CHARACTERS = 125_000;
export const GITHUB_RELEASE_BODY_MAX_BYTES = 125_000;

type ReleaseNotesTarget = {
  changelog: unknown;
  version: unknown;
  tag: unknown;
  repository: unknown;
};

const RELEASE_VERIFICATION_HEADING = "### Release verification";
const SHIPPED_BASELINE_EXCLUSIONS_PREFIX = "Shipped baseline exclusions:";
const RELEASE_HEADING_PATTERN =
  /^## (?<version>Unreleased|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:(?:alpha|beta)\.[1-9][0-9]*|[1-9][0-9]*))?)\r?$/u;

function fail(message: string): never {
  throw new Error(message);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    fail(`${label} must be a string`);
  }
}

function normalizeTail(value: string | undefined) {
  return value?.trim() ?? "";
}

function joinBody(notes: string, tail: string | undefined) {
  const normalizedNotes = notes.trimEnd();
  const normalizedTail = normalizeTail(tail);
  return normalizedTail ? `${normalizedNotes}\n\n${normalizedTail}` : normalizedNotes;
}

export function formatContributionRecordProvenance(provenance: ContributionRecordProvenance) {
  const { base, target, inRangePullRequests, retainedSeedOnlyPullRequests } = provenance;
  if (inRangePullRequests === undefined || retainedSeedOnlyPullRequests === undefined) {
    fail("canonical contribution record provenance requires split PR counts");
  }
  const uniquePullRequests = inRangePullRequests + retainedSeedOnlyPullRequests;
  const count = (value: number) => value.toLocaleString("en-US");
  const prs = (value: number) => `PR${value === 1 ? "" : "s"}`;
  return `This audited record covers the complete ${base}..${target} history: ${count(inRangePullRequests)} in-range ${prs(inRangePullRequests)} + ${count(retainedSeedOnlyPullRequests)} retained seed-only ${prs(retainedSeedOnlyPullRequests)} = ${count(uniquePullRequests)} unique ${prs(uniquePullRequests)}.`;
}
export function parseContributionRecordProvenance(section: string) {
  const rows = Array.from(section.matchAll(/^- \*\*PR #(\d+)\*\*/gmu), (match) => Number(match[1]));
  const duplicate = rows.find((value, index) => rows.indexOf(value) !== index);
  if (duplicate !== undefined) {
    fail(`duplicate contribution record PR #${duplicate}`);
  }
  const line = section.match(/^This audited record covers the complete .+$/mu)?.[0];
  if (!line) {
    return undefined;
  }
  const canonical = line.match(
    /^This audited record covers the complete (?<base>\S+)\.\.(?<target>[0-9a-f]{40}) history: (?<inRange>0|[1-9][0-9]{0,2}(?:,[0-9]{3})*) in-range PRs? \+ (?<seedOnly>0|[1-9][0-9]{0,2}(?:,[0-9]{3})*) retained seed-only PRs? = (?<unique>0|[1-9][0-9]{0,2}(?:,[0-9]{3})*) unique PRs?\./u,
  );
  const legacy =
    canonical ??
    line.match(
      /^This audited record covers the complete (?<base>\S+)\.\.(?<target>\S+) history: (?<unique>[0-9]+) merged PRs?\./u,
    );
  const groups = legacy?.groups;
  if (!groups?.base || !groups.target || groups.unique === undefined) {
    fail("release contribution record provenance is malformed");
  }
  const number = (value: string) => Number(value.replaceAll(",", ""));
  const provenance: ContributionRecordProvenance = {
    base: groups.base,
    target: groups.target,
    uniquePullRequests: number(groups.unique),
  };
  const canonicalGroups = canonical?.groups;
  if (canonicalGroups?.inRange !== undefined && canonicalGroups.seedOnly !== undefined) {
    provenance.inRangePullRequests = number(canonicalGroups.inRange);
    provenance.retainedSeedOnlyPullRequests = number(canonicalGroups.seedOnly);
    if (
      provenance.inRangePullRequests + provenance.retainedSeedOnlyPullRequests !==
      provenance.uniquePullRequests
    ) {
      fail("release contribution record provenance arithmetic is invalid");
    }
  }
  if (provenance.uniquePullRequests > 0 && !/^#### Pull requests\r?$/mu.test(section)) {
    fail("positive contribution record requires a Pull requests section");
  }
  if (rows.length !== provenance.uniquePullRequests) {
    fail(`contribution record row count ${rows.length} != ${provenance.uniquePullRequests}`);
  }
  return provenance;
}

function githubReleaseBodySize(body: string) {
  return {
    characters: Array.from(body).length,
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

function fitsGithubReleaseBody(body: string) {
  const size = githubReleaseBodySize(body);
  return (
    size.characters <= GITHUB_RELEASE_BODY_MAX_CHARACTERS &&
    size.bytes <= GITHUB_RELEASE_BODY_MAX_BYTES
  );
}

function releaseSections(changelog: string) {
  const headings: Array<{ version: string | undefined; start: number }> = [];
  let offset = 0;
  let fence: string | undefined;
  for (const segment of changelog.split(/(?<=\n)/u)) {
    const line = segment.replace(/\n$/u, "");
    const fenceMatch = line.match(/^\s*(?<marker>`{3,}|~{3,})/u);
    if (fenceMatch?.groups?.marker) {
      const marker = fenceMatch.groups.marker;
      if (!fence) {
        fence = marker;
      } else if (marker.charAt(0) === fence.charAt(0) && marker.length >= fence.length) {
        fence = undefined;
      }
      offset += segment.length;
      continue;
    }
    if (!fence) {
      if (line.startsWith("## ")) {
        const releaseHeading = line.match(RELEASE_HEADING_PATTERN);
        headings.push({ version: releaseHeading?.groups?.version, start: offset });
      }
    }
    offset += segment.length;
  }
  return headings.flatMap(({ version, start }, index) =>
    version ? [{ version, start, end: headings[index + 1]?.start ?? changelog.length }] : [],
  );
}

export function extractChangelogReleaseSections(changelog: string) {
  return releaseSections(changelog).map(({ version, start, end }) => ({
    version,
    source: changelog.slice(start, end).trimEnd(),
  }));
}

export function extractChangelogSection(changelog: unknown, version: unknown) {
  assertString(changelog, "changelog");
  assertString(version, "version");
  const section = releaseSections(changelog).find((candidate) => candidate.version === version);
  if (!section) {
    fail(`CHANGELOG.md does not contain ## ${version}`);
  }
  return changelog.slice(section.start, section.end).trimEnd();
}

export function releaseNotesVersionForTag(tag: unknown) {
  assertString(tag, "tag");
  validateTag(tag);
  return tag.replace(/^v/u, "").replace(/-(?:(?:alpha|beta)\.[1-9][0-9]*|[1-9][0-9]*)$/u, "");
}

function validateShippedBaselineRef(ref: string) {
  if (!OPENCLAW_RELEASE_TAG_PATTERN.test(ref)) {
    fail(`invalid shipped release tag: ${ref}`);
  }
}

export function formatShippedBaselineExclusions(baselines: ShippedBaselineExclusion[]) {
  if (baselines.length === 0) {
    return "";
  }
  const normalized = baselines
    .map(({ ref, count, pullRequests }) => {
      validateShippedBaselineRef(ref);
      if (!Array.isArray(pullRequests)) {
        fail(`missing shipped baseline PR inventory for ${ref}`);
      }
      const normalizedPullRequests = pullRequests.toSorted((a, b) => a - b);
      if (
        normalizedPullRequests.some((number) => !Number.isSafeInteger(number) || number < 1) ||
        new Set(normalizedPullRequests).size !== normalizedPullRequests.length
      ) {
        fail(`invalid shipped baseline PR inventory for ${ref}`);
      }
      if (!Number.isSafeInteger(count) || count < 0 || count !== normalizedPullRequests.length) {
        fail(`invalid shipped baseline exclusion count for ${ref}: ${count}`);
      }
      return { ref, count, pullRequests: normalizedPullRequests };
    })
    .toSorted((a, b) => (a.ref === b.ref ? 0 : a.ref < b.ref ? -1 : 1));
  const seen = new Set<string>();
  for (const baseline of normalized) {
    if (seen.has(baseline.ref)) {
      fail(`duplicate shipped baseline exclusion: ${baseline.ref}`);
    }
    seen.add(baseline.ref);
  }
  return `${SHIPPED_BASELINE_EXCLUSIONS_PREFIX} ${normalized
    .map(({ ref, count, pullRequests }) =>
      count === 0
        ? `${ref} (0 PRs)`
        : `${ref} (${count} PRs: ${pullRequests.map((number) => `#${number}`).join(", ")})`,
    )
    .join("; ")}.`;
}

export function parseShippedBaselineExclusions(section: string) {
  const lines = section.split(/\r?\n/u).filter((line) => line.startsWith("Shipped baseline"));
  if (lines.length === 0) {
    return [];
  }
  if (lines.length > 1) {
    fail("release contribution record contains multiple shipped baseline exclusion lines");
  }
  const [line] = lines;
  if (!line) {
    fail("release contribution record is missing shipped baseline exclusions");
  }
  const entries = line.match(/^Shipped baseline exclusions: (?<entries>.+)\.$/u)?.groups?.entries;
  if (!entries) {
    fail("release contribution record contains malformed shipped baseline exclusions");
  }
  const baselines = entries.split("; ").map((entry) => {
    const item = entry.match(
      /^(?<ref>\S+) \((?<count>0|[1-9][0-9]*) PRs(?:: (?<pullRequests>#[1-9][0-9]*(?:, #[1-9][0-9]*)*))?\)$/u,
    );
    const groups = item?.groups;
    if (!groups?.ref || groups.count === undefined) {
      fail(`release contribution record contains malformed shipped baseline exclusion: ${entry}`);
    }
    const count = Number(groups.count);
    const pullRequests = groups.pullRequests
      ? groups.pullRequests.split(", ").map((number) => Number(number.slice(1)))
      : [];
    return { ref: groups.ref, count, pullRequests };
  });
  if (formatShippedBaselineExclusions(baselines) !== line) {
    fail("release contribution record shipped baseline exclusions are not canonical");
  }
  return baselines;
}

export function dedicatedSectionVersionForTag(tag: unknown) {
  // Correction (vX-N) and alpha tags may carry their own exact changelog
  // heading; beta and stable bodies must come from the stable base section.
  assertString(tag, "tag");
  const taggedVersion = tag.replace(/^v/u, "");
  if (/-beta\.[1-9][0-9]*$/u.test(taggedVersion)) {
    return undefined;
  }
  return /-(?:alpha\.)?[1-9][0-9]*$/u.test(taggedVersion) ? taggedVersion : undefined;
}

export function releaseNotesSectionForTag(changelog: unknown, version: unknown, tag: unknown) {
  // Alpha and correction tags prefer their own exact heading when the
  // changelog carries one; otherwise they fall back to the base version.
  assertString(tag, "tag");
  assertString(version, "version");
  const dedicatedVersion = dedicatedSectionVersionForTag(tag);
  if (dedicatedVersion && dedicatedVersion !== version) {
    try {
      return extractChangelogSection(changelog, dedicatedVersion);
    } catch {
      // No dedicated section; use the base version below.
    }
  }
  try {
    return extractChangelogSection(changelog, version);
  } catch (error) {
    if (!/-alpha\.[1-9][0-9]*$/u.test(tag)) {
      throw error;
    }
    return extractChangelogSection(changelog, "Unreleased").replace(
      /^## Unreleased\r?$/mu,
      `## ${version}`,
    );
  }
}

export function renderGithubReleaseNotes({
  changelog,
  version,
  tag,
  repository,
  verification = "",
}: ReleaseNotesTarget & { verification?: string }) {
  assertString(repository, "repository");
  assertString(tag, "tag");
  assertString(version, "version");
  validateRepository(repository);
  validateTag(tag);
  const tagVersion = releaseNotesVersionForTag(tag);
  if (tagVersion !== version) {
    fail(`release tag ${tag} requires CHANGELOG.md version ${tagVersion}, got ${version}`);
  }
  const section = releaseNotesSectionForTag(changelog, version, tag);
  const mode = fitsGithubReleaseBody(section) ? "full" : "compact";
  const baseBody = mode === "full" ? section : compactReleaseNotes(section, repository, tag)?.body;
  if (baseBody === undefined) {
    fail(
      "release notes exceed GitHub's body limit and cannot be compacted without a complete contribution record",
    );
  }
  if (!fitsGithubReleaseBody(baseBody)) {
    const size = githubReleaseBodySize(baseBody);
    fail(
      `compacted release notes are still too large for GitHub: ${size.characters} characters, ${size.bytes} bytes`,
    );
  }
  const normalizedVerification = normalizeTail(verification);
  const bodyWithVerification = joinBody(baseBody, normalizedVerification);
  const verificationIncluded =
    normalizedVerification !== "" && fitsGithubReleaseBody(bodyWithVerification);
  const body = verificationIncluded ? bodyWithVerification : baseBody;
  return {
    body,
    mode,
    size: githubReleaseBodySize(body),
    verificationIncluded,
    verificationOmitted: normalizedVerification !== "" && !verificationIncluded,
  };
}

export function verifyGithubReleaseNotes({
  body,
  changelog,
  version,
  tag,
  repository,
}: ReleaseNotesTarget & { body: unknown }) {
  assertString(body, "release body");
  const normalizedBody = body.trimEnd();
  const base = renderGithubReleaseNotes({
    changelog,
    version,
    tag,
    repository,
  });
  if (normalizedBody === base.body) {
    return {
      ...base,
      matches: true,
      actualSize: githubReleaseBodySize(normalizedBody),
    };
  }
  const verificationPrefix = `${base.body}\n\n${RELEASE_VERIFICATION_HEADING}`;
  const verification = normalizedBody.startsWith(verificationPrefix)
    ? normalizedBody.slice(base.body.length + 2)
    : "";
  const expected = verification
    ? renderGithubReleaseNotes({
        changelog,
        version,
        tag,
        repository,
        verification,
      })
    : base;
  return {
    ...expected,
    matches: normalizedBody === expected.body,
    actualSize: githubReleaseBodySize(normalizedBody),
  };
}

function usage() {
  return `Usage:
  node --import tsx scripts/render-github-release-notes.mts \\
    --changelog <path> --tag <tag> --repository <owner/repo> \\
    [--version <version>] [--verification-file <path>] [--output <path>] \\
    [--metadata-output <path>]
`;
}

function parseArgs(argv: string[]) {
  const valueOptions = [
    ["--changelog", "changelog"],
    ["--version", "version"],
    ["--tag", "tag"],
    ["--repository", "repository"],
    ["--verification-file", "verificationFile"],
    ["--output", "output"],
    ["--metadata-output", "metadataOutput"],
  ] as const satisfies ReadonlyArray<readonly [string, string]>;
  type ValueOption = (typeof valueOptions)[number][1];
  const options: Partial<Record<ValueOption, string>> & { help?: true } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const option = valueOptions.find(([flag]) => flag === arg);
    if (option) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`${arg} requires a value`);
      }
      options[option[1]] = value;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  if (!options.help) {
    for (const name of ["changelog", "tag", "repository"] as const) {
      if (!options[name]) {
        fail(`--${name} is required`);
      }
    }
    if (options.metadataOutput && !options.output) {
      fail("--metadata-output requires --output");
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const { changelog: changelogPath, repository, tag } = options;
  if (!changelogPath || !repository || !tag) {
    fail("release notes arguments were not validated");
  }
  const changelog = readFileSync(changelogPath, "utf8");
  const verification = options.verificationFile
    ? readFileSync(options.verificationFile, "utf8")
    : "";
  const rendered = renderGithubReleaseNotes({
    changelog,
    version: options.version ?? releaseNotesVersionForTag(tag),
    tag,
    repository,
    verification,
  });
  if (options.output) {
    writeFileSync(options.output, rendered.body);
    if (options.metadataOutput) {
      const metadata = {
        mode: rendered.mode,
        size: rendered.size,
        verificationIncluded: rendered.verificationIncluded,
        verificationOmitted: rendered.verificationOmitted,
      };
      writeFileSync(options.metadataOutput, `${JSON.stringify(metadata, null, 2)}\n`);
    }
    process.stderr.write(
      `release-notes: ${rendered.mode} body, ${rendered.size.characters} characters, ${rendered.size.bytes} bytes${
        rendered.verificationOmitted ? ", verification omitted at GitHub limit" : ""
      }\n`,
    );
    return;
  }
  process.stdout.write(rendered.body);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
