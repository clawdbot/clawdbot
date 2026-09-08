import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import type { BootstrapContextMode } from "../../bootstrap-files.js";
import { normalizeSpawnedRunMetadata } from "../../spawned-context.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import { resolveSubagentAgentGatewayTimeoutMs } from "./subagent-spawn-gateway.js";
import { AGENT_LANE_SUBAGENT } from "./subagent-spawn.runtime.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import type { SubagentCompletionMode } from "./subagent-system-prompt.js";

export function buildSubagentLaunchRequest(params: {
  completionMode: SubagentCompletionMode;
  spawnMode: SpawnSubagentMode;
  message: string;
  spawnedByKey: string;
  toolSpawnMetadata: Parameters<typeof normalizeSpawnedRunMetadata>[0];
  spawnedWorkspaceDir?: string;
  childSessionKey: string;
  childSessionOrigin?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  childIdem: string;
  outputSchema?: Record<string, unknown>;
  childSystemPrompt: string;
  thinkingOverride?: string;
  runTimeoutSeconds: number;
  lightContext: boolean;
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
  spawnedMetadata: ReturnType<typeof normalizeSpawnedRunMetadata>;
} {
  const bootstrapContextMode: BootstrapContextMode | undefined = params.lightContext
    ? "lightweight"
    : undefined;
  const collect = params.completionMode === "collector";
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
    message: params.message,
    sessionKey: params.childSessionKey,
    ...(collect
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
    deliver: params.completionMode === "thread-direct",
    lane: AGENT_LANE_SUBAGENT,
    disableMessageTool: true,
    swarmCollector: collect,
    swarmOutputSchema: params.outputSchema,
    cleanupBundleMcpOnRunEnd: params.spawnMode !== "session",
    extraSystemPrompt: params.childSystemPrompt,
    thinking: params.thinkingOverride,
    timeout: params.runTimeoutSeconds,
    // Creation owns the label; delayed launches must preserve operator renames.
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
    collect && params.swarmSchedulerGroupKey
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
    spawnedMetadata,
  };
}
