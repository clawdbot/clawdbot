#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GITHUB_RELEASE_BODY_MAX_CHARACTERS = 125_000;
export const GITHUB_RELEASE_BODY_MAX_BYTES = 125_000;

const CONTRIBUTION_RECORD_HEADING = "### Complete contribution record";
const RELEASE_VERIFICATION_HEADING = "### Release verification";
const SHIPPED_BASELINE_EXCLUSIONS_PREFIX = "Shipped baseline exclusions:";
const OPENCLAW_RELEASE_TAG_PATTERN =
  /^v[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:(?:alpha|beta)\.[1-9][0-9]*|[1-9][0-9]*))?$/u;
const RELEASE_HEADING_PATTERN =
  /^## (?<version>Unreleased|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:(?:alpha|beta)\.[1-9][0-9]*|[1-9][0-9]*))?)\r?$/u;

function fail(message) {
  throw new Error(message);
}

function normalizeTail(value) {
  return value?.trim() ?? "";
}

function joinBody(notes, tail) {
  const normalizedNotes = notes.trimEnd();
  const normalizedTail = normalizeTail(tail);
  return normalizedTail ? `${normalizedNotes}\n\n${normalizedTail}` : normalizedNotes;
}

function validateRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail(`invalid GitHub repository: ${repository}`);
  }
}

function validateTag(tag) {
  if (!OPENCLAW_RELEASE_TAG_PATTERN.test(tag)) {
    fail(`invalid release tag: ${tag}`);
  }
}

function githubReleaseBodySize(body) {
  return {
    characters: [...body].length,
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

function fitsGithubReleaseBody(body) {
  const size = githubReleaseBodySize(body);
  return (
    size.characters <= GITHUB_RELEASE_BODY_MAX_CHARACTERS &&
    size.bytes <= GITHUB_RELEASE_BODY_MAX_BYTES
  );
}

function releaseSections(changelog) {
  const headings = [];
  let offset = 0;
  let fence;
  for (const segment of changelog.split(/(?<=\n)/u)) {
    const line = segment.replace(/\n$/u, "");
    const fenceMatch = line.match(/^\s*(?<marker>`{3,}|~{3,})/u);
    if (fenceMatch?.groups?.marker) {
      const marker = fenceMatch.groups.marker;
      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
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
  return headings
    .map((heading, index) => ({
      version: heading.version,
      start: heading.start,
      end: headings[index + 1]?.start ?? changelog.length,
    }))
    .filter((heading) => heading.version);
}

export function extractChangelogReleaseSections(changelog) {
  return releaseSections(changelog).map(({ version, start, end }) => ({
    version,
    source: changelog.slice(start, end).trimEnd(),
  }));
}

export function extractChangelogSection(changelog, version) {
  const section = releaseSections(changelog).find((candidate) => candidate.version === version);
  if (!section) {
    fail(`CHANGELOG.md does not contain ## ${version}`);
  }
  return changelog.slice(section.start, section.end).trimEnd();
}

export function releaseNotesVersionForTag(tag) {
  validateTag(tag);
  return tag.replace(/^v/u, "").replace(/-(?:(?:alpha|beta)\.[1-9][0-9]*|[1-9][0-9]*)$/u, "");
}

function validateShippedBaselineRef(ref) {
  if (!OPENCLAW_RELEASE_TAG_PATTERN.test(ref)) {
    fail(`invalid shipped release tag: ${ref}`);
  }
}

export function formatShippedBaselineExclusions(baselines) {
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
  const seen = new Set();
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

export function parseShippedBaselineExclusions(section) {
  const lines = section.split(/\r?\n/u).filter((line) => line.startsWith("Shipped baseline"));
  if (lines.length === 0) {
    return [];
  }
  if (lines.length > 1) {
    fail("release contribution record contains multiple shipped baseline exclusion lines");
  }
  const match = lines[0].match(/^Shipped baseline exclusions: (?<entries>.+)\.$/u);
  if (!match?.groups?.entries) {
    fail("release contribution record contains malformed shipped baseline exclusions");
  }
  const baselines = match.groups.entries.split("; ").map((entry) => {
    const item = entry.match(
      /^(?<ref>\S+) \((?<count>0|[1-9][0-9]*) PRs(?:: (?<pullRequests>#[1-9][0-9]*(?:, #[1-9][0-9]*)*))?\)$/u,
    );
    if (!item?.groups?.ref || item.groups.count === undefined) {
      fail(`release contribution record contains malformed shipped baseline exclusion: ${entry}`);
    }
    const count = Number(item.groups.count);
    const pullRequests = item.groups.pullRequests
      ? item.groups.pullRequests.split(", ").map((number) => Number(number.slice(1)))
      : [];
    return { ref: item.groups.ref, count, pullRequests };
  });
  if (formatShippedBaselineExclusions(baselines) !== lines[0]) {
    fail("release contribution record shipped baseline exclusions are not canonical");
  }
  return baselines;
}

function tagPinnedContributionRecordUrl(repository, tag) {
  validateRepository(repository);
  validateTag(tag);
  return `https://github.com/${repository}/blob/${tag}/CHANGELOG.md#complete-contribution-record`;
}

function headingIndexOutsideFences(markdown, heading) {
  let offset = 0;
  let fence;
  for (const segment of markdown.split(/(?<=\n)/u)) {
    const line = segment.replace(/\n$/u, "");
    const fenceMatch = line.match(/^\s*(?<marker>`{3,}|~{3,})/u);
    if (fenceMatch?.groups?.marker) {
      const marker = fenceMatch.groups.marker;
      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
    } else if (!fence && line === heading) {
      return offset;
    }
    offset += segment.length;
  }
  return -1;
}

function compactReleaseNotes(section, repository, tag) {
  const recordIndex = headingIndexOutsideFences(section, CONTRIBUTION_RECORD_HEADING);
  if (recordIndex < 0) {
    fail(
      "release notes exceed GitHub's body limit and cannot be compacted without a complete contribution record",
    );
  }
  const editorialNotes = section.slice(0, recordIndex).trimEnd();
  const contributionRecordUrl = tagPinnedContributionRecordUrl(repository, tag);
  return [
    editorialNotes,
    "",
    CONTRIBUTION_RECORD_HEADING,
    "",
    `The full contribution record is available in the tag-pinned [CHANGELOG.md](${contributionRecordUrl}).`,
  ].join("\n");
}

export function dedicatedSectionVersionForTag(tag) {
  // Correction (vX-N) and alpha tags may carry their own exact changelog
  // heading; beta and stable bodies must come from the stable base section.
  const taggedVersion = tag.replace(/^v/u, "");
  if (/-beta\.[1-9][0-9]*$/u.test(taggedVersion)) {
    return undefined;
  }
  return /-(?:alpha\.)?[1-9][0-9]*$/u.test(taggedVersion) ? taggedVersion : undefined;
}

export function releaseNotesSectionForTag(changelog, version, tag) {
  // Alpha and correction tags prefer their own exact heading when the
  // changelog carries one; otherwise they fall back to the base version.
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
    const unreleased = extractChangelogSection(changelog, "Unreleased");
    return unreleased.replace(/^## Unreleased\r?$/mu, `## ${version}`);
  }
}

export function renderGithubReleaseNotes({
  changelog,
  version,
  tag,
  repository,
  verification = "",
}) {
  validateRepository(repository);
  validateTag(tag);
  const tagVersion = releaseNotesVersionForTag(tag);
  if (tagVersion !== version) {
    fail(`release tag ${tag} requires CHANGELOG.md version ${tagVersion}, got ${version}`);
  }
  const section = releaseNotesSectionForTag(changelog, version, tag);
  const mode = fitsGithubReleaseBody(section) ? "full" : "compact";
  const baseBody = mode === "full" ? section : compactReleaseNotes(section, repository, tag);
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

export function verifyGithubReleaseNotes({ body, changelog, version, tag, repository }) {
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
  node scripts/render-github-release-notes.mjs \\
    --changelog <path> --tag <tag> --repository <owner/repo> \\
    [--version <version>] [--verification-file <path>] [--output <path>] \\
    [--metadata-output <path>]
`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (
      arg === "--changelog" ||
      arg === "--version" ||
      arg === "--tag" ||
      arg === "--repository" ||
      arg === "--verification-file" ||
      arg === "--output" ||
      arg === "--metadata-output"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`${arg} requires a value`);
      }
      const key = arg.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
      options[key] = value;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  if (!options.help) {
    for (const name of ["changelog", "tag", "repository"]) {
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
  const changelog = readFileSync(options.changelog, "utf8");
  const verification = options.verificationFile
    ? readFileSync(options.verificationFile, "utf8")
    : "";
  const rendered = renderGithubReleaseNotes({
    changelog,
    version: options.version ?? releaseNotesVersionForTag(options.tag),
    tag: options.tag,
    repository: options.repository,
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
