import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareAscii } from "./lib/canonical-json.mjs";
import { collectExtensionPackageJsonCandidates } from "./lib/plugin-publication-candidates.ts";
import {
  collectPublishablePluginPackagesFromCandidates,
  type PluginPackageJson,
} from "./lib/plugin-publication-collector.ts";
import { pnpmLockfileDocuments } from "./lib/pnpm-lockfile-documents.mjs";
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
import { verifyReleaseToolingIdentity } from "./release-tooling-identity.mjs";
import {
  releaseValidationIntentForPurpose,
  resolveReleaseValidationIntent,
  type ReleaseValidationIntent,
} from "./release-validation-intent.mjs";

type ReleasePlanIntent = "publish" | "diagnostic" | "postpublish-confidence" | "main-qualification";
type MainQualificationValidationIntent = Extract<
  ReleaseValidationIntent,
  "main-daily" | "main-weekly"
>;

type ReleasePlanSource = {
  repoRoot?: string;
  candidateSha: string;
  candidateRef: string;
  toolingSha: string;
  toolingFullRef: string;
  runGh?: (args: string[]) => string;
  intent: ReleasePlanIntent;
  validationIntent?: MainQualificationValidationIntent;
};

type CorePackagePolicy = {
  name: string;
  path: string;
  dependency?: string;
};

type ReleasePlanRuntime = {
  parseYamlDocuments: (sources: [string, string, string]) => [unknown, unknown, unknown];
  runGh: (args: string[]) => string;
};

type ReleasePlanProducerRequest =
  | { operation: "produce" | "produce-lock"; params: ReleasePlanSource }
  | { operation: "verify-lock"; lockJson: string; params: ReleasePlanSource };

const REPOSITORY = "openclaw/openclaw";
const VALIDATION_WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const PUBLICATION_WORKFLOW_PATH = ".github/workflows/openclaw-release-publish.yml";
const NPM_CORE_PACKAGE_POLICY_PATH = "scripts/lib/npm-core-release-packages.json";
const YAML_PACKAGE_VERSION = "2.9.0";
const YAML_PACKAGE_INTEGRITY =
  "sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==";
function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveCommit(repoRoot: string, revision: string, label: string): string {
  let resolved: string;
  try {
    resolved = git(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`]);
  } catch {
    throw new Error(`${label} does not resolve to a commit: ${revision}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(resolved)) {
    throw new Error(`${label} did not resolve to an exact lowercase commit SHA`);
  }
  return resolved;
}
function requireExactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
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

function readGitBytes(repoRoot: string, commit: string, path: string): Buffer {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${path} is missing from ${commit}`);
  }
}

function readGitText(repoRoot: string, commit: string, path: string): string {
  return readGitBytes(repoRoot, commit, path).toString("utf8");
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
type LineRange = { start: number; end: number };

function findLockfileMapping(
  lines: string[],
  key: string,
  indent: number,
  scope: LineRange = { start: 0, end: lines.length },
): LineRange {
  const declaration = `${" ".repeat(indent)}${key}:`;
  const matches = lines
    .slice(scope.start, scope.end)
    .flatMap((line, index) => (line === declaration ? [scope.start + index] : []));
  if (matches.length !== 1) {
    throw new Error(`pnpm lockfile must declare exactly one ${key} mapping`);
  }
  const start = matches[0]!;
  let end = scope.end;
  for (let index = start + 1; index < scope.end; index += 1) {
    const line = lines[index] ?? "";
    if (line && line.length - line.trimStart().length <= indent) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function verifyYamlLockfile(lockfileText: string) {
  const lines = pnpmLockfileDocuments(lockfileText).dependencies.split("\n");
  const body = (range: LineRange) => lines.slice(range.start + 1, range.end);
  if (lines.filter((line) => line === "lockfileVersion: '9.0'").length !== 1) {
    throw new Error("pnpm lockfile must use lockfileVersion 9.0");
  }
  const importers = findLockfileMapping(lines, "importers", 0);
  const rootImporter = findLockfileMapping(lines, ".", 2, importers);
  const dependencies = findLockfileMapping(lines, "dependencies", 4, rootImporter);
  const yamlImporter = findLockfileMapping(lines, "yaml", 6, dependencies);
  const importerEntries = body(yamlImporter).filter(Boolean);
  if (
    importerEntries.length !== 2 ||
    importerEntries[0] !== `        specifier: ${YAML_PACKAGE_VERSION}` ||
    importerEntries[1] !== `        version: ${YAML_PACKAGE_VERSION}`
  ) {
    throw new Error(`pnpm root importer must pin yaml exactly to ${YAML_PACKAGE_VERSION}`);
  }

  const packages = findLockfileMapping(lines, "packages", 0);
  const yamlPackage = findLockfileMapping(lines, `yaml@${YAML_PACKAGE_VERSION}`, 2, packages);
  const resolution = `    resolution: {integrity: ${YAML_PACKAGE_INTEGRITY}}`;
  if (
    body(yamlPackage)
      .filter((line) => line.trimStart().startsWith("resolution:"))
      .join("\n") !== resolution
  ) {
    throw new Error(`pnpm lockfile must bind yaml@${YAML_PACKAGE_VERSION} to its exact integrity`);
  }

  const snapshots = findLockfileMapping(lines, "snapshots", 0);
  if (
    body(snapshots).filter((line) => line === `  yaml@${YAML_PACKAGE_VERSION}: {}`).length !== 1
  ) {
    throw new Error(
      `pnpm lockfile yaml@${YAML_PACKAGE_VERSION} snapshot must have no dependencies`,
    );
  }
}

function parseVerifiedYamlDocuments(
  repoRoot: string,
  toolingSha: string,
  sources: [string, string, string],
  runtime: ReleasePlanRuntime,
): [unknown, unknown, unknown] {
  const packageJsonBytes = readGitBytes(repoRoot, toolingSha, "package.json");
  const lockfileBytes = readGitBytes(repoRoot, toolingSha, "pnpm-lock.yaml");
  let packageJson: { dependencies?: Record<string, unknown> };
  try {
    packageJson = JSON.parse(packageJsonBytes.toString("utf8")) as typeof packageJson;
  } catch (error) {
    throw new Error("tooling package.json is invalid JSON", { cause: error });
  }
  if (packageJson.dependencies?.yaml !== YAML_PACKAGE_VERSION) {
    throw new Error(`tooling package.json must pin yaml exactly to ${YAML_PACKAGE_VERSION}`);
  }
  verifyYamlLockfile(lockfileBytes.toString("utf8"));
  return runtime.parseYamlDocuments(sources);
}

function withCandidateSnapshot<T>(
  repoRoot: string,
  candidateSha: string,
  callback: (snapshotRoot: string) => T,
): T {
  const snapshotRoot = mkdtempSync(join(tmpdir(), "openclaw-release-candidate-"));
  try {
    // Select metadata inside Git before buffering or decoding paths: directory-name
    // decoding can silently omit non-UTF-8 inventory, while source trees can exceed stdout limits.
    // Latin1 preserves raw bytes until mode filtering; only retained blob paths need UTF-8.
    const patterns = [
      "package.json",
      "extensions/*/package.json",
      "extensions/*/README.md",
      "packages/*/package.json",
    ];
    const entries = execFileSync(
      "git",
      [
        "diff-tree",
        "--raw",
        "-r",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        git(repoRoot, ["hash-object", "-t", "tree", "--stdin"]),
        candidateSha,
        "--",
        ...patterns.flatMap((path) => [`:(top,glob)${path}`, `:(top,glob,exclude)${path}/**`]),
      ],
      { cwd: repoRoot },
    )
      .toString("latin1")
      .split("\0");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const inventoryPaths: string[] = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      const mode = entries[index]?.split(" ")[1];
      if (mode === "120000") {
        throw new Error("candidate package inventory must not contain symbolic links");
      }
      if (mode?.startsWith("100")) {
        inventoryPaths.push(decoder.decode(Buffer.from(entries[index + 1]!, "latin1")));
      }
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
  validationIntent?: MainQualificationValidationIntent,
) {
  const parsed = parseReleaseVersion(version);
  if (parsed === null || parsed.version !== version) {
    throw new Error(`unsupported release version: ${version}`);
  }
  if (intent !== "main-qualification" && validationIntent !== undefined) {
    throw new Error("validation intent is only valid for main-qualification");
  }
  const purpose: ReleasePlanPurpose | undefined =
    intent === "main-qualification" ||
    intent === "diagnostic" ||
    intent === "postpublish-confidence"
      ? intent
      : intent === "publish"
        ? parsed.channel === "stable"
          ? "stable-publish"
          : "beta-publish"
        : undefined;
  if (!purpose) {
    throw new Error("unsupported release plan intent");
  }
  const tag = intent === "main-qualification" || intent === "diagnostic" ? null : `v${version}`;
  return {
    ...resolveReleaseValidationIntent(releaseValidationIntentForPurpose(purpose, validationIntent)),
    purpose,
    tag,
  };
}

function collectAllowedGroups(workflowDocument: unknown): string[] {
  const workflow = workflowDocument as {
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

function readPackageManifest(path: string): PluginPackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PluginPackageJson;
}

function collectCorePackagePolicy(document: unknown): CorePackagePolicy[] {
  if (
    !Array.isArray(document) ||
    document.length === 0 ||
    document.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        !/^packages\/[a-z0-9-]+$/u.test(entry.path) ||
        !/^@openclaw\/[a-z0-9-]+$/u.test(entry.name) ||
        (entry.dependency !== undefined && entry.dependency !== entry.name),
    ) ||
    new Set(document.map((entry) => entry.path)).size !== document.length ||
    new Set(document.map((entry) => entry.name)).size !== document.length
  ) {
    throw new Error(`${NPM_CORE_PACKAGE_POLICY_PATH} has invalid core package policy`);
  }
  return document.toSorted((left, right) => compareAscii(left.path, right.path));
}

function collectPackageInventory(
  snapshotRoot: string,
  rootManifest: PluginPackageJson,
  corePackages: CorePackagePolicy[],
) {
  const version = rootManifest.version;
  if (typeof version !== "string" || !version) {
    throw new Error("candidate package.json version is required");
  }
  const packages = new Map<
    string,
    { name: string; source: string; version: string; targets: Set<string> }
  >();
  const addPackage = (manifest: PluginPackageJson, targets: string[], source: string) => {
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`${source} must declare package name and version`);
    }
    const existing = packages.get(manifest.name);
    if (existing && existing.source !== source) {
      throw new Error(
        `package inventory source mismatch for ${manifest.name}: ${existing.source} and ${source}`,
      );
    }
    if (existing && existing.version !== manifest.version) {
      throw new Error(`package inventory version mismatch for ${manifest.name}`);
    }
    const entry = existing ?? {
      name: manifest.name,
      source,
      version: manifest.version,
      targets: new Set<string>(),
    };
    for (const target of targets) {
      entry.targets.add(target);
    }
    packages.set(manifest.name, entry);
  };
  addPackage({ name: "openclaw", version }, ["npm"], "package.json");
  const pluginCandidates = collectExtensionPackageJsonCandidates(snapshotRoot);
  for (const [target, plugins] of [
    ["clawhub", collectPublishablePluginPackagesFromCandidates(pluginCandidates, "clawhub")],
    ["npm", collectPublishablePluginPackagesFromCandidates(pluginCandidates, "npm")],
  ] as const) {
    for (const plugin of plugins) {
      addPackage(
        { name: plugin.packageName, version: plugin.version },
        [target],
        `${plugin.packageDir}/package.json`,
      );
    }
  }
  for (const policy of corePackages) {
    const manifestPath = join(snapshotRoot, policy.path, "package.json");
    if (!existsSync(manifestPath)) {
      if (policy.dependency && typeof rootManifest.dependencies?.[policy.dependency] === "string") {
        throw new Error(
          `publishable core package manifest is missing: ${policy.path}/package.json`,
        );
      }
      continue;
    }
    const manifest = readPackageManifest(manifestPath);
    if (policy.dependency && typeof rootManifest.dependencies?.[policy.dependency] !== "string") {
      continue;
    }
    if (!policy.dependency && manifest.openclaw?.release?.publishToNpm !== true) {
      continue;
    }
    if (manifest.version !== version) {
      throw new Error(`${policy.path} version must match openclaw ${version}`);
    }
    if (manifest.name !== policy.name) {
      throw new Error(`${policy.path} must publish ${policy.name}`);
    }
    addPackage(manifest, ["npm"], `${policy.path}/package.json`);
  }
  return [...packages.values()]
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      targets: [...entry.targets].toSorted(compareAscii),
    }))
    .toSorted((left, right) => compareAscii(left.name, right.name));
}

function collectPlatformSources(workflowText: string, workflowDocument: unknown) {
  const platforms = new Map<string, string>();
  const addPlatform = (id: string, source: string) => {
    const existing = platforms.get(id);
    if (existing && existing !== source) {
      throw new Error(
        `${PUBLICATION_WORKFLOW_PATH} declares conflicting platform ${id}: ${existing} and ${source}`,
      );
    }
    platforms.set(id, source);
  };
  const promotionPattern = /promote_([a-z0-9_]+)_release_assets?\(\)\s*\{([\s\S]*?)^\s*\}/gmu;
  const dispatchPattern =
    /dispatch_workflow(?:_at_ref)?\s+(?:(?:"[^"]+"|'[^']+')\s+){0,2}([a-z0-9][a-z0-9-]+\.yml)/u;
  for (const match of workflowText.matchAll(promotionPattern)) {
    const id = match[1]?.replaceAll("_", "-");
    const workflowName = dispatchPattern.exec(match[2] ?? "")?.[1];
    if (!id || !workflowName) {
      throw new Error(`${PUBLICATION_WORKFLOW_PATH} has an invalid platform promotion function`);
    }
    addPlatform(id, `.github/workflows/${workflowName}`);
  }
  const workflow = workflowDocument as {
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
    addPlatform(
      jobId.slice("publish_".length).replaceAll("_", "-"),
      `.github/workflows/${match[1]}`,
    );
  }
  if (platforms.size === 0) {
    throw new Error(`${PUBLICATION_WORKFLOW_PATH} does not declare platform publication workflows`);
  }
  return [...platforms.entries()].toSorted(([left], [right]) => compareAscii(left, right));
}

function collectPlatformInventory(
  repoRoot: string,
  toolingSha: string,
  workflowText: string,
  workflowDocument: unknown,
) {
  return collectPlatformSources(workflowText, workflowDocument).map(([id, source]) => {
    if (!gitPathExists(repoRoot, toolingSha, source)) {
      throw new Error(`release platform workflow does not exist at tooling SHA: ${source}`);
    }
    return { id, source };
  });
}

function readCandidateInventory(
  repoRoot: string,
  candidateSha: string,
  corePackages: CorePackagePolicy[],
) {
  return withCandidateSnapshot(repoRoot, candidateSha, (snapshotRoot) => {
    const rootPackage = readPackageManifest(join(snapshotRoot, "package.json"));
    if (typeof rootPackage.version !== "string" || !rootPackage.version) {
      throw new Error("candidate package.json version is required");
    }
    return {
      version: rootPackage.version,
      packages: collectPackageInventory(snapshotRoot, rootPackage, corePackages),
    };
  });
}

function resolveSource(params: ReleasePlanSource) {
  const repoRoot = resolve(params.repoRoot ?? ".");
  const candidateSha = requireExactSha(params.candidateSha, "candidate SHA");
  const toolingSha = requireExactSha(params.toolingSha, "tooling SHA");
  const toolingFullRef = requireQualifiedRef(params.toolingFullRef, "tooling full ref");
  if (resolveCommit(repoRoot, candidateSha, "candidate SHA") !== candidateSha) {
    throw new Error("candidate SHA does not resolve to itself");
  }
  const toolingRef = toolingFullRef.replace(/^refs\/(?:heads|tags)\//u, "");
  const verifiedTooling = verifyReleaseToolingIdentity({
    repository: REPOSITORY,
    workflowFullRef: toolingFullRef,
    workflowRef: toolingRef,
    workflowSha: toolingSha,
    ...(params.runGh ? { runGh: params.runGh } : {}),
  });
  if (
    params.intent !== "diagnostic" &&
    params.intent !== "main-qualification" &&
    verifiedTooling.route !== "protected-tag"
  ) {
    throw new Error(`${params.intent} tooling must use a release-publish tag bound to its SHA`);
  }
  return { candidateSha, repoRoot, toolingFullRef, toolingSha };
}

function produceReleasePlan(params: ReleasePlanSource, runtime: ReleasePlanRuntime): ReleasePlan {
  const { candidateSha, repoRoot, toolingFullRef, toolingSha } = resolveSource(params);
  const validationWorkflow = readGitText(repoRoot, toolingSha, VALIDATION_WORKFLOW_PATH);
  const publicationWorkflow = readGitText(repoRoot, toolingSha, PUBLICATION_WORKFLOW_PATH);
  const npmCorePackagePolicy = readGitText(repoRoot, toolingSha, NPM_CORE_PACKAGE_POLICY_PATH);
  const [validationDocument, publicationDocument, npmCorePackageDocument] =
    parseVerifiedYamlDocuments(
      repoRoot,
      toolingSha,
      [validationWorkflow, publicationWorkflow, npmCorePackagePolicy],
      runtime,
    );
  const candidate = readCandidateInventory(
    repoRoot,
    candidateSha,
    collectCorePackagePolicy(npmCorePackageDocument),
  );
  const policy = deriveReleasePlanPolicy(params.intent, candidate.version, params.validationIntent);
  // ReleasePlan binds the candidate bytes. A branch used only to make the FRV
  // workflow reachable is dispatch state and must not become plan authority.
  const expectedCandidateRef =
    params.intent === "diagnostic" || params.intent === "main-qualification"
      ? candidateSha
      : `refs/tags/v${candidate.version}`;
  if (params.candidateRef !== expectedCandidateRef) {
    throw new Error(`${params.intent} candidate ref must be ${expectedCandidateRef}`);
  }
  if (
    params.intent === "postpublish-confidence" &&
    resolveCommit(repoRoot, params.candidateRef, "published candidate tag") !== candidateSha
  ) {
    throw new Error("published candidate tag does not resolve to the candidate SHA");
  }
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
      intent: policy.intent,
      profile: policy.profile,
      soak: policy.soak,
      allowed_groups: collectAllowedGroups(validationDocument),
    },
    inventory: {
      packages: candidate.packages,
      platforms: collectPlatformInventory(
        repoRoot,
        toolingSha,
        publicationWorkflow,
        publicationDocument,
      ),
    },
  });
}

function verifyReleasePlanLock(
  lockJson: string,
  params: ReleasePlanSource,
  runtime: ReleasePlanRuntime,
): ReleasePlanLock {
  const expectedPlan = produceReleasePlan(params, runtime);
  const lock = parseReleasePlanLockJson(lockJson);
  if (canonicalReleasePlanJson(lock.plan) !== canonicalReleasePlanJson(expectedPlan)) {
    throw new Error("release plan does not match repository-derived authority");
  }
  return lock;
}

export function runReleasePlanProducerOperation(
  request: ReleasePlanProducerRequest,
  runtime: ReleasePlanRuntime,
): ReleasePlan | ReleasePlanLock | string {
  const params = { ...request.params, runGh: runtime.runGh };
  if (request.operation === "produce") {
    return produceReleasePlan(params, runtime);
  }
  if (request.operation === "verify-lock") {
    return verifyReleasePlanLock(request.lockJson, params, runtime);
  }
  return canonicalReleasePlanLockJson(createReleasePlanLock(produceReleasePlan(params, runtime)));
}
