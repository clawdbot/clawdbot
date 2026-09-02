import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import type {
  GitHubIdentityFacts,
  ToolsGitHubStatusResult,
} from "../../packages/gateway-protocol/src/index.js";
import { isManagedGitHubProfileId } from "../config/github-identity-profile-id.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef, isValidEnvSecretRefId } from "../config/types.secrets.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { hasErrnoCode } from "../infra/errno.js";
import { readSecretFile } from "../infra/fs-safe-advanced.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { runCommandBuffered } from "../process/exec.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "./agent-scope.js";
import { verifyGitHubCredential } from "./github-oauth-client.js";
import { inspectGitHubOAuthRecord } from "./github-oauth-records.js";
import type { GitHubToolAccount } from "./github-tool-account.js";

const GITHUB_HOST = "github.com";
const PROFILE_COMMAND_TIMEOUT_MS = 15_000;
const PROFILE_OUTPUT_LIMIT_BYTES = 32 * 1024;
const MANAGED_GITHUB_ROOT_SEGMENTS = ["credentials", "github"] as const;

export class GitHubAccountMismatchError extends Error {}

export function createManagedGitHubProfileId(): string {
  return `ghp_${randomBytes(16).toString("hex")}`;
}

export function resolveManagedGitHubProfileDir(params: {
  agentId: string;
  scope: "system" | "agent" | "personal";
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
  scope: "system" | "agent" | "personal";
  env?: NodeJS.ProcessEnv;
}): string {
  const root = path.join(resolveStateDir(params.env), ...MANAGED_GITHUB_ROOT_SEGMENTS);
  return params.scope === "agent"
    ? path.join(root, "agents", resolveManagedGitHubAgentKey(params.agentId))
    : path.join(root, params.scope);
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

function resolveScopedGitHubToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: "system" | "agent";
  env?: NodeJS.ProcessEnv;
}): ResolvedGitHubToolIdentity | undefined {
  const config = resolveConfiguredGitHubToolIdentity(params);
  if (!config) {
    return params.scope === "system" ? { source: "system-detected" as const } : undefined;
  }
  const source = params.scope === "system" ? "system-configured" : "agent-override";
  return {
    source,
    config,
    profileDir: resolveManagedGitHubProfileDir({
      agentId: params.agentId,
      env: params.env,
      scope: params.scope,
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

async function runIdentityCommand(argv: string[], env?: NodeJS.ProcessEnv, cwd?: string) {
  return await runCommandBuffered(argv, {
    env: env ? { ...env } : {},
    cwd,
    timeoutMs: PROFILE_COMMAND_TIMEOUT_MS,
    maxOutputBytes: PROFILE_OUTPUT_LIMIT_BYTES,
  });
}

async function readNativeGitHubToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const result = await runIdentityCommand(["gh", "auth", "token", "--hostname", GITHUB_HOST], env);
  try {
    if (result.code !== 0) {
      return undefined;
    }
    return normalizeManagedGitHubToken(result.stdout.toString("utf8"));
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

async function readManagedGitHubToken(profileDir: string): Promise<string | undefined> {
  if (!(await isPrivateManagedGitHubProfile(profileDir))) {
    return undefined;
  }
  try {
    let hosts: unknown;
    for (const name of ["hosts.yml", "config.yml"]) {
      const filePath = path.join(profileDir, name);
      const stat = await fs.lstat(filePath).catch((error: unknown) => {
        if (name === "config.yml" && hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (!stat) {
        continue;
      }
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        return undefined;
      }
      const raw = await readSecretFile(filePath, "Managed GitHub profile", {
        maxBytes: PROFILE_OUTPUT_LIMIT_BYTES,
        rejectSymlink: true,
      });
      // parse() logs YAML warnings containing file contents. Inspect the document
      // instead so corrupt credentials never escape into parser diagnostics.
      const document = parseDocument(raw, { prettyErrors: false });
      if (document.errors.length || document.warnings.length) {
        return undefined;
      }
      const value: unknown = document.toJS({ maxAliasCount: 0 });
      if (!isRecord(value)) {
        return undefined;
      }
      if (name === "hosts.yml") {
        hosts = value;
      }
    }
    const host = isRecord(hosts) ? hosts[GITHUB_HOST] : undefined;
    // gh reads the active host token before considering the global keyring.
    // User-keyed entries alone cannot prove isolation from native auth.
    return isRecord(host) && typeof host.oauth_token === "string"
      ? normalizeManagedGitHubToken(host.oauth_token)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readGitAuthor(env: NodeJS.ProcessEnv, cwd: string) {
  const result = await runIdentityCommand(
    ["git", "config", "--null", "--get-regexp", "^user\\.(name|email)$"],
    env,
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

async function isPrivateManagedGitHubProfile(profileDir: string): Promise<boolean> {
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
  selectedScope: "system" | "agent";
  env?: NodeJS.ProcessEnv;
}): Promise<ToolsGitHubStatusResult> {
  const effectiveIdentity = resolveGitHubToolIdentity(params);
  const selectedIdentity = resolveScopedGitHubToolIdentity({
    ...params,
    scope: params.selectedScope,
  });
  const effective = await resolveGitHubIdentityFacts({ ...params, identity: effectiveIdentity });
  const selectedMatchesEffective =
    selectedIdentity?.source === effectiveIdentity.source &&
    (selectedIdentity?.source === "system-detected" ||
      (effectiveIdentity.source !== "system-detected" &&
        selectedIdentity?.config.profileId === effectiveIdentity.config.profileId));
  const selected = !selectedIdentity
    ? null
    : selectedMatchesEffective
      ? effective
      : await resolveGitHubIdentityFacts({ ...params, identity: selectedIdentity });
  return {
    agentId: params.agentId,
    selectedScope: params.selectedScope,
    selected: {
      scope: params.selectedScope,
      configured: selectedIdentity?.source !== "system-detected" && selectedIdentity !== undefined,
      identity: selected,
    },
    effective,
  };
}

async function resolveGitHubIdentityFacts(params: {
  config: OpenClawConfig;
  agentId: string;
  identity: ResolvedGitHubToolIdentity;
  env?: NodeJS.ProcessEnv;
}): Promise<GitHubIdentityFacts> {
  const identity = params.identity;
  const managed = identity.source !== "system-detected";
  const localIdentityEnv = localIdentityEnvironmentForIdentity(identity);
  const nativeEnv = params.env ?? {};
  const probeEnv: NodeJS.ProcessEnv = managed
    ? { ...nativeEnv, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, ...localIdentityEnv }
    : nativeEnv;
  const token = managed
    ? await readManagedGitHubToken(identity.profileDir)
    : await readNativeGitHubToken(probeEnv);
  const workspaceDir = resolveAgentWorkspaceDir(params.config, params.agentId);
  const [probe, author] = await Promise.all([
    token ? verifyGitHubCredential(token) : undefined,
    readGitAuthor(probeEnv, workspaceDir),
  ]);
  const account = probe?.status === "available" ? probe.account : null;
  const credentialState =
    probe?.status === "unavailable" || !probe
      ? managed
        ? "configured_unavailable"
        : "unavailable"
      : probe.status;
  const oauth =
    managed && identity.config.kind === "oauth"
      ? inspectGitHubOAuthRecord(identity.config.profileId)
      : { state: "missing" as const };
  const oauthRecord = oauth.state === "valid" ? oauth.record : undefined;
  const refreshState =
    !managed || identity.config.kind !== "oauth"
      ? "not_applicable"
      : oauth.state !== "valid"
        ? "unavailable"
        : oauth.record.pendingRefresh
          ? "refreshing"
          : (oauth.record.refreshFailure ??
            (oauth.record.refreshExpiresAtMs <= Date.now() ? "expired" : "available"));
  return {
    source: identity.source,
    credentialKind: !managed
      ? "native"
      : identity.config.kind === "oauth"
        ? "managed-oauth"
        : "managed-pat",
    credentialState,
    account: account ? { login: account.login } : null,
    gitAuthor: author,
    evidence: account
      ? "github-api"
      : probe?.status === "rate_limited"
        ? "rate-limited"
        : probe
          ? "unverified"
          : "none",
    accessExpiresAtMs: oauthRecord?.accessExpiresAtMs ?? null,
    refreshState,
    oauthScopes: [...(oauthRecord?.scopes ?? [])],
    repositoryGrants: "unknown",
  };
}

export type PreparedGitHubPublicationIdentity = Readonly<{
  source: "system-detected" | "system-configured" | "agent-override" | "personal";
  profileId?: string;
  account: GitHubToolAccount;
  env: NodeJS.ProcessEnv;
}>;

/** Only the personal publication broker receives this environment; never agent execution. */
export async function preparePersonalGitHubPublicationIdentity(params: {
  profileId: string;
  accountId: number;
  assertCurrent: () => void;
}): Promise<PreparedGitHubPublicationIdentity> {
  params.assertCurrent();
  const profileDir = resolveManagedGitHubProfileDir({
    agentId: "",
    scope: "personal",
    profileId: params.profileId,
  });
  const token = await readManagedGitHubToken(profileDir);
  if (!token) {
    throw new Error("My GitHub profile is unavailable; reconnect My GitHub.");
  }
  params.assertCurrent();
  const env = {
    ...process.env,
    GH_TOKEN: token,
    GITHUB_TOKEN: undefined,
    GH_CONFIG_DIR: profileDir,
    GH_PROMPT_DISABLED: "1",
  };
  const probe = await verifyGitHubCredential(token);
  params.assertCurrent();
  if (probe.status !== "available") {
    throw new Error("My GitHub credential could not be verified; reconnect My GitHub.");
  }
  if (probe.account.accountId !== params.accountId) {
    throw new GitHubAccountMismatchError("My GitHub account changed; reconnect My GitHub.");
  }
  return Object.freeze({
    source: "personal",
    profileId: params.profileId,
    account: probe.account,
    env: Object.freeze(env),
  });
}

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

type GitHubIdentityPreparation = {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
};

export class GitHubIdentityError extends Error {
  constructor(readonly reason: "unavailable" | "changed" | "rate_limited" | "unverified") {
    super(
      reason === "changed"
        ? "GitHub identity changed; reload the dashboard and retry."
        : reason === "rate_limited"
          ? "GitHub identity verification is rate limited; wait and retry."
          : reason === "unverified"
            ? "The effective GitHub identity could not be verified; retry or reconnect the agent's GitHub identity."
            : "The selected GitHub credential is unavailable; reconnect the agent's GitHub identity in Settings.",
    );
  }
}

async function prepareSharedGitHubIdentity(
  params: GitHubIdentityPreparation & {
    assertCurrent?: () => void;
  },
) {
  const identity = resolveGitHubToolIdentity(params);
  const managed = identity.source !== "system-detected";
  const hostEnv = params.env ?? process.env;
  const overlay = prepareGitHubToolEnvironment({
    config: params.config,
    sourceConfig: params.sourceConfig,
    agentId: params.agentId,
    env: hostEnv,
  });
  const directScrubEnv = Object.fromEntries(
    Object.keys(overlay.credentialScrubEnv).map((name) => [name, undefined]),
  );
  const currentEnvironment = (): NodeJS.ProcessEnv => ({
    ...(params.env ?? process.env),
    ...directScrubEnv,
    ...overlay.localIdentityEnv,
    GH_PROMPT_DISABLED: "1",
  });
  const env = currentEnvironment();
  const readToken = () =>
    managed
      ? readManagedGitHubToken(identity.profileDir)
      : readNativeGitHubToken(currentEnvironment());
  params.assertCurrent?.();
  const token = await readToken();
  params.assertCurrent?.();
  if (!token) {
    throw new GitHubIdentityError("unavailable");
  }
  const probe = await verifyGitHubCredential(token);
  params.assertCurrent?.();
  if (probe.status !== "available") {
    throw new GitHubIdentityError(probe.status);
  }
  const prepared: PreparedGitHubPublicationIdentity = Object.freeze({
    source: identity.source,
    ...(managed ? { profileId: identity.config.profileId } : {}),
    account: probe.account,
    // Only broker children receive this secret snapshot. Profile retirement or
    // native login changes cannot redirect an already-admitted operation.
    env: Object.freeze({ ...env, GH_TOKEN: token, GITHUB_TOKEN: undefined }),
  });
  return { prepared, token, readToken };
}

/** Publication owns a fixed credential snapshot for its already-admitted operation. */
export async function prepareGitHubPublicationIdentity(
  params: GitHubIdentityPreparation,
): Promise<PreparedGitHubPublicationIdentity> {
  return (await prepareSharedGitHubIdentity(params)).prepared;
}

/** Read authority tracks current selection and token rotation, without exporting a child environment. */
export async function prepareGitHubReadIdentity(
  params: GitHubIdentityPreparation & {
    getCurrentConfig: () => OpenClawConfig;
    assertActive: () => void;
    refresh: () => Promise<void>;
  },
) {
  const selected = resolveGitHubToolIdentity(params);
  const profileId = selected.source === "system-detected" ? undefined : selected.config.profileId;
  const kind = selected.source === "system-detected" ? undefined : selected.config.kind;
  const assertSelected = () => {
    params.assertActive();
    const current = resolveGitHubToolIdentity({ ...params, config: params.getCurrentConfig() });
    if (
      current.source !== selected.source ||
      (current.source !== "system-detected" &&
        (current.config.profileId !== profileId || current.config.kind !== kind))
    ) {
      throw new GitHubIdentityError("changed");
    }
  };
  assertSelected();
  await params.refresh();
  assertSelected();
  const { token, readToken, prepared } = await prepareSharedGitHubIdentity({
    ...params,
    assertCurrent: assertSelected,
  });
  assertSelected();
  return {
    token,
    cacheScope: createHash("sha256")
      .update(JSON.stringify([selected.source, profileId, prepared.account.accountId, token]))
      .digest("hex"),
    assertSelected,
    revalidate: async () => {
      assertSelected();
      const current = await readToken();
      assertSelected();
      if (current !== token) {
        throw new GitHubIdentityError("changed");
      }
    },
  };
}

export async function removeManagedGitHubProfile(profileDir: string): Promise<void> {
  await fs.rm(profileDir, { recursive: true, force: true });
}

function normalizeManagedGitHubToken(token: string): string {
  const normalized = token.trim();
  if (!normalized || normalized.length > 2048 || /\s/u.test(normalized)) {
    throw new Error("Managed GitHub credential must be one non-empty line.");
  }
  registerSecretValueForRedaction(normalized);
  return normalized;
}

async function stageManagedGitHubProfile(parent: string, token: string) {
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  const stagingRoot = await fs.mkdtemp(path.join(parent, ".github-profile.staging-"));
  const stagedProfile = path.join(stagingRoot, "profile");
  try {
    await fs.mkdir(stagedProfile, { mode: 0o700 });
    const credential = normalizeManagedGitHubToken(token);
    const verified = await verifyGitHubCredential(credential);
    if (verified.status !== "available") {
      throw new Error("GitHub could not verify the managed credential.");
    }
    // Match gh's classic-token minimum scopes; fine-grained/integration tokens
    // omit X-OAuth-Scopes, so their repository grants remain unknown.
    const scopes = verified.scopes;
    if (
      scopes.length &&
      (!scopes.includes("repo") ||
        !["read:org", "write:org", "admin:org"].some((scope) => scopes.includes(scope)))
    ) {
      throw new Error("GitHub credential is missing required repo or read:org scopes.");
    }
    // gh's insecure Login still mutates the OS keyring. Materialize its external
    // file contract directly, including schema version to avoid CLI migration.
    await fs.writeFile(
      path.join(stagedProfile, "hosts.yml"),
      stringifyYaml({
        [GITHUB_HOST]: {
          user: verified.account.login,
          oauth_token: credential,
          users: { [verified.account.login]: { oauth_token: credential } },
        },
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(path.join(stagedProfile, "config.yml"), stringifyYaml({ version: "1" }), {
      mode: 0o600,
    });
    return { account: verified.account, stagedProfile, stagingRoot };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Verifies a rotated token, then atomically replaces credentials in one stable profile. */
export async function refreshManagedGitHubProfile(params: {
  profileDir: string;
  token: string;
  expectedAccountId: number;
  assertCurrent?: () => void;
}): Promise<GitHubToolAccount> {
  if (!(await isPrivateManagedGitHubProfile(params.profileDir))) {
    throw new Error("The configured GitHub identity profile is unavailable.");
  }
  const staged = await stageManagedGitHubProfile(path.dirname(params.profileDir), params.token);
  const targetHosts = path.join(params.profileDir, "hosts.yml");
  const replacementHosts = path.join(
    params.profileDir,
    `.hosts.yml.refresh-${randomBytes(16).toString("hex")}`,
  );
  try {
    params.assertCurrent?.();
    if (staged.account.accountId !== params.expectedAccountId) {
      throw new GitHubAccountMismatchError("GitHub OAuth refresh returned a different account.");
    }
    const targetStat = await fs.lstat(targetHosts);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error("The configured GitHub identity profile is unavailable.");
    }
    await fs.copyFile(path.join(staged.stagedProfile, "hosts.yml"), replacementHosts);
    await fs.chmod(replacementHosts, 0o600);
    params.assertCurrent?.();
    await fs.rename(replacementHosts, targetHosts);
    params.assertCurrent?.();
    return staged.account;
  } finally {
    await fs.rm(replacementHosts, { force: true });
    await fs.rm(staged.stagingRoot, { recursive: true, force: true });
  }
}

/** Publishes a new inactive profile and switches config without retiring in-use generations. */
export async function installManagedGitHubProfile(params: {
  profileDir: string;
  token: string;
  commitConfig: (account: GitHubToolAccount) => Promise<void>;
  retainProfileOnCommitFailure?: boolean;
  assertCurrent?: () => void;
}): Promise<GitHubToolAccount> {
  const parent = path.dirname(params.profileDir);
  const staged = await stageManagedGitHubProfile(parent, params.token);
  let published = false;
  let committed = false;
  try {
    params.assertCurrent?.();
    await fs.rename(staged.stagedProfile, params.profileDir);
    published = true;
    params.assertCurrent?.();
    await params.commitConfig(staged.account);
    committed = true;
    return staged.account;
  } finally {
    if (published && !committed && !params.retainProfileOnCommitFailure) {
      await fs.rm(params.profileDir, { recursive: true, force: true });
    }
    await fs.rm(staged.stagingRoot, { recursive: true, force: true });
  }
}
