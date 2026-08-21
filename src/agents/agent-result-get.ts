import type { SwarmLaunchAuthority, SwarmTerminalEvidence } from "./subagent-registry.types.js";
import { readSwarmReplayLaunch } from "./swarm-replay-ledger.js";

export type AgentResultGetStatus =
  | "ok"
  | "result_missing"
  | "not_terminal"
  | "expired"
  | "not_found";

export type AgentResultGetResponse = {
  status: AgentResultGetStatus;
  runId: string;
  sessionKey: string;
  agentId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterLifecycleRevision?: string;
  taskId?: string;
  replayKey: string;
  requestFingerprint: `sha256:${string}`;
  launchIdentityDigest: `sha256:${string}`;
  authorityProfileId: string;
  worktreeFenceToken: string;
  worktreeOwnershipGeneration: number;
  authority?: SwarmLaunchAuthority;
  evidenceContractVersion?: 1;
  schemaContractVersion?: SwarmTerminalEvidence["schemaContractVersion"];
  schemaHash?: `sha256:${string}`;
  structured?: unknown;
  contentHash?: `sha256:${string}`;
  endedAt?: number;
  frozenAt?: number;
  runtime?: SwarmTerminalEvidence["runtime"];
  outcome?: SwarmTerminalEvidence["outcome"];
  usage?: SwarmTerminalEvidence["usage"];
};

type AgentResultGetRequest = {
  runId: string;
  sessionKey: string;
  agentId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterLifecycleRevision?: string;
  replayKey: string;
  requestFingerprint: `sha256:${string}`;
  launchIdentityDigest: `sha256:${string}`;
  authorityProfileId: string;
  worktreeFenceToken: string;
  worktreeOwnershipGeneration: number;
  taskId?: string;
  now?: number;
};

function matchesExactReceipt(
  params: AgentResultGetRequest,
  launch: NonNullable<ReturnType<typeof readSwarmReplayLaunch>>,
): boolean {
  const { identity } = launch;
  return (
    identity.runId === params.runId &&
    identity.sessionKey === params.sessionKey &&
    identity.agentId === params.agentId &&
    identity.requesterSessionKey === params.requesterSessionKey &&
    identity.requesterSessionId === params.requesterSessionId &&
    identity.requesterLifecycleRevision === params.requesterLifecycleRevision &&
    identity.replayKey === params.replayKey &&
    identity.requestFingerprint === params.requestFingerprint &&
    identity.launchIdentityDigest === params.launchIdentityDigest &&
    identity.authority.authorityProfileId === params.authorityProfileId &&
    identity.authority.worktreeFenceToken === params.worktreeFenceToken &&
    identity.authority.worktreeOwnershipGeneration === params.worktreeOwnershipGeneration
  );
}

function terminalEvidenceFields(evidence: SwarmTerminalEvidence) {
  return {
    requesterSessionId: evidence.requesterSessionId,
    ...(evidence.requesterLifecycleRevision
      ? { requesterLifecycleRevision: evidence.requesterLifecycleRevision }
      : {}),
    authority: evidence.authority,
    evidenceContractVersion: evidence.evidenceContractVersion,
    schemaContractVersion: evidence.schemaContractVersion,
    schemaHash: evidence.schemaHash,
    endedAt: evidence.endedAt,
    frozenAt: evidence.frozenAt,
    runtime: evidence.runtime,
    outcome: evidence.outcome,
    ...(evidence.usage ? { usage: evidence.usage } : {}),
  };
}

/**
 * Resolves only producer-frozen replay evidence. Mutable registry/session state is
 * intentionally excluded so a later mutation cannot rewrite a completed result.
 */
export async function resolveAgentResultGet(
  params: AgentResultGetRequest,
): Promise<AgentResultGetResponse> {
  const taskId = params.taskId?.trim() || undefined;
  const responseIdentity = {
    runId: params.runId.trim(),
    sessionKey: params.sessionKey.trim(),
    agentId: params.agentId.trim(),
    requesterSessionKey: params.requesterSessionKey.trim(),
    requesterSessionId: params.requesterSessionId.trim(),
    ...(params.requesterLifecycleRevision?.trim()
      ? { requesterLifecycleRevision: params.requesterLifecycleRevision.trim() }
      : {}),
    ...(taskId ? { taskId } : {}),
    replayKey: params.replayKey.trim(),
    requestFingerprint: params.requestFingerprint,
    launchIdentityDigest: params.launchIdentityDigest,
    authorityProfileId: params.authorityProfileId.trim(),
    worktreeFenceToken: params.worktreeFenceToken.trim(),
    worktreeOwnershipGeneration: params.worktreeOwnershipGeneration,
  };
  if (Object.values(responseIdentity).some((value) => value === "")) {
    return { status: "not_found", ...responseIdentity };
  }

  const normalizedRequest = {
    ...params,
    ...responseIdentity,
    taskId,
  };
  const now = params.now ?? Date.now();
  const launch = readSwarmReplayLaunch(
    responseIdentity.requesterSessionKey,
    responseIdentity.replayKey,
    { now },
  );
  if (!launch || !matchesExactReceipt(normalizedRequest, launch)) {
    return { status: "not_found", ...responseIdentity };
  }
  if (launch.expiresAt !== undefined && launch.expiresAt <= now) {
    return { status: "expired", ...responseIdentity };
  }
  if (launch.status === "reserved" || launch.status === "accepted") {
    return { status: "not_terminal", ...responseIdentity };
  }
  if (launch.status !== "terminal" || !launch.terminalEvidence) {
    return { status: "not_found", ...responseIdentity };
  }

  const evidence = launch.terminalEvidence;
  if ((taskId ?? undefined) !== evidence.taskId) {
    return { status: "not_found", ...responseIdentity };
  }
  const frozen = terminalEvidenceFields(evidence);
  if (!evidence.result) {
    return { status: "result_missing", ...responseIdentity, ...frozen };
  }
  let structured: unknown;
  try {
    structured = JSON.parse(evidence.result.canonicalJson) as unknown;
  } catch {
    return { status: "not_found", ...responseIdentity };
  }
  return {
    status: "ok",
    ...responseIdentity,
    ...frozen,
    structured,
    contentHash: evidence.result.contentHash,
  };
}
