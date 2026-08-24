import {
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  type PreparedGitHubPublicationIdentity,
} from "../agents/github-tool-identity.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/config.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

function publicationConfigSnapshot() {
  const active = getActiveSecretsRuntimeConfigSnapshot();
  if (active) {
    return active;
  }
  const config = getRuntimeConfig();
  return { config, sourceConfig: config };
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

export function resolveGitHubPublicationWorktreeOwner(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  expected?: { worktreeId: string; repositoryFingerprint: string; branch: string };
}) {
  const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  const entry = loaded.entry;
  const worktree = managedWorktrees.findLiveByOwner("session", loaded.canonicalKey);
  if (
    loaded.agentId !== params.agentId ||
    loaded.canonicalKey !== params.sessionKey ||
    entry?.sessionId !== params.sessionId ||
    entry.archivedAt !== undefined ||
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
    params.expected &&
    (worktree.id !== params.expected.worktreeId ||
      worktree.repoFingerprint !== params.expected.repositoryFingerprint ||
      worktree.branch !== params.expected.branch)
  ) {
    throw new Error("GitHub publication workspace authority changed.");
  }
  return { loaded, worktree };
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
    resolveGitHubPublicationWorktreeOwner(params);
    const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId);
    if (params.assertCurrent?.() === false) {
      return false;
    }
    resolveGitHubPublicationWorktreeOwner(params);
    return matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity });
  } catch {
    return false;
  }
}
