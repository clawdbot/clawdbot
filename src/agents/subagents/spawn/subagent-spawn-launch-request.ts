import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import type { BootstrapContextMode } from "../../bootstrap-files.js";
import { normalizeSpawnedRunMetadata } from "../../spawned-context.js";
import { buildSubagentInitialUserMessage } from "./subagent-initial-user-message.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import { resolveSubagentAgentGatewayTimeoutMs } from "./subagent-spawn-gateway.js";
import { AGENT_LANE_SUBAGENT } from "./subagent-spawn.runtime.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export function buildSubagentLaunchRequest(params: {
  childDepth: number;
  maxSpawnDepth: number;
  spawnMode: SpawnSubagentMode;
  task: string;
  spawnedByKey: string;
  toolSpawnMetadata: Parameters<typeof normalizeSpawnedRunMetadata>[0];
  spawnedWorkspaceDir?: string;
  childSessionKey: string;
  collect: boolean;
  childSessionOrigin?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  childIdem: string;
  deliverInitialChildRunDirectly: boolean;
  outputSchema?: Record<string, unknown>;
  childSystemPrompt: string;
  thinkingOverride?: string;
  runTimeoutSeconds: number;
  label?: string;
  lightContext: boolean;
  expectsCompletionMessage: boolean;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  launchAuthorization?: SubagentLaunchAuthorization;
  swarmSchedulerGroupKey?: string;
  swarmMaxConcurrent: number;
}): {
  childLaunch: {
    request: Record<string, unknown>;
    authorization?: SubagentLaunchAuthorization;
    timeoutMs: number;
  };
  queuedLaunch?: {
    request: Record<string, unknown>;
    authorization?: SubagentLaunchAuthorization;
    timeoutMs: number;
    schedulerGroupKey: string;
    maxConcurrent: number;
  };
  progressOrigin: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
    channelId?: string;
    messageId?: string | number;
  };
  shouldAnnounceCompletion: boolean;
  spawnedMetadata: ReturnType<typeof normalizeSpawnedRunMetadata>;
} {
  const bootstrapContextMode: BootstrapContextMode | undefined = params.lightContext
    ? "lightweight"
    : undefined;
  const childTaskMessage = buildSubagentInitialUserMessage({
    childDepth: params.childDepth,
    maxSpawnDepth: params.maxSpawnDepth,
    persistentSession: params.spawnMode === "session",
    task: params.task,
  });
  const spawnedMetadata = normalizeSpawnedRunMetadata({
    spawnedBy: params.spawnedByKey,
    ...params.toolSpawnMetadata,
    workspaceDir: params.spawnedWorkspaceDir,
  });
  const {
    spawnedBy: _spawnedBy,
    workspaceDir: _workspaceDir,
    ...publicSpawnedMetadata
  } = spawnedMetadata;
  const request: Record<string, unknown> = {
    message: childTaskMessage,
    sessionKey: params.childSessionKey,
    ...(params.collect
      ? {}
      : {
          channel: params.childSessionOrigin?.channel,
          to: params.childSessionOrigin?.to ?? undefined,
          accountId: params.childSessionOrigin?.accountId ?? undefined,
          threadId:
            params.childSessionOrigin?.threadId != null
              ? stringifyRouteThreadId(params.childSessionOrigin.threadId)
              : undefined,
        }),
    idempotencyKey: params.childIdem,
    deliver: params.deliverInitialChildRunDirectly,
    lane: AGENT_LANE_SUBAGENT,
    disableMessageTool: true,
    swarmCollector: params.collect,
    swarmOutputSchema: params.outputSchema,
    cleanupBundleMcpOnRunEnd: params.spawnMode !== "session",
    extraSystemPrompt: params.childSystemPrompt,
    thinking: params.thinkingOverride,
    timeout: params.runTimeoutSeconds,
    label: params.label,
    ...(bootstrapContextMode
      ? {
          bootstrapContextMode,
          bootstrapContextRunKind: "default" as const,
        }
      : {}),
    ...publicSpawnedMetadata,
  };
  const childLaunch = {
    request,
    ...(params.launchAuthorization ? { authorization: params.launchAuthorization } : {}),
    timeoutMs: resolveSubagentAgentGatewayTimeoutMs(params.runTimeoutSeconds),
  };
  const queuedLaunch =
    params.collect && params.swarmSchedulerGroupKey
      ? {
          ...childLaunch,
          schedulerGroupKey: params.swarmSchedulerGroupKey,
          maxConcurrent: params.swarmMaxConcurrent,
        }
      : undefined;
  return {
    childLaunch,
    queuedLaunch,
    progressOrigin: {
      channel: params.requesterOrigin?.channel,
      accountId: params.requesterOrigin?.accountId,
      to: params.currentMessagingTarget ?? params.requesterOrigin?.to,
      threadId: params.requesterOrigin?.threadId,
      channelId: params.currentChannelId,
      messageId: params.currentMessageId,
    },
    shouldAnnounceCompletion: params.deliverInitialChildRunDirectly
      ? false
      : params.expectsCompletionMessage,
    spawnedMetadata,
  };
}
