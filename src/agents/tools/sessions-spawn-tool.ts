/**
 * sessions_spawn built-in tool.
 *
 * Starts subagent or ACP-backed sessions with inherited tool policy and delivery context.
 */
import { Type } from "typebox";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import {
  resolveThreadBindingSpawnPolicy,
  supportsAutomaticThreadBindingSpawn,
} from "../../channels/thread-bindings-policy.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
} from "../inherited-tool-deny.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { resolveAcpSessionsSpawnImageAttachments } from "../subagent-attachments.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
} from "../subagent-spawn.js";
import { normalizeSubagentTaskName } from "../subagent-task-name.js";
import { resolveSwarmConfig } from "../swarm-config.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readStringParam,
  ToolInputError,
} from "./common.js";
import {
  maybeSpawnVisibleSession,
  type VisibleSessionsSpawnDeps,
  VISIBLE_SESSIONS_SPAWN_SCHEMA,
} from "./sessions-spawn-visible.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;
const UNSUPPORTED_SESSIONS_SPAWN_TIMEOUT_PARAM_KEYS = [
  "runTimeoutSeconds",
  "timeoutSeconds",
] as const;

type AcpSpawnModule = typeof import("../acp-spawn.js");

const acpSpawnModuleLoader = createLazyImportLoader<AcpSpawnModule>(
  () => import("../acp-spawn.js"),
);

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  return await acpSpawnModuleLoader.load();
}

function addRoleToFailureResult<T extends { status: string }>(
  result: T,
  role: string | undefined,
): T | (T & { role: string }) {
  if (!role || (result.status !== "error" && result.status !== "forbidden")) {
    return result;
  }
  return { ...result, role };
}

type SessionsSpawnThreadAvailability = {
  subagent: boolean;
  acp: boolean;
};

function hasAnyThreadAvailability(availability: SessionsSpawnThreadAvailability): boolean {
  return availability.subagent || availability.acp;
}

function resolveSessionsSpawnThreadAvailability(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
}): SessionsSpawnThreadAvailability {
  const channel = opts?.agentChannel;
  const cfg = opts?.config;
  if (!channel || !cfg || !supportsAutomaticThreadBindingSpawn(channel)) {
    return { subagent: false, acp: false };
  }
  const resolve = (kind: "subagent" | "acp") => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg,
      channel,
      accountId: opts?.agentAccountId,
      kind,
    });
    return policy.enabled && policy.spawnEnabled;
  };
  return {
    subagent: resolve("subagent"),
    acp: resolve("acp"),
  };
}

function createSessionsSpawnToolSchema(params: {
  acpAvailable: boolean;
  threadAvailable: boolean;
  swarmEnabled: boolean;
}) {
  const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : (["run"] as const);
  const schema = {
    task: Type.String(),
    taskName: Type.Optional(
      Type.String({
        description:
          "Stable later-target alias; starts lowercase letter; then lowercase/digit/_/-.",
      }),
    ),
    label: Type.Optional(Type.String()),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    ...(params.threadAvailable
      ? {
          thread: Type.Optional(
            Type.Boolean({
              description: 'Bind new chat thread when supported; true defaults mode="session".',
            }),
          ),
        }
      : {}),
    mode: optionalStringEnum(spawnModes),
    cleanup: optionalStringEnum(["delete", "keep"] as const),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description: "Native: omit/isolated clean; fork only needing requester transcript.",
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description: "Light bootstrap; subagent only.",
      }),
    ),
    ...(params.swarmEnabled
      ? {
          collect: Type.Optional(Type.Boolean()),
          outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
          groupId: Type.Optional(Type.String()),
        }
      : {}),
    ...VISIBLE_SESSIONS_SPAWN_SCHEMA,

    // Inline attachments (snapshot-by-value).
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.String(),
          encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
          mimeType: Type.Optional(Type.String()),
        }),
        { maxItems: 50 },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object({
        // Where the spawned agent should look for attachments.
        // Kept as a hint; implementation materializes into the child workspace.
        mountPath: Type.Optional(Type.String()),
      }),
    ),
    ...(params.acpAvailable
      ? {
          resumeSessionId: Type.Optional(
            Type.String({
              description: "ACP resume id already recorded for requester; ignored by subagent.",
            }),
          ),
          streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, {
            description: 'ACP only; "parent" streams turn to requester. Ignored by subagent.',
          }),
        }
      : {}),
  };
  return Type.Object(schema);
}

function resolveAcpUnavailableMessage(opts?: { sandboxed?: boolean; config?: OpenClawConfig }) {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    requesterTurnRunId?: string;
    /** Separate key used only for completion routing (registerSubagentRun requesterSessionKey). */
    completionOwnerKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    currentMessagingTarget?: string;
    currentChannelId?: string;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
    requesterRunId?: string;
    swarmCollector?: boolean;
  } & VisibleSessionsSpawnDeps &
    SpawnedToolContext,
): AnyAgentTool {
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: opts?.config,
    sandboxed: opts?.sandboxed,
  });
  const threadAvailability = resolveSessionsSpawnThreadAvailability(opts);
  const threadAvailable = hasAnyThreadAvailability(threadAvailability);
  const requesterAgentId =
    opts?.requesterAgentIdOverride ?? parseAgentSessionKey(opts?.agentSessionKey)?.agentId;
  const swarmConfig = resolveSwarmConfig(opts?.config, requesterAgentId);
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: acpAvailable
      ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
      : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool({ acpAvailable, threadAvailable }),
    parameters: createSessionsSpawnToolSchema({
      acpAvailable,
      threadAvailable,
      swarmEnabled: swarmConfig.enabled,
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      if (opts?.swarmCollector && params.collect !== true) {
        throw new ToolInputError(
          "sessions_spawn from a collector requires collect=true so approvals stay non-interactive.",
        );
      }
      const swarmParam = ["collect", "outputSchema", "fastMode", "groupId"].find((key) =>
        Object.hasOwn(params, key),
      );
      if (swarmParam && !swarmConfig.enabled) {
        throw new ToolInputError(
          `sessions_spawn parameter "${swarmParam}" requires tools.swarm.enabled=true.`,
        );
      }
      const hasCollectParam = Object.hasOwn(params, "collect");
      const collect = params.collect === true;
      if (params.outputSchema !== undefined && !collect) {
        throw new ToolInputError('sessions_spawn "outputSchema" requires collect=true.');
      }
      if (params.groupId !== undefined && !collect) {
        throw new ToolInputError('sessions_spawn "groupId" requires collect=true.');
      }
      if (
        collect &&
        (params.thread === true || params.visible === true || params.mode === "session")
      ) {
        throw new ToolInputError(
          "sessions_spawn collect=true does not support thread, visible, or session mode.",
        );
      }
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const unsupportedTimeoutParam = UNSUPPORTED_SESSIONS_SPAWN_TIMEOUT_PARAM_KEYS.find((key) =>
        resolveSnakeCaseParamKey(params, key),
      );
      if (unsupportedTimeoutParam) {
        const providedTimeoutParam =
          resolveSnakeCaseParamKey(params, unsupportedTimeoutParam) ?? unsupportedTimeoutParam;
        throw new ToolInputError(
          `sessions_spawn does not support per-call "${providedTimeoutParam}". Configure agents.defaults.subagents.runTimeoutSeconds instead.`,
        );
      }
      const task = readStringParam(params, "task", { required: true });
      const taskNameResult = normalizeSubagentTaskName(params.taskName);
      if (taskNameResult.error) {
        return jsonResult({
          status: "error",
          error: taskNameResult.error,
        });
      }
      const taskName = taskNameResult.taskName;
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      if (collect && runtime === "acp") {
        throw new ToolInputError('sessions_spawn collect=true supports runtime="subagent" only.');
      }
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = normalizeToolModelOverride(readStringParam(params, "model"));
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const expectsCompletionMessage = collect ? false : params.expectsCompletionMessage !== false;
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const context =
        params.context === "fork" || params.context === "isolated" ? params.context : undefined;
      const streamTo = runtime === "acp" && params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      const roleContext = requestedAgentId ? { role: requestedAgentId } : {};
      const visibleResult = await maybeSpawnVisibleSession({
        raw: params,
        task,
        taskName,
        label,
        runtime,
        requestedAgentId,
        sandbox,
        options: opts,
      });
      if (visibleResult) {
        return jsonResult(
          addRoleToFailureResult(visibleResult as { status: string }, requestedAgentId),
        );
      }
      if (runtime === "acp" && !acpAvailable) {
        return jsonResult({
          status: "error",
          error: resolveAcpUnavailableMessage(opts),
          ...roleContext,
        });
      }
      const acpUnsupportedInheritedTool =
        runtime === "acp"
          ? findAcpUnsupportedInheritedToolDeny(opts?.inheritedToolDenylist)
          : undefined;
      if (acpUnsupportedInheritedTool) {
        return jsonResult({
          status: "forbidden",
          error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
          ...roleContext,
        });
      }
      const acpUnsupportedInheritedAllow =
        runtime === "acp"
          ? findAcpUnsupportedInheritedToolAllow(opts?.inheritedToolAllowlist)
          : undefined;
      if (acpUnsupportedInheritedAllow) {
        return jsonResult({
          status: "forbidden",
          error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
          ...roleContext,
        });
      }
      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
      if (runtime === "acp" && context === "fork") {
        throw new Error('context="fork" is only supported for runtime="subagent".');
      }
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;

      if (runtime === "acp") {
        const { spawnAcpDirect } = await loadAcpSpawnModule();
        const acpAttachments = resolveAcpSessionsSpawnImageAttachments({
          config: opts?.config ?? getRuntimeConfig(),
          attachments,
        });
        if (acpAttachments?.status === "forbidden" || acpAttachments?.status === "error") {
          return jsonResult({
            status: acpAttachments.status,
            error: acpAttachments.error,
            ...roleContext,
          });
        }
        const result = await spawnAcpDirect(
          {
            task,
            taskName,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            model: modelOverride,
            thinking: thinkingOverrideRaw,
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            cleanup,
            expectsCompletionMessage,
            streamTo,
            attachments: acpAttachments?.attachments,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            requesterTurnRunId: opts?.requesterTurnRunId,
            completionOwnerKey: opts?.completionOwnerKey,
            requesterAgentIdOverride: opts?.requesterAgentIdOverride,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            currentMessagingTarget: opts?.currentMessagingTarget,
            currentChannelId: opts?.currentChannelId,
            currentMessageId: opts?.currentMessageId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            agentGroupSpace: opts?.agentGroupSpace,
            agentMemberRoleIds: opts?.agentMemberRoleIds,
            sandboxed: opts?.sandboxed,
            inheritedToolAllowlist: opts?.inheritedToolAllowlist,
            inheritedToolDenylist: opts?.inheritedToolDenylist,
          },
        );
        return jsonResult(addRoleToFailureResult(result, requestedAgentId));
      }

      const result = await spawnSubagentDirect(
        {
          task,
          taskName,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          collect: hasCollectParam ? collect : undefined,
          outputSchema:
            params.outputSchema && typeof params.outputSchema === "object"
              ? (params.outputSchema as Record<string, unknown>)
              : undefined,
          fastMode:
            params.fastMode === true || params.fastMode === false || params.fastMode === "auto"
              ? params.fastMode
              : undefined,
          groupId: readStringParam(params, "groupId"),
          cwd,
          thread,
          mode,
          cleanup,
          sandbox,
          context,
          lightContext,
          expectsCompletionMessage,
          attachments,
          attachMountPath:
            params.attachAs && typeof params.attachAs === "object"
              ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
              : undefined,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          requesterTurnRunId: opts?.requesterTurnRunId,
          completionOwnerKey: opts?.completionOwnerKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          currentMessagingTarget: opts?.currentMessagingTarget ?? opts?.currentChannelId,
          currentChannelId: opts?.currentChannelId,
          currentMessageId: opts?.currentMessageId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
          inheritedToolAllowlist: opts?.inheritedToolAllowlist,
          inheritedToolDenylist: opts?.inheritedToolDenylist,
          requesterRunId: opts?.requesterRunId,
        },
      );

      return jsonResult(addRoleToFailureResult(result, requestedAgentId));
    },
  };
}
