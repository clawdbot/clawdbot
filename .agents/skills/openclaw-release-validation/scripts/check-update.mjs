#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "openclaw";
const SLUG = "release-validation";
const EXPECTED_REF = `@${OWNER}/${SLUG}`;
const REGISTRY = "https://clawhub.ai";
const CHECK_TIMEOUT_MS = 10_000;
const OPENCLAW_METADATA_DIRECTORIES = new Set([".clawhub", ".clawdhub"]);
const scriptPath = fileURLToPath(import.meta.url);
const skillDirectory = resolve(dirname(scriptPath), "..");
const installRoot = resolve(skillDirectory, "..", "..");

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readMetadataJson(root, filename) {
  for (const directory of OPENCLAW_METADATA_DIRECTORIES) {
    const value = await readJson(join(root, directory, filename));
    if (value !== undefined) return value;
  }
  return undefined;
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function collectOpenClawTreeEntries(directory, root = directory) {
  const collected = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (directory === root && OPENCLAW_METADATA_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const portablePath = relative(root, path).split(sep).join("/");
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Skill tree contains unsupported entry ${JSON.stringify(portablePath)}.`);
    }
    if (stat.isDirectory()) {
      collected.push({ path: portablePath, type: "directory" });
      collected.push(...(await collectOpenClawTreeEntries(path, root)));
      continue;
    }
    if (stat.nlink > 1) {
      throw new Error(`Skill tree contains hard-linked file ${JSON.stringify(portablePath)}.`);
    }
    collected.push({
      path: portablePath,
      type: "file",
      sha256: await sha256(path),
    });
  }
  return collected;
}

// Keep this byte-compatible with OpenClaw's ClawHub update guard so the prompt
// never offers an unforced update that OpenClaw will refuse as locally modified.
async function digestOpenClawSkillTree(directory) {
  const entries = await collectOpenClawTreeEntries(directory);
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

function parseSemver(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(value ?? ""),
  );
  if (!match) return undefined;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) return undefined;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

// Installed skill copies run outside OpenClaw's package graph, so mirror only
// the ClawHub metadata trimming needed for update-command equivalence here.
function trimClawHubMetadataText(value) {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function normalizeRegistry(value) {
  const normalized = trimClawHubMetadataText(value);
  return normalized?.replace(/\/+$/, "") || normalized;
}

function normalizeArtifact(value) {
  if (
    (value?.kind === "archive" || value?.kind === "clawpack") &&
    trimClawHubMetadataText(value.sha256) &&
    trimClawHubMetadataText(value.integrity)
  ) {
    return { kind: value.kind, sha256: value.sha256, integrity: value.integrity };
  }
  return undefined;
}

function normalizeSkillFile(value) {
  return trimClawHubMetadataText(value?.path) && trimClawHubMetadataText(value?.sha256)
    ? { path: value.path, sha256: value.sha256 }
    : undefined;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasCoreValidLink(origin, lockEntry) {
  const originRegistry = normalizeRegistry(origin?.registry);
  const lockedRegistry =
    lockEntry?.registry === undefined ? originRegistry : normalizeRegistry(lockEntry.registry);
  const originSkillFile = normalizeSkillFile(origin?.skillFile);
  const lockedSkillFile = normalizeSkillFile(lockEntry?.skillFile);
  const originTree = trimClawHubMetadataText(origin?.fileTreeSha256);
  const lockedTree = trimClawHubMetadataText(lockEntry?.fileTreeSha256);

  return (
    origin?.version === 1 &&
    lockEntry !== undefined &&
    lockEntry.version === origin.installedVersion &&
    lockEntry.installedAt === origin.installedAt &&
    lockedRegistry === originRegistry &&
    trimClawHubMetadataText(lockEntry.ownerHandle) ===
      trimClawHubMetadataText(origin.ownerHandle)?.toLowerCase() &&
    trimClawHubMetadataText(origin.requestedReference) === undefined &&
    trimClawHubMetadataText(lockEntry.requestedReference) === undefined &&
    origin.trustState === undefined &&
    lockEntry.trustState === undefined &&
    trimClawHubMetadataText(lockEntry.sourceUrl) === trimClawHubMetadataText(origin.sourceUrl) &&
    sameJson(normalizeArtifact(lockEntry.artifact), normalizeArtifact(origin.artifact)) &&
    originSkillFile !== undefined &&
    sameJson(lockedSkillFile, originSkillFile) &&
    originTree !== undefined &&
    lockedTree === originTree
  );
}

async function hasLocalModifications(origin, directory = skillDirectory) {
  return (await digestOpenClawSkillTree(directory)) !== origin.fileTreeSha256;
}

function canonicalExistingPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function updateCommand({ force = false } = {}) {
  const configuredStateRoot = resolve(
    process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"),
  );
  const globalInstall =
    canonicalExistingPath(installRoot) === canonicalExistingPath(configuredStateRoot);
  return [
    "openclaw",
    "skills",
    "update",
    EXPECTED_REF,
    ...(globalInstall ? ["--global"] : []),
    ...(force ? ["--force"] : []),
  ];
}

function determineStatus({ comparison, modified }) {
  if (modified === undefined) return "untracked";
  if (comparison === undefined) return "check-failed";
  if (comparison < 0) return "update-available";
  if (modified) return "local-modifications";
  if (comparison > 0) return "ahead-of-latest";
  return "current";
}

function print(value) {
  console.log(
    JSON.stringify(
      {
        schema: "openclaw.release-validation-skill-update/v1",
        ...value,
      },
      null,
      2,
    ),
  );
}

async function main() {
  let source = { kind: "unknown", ref: null, version: null };
  let canonical = { ref: EXPECTED_REF, version: null };

  try {
    const origin = await readMetadataJson(skillDirectory, "origin.json");
    const lock = await readMetadataJson(installRoot, "lock.json");
    const installedVersion = origin?.installedVersion;
    const originRegistry = normalizeRegistry(origin?.registry);
    const originOwner =
      typeof origin?.ownerHandle === "string" ? origin.ownerHandle.trim().toLowerCase() : undefined;
    const sourceMatches =
      origin?.slug === SLUG &&
      originRegistry === REGISTRY &&
      typeof installedVersion === "string" &&
      originOwner === OWNER;

    if (!sourceMatches) {
      source = {
        kind: origin ? "different-source" : "untracked",
        ref: origin ? `@${origin.ownerHandle ?? "unknown"}/${origin.slug ?? "unknown"}` : null,
        version: installedVersion ?? null,
      };
      print({
        source,
        canonical,
        status: origin ? "different-source" : "untracked",
      });
      return;
    }

    source = {
      kind: "clawhub",
      ref: EXPECTED_REF,
      version: installedVersion,
      artifactSha256: origin?.artifact?.sha256 ?? null,
    };

    const lockEntry = lock?.skills?.[SLUG];
    if (!hasCoreValidLink(origin, lockEntry)) {
      print({ source, canonical, status: "untracked", localModifications: null });
      return;
    }

    const detailUrl = new URL(`${REGISTRY}/api/v1/skills/${encodeURIComponent(SLUG)}`);
    detailUrl.searchParams.set("ownerHandle", OWNER);
    const response = await fetch(detailUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "openclaw-release-validation-skill",
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`ClawHub returned HTTP ${response.status}`);
    const detail = await response.json();
    const latestVersion = detail?.latestVersion?.version ?? detail?.skill?.tags?.latest;
    if (typeof latestVersion !== "string")
      throw new Error("ClawHub did not return a latest version");
    if (detail?.owner?.handle !== OWNER)
      throw new Error("ClawHub returned a different skill owner");
    canonical = { ref: EXPECTED_REF, version: latestVersion };

    const modified = await hasLocalModifications(origin);
    const comparison = compareSemver(installedVersion, latestVersion);
    const status = determineStatus({ comparison, modified });

    print({
      source,
      canonical,
      status,
      localModifications: modified ?? null,
      ...(status === "update-available"
        ? { update: { cwd: installRoot, command: updateCommand({ force: modified === true }) } }
        : {}),
    });
  } catch (error) {
    print({
      source,
      canonical,
      status: "check-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(scriptPath)) {
  await main();
}
