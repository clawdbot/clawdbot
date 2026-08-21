import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import {
  ErrorCodes,
  errorShape,
  validateAgentCollectorSpawnParams,
  type AgentCollectorSpawnParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  buildFactoryNativeLaunchAuthority,
  canonicalizeFactoryNativeAuthorityManifest,
  FACTORY_AUTHORITY_PROFILE_ID,
  FACTORY_NATIVE_DYNAMIC_TOOLS,
  FACTORY_EXPLICIT_TOOL_DENY,
  prepareFactoryNativeAttemptPaths,
  resolveFactoryNativeAttemptPaths,
  resolveFactoryNativeGitMetadataRoot,
} from "../../agents/factory-authority-profile.js";
import { getSubagentRunsByRunIds } from "../../agents/subagent-registry.js";
import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import {
  buildSwarmReplayRunId,
  failSwarmReplayLaunch,
  readSwarmReplayLaunch,
  reserveSwarmReplayLaunch,
  waitForSwarmReplayLaunch,
  type SwarmReplayAcceptedIdentity,
} from "../../agents/swarm-replay-ledger.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { isLoopbackAddress } from "../net.js";
import { isAuthorizedFactoryControllerPrincipal } from "./factory-controller-principal.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type NormalizedAgentCollectorSpawn = {
  requesterSessionKey: string;
  task: string;
  groupId: string;
  cwd: string;
  gitMetadataRoot: string;
  nativeReadRoots: string[];
  nativePathEntries: string[];
  nativeEnvironment: Record<string, string>;
  agentId?: string;
  label?: string;
  model?: string;
  thinking?: string;
  fastMode?: boolean | "auto";
  outputSchema?: Record<string, unknown>;
  runTimeoutSeconds?: number;
  authorityProfileId: string;
  worktreeFenceToken: string;
  worktreeOwnershipGeneration: number;
};

function normalizeSpawnParams(params: AgentCollectorSpawnParams): NormalizedAgentCollectorSpawn {
  return {
    requesterSessionKey: params.requesterSessionKey.trim(),
    task: params.task.trim(),
    groupId: params.groupId.trim(),
    cwd: path.resolve(params.cwd.trim()),
    gitMetadataRoot: path.resolve(params.gitMetadataRoot.trim()),
    nativeReadRoots: [
      ...new Set(params.nativeReadRoots.map((root) => path.resolve(root.trim()))),
    ].sort(),
    nativePathEntries: params.nativePathEntries.map((entry) => path.resolve(entry.trim())),
    nativeEnvironment: Object.fromEntries(
      Object.entries(params.nativeEnvironment).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    ...(params.agentId?.trim() ? { agentId: params.agentId.trim() } : {}),
    ...(params.label?.trim() ? { label: params.label.trim() } : {}),
    ...(params.model?.trim() ? { model: params.model.trim() } : {}),
    ...(params.thinking?.trim() ? { thinking: params.thinking.trim() } : {}),
    ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    ...(params.outputSchema ? { outputSchema: params.outputSchema } : {}),
    ...(params.runTimeoutSeconds !== undefined
      ? { runTimeoutSeconds: params.runTimeoutSeconds }
      : {}),
    authorityProfileId: params.authorityProfileId.trim(),
    worktreeFenceToken: params.worktreeFenceToken.trim(),
    worktreeOwnershipGeneration: params.worktreeOwnershipGeneration,
  };
}

function acceptedCollectorResponse(identity: SwarmReplayAcceptedIdentity, replayed: boolean) {
  return {
    status: "accepted" as const,
    runId: identity.runId,
    childSessionKey: identity.sessionKey,
    sessionKey: identity.sessionKey,
    agentId: identity.agentId,
    requesterSessionId: identity.requesterSessionId,
    ...(identity.requesterLifecycleRevision
      ? { requesterLifecycleRevision: identity.requesterLifecycleRevision }
      : {}),
    replayKey: identity.replayKey,
    requestFingerprint: identity.requestFingerprint,
    launchIdentityDigest: identity.launchIdentityDigest,
    authorityProfileId: identity.authority.authorityProfileId,
    worktreeFenceToken: identity.authority.worktreeFenceToken,
    worktreeOwnershipGeneration: identity.authority.worktreeOwnershipGeneration,
    authority: identity.authority,
    replayed,
  };
}

export function buildAgentCollectorSpawnRequestFingerprint(
  params: NormalizedAgentCollectorSpawn,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableStringify(params)).digest("hex")}`;
}

async function resolveAllowedFactoryCwd(params: {
  requestedCwd: string;
  roots: Array<string | undefined>;
}): Promise<{ cwd: string; root: string } | undefined> {
  const cwd = await fs.realpath(params.requestedCwd).catch(() => undefined);
  if (!cwd) {
    return undefined;
  }
  for (const candidate of params.roots) {
    if (!candidate?.trim() || !path.isAbsolute(candidate)) {
      continue;
    }
    const root = await fs.realpath(candidate).catch(() => undefined);
    if (!root) {
      continue;
    }
    const relative = path.relative(root, cwd);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return { cwd, root };
    }
  }
  return undefined;
}

export const agentCollectorSpawnHandler: GatewayRequestHandlers["agent.collector.spawn"] = async ({
  params,
  client,
  respond,
  sessionMutationAuthorization,
  signal,
  context,
}) => {
  if (
    !assertValidParams(params, validateAgentCollectorSpawnParams, "agent.collector.spawn", respond)
  ) {
    return;
  }
  if (!client?.transportRemoteIp || !isLoopbackAddress(client.transportRemoteIp)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, "agent.collector.spawn is restricted to loopback clients"),
    );
    return;
  }
  if (
    !isAuthorizedFactoryControllerPrincipal({
      client,
      credential: params.factoryCredential,
    })
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.FORBIDDEN,
        "agent.collector.spawn requires the dedicated factory controller principal",
      ),
    );
    return;
  }

  const normalized = normalizeSpawnParams(params);
  const requesterIdentity = parseAgentSessionKey(normalized.requesterSessionKey);
  if (
    !requesterIdentity ||
    !normalized.task ||
    !normalized.groupId ||
    !path.isAbsolute(params.cwd)
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "agent.collector.spawn requires a canonical requester session, non-empty task/group, and absolute cwd",
      ),
    );
    return;
  }
  const session = loadSessionEntryReadOnly({
    sessionKey: normalized.requesterSessionKey,
    agentId: requesterIdentity.agentId,
  });
  if (!session) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "requester session does not exist"),
    );
    return;
  }
  const allowedCwd = await resolveAllowedFactoryCwd({
    requestedCwd: normalized.cwd,
    roots: [session.spawnedCwd, session.spawnedWorkspaceDir],
  });
  if (!allowedCwd) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.FORBIDDEN,
        "cwd must stay inside the requester session's bound workspace",
      ),
    );
    return;
  }
  const targetAgentId = normalized.agentId ?? requesterIdentity.agentId;
  const runtimeConfig = context.getRuntimeConfig();
  const targetWorkspace = await fs
    .realpath(resolveAgentWorkspaceDir(runtimeConfig, targetAgentId))
    .catch(() => undefined);
  const authorityProfileValid =
    process.platform === "darwin" &&
    normalized.authorityProfileId === FACTORY_AUTHORITY_PROFILE_ID &&
    targetWorkspace === allowedCwd.root &&
    allowedCwd.cwd === allowedCwd.root;
  if (!authorityProfileValid) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.FORBIDDEN,
        "factory_native_build_v1 requires macOS, the exact target-agent worktree, and Codex app-server's attested native permissions profile",
      ),
    );
    return;
  }
  const publicRunId = buildSwarmReplayRunId(
    normalized.requesterSessionKey,
    params.replayKey.trim(),
  );
  const factoryPaths = resolveFactoryNativeAttemptPaths(publicRunId);
  let nativeManifest: Awaited<ReturnType<typeof canonicalizeFactoryNativeAuthorityManifest>>;
  let gitMetadataRoot: string;
  try {
    [nativeManifest, gitMetadataRoot] = await Promise.all([
      canonicalizeFactoryNativeAuthorityManifest({
        readableRoots: normalized.nativeReadRoots,
        pathEntries: normalized.nativePathEntries,
        environment: normalized.nativeEnvironment,
        factoryStateRoot: factoryPaths.factoryStateRoot,
      }),
      resolveFactoryNativeGitMetadataRoot({
        cwd: allowedCwd.cwd,
        requestedRoot: normalized.gitMetadataRoot,
      }),
    ]);
  } catch (error) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.FORBIDDEN,
        error instanceof Error ? error.message : "factory native manifest is invalid",
      ),
    );
    return;
  }
  const canonicalRequest = {
    ...normalized,
    cwd: allowedCwd.cwd,
    nativeReadRoots: nativeManifest.readableRoots,
    nativePathEntries: nativeManifest.pathEntries,
    nativeEnvironment: nativeManifest.environment,
    gitMetadataRoot,
  };
  const expectedFingerprint = buildAgentCollectorSpawnRequestFingerprint(canonicalRequest);
  if (params.requestFingerprint !== expectedFingerprint) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "requestFingerprint does not match the launch payload",
      ),
    );
    return;
  }

  sessionMutationAuthorization?.assertCurrent();
  const currentRequester = loadSessionEntryReadOnly({
    sessionKey: canonicalRequest.requesterSessionKey,
    agentId: requesterIdentity.agentId,
  });
  if (
    !currentRequester ||
    currentRequester.sessionId !== session.sessionId ||
    currentRequester.lifecycleRevision !== session.lifecycleRevision
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "requester session changed before collector launch"),
    );
    return;
  }
  const replayKey = params.replayKey.trim();
  let preparedFactoryPaths;
  try {
    preparedFactoryPaths = await prepareFactoryNativeAttemptPaths(publicRunId);
  } catch (error) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "factory native scratch setup failed",
        { retryable: true },
      ),
    );
    return;
  }
  const authority = buildFactoryNativeLaunchAuthority({
    cwd: canonicalRequest.cwd,
    workspaceRoot: allowedCwd.root,
    paths: preparedFactoryPaths,
    manifest: nativeManifest,
    gitMetadataRoot,
    worktreeFenceToken: canonicalRequest.worktreeFenceToken,
    worktreeOwnershipGeneration: canonicalRequest.worktreeOwnershipGeneration,
  });
  const reservation = reserveSwarmReplayLaunch({
    requesterSessionKey: canonicalRequest.requesterSessionKey,
    requesterSessionId: session.sessionId,
    ...(session.lifecycleRevision ? { requesterLifecycleRevision: session.lifecycleRevision } : {}),
    replayKey,
    requestFingerprint: expectedFingerprint,
    publicRunId,
    authority,
  });
  if (reservation.status === "conflict") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, reservation.error));
    return;
  }
  if (reservation.status === "failed") {
    respond(true, { status: "error", error: reservation.error, runId: publicRunId });
    return;
  }
  if (reservation.status === "expired") {
    respond(true, {
      status: "error",
      error: "collector replay key is expired and permanently tombstoned",
      runId: reservation.runId,
    });
    return;
  }
  if (reservation.status === "accepted") {
    respond(true, acceptedCollectorResponse(reservation.identity, true));
    return;
  }
  if (reservation.status === "pending") {
    const joined = await waitForSwarmReplayLaunch({
      requesterSessionKey: canonicalRequest.requesterSessionKey,
      replayKey,
      ...(signal ? { signal } : {}),
    });
    if (joined.status === "accepted") {
      respond(true, acceptedCollectorResponse(joined.identity, true));
      return;
    }
    if (joined.status === "conflict") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, joined.error));
      return;
    }
    if (joined.status === "expired") {
      respond(true, {
        status: "error",
        error: "collector replay key is expired and permanently tombstoned",
        runId: joined.runId,
      });
      return;
    }
    respond(true, {
      status: "error",
      error: joined.status === "failed" ? joined.error : "collector replay join failed",
      runId: publicRunId,
    });
    return;
  }

  let spawn;
  try {
    spawn = await spawnSubagentDirect(
      {
        task: canonicalRequest.task,
        collect: true,
        mode: "run",
        cleanup: "keep",
        sandbox: "inherit",
        groupId: canonicalRequest.groupId,
        cwd: canonicalRequest.cwd,
        swarmLaunchReplayKey: replayKey,
        swarmLaunchRequestFingerprint: expectedFingerprint,
        swarmRequesterSessionId: session.sessionId,
        ...(session.lifecycleRevision
          ? { swarmRequesterLifecycleRevision: session.lifecycleRevision }
          : {}),
        swarmLaunchAuthority: authority,
        ...(canonicalRequest.agentId ? { agentId: canonicalRequest.agentId } : {}),
        ...(canonicalRequest.label ? { label: canonicalRequest.label } : {}),
        ...(canonicalRequest.model ? { model: canonicalRequest.model } : {}),
        ...(canonicalRequest.thinking ? { thinking: canonicalRequest.thinking } : {}),
        ...(canonicalRequest.fastMode !== undefined ? { fastMode: canonicalRequest.fastMode } : {}),
        ...(canonicalRequest.outputSchema ? { outputSchema: canonicalRequest.outputSchema } : {}),
        ...(canonicalRequest.runTimeoutSeconds !== undefined
          ? { runTimeoutSeconds: canonicalRequest.runTimeoutSeconds }
          : {}),
      },
      {
        agentSessionKey: canonicalRequest.requesterSessionKey,
        completionOwnerKey: canonicalRequest.requesterSessionKey,
        requesterAgentIdOverride: requesterIdentity.agentId,
        requesterRunId: canonicalRequest.groupId,
        workspaceDir: allowedCwd.root,
        inheritedToolAllowlist: [...FACTORY_NATIVE_DYNAMIC_TOOLS],
        inheritedToolDenylist: [...FACTORY_EXPLICIT_TOOL_DENY],
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failSwarmReplayLaunch({
      requesterSessionKey: canonicalRequest.requesterSessionKey,
      replayKey,
      requestFingerprint: expectedFingerprint,
      error: message,
    });
    respond(true, { status: "error", error: message, runId: publicRunId });
    return;
  }
  if (spawn.status !== "accepted" || !spawn.runId || !spawn.childSessionKey) {
    failSwarmReplayLaunch({
      requesterSessionKey: canonicalRequest.requesterSessionKey,
      replayKey,
      requestFingerprint: expectedFingerprint,
      error: spawn.error || "collector launch was not accepted",
    });
    respond(true, spawn);
    return;
  }
  const entry = getSubagentRunsByRunIds([spawn.runId]).entries.get(spawn.runId);
  const entryPublicRunId = entry?.swarmRunId ?? entry?.runId;
  const resolvedAgentId = entry ? resolveAgentIdFromSessionKey(entry.childSessionKey) : undefined;
  if (
    !entry?.collect ||
    entryPublicRunId !== spawn.runId ||
    entry.childSessionKey !== spawn.childSessionKey ||
    !resolvedAgentId
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "collector registration could not be verified", {
        retryable: true,
      }),
    );
    return;
  }
  const persisted = readSwarmReplayLaunch(canonicalRequest.requesterSessionKey, replayKey);
  const identity = persisted?.identity;
  if (
    (persisted?.status !== "accepted" && persisted?.status !== "terminal") ||
    !identity?.sessionKey ||
    !identity.agentId ||
    !identity.launchIdentityDigest ||
    identity.runId !== entryPublicRunId ||
    identity.sessionKey !== entry.childSessionKey ||
    identity.agentId !== resolvedAgentId
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "collector replay identity was not durably accepted", {
        retryable: true,
      }),
    );
    return;
  }
  respond(
    true,
    acceptedCollectorResponse(
      {
        ...identity,
        sessionKey: identity.sessionKey,
        agentId: identity.agentId,
        launchIdentityDigest: identity.launchIdentityDigest,
      },
      spawn.replayed === true,
    ),
  );
};
