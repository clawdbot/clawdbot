#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractChangelogReleaseSections,
  formatShippedBaselineExclusions,
  parseShippedBaselineExclusions,
  releaseNotesVersionForTag,
  verifyGithubReleaseNotes,
} from "../../../../scripts/render-github-release-notes.mjs";

const repo = "openclaw/openclaw";
const githubSnapshotSchemaVersion = 1;
const githubSnapshotCheckpointInterval = 25;
const commitAssociationQueryBatchSize = 20;
const excludedHandles = new Set(["openclaw", "clawsweeper", "claude", "codex", "steipete"]);
const nonEditorialTypes = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "qa",
  "refactor",
  "style",
  "test",
]);
const nonEditorialTitlePattern =
  /(?:^|[\s:([{\-])(docs?|documentation|tests?|testing|qa|quality assurance|refactor(?:ing)?|ci|continuous integration|build|chore|style|lint|format)(?:$|[\s:)\]}\-])/i;
const editorialTitlePattern =
  /^\s*(?:\[[^\]]+\]\s*)?(?:#\d+:\s*)?(?:add|allow|block|enable|expose|fail|fix|harden|honor|improve|keep|migrate|move|persist|polish|preserve|prevent|propagate|rate[- ]?limit|restore|revert|ship|support|treat|validate)\b|^\s*#\d+:/i;
const genericDirectCommitTerms = new Set([
  "add",
  "allow",
  "avoid",
  "build",
  "change",
  "fix",
  "improve",
  "keep",
  "make",
  "missing",
  "move",
  "omit",
  "omitted",
  "prevent",
  "repair",
  "required",
  "restore",
  "update",
]);
let githubSnapshotState;

function fail(message) {
  throw new Error(message);
}

function printUsage() {
  console.log(`Usage:
  node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \\
    --base <tag-or-sha> --target <tag-or-sha> --version <version> [options]

Required:
  --base <ref>          Release range start.
  --target <ref>        Release range end.
  --version <version>   CHANGELOG.md version heading to verify.

Options:
  --manifest <path>     Read or write the complete contribution record ledger.
  --github-snapshot <path>
                        Override the exact-range GitHub GraphQL snapshot path.
  --no-github-snapshot  Disable GitHub GraphQL snapshot reuse.
  --refresh-github-snapshot
                        Ignore an existing exact-range snapshot and rebuild it.
  --main-ref <ref>      Canonical mainline used to replace backport PRs.
  --seed-ref <ref>      Use an existing release section as editorial input.
  --shipped-ref <tag>   Exclude PRs already recorded by this shipped tag; repeatable.
  --write-ledger        Write the verified ledger back into CHANGELOG.md.
  --release-tag <tag>   GitHub release tag to compare; repeatable with --check-github.
  --check-github        Require each supplied GitHub release body to match.
  --json                Emit machine-readable verification output.
  --help                Show this help text.`);
}

function parseArgs(argv) {
  const options = {
    releaseTags: [],
    checkGithub: false,
    help: false,
    json: false,
    manifestPath: undefined,
    githubSnapshotPath: undefined,
    mainRef: undefined,
    noGithubSnapshot: false,
    refreshGithubSnapshot: false,
    seedRef: undefined,
    shippedRefs: [],
    writeLedger: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (
      arg === "--check-github" ||
      arg === "--json" ||
      arg === "--no-github-snapshot" ||
      arg === "--refresh-github-snapshot" ||
      arg === "--write-ledger"
    ) {
      options[
        arg === "--check-github"
          ? "checkGithub"
          : arg === "--write-ledger"
            ? "writeLedger"
            : arg === "--no-github-snapshot"
              ? "noGithubSnapshot"
              : arg === "--refresh-github-snapshot"
                ? "refreshGithubSnapshot"
                : "json"
      ] = true;
      continue;
    }
    if (
      arg === "--base" ||
      arg === "--target" ||
      arg === "--version" ||
      arg === "--release-tag" ||
      arg === "--shipped-ref" ||
      arg === "--github-snapshot" ||
      arg === "--main-ref" ||
      arg === "--manifest" ||
      arg === "--seed-ref"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`missing value for ${arg}`);
      }
      if (arg === "--release-tag") {
        options.releaseTags.push(value);
      } else if (arg === "--shipped-ref") {
        options.shippedRefs.push(value);
      } else if (arg === "--manifest") {
        options.manifestPath = value;
      } else if (arg === "--github-snapshot") {
        options.githubSnapshotPath = value;
      } else if (arg === "--main-ref") {
        options.mainRef = value;
      } else if (arg === "--seed-ref") {
        options.seedRef = value;
      } else {
        options[arg.slice(2)] = value;
      }
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }

  if (!options.help) {
    for (const name of ["base", "target", "version"]) {
      if (!options[name]) {
        fail(`--${name} is required`);
      }
    }
  } else if (options.checkGithub || options.releaseTags.length > 0) {
    fail("--help cannot be combined with verification options");
  }
  if (!options.help && options.checkGithub && options.releaseTags.length === 0) {
    fail("--check-github requires at least one --release-tag");
  }
  if (options.noGithubSnapshot && options.githubSnapshotPath) {
    fail("--no-github-snapshot cannot be combined with --github-snapshot");
  }
  if (options.noGithubSnapshot && options.refreshGithubSnapshot) {
    fail("--no-github-snapshot cannot be combined with --refresh-github-snapshot");
  }
  const uniqueShippedRefs = new Set(options.shippedRefs);
  if (uniqueShippedRefs.size !== options.shippedRefs.length) {
    fail("--shipped-ref values must be unique");
  }
  options.shippedRefs = options.shippedRefs.toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  return options;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...options.env },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(args) {
  return run("git", args).trimEnd();
}

function gitIsAncestor(base, target) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${base}^{commit}`, `${target}^{commit}`],
    {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  fail(
    `could not validate release range ancestry for ${base}..${target}: ${
      result.stderr?.trim() || result.signal || result.status
    }`,
  );
}

function gitCommit(ref, required = false) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  if (!required) {
    return undefined;
  }
  fail(`could not resolve canonical main ref ${ref}: ${result.stderr?.trim() || result.status}`);
}

function fetchGithubApi(args) {
  try {
    return JSON.parse(
      run("ghx", ["api", ...args], { env: { GHX_NO_CACHE: "1" } }).replace(
        /\u001B\[[0-?]*[ -/]*[@-~]/g,
        "",
      ),
    );
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.trim() !== "") {
      return JSON.parse(error.stdout.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, ""));
    }
    throw error;
  }
}

export function createGithubSnapshotState({
  base,
  checkpointEvery = githubSnapshotCheckpointInterval,
  filePath,
  refresh = false,
  repository = repo,
  target,
}) {
  if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 1) {
    fail("GitHub snapshot checkpoint interval must be a positive integer");
  }
  let responses = {};
  if (!refresh && existsSync(filePath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      fail(
        `could not read GitHub snapshot ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      parsed.schemaVersion !== githubSnapshotSchemaVersion ||
      parsed.repository !== repository ||
      parsed.base !== base ||
      parsed.target !== target ||
      !parsed.responses ||
      typeof parsed.responses !== "object" ||
      Array.isArray(parsed.responses)
    ) {
      fail(
        `GitHub snapshot ${filePath} does not match ${repository} ${base}..${target}; use --refresh-github-snapshot`,
      );
    }
    responses = parsed.responses;
  }
  return {
    base,
    checkpointEvery,
    dirty: refresh && existsSync(filePath),
    filePath,
    hits: 0,
    misses: 0,
    repository,
    responses,
    target,
    writesSincePersist: 0,
  };
}

export function githubApiWithSnapshot(args, fetchApi, snapshotState) {
  if (!snapshotState || args[0] !== "graphql") {
    return fetchApi(args);
  }
  const key = JSON.stringify(args);
  const cached = snapshotState.responses[key];
  if (cached !== undefined) {
    snapshotState.hits += 1;
    return structuredClone(cached);
  }
  snapshotState.misses += 1;
  const response = fetchApi(args);
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    response.data === undefined ||
    (Array.isArray(response.errors) && response.errors.length > 0)
  ) {
    return response;
  }
  snapshotState.responses[key] = structuredClone(response);
  snapshotState.dirty = true;
  snapshotState.writesSincePersist += 1;
  if (snapshotState.writesSincePersist >= snapshotState.checkpointEvery) {
    persistGithubSnapshot(snapshotState);
  }
  return response;
}

export function persistGithubSnapshot(snapshotState) {
  if (!snapshotState?.dirty) {
    return;
  }
  const output = `${JSON.stringify(
    {
      schemaVersion: githubSnapshotSchemaVersion,
      repository: snapshotState.repository,
      base: snapshotState.base,
      target: snapshotState.target,
      responses: snapshotState.responses,
    },
    null,
    2,
  )}\n`;
  mkdirSync(path.dirname(snapshotState.filePath), { recursive: true });
  const tempPath = `${snapshotState.filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, output);
    renameSync(tempPath, snapshotState.filePath);
    snapshotState.dirty = false;
    snapshotState.writesSincePersist = 0;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function githubApi(args) {
  return githubApiWithSnapshot(args, fetchGithubApi, githubSnapshotState);
}

export function defaultGithubSnapshotPath(base, target, gitCommonDir) {
  const defaultName = `verify-release-notes-${base}-${target}.json`;
  return path.resolve(gitCommonDir, "openclaw-release-cache", defaultName);
}

function initializeGithubSnapshot(options) {
  if (options.noGithubSnapshot) {
    return undefined;
  }
  const base = git(["rev-parse", `${options.base}^{commit}`]);
  const target = git(["rev-parse", `${options.target}^{commit}`]);
  const filePath = path.resolve(
    options.githubSnapshotPath ??
      defaultGithubSnapshotPath(base, target, git(["rev-parse", "--git-common-dir"])),
  );
  const state = createGithubSnapshotState({
    base,
    filePath,
    refresh: options.refreshGithubSnapshot,
    target,
  });
  process.once("exit", () => persistGithubSnapshot(state));
  return state;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isEligibleHandle(handle) {
  return (
    typeof handle === "string" &&
    handle.toLowerCase() !== "undefined" &&
    !handle.endsWith("[bot]") &&
    !excludedHandles.has(handle.toLowerCase())
  );
}

function githubHandleFromNoreply(email) {
  return email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i)?.[1];
}

function editorialClassification(subject) {
  const type = subject.match(/^\s*([a-z]+)(?:\([^)]*\))?!?:/i)?.[1]?.toLowerCase();
  return {
    editorialEligible:
      (Boolean(type) || editorialTitlePattern.test(subject)) &&
      !nonEditorialTypes.has(type) &&
      !nonEditorialTitlePattern.test(subject),
    type: type ?? "other",
  };
}

function mergedByTarget(mergedAt, targetTimestamp) {
  const mergedTimestamp = Date.parse(mergedAt);
  return Number.isFinite(mergedTimestamp) && mergedTimestamp <= targetTimestamp;
}

function sectionFor(changelog, version) {
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\r?$`, "m").exec(changelog);
  if (!heading || heading.index === undefined) {
    fail(`CHANGELOG.md does not contain ## ${version}`);
  }
  const start = heading.index;
  const bodyStart = changelog.indexOf("\n", start) + 1;
  const next = /^## /gm;
  next.lastIndex = bodyStart;
  const nextHeading = next.exec(changelog);
  const end = nextHeading?.index ?? changelog.length;
  return {
    start,
    end,
    source: changelog.slice(start, end).trimEnd(),
    body: changelog.slice(bodyStart, end).trim(),
  };
}

function referencesIn(text) {
  const references = [];
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_.&-])(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g,
  )) {
    const qualifiedRepository = match.groups?.owner
      ? `${match.groups.owner}/${match.groups.name}`.toLowerCase()
      : undefined;
    if (!qualifiedRepository || qualifiedRepository === repo) {
      references.push(Number(match.groups?.number));
    }
  }
  return references;
}

function referenceLabelsIn(text) {
  const labels = [];
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_.&-])(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g,
  )) {
    const qualifiedRepository = match.groups?.owner
      ? `${match.groups.owner}/${match.groups.name}`
      : undefined;
    labels.push(
      !qualifiedRepository || qualifiedRepository.toLowerCase() === repo
        ? `#${match.groups?.number}`
        : `${qualifiedRepository}#${match.groups?.number}`,
    );
  }
  return labels;
}

export function renderContributionRecordEntry(entry) {
  const references = [];
  appendUnique(references, referenceLabelsIn(entry.title));
  appendUnique(
    references,
    (entry.priorReferences ?? []).map((number) => `#${number}`),
  );
  appendUnique(references, entry.externalReferences ?? []);
  for (const issue of entry.linkedIssues) {
    appendUnique(references, [`#${issue.number}`]);
  }
  const related = references.length > 0 ? ` Related ${references.join(", ")}.` : "";
  const attribution =
    entry.thanks.length > 0
      ? ` Thanks ${entry.thanks.map((handle) => `@${handle}`).join(" and ")}.`
      : "";
  return `- **PR #${entry.number}**${related}${attribution}`;
}

export function releaseNoteReferences(sectionSource, shippedBaselines) {
  const shippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  // The baseline inventory proves subtraction; its PR ids are not release-note references.
  const referenceSource = shippedBaselineLine
    ? sectionSource.replace(shippedBaselineLine, "")
    : sectionSource;
  return referencesIn(referenceSource);
}

function closingReferencesIn(text) {
  const references = [];
  for (const match of text.matchAll(
    /\b(?:fix(?:es|ed)?|closes?|closed|resolves?|resolved)\s+(?:(?:openclaw\/openclaw)?#\d+)(?:\s*(?:,|and)\s*(?:(?:openclaw\/openclaw)?#\d+))*/gi,
  )) {
    appendReferences(references, referencesIn(match[0]));
  }
  return references;
}

export function standardRevertedHash(message) {
  const paragraphs = message
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim());
  const messageIsRevert = /^(?:[a-z][a-z0-9-]*(?:\([^)]+\))?!?:\s*)?revert\b/i.test(
    paragraphs[0] ?? "",
  );
  for (const [index, paragraph] of paragraphs.entries()) {
    const revertedHash = paragraph.match(/^This reverts commit ([0-9a-f]{7,40})\.$/i)?.[1];
    if (!revertedHash) {
      continue;
    }
    // GitHub squash messages can embed a reverted intermediate commit. Its
    // marker follows the corresponding bullet and does not revert the squash.
    if (!messageIsRevert && /^\*\s+Revert\b/i.test(paragraphs[index - 1] ?? "")) {
      continue;
    }
    return revertedHash;
  }
  return undefined;
}

function handlesIn(text) {
  const thanksStart = text.lastIndexOf(" Thanks ");
  if (thanksStart < 0) {
    return [];
  }
  const content = text.slice(0, thanksStart);
  return [...text.slice(thanksStart).matchAll(/@([A-Za-z0-9-]+)/g)]
    .map((match) => match[1])
    .filter(
      (handle) =>
        isEligibleHandle(handle) &&
        !new RegExp(`(?<![A-Za-z0-9-])@${escapeRegExp(handle)}\\b`, "i").test(content),
    );
}

function externalReferencesIn(text) {
  return referenceLabelsIn(text).filter((reference) => !reference.startsWith("#"));
}

function appendUnique(values, additions) {
  const seen = new Set(values.map((value) => value.toLowerCase()));
  for (const value of additions) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      values.push(value);
      seen.add(key);
    }
  }
}

function addContributionRecordEntry(entries, key, entry) {
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, {
      ...entry,
      externalReferences: [...(entry.externalReferences ?? [])],
      references: [...entry.references],
      thanks: [...entry.thanks],
    });
    return;
  }
  appendUnique(existing.externalReferences, entry.externalReferences ?? []);
  appendReferences(existing.references, entry.references);
  addHandles(existing.thanks, entry.thanks);
}

export function contributionRecordFor(section) {
  const result = { legacyIssues: new Map(), pullRequests: new Map() };
  const recordStart = section.source.search(/\n### Complete contribution (?:ledger|record)\r?$/m);
  if (recordStart < 0) {
    return result;
  }
  const record = section.source.slice(recordStart);
  let subsection = "";
  for (const line of record.split("\n")) {
    if (line === "#### Pull requests") {
      subsection = "pull-requests";
      continue;
    }
    if (line === "#### Linked issues") {
      subsection = "linked-issues";
      continue;
    }
    if (line.startsWith("#### ")) {
      subsection = "";
      continue;
    }
    if (subsection === "pull-requests") {
      const explicitRecord = line.match(/^- \*\*PR #(\d+)\*\*/);
      const legacyRecord = line.match(/\(#(\d+)\)\.(?: Thanks.*)?$/);
      const number = explicitRecord?.[1] ?? legacyRecord?.[1];
      if (number) {
        const value = Number(number);
        const metadata = explicitRecord ? line.slice(explicitRecord[0].length) : line;
        addContributionRecordEntry(result.pullRequests, value, {
          externalReferences: externalReferencesIn(metadata),
          references: referencesIn(metadata).filter((reference) => reference !== value),
          thanks: handlesIn(line),
        });
      }
      continue;
    }
    if (subsection === "linked-issues") {
      const number = referencesIn(line)[0];
      if (number) {
        addContributionRecordEntry(result.legacyIssues, number, {
          references: [],
          thanks: handlesIn(line),
        });
      }
    }
  }
  return result;
}

function completeContributionRecord(section, label) {
  const recordStart = section.source.search(/\n### Complete contribution record\r?$/m);
  if (recordStart < 0) {
    fail(`${label} is missing ### Complete contribution record`);
  }
  const recordSource = section.source.slice(recordStart);
  const provenance = recordSource.match(
    /^This audited record covers the complete \S+\.\.[0-9a-f]{40} history: (?<count>[0-9]+) merged PRs?\./mu,
  );
  if (!provenance?.groups?.count) {
    fail(`${label} is missing exact complete contribution record provenance`);
  }
  const record = contributionRecordFor(section);
  const declaredCount = Number(provenance.groups.count);
  if (record.pullRequests.size !== declaredCount) {
    fail(
      `${label} contribution record declares ${declaredCount} PRs but contains ${record.pullRequests.size}`,
    );
  }
  return { record, declaredCount };
}

export function cumulativeShippedPullRequests(changelog, label) {
  const sections = extractChangelogReleaseSections(changelog).filter(
    (section) =>
      section.version !== "Unreleased" &&
      section.source.includes("\n### Complete contribution record"),
  );
  if (sections.length === 0) {
    fail(`${label} is missing ### Complete contribution record`);
  }
  const pullRequests = new Set();
  for (const section of sections) {
    const record = contributionRecordFor(section);
    for (const number of record.pullRequests.keys()) {
      pullRequests.add(number);
    }
  }
  return pullRequests;
}

function shippedBaselineFor(ref) {
  const version = releaseNotesVersionForTag(ref);
  const tagRef = `refs/tags/${ref}`;
  git(["rev-parse", `${tagRef}^{commit}`]);
  const changelog = git(["show", `${tagRef}:CHANGELOG.md`]);
  completeContributionRecord(sectionFor(changelog, version), `shipped baseline ${ref}`);
  return {
    ref,
    pullRequests: cumulativeShippedPullRequests(changelog, `shipped baseline ${ref}`),
  };
}

export function subtractShippedPullRequests(source, baselines) {
  const excluded = new Set();
  const metadata = [];
  for (const baseline of baselines.toSorted((a, b) =>
    a.ref === b.ref ? 0 : a.ref < b.ref ? -1 : 1,
  )) {
    const pullRequests = [];
    for (const number of baseline.pullRequests) {
      if (
        !excluded.has(number) &&
        (source.pullRequests.has(number) || source.references.includes(number))
      ) {
        excluded.add(number);
        pullRequests.push(number);
      }
      source.pullRequests.delete(number);
    }
    source.references = source.references.filter((number) => !baseline.pullRequests.has(number));
    const sortedPullRequests = pullRequests.toSorted((a, b) => a - b);
    metadata.push({
      ref: baseline.ref,
      count: sortedPullRequests.length,
      pullRequests: sortedPullRequests,
    });
  }
  return { baselines: metadata, pullRequests: excluded };
}

export function withoutExcludedContributionRecords(record, excludedReferences) {
  if (excludedReferences.size === 0) {
    return record;
  }
  const filtered = { legacyIssues: new Map(), pullRequests: new Map() };
  for (const [number, entry] of record.pullRequests) {
    if (excludedReferences.has(number)) {
      continue;
    }
    addContributionRecordEntry(filtered.pullRequests, number, {
      ...entry,
      externalReferences: entry.externalReferences,
      references: entry.references.filter((reference) => !excludedReferences.has(reference)),
    });
  }
  for (const [number, entry] of record.legacyIssues) {
    if (!excludedReferences.has(number)) {
      addContributionRecordEntry(filtered.legacyIssues, number, entry);
    }
  }
  return filtered;
}

function contributionRecordReferences(record) {
  return [...record.pullRequests.keys()];
}

function contributionRecordMetadataReferences(record) {
  const references = contributionRecordReferences(record);
  for (const entry of record.pullRequests.values()) {
    appendReferences(references, entry.references);
  }
  appendReferences(references, record.legacyIssues.keys());
  return references;
}

export function renderedContributionRecordReferences(record, writeLedger) {
  // Write mode replaces the existing generated record. Validating stale record
  // references here would make the verifier unable to repair its own output.
  return writeLedger ? [] : contributionRecordMetadataReferences(record);
}

export function contaminatingPullRequestReferences({
  noteReferences,
  recordedReferences,
  sourcePullRequests,
  sourceReferences,
  seededPullRequests,
  nodes,
}) {
  const allowed = new Set([...sourcePullRequests, ...seededPullRequests]);
  for (const number of sourceReferences) {
    if (nodes.get(number)?.__typename === "PullRequest") {
      allowed.add(number);
    }
  }
  return [...new Set([...noteReferences, ...recordedReferences])].filter(
    (number) => nodes.get(number)?.__typename === "PullRequest" && !allowed.has(number),
  );
}

function appendReferences(references, additions) {
  const seen = new Set(references);
  for (const number of additions) {
    if (!seen.has(number)) {
      references.push(number);
      seen.add(number);
    }
  }
}

function normalizedCommitSubject(subject) {
  return subject
    .replace(/\s+\(#\d+\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cherryPickOrigins(message) {
  return [...message.matchAll(/^\(cherry picked from commit ([0-9a-f]{40})\)$/gim)].map((match) =>
    match[1].toLowerCase(),
  );
}

function backportPullRequestOrigins(message) {
  return [
    ...message.matchAll(/^Backport of #(\d+) to release\/[A-Za-z0-9._/-]+(?:\.)?\s*$/gim),
  ].map((match) => Number(match[1]));
}

function changedPathsForCommit(hash) {
  return new Set(
    git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", hash, "--"])
      .split("\n")
      .filter(Boolean),
  );
}

function authorsMatch(left, right) {
  const leftEmail = left.authorEmail?.trim().toLowerCase();
  const rightEmail = right.authorEmail?.trim().toLowerCase();
  if (leftEmail && rightEmail && leftEmail === rightEmail) {
    return true;
  }
  return (
    left.authorName?.trim().toLowerCase() === right.authorName?.trim().toLowerCase() &&
    Boolean(left.authorName?.trim())
  );
}

function pathsOverlap(left, right) {
  for (const path of left) {
    if (right.has(path)) {
      return true;
    }
  }
  return false;
}

export function canonicalMainCommitMatches(commit, candidates) {
  const exact = candidates.find((candidate) => candidate.hash === commit.hash);
  if (exact) {
    return [exact.hash];
  }

  const origins = new Set(cherryPickOrigins(commit.body));
  const explicit = candidates
    .filter((candidate) => origins.has(candidate.hash))
    .map((candidate) => candidate.hash);
  if (explicit.length > 0) {
    return [...new Set(explicit)];
  }

  const pullRequestOrigins = new Set(backportPullRequestOrigins(commit.body));
  if (pullRequestOrigins.size > 0) {
    const pullRequestMatches = candidates.filter(
      (candidate) =>
        (candidate.pullRequests ?? []).some((number) => pullRequestOrigins.has(number)) &&
        authorsMatch(commit, candidate) &&
        pathsOverlap(commit.changedPaths, candidate.changedPaths),
    );
    return pullRequestMatches.length === 1 ? [pullRequestMatches[0].hash] : [];
  }

  const subject = normalizedCommitSubject(commit.subject);
  const matches = candidates.filter(
    (candidate) =>
      normalizedCommitSubject(candidate.subject) === subject &&
      authorsMatch(commit, candidate) &&
      pathsOverlap(commit.changedPaths, candidate.changedPaths),
  );
  return matches.length === 1 ? [matches[0].hash] : [];
}

export function canonicalPullRequests(
  currentPullRequests,
  mainPullRequests,
  hasCanonicalMainCommit = mainPullRequests.length > 0,
) {
  const pullRequests = hasCanonicalMainCommit ? mainPullRequests : currentPullRequests;
  return [...new Set(pullRequests)].toSorted((left, right) => left - right);
}

function canonicalMainCommits(base, mainRef) {
  if (!mainRef) {
    return [];
  }
  const mainCommit = gitCommit(mainRef, true);
  const mainBase = git(["merge-base", base, mainCommit]);
  const output = git([
    "log",
    "--reverse",
    "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%B%x1e",
    `${mainBase}..${mainCommit}`,
  ]);
  const commits = [];
  for (const record of output.split("\x1e")) {
    if (!record) {
      continue;
    }
    const [rawHash, subject, authorName, authorEmail, ...bodyParts] = record.split("\x1f");
    const hash = rawHash.trim();
    commits.push({
      authorEmail,
      authorName,
      body: bodyParts.join("\x1f"),
      hash,
      subject,
    });
  }
  return commits;
}

function sourceCommits(base, target, mainRef) {
  const targetCommit = git(["rev-parse", `${target}^{commit}`]);
  if (!gitIsAncestor(base, targetCommit)) {
    fail(`release range base ${base} must be an ancestor of target ${target}`);
  }
  const mergeBase = git(["merge-base", base, targetCommit]);
  const targetTimestamp = Date.parse(git(["show", "-s", "--format=%cI", targetCommit]));
  if (!Number.isFinite(targetTimestamp)) {
    fail(`could not resolve timestamp for release target ${target}`);
  }
  const output = git([
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%B%x1e",
    `${mergeBase}..${targetCommit}`,
  ]);
  const commits = new Map();
  const revertsByTarget = new Map();
  for (const record of output.split("\x1e")) {
    if (!record) {
      continue;
    }
    const [rawHash, subject, authorName, authorEmail, ...bodyParts] = record.split("\x1f");
    const hash = rawHash.trim();
    const body = bodyParts.join("\x1f");
    const revertedHash = standardRevertedHash(body);
    const isRevert = Boolean(revertedHash) || subject.startsWith('Revert "');
    commits.set(hash, {
      authorEmail,
      authorName,
      body,
      hash,
      isRevert,
      revertedHash,
      subject,
    });
  }
  for (const commit of commits.values()) {
    if (!commit.revertedHash) {
      continue;
    }
    const targetHash = [...commits.keys()].find((candidate) =>
      candidate.startsWith(commit.revertedHash),
    );
    if (targetHash) {
      const reverts = revertsByTarget.get(targetHash) ?? [];
      reverts.push(commit.hash);
      revertsByTarget.set(targetHash, reverts);
    }
  }
  const active = new Map();
  function isActive(hash) {
    if (active.has(hash)) {
      return active.get(hash);
    }
    const cancellingReverts = revertsByTarget.get(hash) ?? [];
    const value = !cancellingReverts.some((revertHash) => isActive(revertHash));
    active.set(hash, value);
    return value;
  }
  const revertedCommitStates = new Map();
  function revertedCommitState(ref, seen = new Set()) {
    let hash;
    try {
      hash = git(["rev-parse", `${ref}^{commit}`]);
    } catch {
      return undefined;
    }
    const cached = revertedCommitStates.get(hash);
    if (cached) {
      return cached;
    }
    if (seen.has(hash)) {
      fail(`cyclic revert history at ${hash}`);
    }
    seen.add(hash);
    const output = git(["show", "-s", "--format=%s%x1f%B", hash]);
    const [subject, ...bodyParts] = output.split("\x1f");
    const body = bodyParts.join("\x1f");
    const message = `${subject}\n${body}`;
    const revertedHash = standardRevertedHash(body);
    const targetState = revertedHash ? revertedCommitState(revertedHash, seen) : undefined;
    const state = targetState
      ? { ...targetState, depth: targetState.depth + 1 }
      : { depth: 0, hash, references: referencesIn(message) };
    revertedCommitStates.set(hash, state);
    return state;
  }

  const references = [];
  const revertedReferences = new Set();
  const revertedCommitHashes = new Set();
  const coauthorsByReference = new Map();
  const activeCommits = [];
  for (const commit of commits.values()) {
    if (commit.isRevert && isActive(commit.hash)) {
      const coauthorEmails = [...commit.body.matchAll(/^Co-authored-by:\s*.+?<([^>\s]+)>$/gim)].map(
        (match) => match[1],
      );
      activeCommits.push({
        authorEmail: commit.authorEmail,
        authorHandle: githubHandleFromNoreply(commit.authorEmail),
        authorName: commit.authorName,
        body: commit.body,
        closingReferences: [],
        coauthors: coauthorEmails.map(githubHandleFromNoreply).filter(isEligibleHandle),
        coauthorEmails,
        hash: commit.hash,
        isRevert: true,
        pullRequests: [],
        references: [],
        subject: commit.subject,
      });
      continue;
    }
    if (commit.isRevert) {
      continue;
    }
    const uniqueReferences = [...new Set(referencesIn(`${commit.subject}\n${commit.body}`))];
    if (!isActive(commit.hash)) {
      revertedCommitHashes.add(commit.hash);
      for (const number of uniqueReferences) {
        revertedReferences.add(number);
      }
      continue;
    }
    const coauthorEmails = [...commit.body.matchAll(/^Co-authored-by:\s*.+?<([^>\s]+)>$/gim)].map(
      (match) => match[1],
    );
    const coauthors = coauthorEmails.map(githubHandleFromNoreply).filter(isEligibleHandle);
    activeCommits.push({
      authorEmail: commit.authorEmail,
      authorHandle: githubHandleFromNoreply(commit.authorEmail),
      authorName: commit.authorName,
      body: commit.body,
      closingReferences: closingReferencesIn(`${commit.subject}\n${commit.body}`),
      coauthors,
      coauthorEmails,
      hash: commit.hash,
      isRevert: false,
      pullRequests: [],
      references: uniqueReferences,
      subject: commit.subject,
    });
  }
  for (const commit of commits.values()) {
    if (!commit.isRevert || !commit.revertedHash || !isActive(commit.hash)) {
      continue;
    }
    const targetInRange = [...commits.keys()].some((candidate) =>
      candidate.startsWith(commit.revertedHash),
    );
    if (targetInRange) {
      continue;
    }
    const revertedState = revertedCommitState(commit.revertedHash);
    if (!revertedState) {
      continue;
    }
    if (revertedState.depth % 2 !== 0) {
      continue;
    }
    revertedCommitHashes.add(revertedState.hash);
    for (const number of revertedState.references) {
      revertedReferences.add(number);
    }
  }
  const activePullRequests = resolveAssociatedPullRequests(
    activeCommits.map((commit) => commit.hash),
    targetTimestamp,
  );
  const mainCommits = canonicalMainCommits(base, mainRef);
  const mainCommitsByHash = new Map(mainCommits.map((commit) => [commit.hash, commit]));
  const mainCommitsBySubject = new Map();
  for (const commit of mainCommits) {
    const subject = normalizedCommitSubject(commit.subject);
    const matches = mainCommitsBySubject.get(subject) ?? [];
    matches.push(commit);
    mainCommitsBySubject.set(subject, matches);
  }
  const canonicalMainCommitsByReleaseCommit = new Map();
  const namedMainPullRequestsByReleaseCommit = new Map();
  const canonicalMainHashes = new Set();
  const mainAssociationCandidateHashes = new Set();
  const pendingCanonicalMatches = [];
  const changedPathsByCommit = new Map();
  const withChangedPaths = (commit) => {
    if (!changedPathsByCommit.has(commit.hash)) {
      changedPathsByCommit.set(commit.hash, changedPathsForCommit(commit.hash));
    }
    return { ...commit, changedPaths: changedPathsByCommit.get(commit.hash) };
  };
  for (const commit of activeCommits) {
    const exact = mainCommitsByHash.get(commit.hash);
    if (exact) {
      canonicalMainCommitsByReleaseCommit.set(commit.hash, []);
      continue;
    }
    const explicit = cherryPickOrigins(commit.body)
      .map((origin) => mainCommitsByHash.get(origin))
      .filter(Boolean);
    if (explicit.length > 0) {
      const matches = [...new Set(explicit.map((candidate) => candidate.hash))];
      canonicalMainCommitsByReleaseCommit.set(commit.hash, matches);
      for (const hash of matches) {
        canonicalMainHashes.add(hash);
      }
      continue;
    }
    const releaseCommit = withChangedPaths(commit);
    const pullRequestOrigins = backportPullRequestOrigins(commit.body);
    const candidates = new Map(
      (mainCommitsBySubject.get(normalizedCommitSubject(commit.subject)) ?? []).map((candidate) => [
        candidate.hash,
        candidate,
      ]),
    );
    if (pullRequestOrigins.length > 0) {
      for (const candidate of mainCommits) {
        if (!authorsMatch(releaseCommit, candidate)) {
          continue;
        }
        const mainCandidate = withChangedPaths(candidate);
        if (!pathsOverlap(releaseCommit.changedPaths, mainCandidate.changedPaths)) {
          continue;
        }
        candidates.set(candidate.hash, candidate);
        mainAssociationCandidateHashes.add(candidate.hash);
      }
    }
    pendingCanonicalMatches.push({ candidates, commit: releaseCommit, pullRequestOrigins });
  }
  const candidateMainPullRequests = resolveAssociatedPullRequests(
    [...mainAssociationCandidateHashes],
    Number.POSITIVE_INFINITY,
  );
  for (const { candidates, commit, pullRequestOrigins } of pendingCanonicalMatches) {
    const matches = canonicalMainCommitMatches(
      commit,
      [...candidates.values()].map((candidate) => ({
        ...withChangedPaths(candidate),
        pullRequests: candidateMainPullRequests.get(candidate.hash) ?? [],
      })),
    );
    canonicalMainCommitsByReleaseCommit.set(commit.hash, matches);
    if (pullRequestOrigins.length > 0 && matches.length === 1) {
      const associatedPullRequests = candidateMainPullRequests.get(matches[0]) ?? [];
      const namedPullRequests = pullRequestOrigins.filter((number) =>
        associatedPullRequests.includes(number),
      );
      if (namedPullRequests.length > 0) {
        namedMainPullRequestsByReleaseCommit.set(commit.hash, namedPullRequests);
      }
    }
    for (const hash of matches) {
      canonicalMainHashes.add(hash);
    }
  }
  const canonicalMainPullRequests = resolveAssociatedPullRequests(
    [...canonicalMainHashes],
    Number.POSITIVE_INFINITY,
  );
  const resolvedCoauthors = resolveCommitCoauthors(activeCommits);
  const pullRequests = new Set();
  const nonRevertPullRequests = new Set();
  for (const commit of activeCommits) {
    const currentPullRequests = activePullRequests.get(commit.hash) ?? [];
    const namedMainPullRequests = namedMainPullRequestsByReleaseCommit.get(commit.hash);
    const mainPullRequests =
      namedMainPullRequests ??
      (canonicalMainCommitsByReleaseCommit.get(commit.hash) ?? []).flatMap(
        (hash) => canonicalMainPullRequests.get(hash) ?? [],
      );
    const matchedMainCommits = canonicalMainCommitsByReleaseCommit.get(commit.hash) ?? [];
    const associatedPullRequests = canonicalPullRequests(
      currentPullRequests,
      mainPullRequests,
      matchedMainCommits.length > 0,
    );
    commit.pullRequests = associatedPullRequests;
    const suppressedBackportPullRequests = new Set(
      currentPullRequests.filter((number) => !associatedPullRequests.includes(number)),
    );
    commit.references = commit.references.filter(
      (number) => !suppressedBackportPullRequests.has(number),
    );
    addHandles(commit.coauthors, resolvedCoauthors.get(commit.hash) ?? []);
    appendReferences(commit.references, associatedPullRequests);
    for (const number of associatedPullRequests) {
      pullRequests.add(number);
      if (!commit.isRevert) {
        nonRevertPullRequests.add(number);
      }
    }
    appendReferences(references, commit.references);
    if (commit.coauthors.length === 0) {
      continue;
    }
    for (const number of commit.references) {
      const handles = coauthorsByReference.get(number) ?? new Set();
      for (const handle of commit.coauthors) {
        handles.add(handle);
      }
      coauthorsByReference.set(number, handles);
    }
  }
  const revertedPullRequests = new Set();
  for (const pullRequests of resolveAssociatedPullRequests(
    [...revertedCommitHashes],
    targetTimestamp,
  ).values()) {
    for (const number of pullRequests) {
      revertedPullRequests.add(number);
    }
  }
  // A later active implementation supersedes an earlier reverted fix, including
  // direct commits that cite the same issue without having a recoverable PR.
  for (const commit of activeCommits) {
    if (commit.isRevert) {
      continue;
    }
    for (const number of commit.references) {
      revertedReferences.delete(number);
    }
  }
  // A PR can span several commits. A reverted commit does not erase the PR while
  // another non-revert commit from it remains active in this release range.
  for (const number of revertedPullRequests) {
    if (!nonRevertPullRequests.has(number)) {
      pullRequests.delete(number);
      revertedReferences.add(number);
    }
  }
  for (const number of pullRequests) {
    revertedReferences.delete(number);
  }

  return {
    activeCommits,
    coauthorsByReference,
    mergeBase,
    pullRequests,
    references,
    revertedReferences,
    target: targetCommit,
    targetTimestamp,
  };
}

function graphql(query) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = githubApi(["graphql", "-f", `query=${query}`]);
      if (response?.data && typeof response.data === "object") {
        return response.data;
      }
      const errors = Array.isArray(response?.errors)
        ? response.errors.map((error) => error?.message).filter(Boolean)
        : [];
      const detail = [...errors, response?.message].filter(Boolean).join("\n");
      throw new Error(
        detail
          ? `GitHub GraphQL response did not include data:\n${detail}`
          : "GitHub GraphQL response did not include data.",
      );
    } catch (error) {
      lastError = error;
      const message = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
      // Historical ranges batch hundreds of objects; only retry transient transport failures.
      if (
        !/(?:operation timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS handshake timeout|stream error: .*CANCEL|unexpected end of JSON input|upstream connect error|connection termination|connection reset by peer|error connecting to api\.github\.com|Unexpected token '<'|something went wrong|temporarily unavailable|internal server error|rate limit)/i.test(
          message,
        )
      ) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function resolveAssociatedPullRequests(commitHashes, targetTimestamp) {
  const pullRequestsByCommit = new Map();
  const pending = [];
  function appendPullRequests(commitHash, connection) {
    const pullRequests = pullRequestsByCommit.get(commitHash) ?? [];
    const seen = new Set(pullRequests);
    for (const pullRequest of connection?.nodes ?? []) {
      // GitHub's mergedAt can trail the merge commit timestamp by a second.
      // Keep an exact merge-commit association so a release ending there does not drop its PR.
      const isExactMergeCommit = pullRequest.mergeCommit?.oid === commitHash;
      if (
        pullRequest.mergedAt &&
        (isExactMergeCommit || mergedByTarget(pullRequest.mergedAt, targetTimestamp)) &&
        !seen.has(pullRequest.number)
      ) {
        pullRequests.push(pullRequest.number);
        seen.add(pullRequest.number);
      }
    }
    pullRequestsByCommit.set(commitHash, pullRequests);
    if (connection?.pageInfo?.hasNextPage) {
      pending.push({ commitHash, cursor: connection.pageInfo.endCursor });
    }
  }
  for (let index = 0; index < commitHashes.length; index += commitAssociationQueryBatchSize) {
    const chunk = commitHashes.slice(index, index + commitAssociationQueryBatchSize);
    const fields = chunk
      .map(
        (hash, offset) =>
          `c${index + offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(hash)}) {
              ... on Commit {
                associatedPullRequests(first: 100) {
                  nodes {
                    number
                    mergedAt
                    mergeCommit { oid }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      appendPullRequests(chunk[offset], data[`c${index + offset}`]?.object?.associatedPullRequests);
    }
  }
  while (pending.length > 0) {
    const chunk = pending.splice(0, 20);
    const fields = chunk
      .map(
        (item, offset) =>
          `c${offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(item.commitHash)}) {
              ... on Commit {
                associatedPullRequests(first: 100, after: ${JSON.stringify(item.cursor)}) {
                  nodes {
                    number
                    mergedAt
                    mergeCommit { oid }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      appendPullRequests(
        chunk[offset].commitHash,
        data[`c${offset}`]?.object?.associatedPullRequests,
      );
    }
  }
  return pullRequestsByCommit;
}

function issueConnectionName(node) {
  if (node.__typename === "Issue") {
    return "closedByPullRequestsReferences";
  }
  if (node.__typename === "PullRequest") {
    return "closingIssuesReferences";
  }
  return undefined;
}

function resolveIssueRelationshipPages(nodes) {
  const pending = [];
  for (const [number, node] of nodes) {
    const connectionName = issueConnectionName(node);
    const pageInfo = connectionName ? node[connectionName]?.pageInfo : undefined;
    if (pageInfo?.hasNextPage) {
      pending.push({ connectionName, cursor: pageInfo.endCursor, number, type: node.__typename });
    }
  }
  while (pending.length > 0) {
    const chunk = pending.splice(0, 20);
    const fields = chunk
      .map((item, offset) => {
        const connection = `${item.connectionName}(first: 100, after: ${JSON.stringify(item.cursor)}) {
          nodes { number }
          pageInfo { hasNextPage endCursor }
        }`;
        return `n${offset}: repository(owner: "openclaw", name: "openclaw") {
          issueOrPullRequest(number: ${item.number}) {
            ... on ${item.type} {
              ${connection}
            }
          }
        }`;
      })
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const item = chunk[offset];
      const node = nodes.get(item.number);
      const connection = data[`n${offset}`]?.issueOrPullRequest?.[item.connectionName];
      if (!node || !connection) {
        continue;
      }
      node[item.connectionName] = {
        nodes: [...(node[item.connectionName]?.nodes ?? []), ...connection.nodes],
        pageInfo: connection.pageInfo,
      };
      if (connection.pageInfo.hasNextPage) {
        pending.push({
          connectionName: item.connectionName,
          cursor: connection.pageInfo.endCursor,
          number: item.number,
          type: item.type,
        });
      }
    }
  }
  return nodes;
}

function resolveReferences(numbers) {
  const nodes = new Map();
  for (let index = 0; index < numbers.length; index += 40) {
    const chunk = numbers.slice(index, index + 40);
    const fields = chunk
      .map(
        (number) => `n${number}: repository(owner: "openclaw", name: "openclaw") {
          issueOrPullRequest(number: ${number}) {
            __typename
            ... on Issue {
              number
              title
              author { __typename login }
              closedByPullRequestsReferences(first: 100) {
                nodes { number }
                pageInfo { hasNextPage endCursor }
              }
            }
            ... on PullRequest {
              number
              title
              mergedAt
              author { __typename login }
              closingIssuesReferences(first: 100) {
                nodes { number }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (const number of chunk) {
      const node = data[`n${number}`]?.issueOrPullRequest;
      if (node) {
        nodes.set(number, node);
      }
    }
  }
  return resolveIssueRelationshipPages(nodes);
}

function resolveGitHubHandles(handles) {
  const resolved = new Map();
  const uniqueHandles = [...new Set(handles)];
  for (let index = 0; index < uniqueHandles.length; index += 80) {
    const chunk = uniqueHandles.slice(index, index + 80);
    const fields = chunk
      .map(
        (handle, offset) =>
          `u${index + offset}: user(login: ${JSON.stringify(handle)}) { __typename login }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const user = data[`u${index + offset}`];
      if (user?.__typename === "User" && isEligibleHandle(user.login)) {
        resolved.set(chunk[offset].toLowerCase(), user.login);
      }
    }
  }
  return resolved;
}

function resolveDirectCommitAuthors(commits) {
  const resolved = new Map();
  const commitsWithoutGitHubHandle = commits.filter((commit) => !commit.author?.handle);
  for (let index = 0; index < commitsWithoutGitHubHandle.length; index += 40) {
    const chunk = commitsWithoutGitHubHandle.slice(index, index + 40);
    const fields = chunk
      .map(
        (commit, offset) =>
          `c${index + offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(commit.hash)}) {
              ... on Commit {
                author {
                  user {
                    login
                  }
                }
              }
            }
          }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const author = data[`c${index + offset}`]?.object?.author?.user;
      if (author?.login && isEligibleHandle(author.login)) {
        resolved.set(chunk[offset].hash, author.login);
      }
    }
  }
  return resolved;
}

function resolveCommitCoauthors(commits) {
  const resolved = new Map();
  const commitsWithCoauthors = commits.filter((commit) => commit.coauthorEmails.length > 0);
  for (let index = 0; index < commitsWithCoauthors.length; index += 40) {
    const chunk = commitsWithCoauthors.slice(index, index + 40);
    const fields = chunk
      .map(
        (commit, offset) =>
          `c${index + offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(commit.hash)}) {
              ... on Commit {
                authors(first: 20) {
                  nodes {
                    email
                    user { login }
                  }
                }
              }
            }
          }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const coauthorEmails = new Set(
        chunk[offset].coauthorEmails.map((email) => email.toLowerCase()),
      );
      const handles =
        data[`c${index + offset}`]?.object?.authors?.nodes
          .filter((author) => coauthorEmails.has(author.email?.toLowerCase()))
          .map((author) => author.user?.login)
          .filter(isEligibleHandle) ?? [];
      resolved.set(chunk[offset].hash, handles);
    }
  }
  return resolved;
}

function withDirectCommitAuthors(commits, resolvedAuthors) {
  return commits.map((commit) => {
    const authorHandle = resolvedAuthors.get(commit.hash) ?? commit.author?.handle;
    const contributors = [];
    if (authorHandle) {
      contributors.push(authorHandle);
    }
    addHandles(contributors, commit.contributors);
    return {
      ...commit,
      author: {
        handle: authorHandle,
        name: commit.author?.name ?? commit.authorName,
      },
      contributors,
    };
  });
}

function thanksFor(node, coauthorHandles) {
  const handles = [];
  if (node.author?.__typename === "User" && isEligibleHandle(node.author.login)) {
    handles.push(node.author.login);
  }
  for (const handle of coauthorHandles) {
    if (!handles.some((candidate) => candidate.toLowerCase() === handle.toLowerCase())) {
      handles.push(handle);
    }
  }
  return handles;
}

function addHandles(handles, additions) {
  for (const handle of additions) {
    if (!isEligibleHandle(handle)) {
      continue;
    }
    if (!handles.some((candidate) => candidate.toLowerCase() === handle.toLowerCase())) {
      handles.push(handle);
    }
  }
  return handles;
}

function titleReferences(entries) {
  return [...new Set(entries.flatMap((entry) => referencesIn(entry.title)))];
}

function releaseTitle(title) {
  return title;
}

function withSentenceEnding(value) {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function formatThanks(handles) {
  const mentions = handles.map((handle) => `@${handle}`);
  if (mentions.length <= 1) {
    return mentions[0] ?? "";
  }
  if (mentions.length === 2) {
    return mentions.join(" and ");
  }
  return `${mentions.slice(0, -1).join(", ")}, and ${mentions.at(-1)}`;
}

function directCommitTitleTokens(subject) {
  const title = subject.replace(/^\s*[a-z]+(?:\([^)]*\))?!?:\s*/i, "");
  return [...new Set(title.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])].filter(
    (token) => !genericDirectCommitTerms.has(token),
  );
}

function lineHasTerm(line, term) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(line);
}

function directCommitMatchesLine(commit, line) {
  if (!line.startsWith("- ")) {
    return false;
  }
  if (commit.closingReferences.some((number) => referencesIn(line).includes(number))) {
    return true;
  }
  const matchingTerms = directCommitTitleTokens(commit.subject).filter((token) =>
    lineHasTerm(line, token),
  );
  return matchingTerms.length >= 2;
}

function directCommitCreditsForLine(line, directCommits) {
  const contributors = [];
  for (const commit of directCommits) {
    if (
      !editorialClassification(commit.subject).editorialEligible ||
      !directCommitMatchesLine(commit, line)
    ) {
      continue;
    }
    addHandles(contributors, commit.contributors);
  }
  return contributors;
}

function completeEditorialCredits(prose, pullRequests, directCommits) {
  const pullRequestsByNumber = new Map(
    pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  return prose
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- ")) {
        return line;
      }
      const contributors = [];
      for (const number of referencesIn(line)) {
        addHandles(contributors, pullRequestsByNumber.get(number)?.thanks ?? []);
      }
      addHandles(contributors, directCommitCreditsForLine(line, directCommits));
      if (contributors.length === 0) {
        return line;
      }
      const existingContributors = handlesIn(line);
      addHandles(existingContributors, contributors);
      const thanksStart = line.lastIndexOf(" Thanks ");
      const rawContent = thanksStart >= 0 ? line.slice(0, thanksStart) : line;
      const content =
        referencesIn(rawContent).length === 0
          ? withSentenceEnding(rawContent)
          : rawContent.replace(/[.!?]$/, "");
      return `${content} Thanks ${formatThanks(existingContributors)}.`;
    })
    .join("\n");
}

function issueEntries(numbers, nodes, priorIssues = new Map()) {
  return [...new Set(numbers)]
    .map((number) => {
      const node = nodes.get(number);
      if (node?.__typename !== "Issue") {
        return undefined;
      }
      const thanks = thanksFor(node, []);
      addHandles(thanks, priorIssues.get(number)?.thanks ?? []);
      return {
        number,
        thanks,
        title: node.title.replace(/\s+/g, " ").trim(),
      };
    })
    .filter(Boolean);
}

function legacyIssuesByPullRequest(priorRecord, nodes) {
  const result = new Map();
  for (const number of priorRecord.legacyIssues.keys()) {
    const issue = nodes.get(number);
    if (issue?.__typename !== "Issue") {
      continue;
    }
    const pullRequests =
      issue.closedByPullRequestsReferences?.nodes.map((pullRequest) => pullRequest.number) ?? [];
    for (const pullRequest of new Set(pullRequests)) {
      const issues = result.get(pullRequest) ?? [];
      issues.push(number);
      result.set(pullRequest, issues);
    }
  }
  return result;
}

function contributionRelationships(source, nodes, resolvedContributors) {
  const issuesByPullRequest = new Map();
  const directCommits = [];
  for (const commit of source.activeCommits) {
    const pullRequests = commit.pullRequests;
    const issues = issueEntries(commit.closingReferences, nodes);
    if (pullRequests.length === 0) {
      const authorHandle = commit.authorHandle
        ? resolvedContributors.get(commit.authorHandle.toLowerCase())
        : undefined;
      const contributors = [];
      if (authorHandle) {
        contributors.push(authorHandle);
      }
      addHandles(
        contributors,
        commit.coauthors
          .map((handle) => resolvedContributors.get(handle.toLowerCase()))
          .filter(Boolean),
      );
      directCommits.push({
        ...commit,
        author: { handle: authorHandle, name: commit.authorName },
        contributors,
        issues,
      });
      continue;
    }
    if (issues.length === 0) {
      continue;
    }
    for (const number of pullRequests) {
      const existing = issuesByPullRequest.get(number) ?? [];
      issuesByPullRequest.set(number, [...existing, ...issues]);
    }
  }
  return { directCommits, issuesByPullRequest };
}

function mergeIssues(...groups) {
  const entries = new Map();
  for (const group of groups) {
    for (const issue of group) {
      const existing = entries.get(issue.number);
      if (existing) {
        addHandles(existing.thanks, issue.thanks);
      } else {
        entries.set(issue.number, { ...issue, thanks: [...issue.thanks] });
      }
    }
  }
  return [...entries.values()];
}

export function ledgerFor(
  base,
  target,
  references,
  nodes,
  coauthorsByReference,
  resolvedHandles,
  relationships,
  priorRecord,
  sourcePullRequests,
  sourceReferences,
  noteReferences,
  legacyIssuePullRequests,
  revertedReferences,
  shippedBaselines,
  targetTimestamp,
) {
  const entries = references.map((number) => {
    const node = nodes.get(number);
    const rawCoauthors = coauthorsByReference.get(number) ?? new Set();
    const coauthors = [...rawCoauthors]
      .map((handle) => resolvedHandles.get(handle.toLowerCase()))
      .filter(Boolean);
    return {
      number,
      title: releaseTitle(node.title.replace(/\s+/g, " ").trim()),
      type: node.__typename,
      mergedAt: node.mergedAt,
      closingIssuesReferences: node.closingIssuesReferences,
      thanks: thanksFor(node, coauthors),
    };
  });

  const recordedPullRequests = new Set([
    ...sourcePullRequests,
    ...sourceReferences,
    ...noteReferences,
    ...legacyIssuePullRequests,
    ...priorRecord.pullRequests.keys(),
  ]);
  const pullRequests = entries.filter(
    (entry) =>
      entry.type === "PullRequest" &&
      entry.mergedAt &&
      (sourcePullRequests.has(entry.number) || mergedByTarget(entry.mergedAt, targetTimestamp)) &&
      recordedPullRequests.has(entry.number) &&
      !revertedReferences.has(entry.number),
  );
  const issues = entries.filter((entry) => entry.type === "Issue");
  const legacyIssues = legacyIssuesByPullRequest(priorRecord, nodes);
  const records = pullRequests.map((entry) => {
    const priorEntry = priorRecord.pullRequests.get(entry.number);
    const priorReferences = priorEntry?.references ?? [];
    const titleIssues = issueEntries(referencesIn(entry.title), nodes);
    const closingIssues = issueEntries(
      entry.closingIssuesReferences?.nodes.map((issue) => issue.number) ?? [],
      nodes,
    );
    const linkedIssues = mergeIssues(
      titleIssues,
      closingIssues,
      relationships.issuesByPullRequest.get(entry.number) ?? [],
      issueEntries(priorReferences, nodes),
      issueEntries(legacyIssues.get(entry.number) ?? [], nodes, priorRecord.legacyIssues),
    );
    const thanks = [...entry.thanks];
    addHandles(thanks, priorEntry?.thanks ?? []);
    for (const issue of linkedIssues) {
      addHandles(thanks, issue.thanks);
    }
    return {
      ...entry,
      ...editorialClassification(entry.title),
      externalReferences: priorEntry?.externalReferences ?? [],
      linkedIssues,
      priorReferences,
      thanks,
    };
  });
  const shippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  const ledger = [
    "### Complete contribution record",
    "",
    `This audited record covers the complete ${base}..${target} history: ${records.length} merged PRs. The generation manifest also supplies direct commits as editorial input; the grouped notes above prioritize user impact.`,
    ...(shippedBaselineLine ? ["", shippedBaselineLine] : []),
    "",
    "#### Pull requests",
    "",
    ...records.map((entry) => renderContributionRecordEntry(entry)),
  ].join("\n");
  return {
    entries,
    issues,
    ledger,
    pullRequests: records,
    titleReferences: titleReferences(records),
  };
}

function replaceLedger(changelog, section, ledger, pullRequests, directCommits) {
  const beforeLedger = completeEditorialCredits(
    section.source.replace(/\n+### Complete contribution (?:ledger|record)[\s\S]*$/m, "").trimEnd(),
    pullRequests,
    directCommits,
  );
  const replacement = `${beforeLedger}\n\n${ledger}\n`;
  return `${changelog.slice(0, section.start)}${replacement}${changelog.slice(section.end)}`;
}

export function countTopLevelSectionBullets(sectionSource, heading) {
  const headingMatch = new RegExp(`^### ${escapeRegExp(heading)}\\r?$`, "mu").exec(sectionSource);
  if (!headingMatch || headingMatch.index === undefined) {
    return 0;
  }
  const headingEnd = sectionSource.indexOf("\n", headingMatch.index);
  const bodyStart = headingEnd < 0 ? sectionSource.length : headingEnd + 1;
  const nextHeading = /^### /gmu;
  nextHeading.lastIndex = bodyStart;
  const end = nextHeading.exec(sectionSource)?.index ?? sectionSource.length;
  return sectionSource
    .slice(bodyStart, end)
    .split("\n")
    .filter((line) => line.startsWith("- ")).length;
}

export function highlightCountError(sectionSource) {
  const count = countTopLevelSectionBullets(sectionSource, "Highlights");
  return count >= 5 && count <= 8
    ? undefined
    : `### Highlights must contain 5-8 top-level bullets; found ${count}`;
}

export function ledgerChecks(section, pullRequests, nodes, directCommits, shippedBaselines = []) {
  const errors = [];
  let sectionReferences = referencesIn(section.source);
  if (/@undefined\b/i.test(section.source)) {
    errors.push("release section contains invalid @undefined contributor credit");
  }
  if (!section.source.includes("### Highlights")) {
    errors.push("missing ### Highlights");
  } else {
    const error = highlightCountError(section.source);
    if (error) {
      errors.push(error);
    }
  }
  if (!section.source.includes("### Changes")) {
    errors.push("missing ### Changes");
  }
  if (!section.source.includes("### Fixes")) {
    errors.push("missing ### Fixes");
  }
  const ledgerStart = section.source.indexOf("### Complete contribution record");
  if (ledgerStart < 0) {
    errors.push("missing ### Complete contribution record");
    return errors;
  }
  const ledger = section.source.slice(ledgerStart);
  const expectedShippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  try {
    const sectionShippedBaselineLine = formatShippedBaselineExclusions(
      parseShippedBaselineExclusions(section.source),
    );
    const actualShippedBaselineLine = formatShippedBaselineExclusions(
      parseShippedBaselineExclusions(ledger),
    );
    if (sectionShippedBaselineLine !== actualShippedBaselineLine) {
      errors.push(
        "shipped baseline exclusions must appear inside the complete contribution record",
      );
    } else if (actualShippedBaselineLine !== expectedShippedBaselineLine) {
      errors.push(
        `shipped baseline exclusions mismatch: expected ${
          expectedShippedBaselineLine || "none"
        }, found ${actualShippedBaselineLine || "none"}`,
      );
    } else {
      sectionReferences = releaseNoteReferences(section.source, shippedBaselines);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (ledger.includes("#### Linked issues")) {
    errors.push("complete contribution record must not have a linked-issues inventory");
  }
  if (ledger.includes("#### Direct commits")) {
    errors.push("complete contribution record must not list direct commits");
  }
  for (const number of new Set(sectionReferences)) {
    if (!nodes.has(number)) {
      errors.push(`unresolved release-note reference #${number}`);
    }
  }
  for (const entry of pullRequests) {
    const line = ledger
      .split("\n")
      .find((candidate) => candidate.startsWith(`- **PR #${entry.number}**`));
    if (!line) {
      errors.push(`missing contribution record for PR #${entry.number}`);
      continue;
    }
    for (const handle of entry.thanks) {
      if (!line.toLowerCase().includes(`@${handle.toLowerCase()}`)) {
        errors.push(`missing Thanks @${handle} for #${entry.number}`);
      }
    }
    const expectedReferences = [];
    appendUnique(expectedReferences, referenceLabelsIn(entry.title));
    appendUnique(
      expectedReferences,
      entry.priorReferences.map((number) => `#${number}`),
    );
    appendUnique(expectedReferences, entry.externalReferences);
    appendUnique(
      expectedReferences,
      entry.linkedIssues.map((issue) => `#${issue.number}`),
    );
    const actualReferences = new Set(
      referenceLabelsIn(line).map((reference) => reference.toLowerCase()),
    );
    for (const reference of expectedReferences) {
      if (!actualReferences.has(reference.toLowerCase())) {
        errors.push(`missing ${reference} on contribution record for PR #${entry.number}`);
      }
    }
  }
  const editorialProse = section.source.slice(0, ledgerStart);
  for (const entry of pullRequests) {
    if (
      !entry.editorialEligible &&
      new RegExp(`(?<![A-Za-z0-9_./-])#${entry.number}\\b`).test(editorialProse)
    ) {
      errors.push(
        `editorial release prose references non-editorial ${entry.type} PR #${entry.number} (${entry.type})`,
      );
    }
  }
  const editorialLines = editorialProse.split("\n");
  for (const entry of pullRequests) {
    for (const line of editorialLines) {
      if (
        !new RegExp(`(?<![A-Za-z0-9_./-])#${entry.number}\\b`).test(line) ||
        !line.startsWith("- ")
      ) {
        continue;
      }
      for (const handle of entry.thanks) {
        if (!line.toLowerCase().includes(`@${handle.toLowerCase()}`)) {
          errors.push(`missing editorial Thanks @${handle} for PR #${entry.number}`);
        }
      }
    }
  }
  for (const line of editorialLines) {
    if (!line.startsWith("- ")) {
      continue;
    }
    for (const handle of directCommitCreditsForLine(line, directCommits)) {
      if (!line.toLowerCase().includes(`@${handle.toLowerCase()}`)) {
        errors.push(`missing editorial Thanks @${handle} for directly landed work`);
      }
    }
  }
  const lines = section.source.split("\n");
  for (const number of new Set(referencesIn(section.source))) {
    const node = nodes.get(number);
    if (node?.__typename !== "Issue") {
      continue;
    }
    for (const handle of thanksFor(node, [])) {
      const credited = lines.some(
        (line) =>
          line.includes(`#${number}`) && line.toLowerCase().includes(`@${handle.toLowerCase()}`),
      );
      if (!credited) {
        errors.push(`missing Thanks @${handle} for issue #${number}`);
      }
    }
  }
  return errors;
}

function manifestFor(options, source, ledger, directCommitRecords) {
  const directCommits = directCommitRecords.map((commit) => ({
    ...editorialClassification(commit.subject),
    commit: commit.hash.slice(0, 12),
    subject: commit.subject,
    references: commit.references,
    author: commit.author,
    contributors: commit.contributors,
    issues: commit.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      reporter: issue.thanks,
    })),
  }));
  const unlinkedCommits = directCommits.filter((commit) => commit.references.length === 0);
  return {
    schemaVersion: 2,
    base: options.base,
    target: options.target,
    mergeBase: source.mergeBase,
    version: options.version,
    shippedBaselines: source.shippedBaselines,
    source: {
      references: ledger.entries.length,
      pullRequests: ledger.pullRequests.length,
      issues: ledger.issues.length,
      directCommits: directCommits.length,
      unlinkedCommits: unlinkedCommits.length,
    },
    pullRequests: ledger.pullRequests.map((entry) => ({
      number: entry.number,
      title: entry.title,
      type: entry.type,
      editorialEligible: entry.editorialEligible,
      thanks: entry.thanks,
      externalReferences: entry.externalReferences,
      relatedReferences: [...new Set([...entry.priorReferences, ...referencesIn(entry.title)])],
      linkedIssues: entry.linkedIssues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        reporter: issue.thanks,
      })),
    })),
    directCommits,
    unlinkedCommits,
  };
}

function releaseChecks(changelog, version, releaseTags) {
  const checks = [];
  for (const tag of releaseTags) {
    const release = githubApi([`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
    const verification = verifyGithubReleaseNotes({
      body: release.body ?? "",
      changelog,
      version,
      tag,
      repository: repo,
    });
    checks.push({
      tag,
      releaseId: release.id,
      matches: verification.matches,
      mode: verification.mode,
      bodyLength: verification.actualSize.characters,
      bodyBytes: verification.actualSize.bytes,
    });
  }
  return checks;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  githubSnapshotState = initializeGithubSnapshot(options);
  let changelog = readFileSync("CHANGELOG.md", "utf8");
  let section = sectionFor(changelog, options.version);
  const source = sourceCommits(options.base, options.target, options.mainRef ?? "origin/main");
  const shippedBaselineRecords = options.shippedRefs.map(shippedBaselineFor);
  const shippedExclusions = subtractShippedPullRequests(source, shippedBaselineRecords);
  source.shippedBaselines = shippedExclusions.baselines;
  const preexistingNotes = section.source.replace(
    /\n+### Complete contribution (?:ledger|record)[\s\S]*$/m,
    "",
  );
  const noteReferences = referencesIn(preexistingNotes);
  const revertedNoteReferences = noteReferences.filter((number) =>
    source.revertedReferences.has(number),
  );
  if (revertedNoteReferences.length > 0) {
    fail(
      `release notes reference reverted work: ${[...new Set(revertedNoteReferences)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const renderedRecord = contributionRecordFor(section);
  const renderedRecordReferences = contributionRecordMetadataReferences(renderedRecord);
  const revertedRenderedReferences = renderedRecordReferences.filter((number) =>
    source.revertedReferences.has(number),
  );
  if (!options.writeLedger && revertedRenderedReferences.length > 0) {
    fail(
      `contribution record references reverted work: ${[...new Set(revertedRenderedReferences)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const excludedRecordedReferences = new Set([
    ...source.revertedReferences,
    ...shippedExclusions.pullRequests,
  ]);
  const effectiveRenderedRecordReferences = renderedContributionRecordReferences(
    renderedRecord,
    options.writeLedger,
  );
  let priorRecord = { legacyIssues: new Map(), pullRequests: new Map() };
  if (options.seedRef) {
    const seedChangelog = git(["show", `${options.seedRef}:CHANGELOG.md`]);
    const seedSection = sectionFor(seedChangelog, options.version);
    priorRecord = contributionRecordFor(seedSection);
  }
  priorRecord = withoutExcludedContributionRecords(priorRecord, excludedRecordedReferences);
  const recordedReferences = contributionRecordMetadataReferences(priorRecord);
  const revertedRecordedReferences = recordedReferences.filter((number) =>
    source.revertedReferences.has(number),
  );
  if (revertedRecordedReferences.length > 0) {
    fail(
      `contribution record references reverted work: ${[...new Set(revertedRecordedReferences)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const references = [...source.references];
  appendReferences(references, noteReferences);
  appendReferences(references, effectiveRenderedRecordReferences);
  appendReferences(references, recordedReferences);
  let nodes = resolveReferences(references);
  const contamination = contaminatingPullRequestReferences({
    noteReferences,
    recordedReferences: effectiveRenderedRecordReferences,
    sourcePullRequests: source.pullRequests,
    sourceReferences: source.references,
    seededPullRequests: new Set(priorRecord.pullRequests.keys()),
    nodes,
  });
  if (contamination.length > 0) {
    fail(
      `release section contains PRs outside ${options.base}..${options.target}: ${contamination
        .map((number) => `#${number}`)
        .join(", ")}; use --seed-ref only for an intentional historical backfill`,
    );
  }
  const legacyIssuePullRequests = [...legacyIssuesByPullRequest(priorRecord, nodes).keys()].filter(
    (number) => !shippedExclusions.pullRequests.has(number),
  );
  appendReferences(references, legacyIssuePullRequests);
  nodes = resolveReferences(references);
  const unresolvedSourceReferences = references.filter((number) => !nodes.has(number));
  if (unresolvedSourceReferences.length > 0) {
    fail(
      `GitHub could not resolve source references: ${unresolvedSourceReferences
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const provisionalEntries = references
    .map((number) => nodes.get(number))
    .filter((node) => node?.__typename === "PullRequest");
  const titleReferenceNumbers = titleReferences(provisionalEntries);
  const closingIssueNumbers = provisionalEntries.flatMap(
    (entry) => entry.closingIssuesReferences?.nodes.map((issue) => issue.number) ?? [],
  );
  const resolvedReferences = [...references];
  appendReferences(resolvedReferences, titleReferenceNumbers);
  appendReferences(resolvedReferences, closingIssueNumbers);
  nodes = resolveReferences(resolvedReferences);
  const invalidRecordedPullRequests = [...priorRecord.pullRequests.keys()].filter((number) => {
    const node = nodes.get(number);
    return (
      node?.__typename !== "PullRequest" ||
      !node.mergedAt ||
      (!source.pullRequests.has(number) && !mergedByTarget(node.mergedAt, source.targetTimestamp))
    );
  });
  if (!options.writeLedger && invalidRecordedPullRequests.length > 0) {
    fail(
      `contribution record contains unresolved or unmerged PRs: ${invalidRecordedPullRequests
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const unresolvedTitleReferences = titleReferenceNumbers.filter((number) => !nodes.has(number));
  if (unresolvedTitleReferences.length > 0) {
    fail(
      `GitHub could not resolve PR-title references: ${unresolvedTitleReferences
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const contributorHandles = [
    ...source.activeCommits.flatMap((commit) => commit.coauthors),
    ...source.activeCommits.map((commit) => commit.authorHandle).filter(Boolean),
  ];
  const resolvedHandles = resolveGitHubHandles(contributorHandles);
  const relationships = contributionRelationships(source, nodes, resolvedHandles);
  const unlinkedCommits = source.activeCommits.filter((commit) => commit.references.length === 0);
  const resolvedCommitAuthors = resolveDirectCommitAuthors(relationships.directCommits);
  relationships.directCommits = withDirectCommitAuthors(
    relationships.directCommits,
    resolvedCommitAuthors,
  );
  const ledger = ledgerFor(
    options.base,
    source.target,
    references,
    nodes,
    source.coauthorsByReference,
    resolvedHandles,
    relationships,
    priorRecord,
    source.pullRequests,
    source.references,
    noteReferences,
    legacyIssuePullRequests,
    source.revertedReferences,
    source.shippedBaselines,
    source.targetTimestamp,
  );
  const manifest = manifestFor(
    { ...options, target: source.target },
    source,
    ledger,
    relationships.directCommits,
  );

  if (options.manifestPath) {
    writeFileSync(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  if (options.writeLedger) {
    changelog = replaceLedger(
      changelog,
      section,
      ledger.ledger,
      ledger.pullRequests,
      relationships.directCommits,
    );
    writeFileSync("CHANGELOG.md", changelog);
    section = sectionFor(changelog, options.version);
  }

  const errors = ledgerChecks(
    section,
    ledger.pullRequests,
    nodes,
    relationships.directCommits,
    source.shippedBaselines,
  );
  const github = options.checkGithub
    ? releaseChecks(changelog, options.version, options.releaseTags)
    : [];
  for (const check of github) {
    if (!check.matches) {
      errors.push(
        `GitHub release ${check.tag} does not match the ${options.version} CHANGELOG section`,
      );
    }
  }

  const result = {
    base: options.base,
    target: source.target,
    mergeBase: source.mergeBase,
    version: options.version,
    shippedBaselines: source.shippedBaselines,
    source: {
      references: references.length,
      pullRequests: ledger.pullRequests.length,
      issues: ledger.issues.length,
      directCommits: manifest.directCommits.length,
      unlinkedCommits: manifest.unlinkedCommits.length,
    },
    github,
    githubSnapshot: githubSnapshotState
      ? {
          path: githubSnapshotState.filePath,
          hits: githubSnapshotState.hits,
          misses: githubSnapshotState.misses,
        }
      : null,
    errors,
  };
  persistGithubSnapshot(githubSnapshotState);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const snapshotSummary = githubSnapshotState
      ? `, GitHub snapshot ${githubSnapshotState.hits} hits/${githubSnapshotState.misses} misses`
      : "";
    process.stdout.write(
      `${options.version}: ${ledger.pullRequests.length} PRs, ${ledger.issues.length} issues, ${errors.length === 0 ? "verified" : `${errors.length} errors`}${snapshotSummary}\n`,
    );
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
