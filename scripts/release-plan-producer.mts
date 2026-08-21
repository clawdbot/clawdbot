#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { collectClawHubPublishablePluginPackages } from "./lib/plugin-clawhub-release.ts";
import { collectPublishablePluginPackages } from "./lib/plugin-npm-release.ts";
import { parseReleaseVersion } from "./lib/release-version.mjs";
import {
  canonicalReleasePlanJson,
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  parseReleasePlanLockJson,
  RELEASE_PLAN_SCHEMA,
  validateReleasePlan,
  type ReleasePlan,
  type ReleasePlanLock,
  type ReleasePlanPurpose,
} from "./release-plan-contract.mjs";

export type ReleasePlanIntent = "publish" | "postpublish-confidence" | "main-qualification";

type ReleasePlanSource = {
  repoRoot?: string;
  intent: ReleasePlanIntent;
  candidateSha: string;
  candidateRef: string;
  toolingSha: string;
  toolingFullRef: string;
};

const REPOSITORY = "openclaw/openclaw";
const VALIDATION_WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const PUBLICATION_WORKFLOW_PATH = ".github/workflows/openclaw-release-publish.yml";
const PRODUCER_PATH = "scripts/release-plan-producer.mts";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const compareAscii = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function resolveCommit(repoRoot: string, revision: string, label: string): string {
  let resolved: string;
  try {
    resolved = git(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`]);
  } catch {
    throw new Error(`${label} does not resolve to a commit: ${revision}`);
  }
  if (!SHA_PATTERN.test(resolved)) {
    throw new Error(`${label} did not resolve to an exact lowercase commit SHA`);
  }
  return resolved;
}

function requireExactSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact lowercase 40-character commit SHA`);
  }
  return value;
}

function requireQualifiedRef(value: string, label: string): string {
  if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error(`${label} must be a qualified branch or tag ref`);
  }
  return value;
}

function readGitText(repoRoot: string, commit: string, path: string): string {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${path} is missing from ${commit}`);
  }
}

function gitPathExists(repoRoot: string, commit: string, path: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}:${path}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function withCandidateSnapshot<T>(
  repoRoot: string,
  candidateSha: string,
  callback: (snapshotRoot: string) => T,
): T {
  const snapshotRoot = mkdtempSync(join(tmpdir(), "openclaw-release-candidate-"));
  try {
    const tree = execFileSync(
      "git",
      ["ls-tree", "-r", "-z", candidateSha, "--", "package.json", "extensions"],
      { cwd: repoRoot },
    ).toString("utf8");
    const inventoryPaths: string[] = [];
    for (const entry of tree.split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t");
      if (
        !path ||
        (path !== "package.json" &&
          !/^extensions\/[^/]+\/(?:package\.json|README\.md)$/u.test(path))
      ) {
        continue;
      }
      if (metadata?.startsWith("120000 ")) {
        throw new Error("candidate package inventory must not contain symbolic links");
      }
      inventoryPaths.push(path);
    }
    if (!inventoryPaths.includes("package.json")) {
      throw new Error("candidate package.json is missing");
    }
    const archivePath = join(snapshotRoot, "candidate.tar");
    execFileSync(
      "git",
      ["archive", "--format=tar", `--output=${archivePath}`, candidateSha, "--", ...inventoryPaths],
      { cwd: repoRoot },
    );
    execFileSync("tar", ["-xf", archivePath, "-C", snapshotRoot]);
    mkdirSync(join(snapshotRoot, "extensions"), { recursive: true });
    return callback(snapshotRoot);
  } finally {
    rmSync(snapshotRoot, { force: true, recursive: true });
  }
}

export function deriveReleasePlanPolicy(
  intent: ReleasePlanIntent,
  version: string,
): {
  profile: "beta" | "stable" | "full";
  purpose: ReleasePlanPurpose;
  soak: boolean;
  tag: string | null;
} {
  const parsed = parseReleaseVersion(version);
  if (parsed === null || parsed.version !== version) {
    throw new Error(`unsupported release version: ${version}`);
  }
  if (intent === "main-qualification") {
    return { profile: "full", purpose: "main-qualification", soak: true, tag: null };
  }
  if (intent === "postpublish-confidence") {
    return {
      profile: "full",
      purpose: "postpublish-confidence",
      soak: true,
      tag: `v${version}`,
    };
  }
  return parsed.channel === "stable"
    ? { profile: "stable", purpose: "stable-publish", soak: true, tag: `v${version}` }
    : { profile: "beta", purpose: "beta-publish", soak: false, tag: `v${version}` };
}

function collectAllowedGroups(workflowText: string): string[] {
  const workflow = parseYaml(workflowText) as {
    on?: { workflow_dispatch?: { inputs?: { rerun_group?: { options?: unknown } } } };
  };
  const options = workflow.on?.workflow_dispatch?.inputs?.rerun_group?.options;
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    options.some((entry) => typeof entry !== "string" || !entry)
  ) {
    throw new Error(`${VALIDATION_WORKFLOW_PATH} must declare rerun_group choice options`);
  }
  const groups = [...new Set(options)];
  if (groups.length !== options.length) {
    throw new Error(`${VALIDATION_WORKFLOW_PATH} rerun_group options must be unique`);
  }
  return groups.toSorted(compareAscii);
}

function collectPackageInventory(snapshotRoot: string, version: string) {
  const packages = new Map<string, { name: string; version: string; targets: Set<string> }>();
  packages.set("openclaw", { name: "openclaw", version, targets: new Set(["npm"]) });
  for (const plugin of collectPublishablePluginPackages(snapshotRoot)) {
    packages.set(plugin.packageName, {
      name: plugin.packageName,
      version: plugin.version,
      targets: new Set(["npm"]),
    });
  }
  for (const plugin of collectClawHubPublishablePluginPackages(snapshotRoot)) {
    const existing = packages.get(plugin.packageName);
    if (existing && existing.version !== plugin.version) {
      throw new Error(`plugin inventory version mismatch for ${plugin.packageName}`);
    }
    const entry = existing ?? {
      name: plugin.packageName,
      version: plugin.version,
      targets: new Set<string>(),
    };
    entry.targets.add("clawhub");
    packages.set(plugin.packageName, entry);
  }
  return [...packages.values()]
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      targets: [...entry.targets].toSorted(compareAscii),
    }))
    .toSorted((left, right) => compareAscii(left.name, right.name));
}

function collectPlatformSources(workflowText: string) {
  const platforms = new Map<string, string>();
  const promotionPattern = /promote_([a-z0-9_]+)_release_assets?\(\)\s*\{([\s\S]*?)^\s*\}/gmu;
  const dispatchPattern =
    /dispatch_workflow(?:_at_ref)?\s+(?:(?:"[^"]+"|'[^']+')\s+){0,2}([a-z0-9][a-z0-9-]+\.yml)/u;
  for (const match of workflowText.matchAll(promotionPattern)) {
    const id = match[1]?.replaceAll("_", "-");
    const workflowName = dispatchPattern.exec(match[2] ?? "")?.[1];
    if (!id || !workflowName) {
      throw new Error(`${PUBLICATION_WORKFLOW_PATH} has an invalid platform promotion function`);
    }
    platforms.set(id, `.github/workflows/${workflowName}`);
  }
  const workflow = parseYaml(workflowText) as {
    jobs?: Record<string, { uses?: unknown }>;
  };
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (!jobId.startsWith("publish_") || typeof job.uses !== "string") {
      continue;
    }
    const match = /^\.\/\.github\/workflows\/([a-z0-9][a-z0-9-]+\.yml)$/u.exec(job.uses);
    if (!match?.[1]) {
      throw new Error(`${PUBLICATION_WORKFLOW_PATH} has an invalid reusable publication workflow`);
    }
    platforms.set(
      jobId.slice("publish_".length).replaceAll("_", "-"),
      `.github/workflows/${match[1]}`,
    );
  }
  if (platforms.size === 0) {
    throw new Error(`${PUBLICATION_WORKFLOW_PATH} does not declare platform publication workflows`);
  }
  return [...platforms.entries()].toSorted(([left], [right]) => compareAscii(left, right));
}

function collectPlatformInventory(repoRoot: string, toolingSha: string, workflowText: string) {
  return collectPlatformSources(workflowText).map(([id, source]) => {
    if (!gitPathExists(repoRoot, toolingSha, source)) {
      throw new Error(`release platform workflow does not exist at tooling SHA: ${source}`);
    }
    return { id, source };
  });
}

function readCandidateInventory(repoRoot: string, candidateSha: string) {
  return withCandidateSnapshot(repoRoot, candidateSha, (snapshotRoot) => {
    const rootPackage = JSON.parse(readFileSync(join(snapshotRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof rootPackage.version !== "string" || !rootPackage.version) {
      throw new Error("candidate package.json version is required");
    }
    return {
      version: rootPackage.version,
      packages: collectPackageInventory(snapshotRoot, rootPackage.version),
    };
  });
}

function resolveSource(params: ReleasePlanSource) {
  const repoRoot = resolve(params.repoRoot ?? ".");
  const candidateSha = requireExactSha(params.candidateSha, "candidate SHA");
  const toolingSha = requireExactSha(params.toolingSha, "tooling SHA");
  const toolingFullRef = requireQualifiedRef(params.toolingFullRef, "tooling full ref");
  if (resolveCommit(repoRoot, params.candidateRef, "candidate ref") !== candidateSha) {
    throw new Error("candidate ref does not resolve to the requested candidate SHA");
  }
  if (resolveCommit(repoRoot, toolingFullRef, "tooling full ref") !== toolingSha) {
    throw new Error("tooling full ref does not resolve to the requested tooling SHA");
  }
  return { candidateSha, repoRoot, toolingFullRef, toolingSha };
}

export function produceReleasePlan(params: ReleasePlanSource): ReleasePlan {
  const { candidateSha, repoRoot, toolingFullRef, toolingSha } = resolveSource(params);
  const candidate = readCandidateInventory(repoRoot, candidateSha);
  const policy = deriveReleasePlanPolicy(params.intent, candidate.version);
  const expectedCandidateRef =
    params.intent === "main-qualification" ? candidateSha : `refs/tags/v${candidate.version}`;
  if (params.candidateRef !== expectedCandidateRef) {
    throw new Error(`${params.intent} candidate ref must be ${expectedCandidateRef}`);
  }
  if (!gitPathExists(repoRoot, toolingSha, PRODUCER_PATH)) {
    throw new Error(`${PRODUCER_PATH} is missing from tooling SHA ${toolingSha}`);
  }
  const validationWorkflow = readGitText(repoRoot, toolingSha, VALIDATION_WORKFLOW_PATH);
  const publicationWorkflow = readGitText(repoRoot, toolingSha, PUBLICATION_WORKFLOW_PATH);
  return validateReleasePlan({
    schema: RELEASE_PLAN_SCHEMA,
    release_id: candidate.version,
    version: candidate.version,
    tag: policy.tag,
    candidate_sha: candidateSha,
    target_context_ref: expectedCandidateRef,
    purpose: policy.purpose,
    tooling: {
      repository: REPOSITORY,
      workflow_path: VALIDATION_WORKFLOW_PATH,
      ref: toolingFullRef,
      sha: toolingSha,
    },
    validation: {
      profile: policy.profile,
      soak: policy.soak,
      allowed_groups: collectAllowedGroups(validationWorkflow),
      exceptions: [],
    },
    inventory: {
      packages: candidate.packages,
      platforms: collectPlatformInventory(repoRoot, toolingSha, publicationWorkflow),
    },
  });
}

export function verifyReleasePlanLock(
  lockJson: string,
  params: ReleasePlanSource,
): ReleasePlanLock {
  const lock = parseReleasePlanLockJson(lockJson);
  const expectedPlan = produceReleasePlan(params);
  if (canonicalReleasePlanJson(lock.plan) !== canonicalReleasePlanJson(expectedPlan)) {
    throw new Error("release plan does not match repository-derived authority");
  }
  return lock;
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const intent = requiredOption(args, "--intent") as ReleasePlanIntent;
  if (!["publish", "postpublish-confidence", "main-qualification"].includes(intent)) {
    throw new Error("--intent must be publish, postpublish-confidence, or main-qualification");
  }
  const plan = produceReleasePlan({
    intent,
    candidateSha: requiredOption(args, "--candidate-sha"),
    candidateRef: requiredOption(args, "--candidate-ref"),
    toolingSha: requiredOption(args, "--tooling-sha"),
    toolingFullRef: requiredOption(args, "--tooling-full-ref"),
  });
  process.stdout.write(canonicalReleasePlanLockJson(createReleasePlanLock(plan)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[release-plan-producer] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
