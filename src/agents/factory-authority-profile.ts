import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  FactoryNativePermissionProfileDefinition,
  FactoryNativeShellEnvironmentPolicy,
  SwarmLaunchAuthority,
  SwarmEffectiveAuthorityProof,
} from "./subagent-registry.types.js";

export const FACTORY_AUTHORITY_PROFILE_ID = "factory_native_build_v1" as const;

export const FACTORY_NATIVE_BASE_PATH_ENTRIES = [
  "/Library/Developer/CommandLineTools/usr/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

export const FACTORY_NATIVE_FIXED_PATH = FACTORY_NATIVE_BASE_PATH_ENTRIES.join(":");

export const FACTORY_NATIVE_DYNAMIC_TOOLS = [] as const;

export const FACTORY_NATIVE_DISABLED_CAPABILITIES = [
  "openclaw-exec",
  "openclaw-process",
  "mcp",
  "apps",
  "plugins",
  "browser",
  "web-search",
  "image-generation",
  "multi-agent",
  "hooks",
] as const;

export const FACTORY_EXPLICIT_TOOL_DENY = [
  "exec",
  "process",
  "message",
  "browser",
  "image",
  "github*",
  "gh_*",
  "*deploy*",
  "sessions_*",
  "subagents",
  "cron",
  "gateway",
  "nodes",
  "web_*",
] as const;

export const FACTORY_NATIVE_READ_ONLY_WORKTREE_SUBPATHS = [".git", ".codex", ".agents"] as const;

export const FACTORY_NATIVE_DENIED_SECRET_GLOBS = [
  ".env",
  "**/.env",
  ".env.*",
  "**/.env.*",
  "*.env",
  "**/*.env",
  ".secrets/**",
  "**/.secrets/**",
] as const;

const FACTORY_NATIVE_REQUIRED_READ_ROOTS = [
  "/Library/Developer/CommandLineTools",
  "/opt/homebrew",
] as const;
const FACTORY_NATIVE_PLATFORM_PATH_ENTRIES = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SENSITIVE_ENVIRONMENT_NAME_PATTERN =
  /(AUTH|CREDENTIAL|KEY|OPENAI|PASSWORD|PASSWD|SECRET|SLACK|TOKEN|GITHUB|GH_|COOKIE|SESSION)/u;

export type FactoryNativeAuthorityManifest = {
  readableRoots: string[];
  pathEntries: string[];
  environment: Record<string, string>;
};

export type FactoryNativeAttemptPaths = {
  factoryStateRoot: string;
  attemptRoot: string;
  scratchRoot: string;
  sanitizedHome: string;
  tempDir: string;
};

export type FactoryNativeRunAuthority = {
  runId: string;
  launchIdentityDigest: `sha256:${string}`;
  authority: SwarmLaunchAuthority;
};

export function hashFactoryNativeAuthorityBytes(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashFactoryNativeAuthorityValue(value: unknown): `sha256:${string}` {
  return hashFactoryNativeAuthorityBytes(stableStringify(value));
}

export function resolveFactoryNativeAttemptPaths(runId: string): FactoryNativeAttemptPaths {
  if (!/^swarm_[a-f0-9]{32}$/u.test(runId)) {
    throw new Error("factory native run id is invalid");
  }
  const factoryStateRoot = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "OpenClawFactory",
  );
  const attemptRoot = path.join(factoryStateRoot, "attempts", runId);
  const scratchRoot = path.join(attemptRoot, "scratch");
  return {
    factoryStateRoot,
    attemptRoot,
    scratchRoot,
    sanitizedHome: path.join(scratchRoot, "home"),
    tempDir: path.join(scratchRoot, "tmp"),
  };
}

/** Creates only the exact owner-private attempt directories exposed to the worker. */
export async function prepareFactoryNativeAttemptPaths(
  runId: string,
): Promise<FactoryNativeAttemptPaths> {
  const resolved = resolveFactoryNativeAttemptPaths(runId);
  for (const directory of [
    resolved.factoryStateRoot,
    resolved.attemptRoot,
    resolved.scratchRoot,
    resolved.sanitizedHome,
    resolved.tempDir,
  ]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }
  const realStateRoot = await fs.realpath(resolved.factoryStateRoot);
  const realScratchRoot = await fs.realpath(resolved.scratchRoot);
  const relative = path.relative(realStateRoot, realScratchRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("factory native scratch root escaped the owner-private state root");
  }
  return {
    factoryStateRoot: realStateRoot,
    attemptRoot: await fs.realpath(resolved.attemptRoot),
    scratchRoot: realScratchRoot,
    sanitizedHome: await fs.realpath(resolved.sanitizedHome),
    tempDir: await fs.realpath(resolved.tempDir),
  };
}

function assertAbsoluteDistinctRoots(roots: readonly string[], label: string): void {
  if (roots.length === 0 || roots.some((root) => !path.isAbsolute(root))) {
    throw new Error(`${label} must contain absolute paths`);
  }
  if (new Set(roots).size !== roots.length) {
    throw new Error(`${label} contains duplicate paths`);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertFactoryReadableRootsSafe(params: {
  roots: readonly string[];
  factoryStateRoot: string;
}): void {
  assertAbsoluteDistinctRoots(params.roots, "factory native readable roots");
  const missingRequiredRoot = FACTORY_NATIVE_REQUIRED_READ_ROOTS.find(
    (root) => !params.roots.includes(root),
  );
  if (missingRequiredRoot) {
    throw new Error(`factory native readable roots must include ${missingRequiredRoot}`);
  }
  const home = os.homedir();
  const forbidden = [
    "/",
    home,
    path.join(home, ".openclaw"),
    path.join(home, ".codex"),
    path.join(home, ".ssh"),
    path.join(home, "Library"),
    params.factoryStateRoot,
    "/tmp",
    "/private/tmp",
    "/var/tmp",
  ];
  for (const root of params.roots) {
    if (forbidden.some((candidate) => root === candidate || isPathInside(root, candidate))) {
      throw new Error(`factory native readable root is too broad or sensitive: ${root}`);
    }
    if (root.startsWith(`${home}${path.sep}`)) {
      const approvedLocalShare = path.join(home, ".local", "share");
      const relative = path.relative(approvedLocalShare, root);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          `factory native user read root is outside the approved toolchain area: ${root}`,
        );
      }
      continue;
    }
    if (!FACTORY_NATIVE_REQUIRED_READ_ROOTS.some((approved) => isPathInside(approved, root))) {
      throw new Error(
        `factory native system read root is outside the approved toolchain area: ${root}`,
      );
    }
  }
}

function assertFactoryEnvironmentSafe(params: {
  environment: Readonly<Record<string, string>>;
  readableRoots: readonly string[];
}): void {
  for (const [name, value] of Object.entries(params.environment)) {
    if (
      !SAFE_ENVIRONMENT_NAME_PATTERN.test(name) ||
      SENSITIVE_ENVIRONMENT_NAME_PATTERN.test(name) ||
      name === "PATH" ||
      name === "HOME" ||
      name === "TMPDIR" ||
      name === "CODEX_THREAD_ID"
    ) {
      throw new Error(`factory native environment variable is not approved: ${name}`);
    }
    if (!value || value.length > 4_096 || value.includes("\0") || value.includes("\n")) {
      throw new Error(`factory native environment value is invalid: ${name}`);
    }
    if (path.isAbsolute(value) && !params.readableRoots.some((root) => isPathInside(root, value))) {
      throw new Error(`factory native environment path is outside approved read roots: ${name}`);
    }
  }
}

function assertFactoryPathEntriesSafe(params: {
  pathEntries: readonly unknown[];
  readableRoots: readonly string[];
}): asserts params is { pathEntries: string[]; readableRoots: readonly string[] } {
  if (params.pathEntries.length === 0 || params.pathEntries.length > 32) {
    throw new Error("factory native PATH must contain between 1 and 32 toolchain directories");
  }
  const seen = new Set<string>();
  for (const entry of params.pathEntries) {
    if (
      typeof entry !== "string" ||
      !path.isAbsolute(entry) ||
      (!FACTORY_NATIVE_PLATFORM_PATH_ENTRIES.has(entry) &&
        !params.readableRoots.some((root) => isPathInside(root, entry)))
    ) {
      throw new Error(`factory native PATH entry is outside approved read roots: ${String(entry)}`);
    }
    if (seen.has(entry)) {
      throw new Error(`factory native PATH contains a duplicate canonical entry: ${entry}`);
    }
    seen.add(entry);
  }
}

export async function canonicalizeFactoryNativeAuthorityManifest(params: {
  readableRoots: readonly string[];
  pathEntries: readonly string[];
  environment: Readonly<Record<string, string>>;
  factoryStateRoot: string;
}): Promise<FactoryNativeAuthorityManifest> {
  const readableRoots = await Promise.all(
    [...new Set(params.readableRoots.map((root) => path.resolve(root)))].map(async (root) => {
      const stat = await fs.stat(root).catch(() => undefined);
      if (!stat?.isDirectory()) {
        throw new Error(`factory native readable root does not exist: ${root}`);
      }
      return await fs.realpath(root);
    }),
  );
  readableRoots.sort();
  assertFactoryReadableRootsSafe({
    roots: readableRoots,
    factoryStateRoot: params.factoryStateRoot,
  });
  const pathEntries: string[] = [];
  for (const rawEntry of params.pathEntries) {
    if (!path.isAbsolute(rawEntry)) {
      throw new Error("factory native PATH entries must be absolute");
    }
    const resolved = await fs.realpath(path.resolve(rawEntry)).catch(() => undefined);
    const stat = resolved ? await fs.stat(resolved).catch(() => undefined) : undefined;
    if (!resolved || !stat?.isDirectory()) {
      throw new Error(`factory native PATH entry does not exist: ${rawEntry}`);
    }
    if (
      !FACTORY_NATIVE_PLATFORM_PATH_ENTRIES.has(resolved) &&
      !readableRoots.some((root) => isPathInside(root, resolved))
    ) {
      throw new Error(`factory native PATH entry is outside approved read roots: ${resolved}`);
    }
    if (pathEntries.includes(resolved)) {
      throw new Error(`factory native PATH contains a duplicate canonical entry: ${resolved}`);
    }
    pathEntries.push(resolved);
  }
  assertFactoryPathEntriesSafe({ pathEntries, readableRoots });
  const environment = Object.fromEntries(
    Object.entries(params.environment).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  assertFactoryEnvironmentSafe({ environment, readableRoots });
  return { readableRoots, pathEntries, environment };
}

/** Resolves and verifies the exact Git metadata root bound to a linked worktree. */
export async function resolveFactoryNativeGitMetadataRoot(params: {
  cwd: string;
  requestedRoot: string;
}): Promise<string> {
  const dotGit = path.join(params.cwd, ".git");
  const stat = await fs.lstat(dotGit).catch(() => undefined);
  if (!stat) {
    throw new Error("factory native worktree has no .git metadata binding");
  }
  let worktreeGitDir: string;
  if (stat.isDirectory()) {
    worktreeGitDir = await fs.realpath(dotGit);
  } else if (stat.isFile()) {
    const pointer = (await fs.readFile(dotGit, "utf8")).trim();
    const match = /^gitdir:\s*(.+)$/iu.exec(pointer);
    if (!match?.[1]) {
      throw new Error("factory native worktree .git pointer is invalid");
    }
    const candidate = path.resolve(params.cwd, match[1]);
    worktreeGitDir = await fs.realpath(candidate);
  } else {
    throw new Error("factory native worktree .git binding is not a file or directory");
  }
  const commonDirFile = path.join(worktreeGitDir, "commondir");
  const commonDir = await fs.readFile(commonDirFile, "utf8").catch(() => undefined);
  const resolvedCommonDir = commonDir?.trim()
    ? await fs.realpath(path.resolve(worktreeGitDir, commonDir.trim()))
    : worktreeGitDir;
  const requested = await fs.realpath(path.resolve(params.requestedRoot)).catch(() => undefined);
  if (
    !requested ||
    requested !== resolvedCommonDir ||
    path.basename(resolvedCommonDir) !== ".git"
  ) {
    throw new Error("factory native Git metadata root does not match the registered worktree");
  }
  return resolvedCommonDir;
}

export function buildFactoryNativePermissionProfile(params: {
  cwd: string;
  scratchRoot: string;
  readableRoots: readonly string[];
  gitMetadataRoot: string;
}): FactoryNativePermissionProfileDefinition {
  const filesystem: FactoryNativePermissionProfileDefinition["filesystem"] = {
    ":root": "deny",
    ":minimal": "read",
    ...Object.fromEntries(params.readableRoots.map((root) => [root, "read" as const])),
    [params.gitMetadataRoot]: "read",
    ":workspace_roots": {
      ".": "write",
      ...Object.fromEntries(
        FACTORY_NATIVE_READ_ONLY_WORKTREE_SUBPATHS.map((entry) => [entry, "read" as const]),
      ),
      ...Object.fromEntries(
        FACTORY_NATIVE_DENIED_SECRET_GLOBS.map((entry) => [entry, "deny" as const]),
      ),
    },
  };
  return {
    workspace_roots: {
      [params.cwd]: true,
      [params.scratchRoot]: true,
    },
    filesystem,
    network: { enabled: false },
  };
}

export function buildFactoryNativeShellEnvironmentPolicy(params: {
  sanitizedHome: string;
  tempDir: string;
  pathEntries: readonly string[];
  environment: Readonly<Record<string, string>>;
}): FactoryNativeShellEnvironmentPolicy {
  const names = [
    "PATH",
    "HOME",
    "TMPDIR",
    "GIT_OPTIONAL_LOCKS",
    ...Object.keys(params.environment).toSorted(),
  ];
  const effectivePath = [
    ...params.pathEntries,
    ...FACTORY_NATIVE_BASE_PATH_ENTRIES.filter((entry) => !params.pathEntries.includes(entry)),
  ].join(":");
  return {
    inherit: "none",
    ignore_default_excludes: false,
    set: {
      PATH: effectivePath,
      HOME: params.sanitizedHome,
      TMPDIR: params.tempDir,
      GIT_OPTIONAL_LOCKS: "0",
      ...params.environment,
    },
    include_only: names,
  };
}

export function buildFactoryNativeLaunchAuthority(params: {
  cwd: string;
  workspaceRoot: string;
  paths: FactoryNativeAttemptPaths;
  manifest: FactoryNativeAuthorityManifest;
  gitMetadataRoot: string;
  worktreeFenceToken: string;
  worktreeOwnershipGeneration: number;
}): SwarmLaunchAuthority {
  if (!path.isAbsolute(params.cwd) || !path.isAbsolute(params.workspaceRoot)) {
    throw new Error("factory native worktree roots must be absolute");
  }
  if (
    !params.worktreeFenceToken.trim() ||
    !Number.isSafeInteger(params.worktreeOwnershipGeneration) ||
    params.worktreeOwnershipGeneration < 1
  ) {
    throw new Error("factory native worktree ownership fence is invalid");
  }
  assertFactoryReadableRootsSafe({
    roots: params.manifest.readableRoots,
    factoryStateRoot: params.paths.factoryStateRoot,
  });
  assertFactoryEnvironmentSafe({
    environment: params.manifest.environment,
    readableRoots: params.manifest.readableRoots,
  });
  assertFactoryPathEntriesSafe({
    pathEntries: params.manifest.pathEntries,
    readableRoots: params.manifest.readableRoots,
  });
  if (!isPathInside(params.paths.factoryStateRoot, params.paths.scratchRoot)) {
    throw new Error("factory native scratch root must stay inside its private state root");
  }
  if (
    !path.isAbsolute(params.gitMetadataRoot) ||
    path.basename(params.gitMetadataRoot) !== ".git" ||
    isPathInside(params.gitMetadataRoot, params.paths.factoryStateRoot)
  ) {
    throw new Error("factory native Git metadata root is invalid");
  }
  if (
    !isPathInside(params.paths.scratchRoot, params.paths.sanitizedHome) ||
    !isPathInside(params.paths.scratchRoot, params.paths.tempDir)
  ) {
    throw new Error("factory native HOME and TMPDIR must stay inside the attempt scratch root");
  }
  const definition = buildFactoryNativePermissionProfile({
    cwd: params.cwd,
    scratchRoot: params.paths.scratchRoot,
    readableRoots: params.manifest.readableRoots,
    gitMetadataRoot: params.gitMetadataRoot,
  });
  const shellEnvironmentDefinition = buildFactoryNativeShellEnvironmentPolicy({
    sanitizedHome: params.paths.sanitizedHome,
    tempDir: params.paths.tempDir,
    pathEntries: params.manifest.pathEntries,
    environment: params.manifest.environment,
  });
  return {
    contractVersion: 1,
    authorityProfileId: FACTORY_AUTHORITY_PROFILE_ID,
    platform: "darwin",
    executor: "codex-app-server",
    backend: "macos-seatbelt",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    permissionProfile: {
      id: FACTORY_AUTHORITY_PROFILE_ID,
      definition,
      definitionHash: hashFactoryNativeAuthorityValue(definition),
      // Codex's :minimal macOS SBPL grants shared platform temp R/W. This is
      // an explicit compatibility carveout, never a claim of zero temp access.
      platformDefaultTempAccess: "read_write",
    },
    filesystem: {
      platformDefaults: ":minimal",
      readableRoots: [...params.manifest.readableRoots],
      writableRoots: [params.cwd, params.paths.scratchRoot],
      gitMetadataRoot: params.gitMetadataRoot,
      readOnlyWorktreeSubpaths: [...FACTORY_NATIVE_READ_ONLY_WORKTREE_SUBPATHS],
      deniedSecretGlobs: [...FACTORY_NATIVE_DENIED_SECRET_GLOBS],
      factoryStateRoot: params.paths.factoryStateRoot,
      scratchRoot: params.paths.scratchRoot,
      sanitizedHome: params.paths.sanitizedHome,
      tempDir: params.paths.tempDir,
      inheritedTmpdir: false,
      controlPlaneStateInSharedTemp: false,
    },
    network: "none",
    shellEnvironmentPolicy: {
      definition: shellEnvironmentDefinition,
      definitionHash: hashFactoryNativeAuthorityValue(shellEnvironmentDefinition),
      orderedNativePathEntries: [...params.manifest.pathEntries],
      effectivePath: shellEnvironmentDefinition.set.PATH!,
      runtimeAddedNames: ["CODEX_THREAD_ID"],
      containsSecretValues: false,
    },
    toolSurface: {
      codexNativeCodeMode: true,
      openClawDynamicTools: [...FACTORY_NATIVE_DYNAMIC_TOOLS],
      disabledCapabilities: [...FACTORY_NATIVE_DISABLED_CAPABILITIES],
    },
    worktreeFenceToken: params.worktreeFenceToken,
    worktreeOwnershipGeneration: params.worktreeOwnershipGeneration,
    cwd: params.cwd,
    workspaceRoot: params.workspaceRoot,
  };
}

/** Parses a frozen authority row and rejects drift/corruption before replay. */
export function assertFactoryNativeLaunchAuthority(value: unknown): SwarmLaunchAuthority {
  if (
    !isRecord(value) ||
    value.contractVersion !== 1 ||
    value.authorityProfileId !== FACTORY_AUTHORITY_PROFILE_ID ||
    value.platform !== "darwin" ||
    value.executor !== "codex-app-server" ||
    value.backend !== "macos-seatbelt" ||
    value.approvalPolicy !== "never" ||
    value.approvalsReviewer !== "auto_review" ||
    typeof value.cwd !== "string" ||
    typeof value.workspaceRoot !== "string" ||
    typeof value.worktreeFenceToken !== "string" ||
    typeof value.worktreeOwnershipGeneration !== "number" ||
    !isRecord(value.filesystem) ||
    !Array.isArray(value.filesystem.readableRoots) ||
    typeof value.filesystem.factoryStateRoot !== "string" ||
    typeof value.filesystem.gitMetadataRoot !== "string" ||
    typeof value.filesystem.scratchRoot !== "string" ||
    typeof value.filesystem.sanitizedHome !== "string" ||
    typeof value.filesystem.tempDir !== "string" ||
    !isRecord(value.shellEnvironmentPolicy) ||
    !isRecord(value.shellEnvironmentPolicy.definition) ||
    !isRecord(value.shellEnvironmentPolicy.definition.set) ||
    !Array.isArray(value.shellEnvironmentPolicy.orderedNativePathEntries) ||
    typeof value.shellEnvironmentPolicy.effectivePath !== "string" ||
    typeof value.shellEnvironmentPolicy.definitionHash !== "string" ||
    !SHA256_PATTERN.test(value.shellEnvironmentPolicy.definitionHash) ||
    !isRecord(value.permissionProfile) ||
    typeof value.permissionProfile.definitionHash !== "string" ||
    !SHA256_PATTERN.test(value.permissionProfile.definitionHash)
  ) {
    throw new Error("factory native authority contract is invalid");
  }
  const authority = value as SwarmLaunchAuthority;
  const fixedNames = new Set(["PATH", "HOME", "TMPDIR", "GIT_OPTIONAL_LOCKS"]);
  const environment = Object.fromEntries(
    Object.entries(authority.shellEnvironmentPolicy.definition.set).filter(
      ([name]) => !fixedNames.has(name),
    ),
  );
  const expected = buildFactoryNativeLaunchAuthority({
    cwd: authority.cwd,
    workspaceRoot: authority.workspaceRoot,
    paths: {
      factoryStateRoot: authority.filesystem.factoryStateRoot,
      attemptRoot: path.dirname(authority.filesystem.scratchRoot),
      scratchRoot: authority.filesystem.scratchRoot,
      sanitizedHome: authority.filesystem.sanitizedHome,
      tempDir: authority.filesystem.tempDir,
    },
    manifest: {
      readableRoots: authority.filesystem.readableRoots,
      pathEntries: authority.shellEnvironmentPolicy.orderedNativePathEntries,
      environment,
    },
    gitMetadataRoot: authority.filesystem.gitMetadataRoot,
    worktreeFenceToken: authority.worktreeFenceToken,
    worktreeOwnershipGeneration: authority.worktreeOwnershipGeneration,
  });
  if (stableStringify(authority) !== stableStringify(expected)) {
    throw new Error("factory native authority contract does not match the enforced profile");
  }
  return structuredClone(authority);
}

export function buildFactoryNativeRuntimePolicyHash(
  runtime: SwarmEffectiveAuthorityProof["runtime"],
): `sha256:${string}` {
  return hashFactoryNativeAuthorityValue({
    approvalPolicy: runtime.approvalPolicy,
    approvalsReviewer: runtime.approvalsReviewer,
    permissionSelection: runtime.permissionSelection,
    activePermissionProfile: runtime.activePermissionProfile,
    sandbox: runtime.sandbox,
    cwd: runtime.cwd,
    runtimeWorkspaceRoots: runtime.runtimeWorkspaceRoots,
    profileDefinitionHash: runtime.profileDefinitionHash,
    threadConfigHash: runtime.threadConfigHash,
    shellEnvironmentPolicyHash: runtime.shellEnvironmentPolicyHash,
    dynamicTools: runtime.dynamicTools,
    threadStartRequestHash: runtime.threadStartRequestHash,
    turnStartRequestHash: runtime.turnStartRequestHash,
  });
}

export function buildFactoryNativeProofHash(
  proof: Omit<SwarmEffectiveAuthorityProof, "proofHash">,
): `sha256:${string}` {
  return hashFactoryNativeAuthorityValue(proof);
}

/** Validates the effective app-server proof against the immutable launch contract. */
export function assertFactoryNativeAuthorityProof(params: {
  binding: FactoryNativeRunAuthority;
  proof: SwarmEffectiveAuthorityProof;
}): SwarmEffectiveAuthorityProof {
  const authority = assertFactoryNativeLaunchAuthority(params.binding.authority);
  const { proof } = params;
  const contractHash = hashFactoryNativeAuthorityValue(authority);
  const expectedRoots = [...authority.filesystem.writableRoots].toSorted();
  const expectedSandboxWritableRoots = expectedRoots.filter((root) => root !== authority.cwd);
  if (
    proof.proofContractVersion !== 1 ||
    proof.contractHash !== contractHash ||
    proof.launchIdentityDigest !== params.binding.launchIdentityDigest ||
    proof.runtime.codexVersion !== proof.runtime.appServerVersion ||
    !proof.runtime.appServerInstanceId.trim() ||
    !proof.runtime.appServerBuildIdentity.trim() ||
    !proof.runtime.runtimeArtifactId.trim() ||
    !proof.runtime.runtimeArtifactFingerprint.trim() ||
    proof.runtime.activePermissionProfile.id !== authority.permissionProfile.id ||
    proof.runtime.activePermissionProfile.extends != null ||
    proof.runtime.sandbox.type !== "workspaceWrite" ||
    stableStringify([...proof.runtime.sandbox.writableRoots].toSorted()) !==
      stableStringify(expectedSandboxWritableRoots) ||
    proof.runtime.sandbox.networkAccess !== false ||
    proof.runtime.sandbox.excludeTmpdirEnvVar !== true ||
    proof.runtime.sandbox.excludeSlashTmp !== true ||
    proof.runtime.profileDefinitionHash !== authority.permissionProfile.definitionHash ||
    proof.runtime.shellEnvironmentPolicyHash !== authority.shellEnvironmentPolicy.definitionHash ||
    proof.runtime.approvalPolicy !== authority.approvalPolicy ||
    proof.runtime.approvalsReviewer !== authority.approvalsReviewer ||
    proof.runtime.permissionSelection !== authority.permissionProfile.id ||
    proof.runtime.cwd !== authority.cwd ||
    stableStringify([...proof.runtime.runtimeWorkspaceRoots].toSorted()) !==
      stableStringify(expectedRoots) ||
    stableStringify(proof.runtime.dynamicTools) !==
      stableStringify(authority.toolSurface.openClawDynamicTools) ||
    proof.runtime.policyHash !== buildFactoryNativeRuntimePolicyHash(proof.runtime) ||
    proof.proofHash !==
      buildFactoryNativeProofHash({
        proofContractVersion: proof.proofContractVersion,
        contractHash: proof.contractHash,
        launchIdentityDigest: proof.launchIdentityDigest,
        runtime: proof.runtime,
        observedAt: proof.observedAt,
      })
  ) {
    throw new Error("factory native effective authority proof does not match the launch contract");
  }
  return structuredClone(proof);
}
