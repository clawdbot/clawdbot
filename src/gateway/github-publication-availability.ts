import type { GitHubPublicationPublisher } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  type PreparedGitHubPublicationIdentity,
} from "../agents/github-tool-identity.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/config.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import {
  GitHubPublicationWorkspaceChangedError,
  GitHubPublicationSessionChangedError,
  rejectGitHubPublicationSelection,
  type GitHubPublicationPreparation,
} from "./github-publication-failure.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

function publicationConfigSnapshot() {
  const active = getActiveSecretsRuntimeConfigSnapshot();
  if (active) {
    return active;
  }
  const config = getRuntimeConfig();
  return { config, sourceConfig: config };
}

export function assertExpectedSharedGitHubPublisher(
  expected: GitHubPublicationPublisher | undefined,
  actual: GitHubPublicationPublisher,
  preparation?: GitHubPublicationPreparation,
): void {
  if (
    actual.source === "personal" ||
    (expected &&
      (expected.source !== actual.source ||
        expected.accountId !== actual.accountId ||
        expected.login.toLowerCase() !== actual.login.toLowerCase()))
  ) {
    rejectGitHubPublicationSelection(
      "GitHub publication identity changed; review the current shared account and try again.",
      preparation,
    );
  }
}

export function currentGitHubPublicationConfig() {
  return publicationConfigSnapshot().config;
}

export async function prepareCurrentGitHubPublicationIdentity(
  agentId: string,
): Promise<PreparedGitHubPublicationIdentity> {
  await requestCurrentGitHubOAuthRefresh(agentId);
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
  });
}

export function matchesCurrentGitHubPublicationIdentity(params: {
  agentId: string;
  identity: PreparedGitHubPublicationIdentity;
}): boolean {
  return matchesPreparedGitHubPublicationIdentity({
    config: currentGitHubPublicationConfig(),
    ...params,
  });
}

type PublicationSessionIdentity = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string | null;
};
type ExpectedWorktree = { worktreeId: string; repositoryFingerprint: string; branch: string };

function readPublicationSessionOwner(params: PublicationSessionIdentity) {
  const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  const entry = loaded.entry;
  if (
    loaded.agentId !== params.agentId ||
    loaded.canonicalKey !== params.sessionKey ||
    entry?.sessionId !== params.sessionId ||
    entry.archivedAt !== undefined ||
    (params.lifecycleRevision !== undefined &&
      (entry.lifecycleRevision ?? null) !== params.lifecycleRevision)
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  return { ...loaded, entry };
}

function readPublicationWorktreeOwner(
  loaded: ReturnType<typeof readPublicationSessionOwner>,
  expected?: ExpectedWorktree,
) {
  const entry = loaded.entry;
  const worktree = managedWorktrees.findLiveByOwner("session", loaded.canonicalKey);
  if (
    !entry.worktree?.id ||
    !worktree ||
    worktree.id !== entry.worktree.id ||
    worktree.ownerKind !== "session" ||
    worktree.ownerId !== loaded.canonicalKey ||
    worktree.branch !== entry.worktree.branch ||
    worktree.repoRoot !== entry.worktree.repoRoot
  ) {
    throw new Error("GitHub publication session worktree owner changed.");
  }
  if (
    expected &&
    (worktree.id !== expected.worktreeId ||
      worktree.repoFingerprint !== expected.repositoryFingerprint ||
      worktree.branch !== expected.branch)
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication workspace authority changed.",
    );
  }
  return { loaded, worktree };
}

export function resolveGitHubPublicationWorktreeOwner(
  params: PublicationSessionIdentity & { expected?: ExpectedWorktree },
) {
  return readPublicationWorktreeOwner(readPublicationSessionOwner(params), params.expected);
}

export function resolveGitHubPublicationWorkspaceOwner(params: PublicationSessionIdentity) {
  const loaded = readPublicationSessionOwner(params);
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  if (!workspaceId) {
    return { kind: "worktree" as const, ...readPublicationWorktreeOwner(loaded) };
  }
  const workspace = getSessionRepositoryWorkspaceStore().get(workspaceId);
  if (
    !workspace ||
    workspace.agentId !== params.agentId ||
    workspace.sessionKey !== params.sessionKey
  ) {
    throw new Error("GitHub publication session repository owner changed.");
  }
  return { kind: "repository" as const, loaded, workspace };
}

export function sameGitHubPublicationWorkspace(
  first: ReturnType<typeof resolveGitHubPublicationWorkspaceOwner>,
  current: ReturnType<typeof resolveGitHubPublicationWorkspaceOwner>,
): boolean {
  if (first.loaded.entry?.lifecycleRevision !== current.loaded.entry?.lifecycleRevision) {
    return false;
  }
  return first.kind === "repository"
    ? current.kind === "repository" &&
        current.workspace.workspaceId === first.workspace.workspaceId &&
        current.workspace.url === first.workspace.url &&
        current.workspace.branch === first.workspace.branch
    : current.kind === "worktree" &&
        current.worktree.id === first.worktree.id &&
        current.worktree.repoFingerprint === first.worktree.repoFingerprint &&
        current.worktree.branch === first.worktree.branch;
}

export function resolveLocalGitHubPublicationWorktreeOwner(row: {
  request_id: string;
  identity_source: string;
  session_id: string;
  session_key: string;
  agent_id: string;
  worktree_id: string;
  repository_fingerprint: string;
  branch: string;
}) {
  const lifecycle = readGitHubPublicationSessionLifecycle({
    publicationKind: row.identity_source === "personal" ? "personal" : "shared",
    requestId: row.request_id,
  });
  if (!lifecycle) {
    throw new GitHubPublicationSessionChangedError();
  }
  return resolveGitHubPublicationWorktreeOwner({
    sessionId: row.session_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    lifecycleRevision: lifecycle.lifecycle_revision,
    expected: {
      worktreeId: row.worktree_id,
      repositoryFingerprint: row.repository_fingerprint,
      branch: row.branch,
    },
  });
}

export async function prepareGitHubPublicationAvailability(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
}): Promise<boolean> {
  try {
    if (params.assertCurrent?.() === false) {
      return false;
    }
    const initial = resolveGitHubPublicationWorkspaceOwner(params);
    const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId);
    if (params.assertCurrent?.() === false) {
      return false;
    }
    return (
      sameGitHubPublicationWorkspace(initial, resolveGitHubPublicationWorkspaceOwner(params)) &&
      matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })
    );
  } catch {
    return false;
  }
}
