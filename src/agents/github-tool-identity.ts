import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { ToolsGitHubStatusResult } from "../../packages/gateway-protocol/src/index.js";
import { isManagedGitHubProfileId } from "../config/github-identity-profile-id.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef, isValidEnvSecretRefId } from "../config/types.secrets.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { runCommandBuffered } from "../process/exec.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "./agent-scope.js";

const GITHUB_HOST = "github.com";
const PROFILE_COMMAND_TIMEOUT_MS = 15_000;
const PROFILE_OUTPUT_LIMIT_BYTES = 32 * 1024;
const MANAGED_GITHUB_ROOT_SEGMENTS = ["credentials", "github"] as const;

type GitHubToolAccount = { accountId: number; login: string; avatarUrl: string | null };

export function createManagedGitHubProfileId(): string {
  return `ghp_${randomBytes(16).toString("hex")}`;
}

export function resolveManagedGitHubProfileDir(params: {
  agentId: string;
  scope: "system" | "agent";
  profileId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (!isManagedGitHubProfileId(params.profileId)) {
    throw new Error("Managed GitHub profile id is invalid.");
  }
  const root = resolveManagedGitHubProfileRoot(params);
  return path.join(root, params.profileId);
}

export function resolveManagedGitHubProfileRoot(params: {
  agentId: string;
  scope: "system" | "agent";
  env?: NodeJS.ProcessEnv;
}): string {
  const root = path.join(resolveStateDir(params.env), ...MANAGED_GITHUB_ROOT_SEGMENTS);
  return params.scope === "agent"
    ? path.join(root, "agents", resolveManagedGitHubAgentKey(params.agentId))
    : path.join(root, "system");
}

export function resolveManagedGitHubAgentKey(agentId: string): string {
  return createHash("sha256").update(normalizeAgentId(agentId), "utf8").digest("hex");
}

export function resolveConfiguredGitHubToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: "system" | "agent";
}): GitHubToolIdentityConfig | undefined {
  return params.scope === "agent"
    ? resolveAgentConfig(params.config, params.agentId)?.tools?.github
    : params.config.tools?.github;
}

function resolveGitHubToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}) {
  const agentOverride = resolveAgentConfig(params.config, params.agentId)?.tools?.github;
  const config = agentOverride ?? params.config.tools?.github;
  if (!config) {
    return { source: "system-detected" as const };
  }
  const source: "agent-override" | "system-configured" = agentOverride
    ? "agent-override"
    : "system-configured";
  return {
    source,
    config,
    profileDir: resolveManagedGitHubProfileDir({
      agentId: params.agentId,
      env: params.env,
      scope: source === "agent-override" ? "agent" : "system",
      profileId: config.profileId,
    }),
  };
}

type ResolvedGitHubToolIdentity = ReturnType<typeof resolveGitHubToolIdentity>;

export type PreparedGitHubToolEnvironment = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  localIdentityEnv: Readonly<Record<string, string>>;
  excludedStoreNames: readonly string[];
  /** A local process must retain the host-selected profile and author identity. */
  managedLocalIdentity: boolean;
}>;

function localIdentityEnvironmentForIdentity(
  identity: ResolvedGitHubToolIdentity,
): Readonly<Record<string, string>> {
  if (identity.source === "system-detected") {
    return {};
  }
  const author = identity.config.gitAuthor;
  const gitConfigEntries = Object.entries({
    ...(author?.name ? { "user.name": author.name } : {}),
    ...(author?.email ? { "user.email": author.email } : {}),
  });
  const gitConfigEnv = Object.fromEntries(
    gitConfigEntries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  );
  return {
    GH_CONFIG_DIR: identity.profileDir,
    ...(gitConfigEntries.length > 0
      ? { GIT_CONFIG_COUNT: String(gitConfigEntries.length), ...gitConfigEnv }
      : {}),
    ...(author?.name ? { GIT_AUTHOR_NAME: author.name, GIT_COMMITTER_NAME: author.name } : {}),
    ...(author?.email ? { GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_EMAIL: author.email } : {}),
  };
}

/** Prepares the non-secret child overlay and store exclusions once per agent run. */
export function prepareGitHubToolEnvironment(params: {
  config: OpenClawConfig;
  agentId: string;
  sourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): PreparedGitHubToolEnvironment {
  const identity = resolveGitHubToolIdentity(params);
  const managedLocalIdentity = identity.source !== "system-detected";
  const previewToken =
    params.sourceConfig?.gateway?.controlUi?.github?.token ??
    params.config.gateway?.controlUi?.github?.token;
  const credentialScrubEnv: Record<string, string> = managedLocalIdentity
    ? { GH_TOKEN: "", GITHUB_TOKEN: "" }
    : {};
  const excludedStoreNames: string[] = [];
  if (isSecretRef(previewToken)) {
    if (previewToken.source === "env" && isValidEnvSecretRefId(previewToken.id)) {
      credentialScrubEnv[previewToken.id] = "";
    } else if (previewToken.source === "store") {
      credentialScrubEnv[previewToken.id] = "";
      excludedStoreNames.push(previewToken.id);
    }
  }
  return Object.freeze({
    credentialScrubEnv: Object.freeze(credentialScrubEnv),
    localIdentityEnv: Object.freeze({ ...localIdentityEnvironmentForIdentity(identity) }),
    excludedStoreNames: Object.freeze(excludedStoreNames),
    managedLocalIdentity,
  });
}

async function runIdentityCommand(
  argv: string[],
  env?: NodeJS.ProcessEnv,
  input?: string,
  cwd?: string,
) {
  return await runCommandBuffered(argv, {
    env: env ? { ...env } : {},
    input,
    cwd,
    timeoutMs: PROFILE_COMMAND_TIMEOUT_MS,
    maxOutputBytes: PROFILE_OUTPUT_LIMIT_BYTES,
  });
}

function parseAccount(stdout: Buffer): GitHubToolAccount | undefined {
  try {
    const value: unknown = JSON.parse(stdout.toString("utf8"));
    if (!isRecord(value)) {
      return undefined;
    }
    const accountId = value.id;
    const login = readNonBlankString(value.login)?.trim();
    if (!Number.isSafeInteger(accountId) || Number(accountId) <= 0 || !login) {
      return undefined;
    }
    return {
      accountId: Number(accountId),
      login,
      avatarUrl: readNonBlankString(value.avatarUrl)?.trim() ?? null,
    };
  } catch {
    return undefined;
  }
}

async function probeAccount(env?: NodeJS.ProcessEnv) {
  const result = await runIdentityCommand(
    [
      "gh",
      "api",
      "user",
      "--hostname",
      GITHUB_HOST,
      "--jq",
      "{id: .id, login: .login, avatarUrl: .avatar_url}",
    ],
    env,
  );
  return {
    result,
    account: result.code === 0 ? parseAccount(result.stdout) : undefined,
  };
}

function isRateLimitedProbe(result: Awaited<ReturnType<typeof runIdentityCommand>>): boolean {
  if (result.code === 0) {
    return false;
  }
  const stderr = result.stderr.toString("utf8");
  return /\bHTTP 403\b/iu.test(stderr) && /(?:rate.?limit|abuse detection)/iu.test(stderr);
}

function isInvalidCredentialProbe(result: Awaited<ReturnType<typeof runIdentityCommand>>): boolean {
  if (result.code === 4) {
    return true;
  }
  const stderr = result.stderr.toString("utf8");
  return /\bHTTP 401\b|bad credentials|authentication required/iu.test(stderr);
}

async function readGitAuthor(env: NodeJS.ProcessEnv, cwd: string) {
  const result = await runIdentityCommand(
    ["git", "config", "--null", "--get-regexp", "^user\\.(name|email)$"],
    env,
    undefined,
    cwd,
  );
  const author: { name: string | null; email: string | null } = { name: null, email: null };
  if (result.code !== 0) {
    return author;
  }
  for (const entry of result.stdout.toString("utf8").split("\0")) {
    const separator = entry.indexOf("\n");
    if (separator < 0) {
      continue;
    }
    const key = entry.slice(0, separator);
    const value = readNonBlankString(entry.slice(separator + 1))?.trim() ?? null;
    if (key === "user.name") {
      author.name = value;
    } else if (key === "user.email") {
      author.email = value;
    }
  }
  return author;
}

async function isPrivateManagedProfile(profileDir: string): Promise<boolean> {
  try {
    const [profile, hosts] = await Promise.all([
      fs.lstat(profileDir),
      fs.lstat(path.join(profileDir, "hosts.yml")),
    ]);
    if (
      !profile.isDirectory() ||
      profile.isSymbolicLink() ||
      !hosts.isFile() ||
      hosts.isSymbolicLink()
    ) {
      return false;
    }
    return (
      process.platform === "win32" || ((profile.mode & 0o077) === 0 && (hosts.mode & 0o077) === 0)
    );
  } catch {
    return false;
  }
}

export async function resolveGitHubToolIdentityStatus(params: {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ToolsGitHubStatusResult> {
  const identity = resolveGitHubToolIdentity(params);
  const managed = identity.source !== "system-detected";
  const localIdentityEnv = localIdentityEnvironmentForIdentity(identity);
  const nativeEnv = params.env ?? {};
  const probeEnv: NodeJS.ProcessEnv = managed
    ? { ...nativeEnv, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, ...localIdentityEnv }
    : nativeEnv;
  const profileAvailable = !managed || (await isPrivateManagedProfile(identity.profileDir));
  const workspaceDir = resolveAgentWorkspaceDir(params.config, params.agentId);
  const [probe, author] = await Promise.all([
    profileAvailable ? probeAccount(probeEnv) : undefined,
    readGitAuthor(probeEnv, workspaceDir),
  ]);
  const account = probe?.account ?? null;
  const credentialState = account
    ? "available"
    : probe && isRateLimitedProbe(probe.result)
      ? "rate_limited"
      : probe && isInvalidCredentialProbe(probe.result)
        ? managed
          ? "configured_unavailable"
          : "unavailable"
        : probe
          ? "unverified"
          : managed
            ? "configured_unavailable"
            : "unavailable";
  return {
    agentId: params.agentId,
    source: identity.source,
    credentialState,
    account: account ? { login: account.login, avatarUrl: account.avatarUrl } : null,
    gitAuthor: author,
    evidence: account
      ? "github-api"
      : probe && isRateLimitedProbe(probe.result)
        ? "rate-limited"
        : probe
          ? "unverified"
          : "none",
  };
}

export type PreparedGitHubPublicationIdentity = Readonly<{
  source: "system-detected" | "system-configured" | "agent-override";
  profileId?: string;
  account: GitHubToolAccount;
  env: NodeJS.ProcessEnv;
}>;

/** Confirms the current config still selects the prepared publication profile. */
export function matchesPreparedGitHubPublicationIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  identity: PreparedGitHubPublicationIdentity;
}): boolean {
  const current = resolveGitHubToolIdentity(params);
  return (
    current.source === params.identity.source &&
    (current.source === "system-detected" || current.config.profileId === params.identity.profileId)
  );
}

/** Resolves a Gateway-owned publication identity without exposing its child environment. */
export async function prepareGitHubPublicationIdentity(params: {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PreparedGitHubPublicationIdentity> {
  const identity = resolveGitHubToolIdentity(params);
  const managed = identity.source !== "system-detected";
  if (managed && !(await isPrivateManagedProfile(identity.profileDir))) {
    throw new Error("The configured GitHub identity profile is unavailable.");
  }
  const hostEnv = params.env ?? process.env;
  const prepared = prepareGitHubToolEnvironment({
    config: params.config,
    sourceConfig: params.sourceConfig,
    agentId: params.agentId,
    env: hostEnv,
  });
  const directScrubEnv = Object.fromEntries(
    Object.keys(prepared.credentialScrubEnv).map((name) => [name, undefined]),
  );
  const env: NodeJS.ProcessEnv = {
    ...hostEnv,
    ...directScrubEnv,
    ...prepared.localIdentityEnv,
    // Direct gh calls must not see empty token variables: gh treats them as
    // authoritative and will not fall through to a native or managed profile.
    ...(managed ? { GH_TOKEN: undefined, GITHUB_TOKEN: undefined } : {}),
    GH_PROMPT_DISABLED: "1",
  };
  const probe = await probeAccount(env);
  if (!probe.account) {
    throw new Error("The effective GitHub identity could not be verified.");
  }
  return Object.freeze({
    source: identity.source,
    ...(managed ? { profileId: identity.config.profileId } : {}),
    account: probe.account,
    env,
  });
}

async function makePrivateTree(root: string): Promise<void> {
  await fs.chmod(root, 0o700);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makePrivateTree(child);
    } else if (entry.isFile()) {
      await fs.chmod(child, 0o600);
    } else {
      throw new Error("Managed GitHub profile contains an unsupported filesystem entry.");
    }
  }
}

/** Publishes a new inactive profile and switches config without retiring in-use generations. */
export async function installManagedGitHubProfile(params: {
  profileDir: string;
  token: string;
  commitConfig: (account: GitHubToolAccount) => Promise<void>;
}): Promise<GitHubToolAccount> {
  const token = params.token.trim();
  if (!token || /[\r\n]/u.test(token)) {
    throw new Error("Managed GitHub credential must be one non-empty line.");
  }
  const parent = path.dirname(params.profileDir);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  const stagingRoot = await fs.mkdtemp(path.join(parent, ".github-profile.staging-"));
  const stagedProfile = path.join(stagingRoot, "profile");
  let published = false;
  let committed = false;
  try {
    await fs.mkdir(stagedProfile, { mode: 0o700 });
    const stagedEnv: NodeJS.ProcessEnv = {
      GH_CONFIG_DIR: stagedProfile,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
    };
    const login = await runIdentityCommand(
      ["gh", "auth", "login", "--hostname", GITHUB_HOST, "--with-token", "--insecure-storage"],
      stagedEnv,
      `${token}\n`,
    );
    if (login.code !== 0) {
      throw new Error("GitHub CLI rejected the managed credential.");
    }
    const verified = await probeAccount(stagedEnv);
    if (!verified.account) {
      throw new Error("GitHub CLI could not verify the managed credential.");
    }
    await makePrivateTree(stagedProfile);
    await fs.rename(stagedProfile, params.profileDir);
    published = true;
    await params.commitConfig(verified.account);
    committed = true;
    return verified.account;
  } finally {
    if (published && !committed) {
      await fs.rm(params.profileDir, { recursive: true, force: true });
    }
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}
