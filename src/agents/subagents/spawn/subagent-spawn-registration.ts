import type { SubagentAttachmentStagingBoundary } from "./subagent-spawn-attachment-boundary.js";
import type { SpawnSubagentParams } from "./subagent-spawn-contract.js";
import type { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";

type LaunchRequest = ReturnType<typeof buildSubagentLaunchRequest>;

export function buildSubagentSpawnRegistration(params: {
  runId: string;
  request: SpawnSubagentParams;
  launch: LaunchRequest;
  queued: boolean;
  launchCleanupPending: boolean;
  requesterTurnRunId?: string;
  childSessionKey: string;
  controllerSessionKey: string;
  requesterSessionKey: string;
  requesterDisplayKey: string;
  requesterOrigin?: LaunchRequest["progressOrigin"];
  task: string;
  taskName?: string;
  targetAgentId: string;
  requesterAgentId: string;
  cleanup: "delete" | "keep";
  label?: string;
  resolvedModel?: string;
  targetAgentDir?: string;
  runTimeoutSeconds: number;
  spawnMode: "run" | "session";
  swarmRequesterSessionKey?: string;
  swarmGroupId?: string;
  swarmLaunchReplayKey?: string;
  attachmentBoundary: SubagentAttachmentStagingBoundary;
  attachmentAbsDir?: string;
  attachmentRootDir?: string;
  attachmentSandboxDir?: string;
  retainAttachmentsOnKeep: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
}) {
  const { launch, request } = params;
  return {
    runId: params.runId,
    requesterTurnRunId: params.requesterTurnRunId,
    childSessionKey: params.childSessionKey,
    controllerSessionKey: params.controllerSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin: params.requesterOrigin,
    progressOrigin: launch.progressOrigin,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    taskName: params.taskName,
    agentId: params.targetAgentId,
    requesterAgentId: params.requesterAgentId,
    cleanup: params.cleanup,
    label: params.label,
    model: params.resolvedModel,
    agentDir: params.targetAgentDir,
    workspaceDir: launch.spawnedMetadata.workspaceDir,
    runTimeoutSeconds: params.runTimeoutSeconds,
    expectsCompletionMessage: launch.shouldAnnounceCompletion,
    spawnMode: params.spawnMode,
    collect: request.collect === true,
    swarmRequesterSessionKey: request.collect ? params.swarmRequesterSessionKey : undefined,
    swarmLaunchIdempotencyKey: request.collect ? params.runId : undefined,
    swarmLaunchReplayKey: request.collect ? params.swarmLaunchReplayKey : undefined,
    swarmLaunchRequestFingerprint: request.collect
      ? request.swarmLaunchRequestFingerprint
      : undefined,
    outputSchema: request.outputSchema,
    groupId: params.swarmGroupId,
    queuedLaunch: launch.queuedLaunch,
    queued: params.queued,
    launchCleanupPending: params.launchCleanupPending,
    launchCleanupSessionIdentity:
      params.launchCleanupPending && params.expectedSessionId && params.expectedLifecycleRevision
        ? {
            sessionId: params.expectedSessionId,
            lifecycleRevision: params.expectedLifecycleRevision,
          }
        : undefined,
    attachmentsDir: params.attachmentAbsDir,
    attachmentsRootDir: params.attachmentRootDir,
    attachmentsSandboxSessionKey: params.attachmentBoundary.sandboxOwner?.sessionKey,
    attachmentsSandboxAgentId: params.attachmentBoundary.sandboxOwner?.agentId,
    attachmentsSandboxWorkspaceDir: params.attachmentBoundary.sandboxOwner?.workspaceDir,
    attachmentsSandboxIdentity: params.attachmentBoundary.sandboxOwner?.identity,
    attachmentsSandboxDir: params.attachmentBoundary.sandboxOwner
      ? params.attachmentSandboxDir
      : undefined,
    retainAttachmentsOnKeep: params.retainAttachmentsOnKeep,
  };
}
