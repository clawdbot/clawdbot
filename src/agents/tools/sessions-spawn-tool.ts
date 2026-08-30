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
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
} from "../inherited-tool-deny.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { getSubagentDeliveryBacklogPressure } from "../subagents/registry/subagent-registry.js";
import { withParentExecutionIdentity } from "../subagents/spawn/execution-identity-spawn-context.js";
import { resolveAcpSessionsSpawnImageAttachments } from "../subagents/spawn/subagent-attachments.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
} from "../subagents/spawn/subagent-spawn.js";
import { normalizeSubagentTaskName } from "../subagents/spawn/subagent-task-name.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "../subagents/swarm/swarm-code-mode.js";
import { resolveSwarmConfig } from "../subagents/swarm/swarm-config.js";
import {
  describeSessionsSpawnTool,
  describeSubagentSpawnContext,
  SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readNonNegativeIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  recordSessionToolActionFact,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
} from "./sessions-helpers.js";
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
type AcpSpawnModule = typeof import("../subagents/spawn/acp-spawn.js");

const acpSpawnModuleLoader = createLazyImportLoader<AcpSpawnModule>(
  () => import("../subagents/spawn/acp-spawn.js"),
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

function recordAcceptedSessionSpawn(
  result: Record<string, unknown>,
  context: "fork" | "isolated" | undefined,
): void {
  const childSessionKey =
    typeof result.childSessionKey === "string" ? result.childSessionKey.trim() : "";
  const targetAgentId = childSessionKey
    ? parseAgentSessionKey(childSessionKey)?.agentId
    : undefined;
  if (result.status !== "accepted" || !childSessionKey || !targetAgentId || !context) {
    return;
  }
  recordSessionToolActionFact({
    operation: context === "fork" ? "fork" : "create",
    fact: "committed",
    targetAgentId,
    targetSessionKey: childSessionKey,
  });
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
  agentChannel?: string;
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
  subagentThreadAvailable: boolean;
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
    label: Type.Optional(
      Type.String({
        description: "Short task title shown in UI lists; name the work, not the agent.",
      }),
    ),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
      { description: 'Runtime; visible=true requires "subagent".' },
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Per-run timeout in seconds; overrides the configured subagent default. Zero disables the timeout.",
      }),
    ),
    thinking: Type.Optional(
      Type.String({ description: "Thinking override; unavailable with visible=true." }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Child working directory. Visible paths outside configured agent workspaces require operator.admin. Omitted with worktree=true: inherit the same-agent parent managed repository; otherwise use the target agent workspace.",
      }),
    ),
    ...(params.threadAvailable
      ? {
          thread: Type.Optional(
            Type.Boolean({
              description:
                'Bind new chat thread when supported; true defaults mode="session"; unavailable with visible=true.',
            }),
          ),
        }
      : {}),
    mode: optionalStringEnum(spawnModes, {
      description: params.threadAvailable
        ? '"run" one-shot; "session" persistent/thread-bound. Visible sessions accept only omitted/default "run" and remain persistent.'
        : '"run" one-shot. Visible sessions accept omitted/default "run" and remain persistent.',
    }),
    cleanup: optionalStringEnum(["delete", "keep"] as const, {
      description: "Hidden session cleanup; visible=true always keeps the session.",
    }),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES, {
      description: '"inherit" parent sandbox policy; "require" fails unless child is sandboxed.',
    }),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description: describeSubagentSpawnContext(params.subagentThreadAvailable),
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description: "Light bootstrap; subagent only; unavailable with visible=true.",
      }),
    ),
    ...(params.swarmEnabled
      ? {
          collect: Type.Optional(
            Type.Boolean({
              description: "Swarm collector child for parallel fan-out.",
            }),
          ),
          outputSchema: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "JSON Schema for the child's structured result; requires collect=true.",
            }),
          ),
          fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
          groupId: Type.Optional(
            Type.String({
              description: "Groups parallel collector children; requires collect=true.",
            }),
          ),
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
        {
          maxItems: 50,
          description: "Inline snapshots; visible=true accepts only an empty array.",
        },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object(
        {
          // Where the spawned agent should look for attachments.
          // Kept as a hint; implementation materializes into the child workspace.
          mountPath: Type.Optional(Type.String()),
        },
        {
          description:
            "Attachment mount hint; visible=true accepts only an omitted or blank mountPath.",
        },
      ),
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
    agentChannel?: string;
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
    /** Backend-derived parent incarnation; never sourced from model arguments. */
    expectedParentSessionId?: string;
    signal?: AbortSignal;
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
  const visibilityCfg = opts?.config ?? getRuntimeConfig();
  const sessionToolsVisibility = resolveEffectiveSessionToolsVisibility({
    cfg: visibilityCfg,
    sandboxed: opts?.sandboxed === true,
  });
  const { restrictToSpawned } = resolveSandboxedSessionToolContext({
    cfg: visibilityCfg,
    agentSessionKey: opts?.agentSessionKey,
    requesterAgentId,
    sandboxed: opts?.sandboxed,
  });
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: acpAvailable
      ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
      : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool({
      acpAvailable,
      threadAvailable,
      subagentThreadAvailable: threadAvailability.subagent,
      swarmEnabled: swarmConfig.enabled,
      sessionToolsVisibility,
      spawnRestricted: restrictToSpawned,
    }),
    parameters: createSessionsSpawnToolSchema({
      acpAvailable,
      threadAvailable,
      subagentThreadAvailable: threadAvailability.subagent,
      swarmEnabled: swarmConfig.enabled,
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<PropertyKey, unknown>;
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
          `sessions_spawn does not support "${unsupportedParam}"; remove channel-delivery parameters.`,
        );
      }
      const unsupportedTimeoutParam = resolveSnakeCaseParamKey(params, "timeoutSeconds");
      if (unsupportedTimeoutParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedTimeoutParam}". Use "runTimeoutSeconds" for a per-run timeout.`,
        );
      }
      const task = readToolStringParam(params, "task", { required: true });
      const runTimeoutSeconds = readNonNegativeIntegerParam(params, "runTimeoutSeconds");
      const taskNameResult = normalizeSubagentTaskName(params.taskName);
      if (taskNameResult.error) {
        return jsonResult({
          status: "error",
          error: taskNameResult.error,
        });
      }
      const taskName = taskNameResult.taskName;
      const label = readToolStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      if (collect && runtime === "acp") {
        throw new ToolInputError('sessions_spawn collect=true supports runtime="subagent" only.');
      }
      const requestedAgentId = readToolStringParam(params, "agentId");
      const resumeSessionId = readToolStringParam(params, "resumeSessionId");
      const modelOverride = normalizeToolModelOverride(readToolStringParam(params, "model"));
      const thinkingOverrideRaw = readToolStringParam(params, "thinking");
      const cwd = readToolStringParam(params, "cwd");
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
      const deliveryPressure = getSubagentDeliveryBacklogPressure();
      if (deliveryPressure.blocked) {
        return jsonResult({
          status: "forbidden",
          error: `sessions_spawn is paused because ${deliveryPressure.suspended} completed tasks have blocked delivery. Run openclaw tasks list, then retry or dismiss blocked deliveries.`,
          ...roleContext,
        });
      }
      const expectedParentSessionKey = opts?.agentSessionKey?.trim();
      if (opts?.expectedParentSessionId && !expectedParentSessionKey) {
        throw new Error("Exact parent session access requires a session key");
      }
      const spawnVisible = async () =>
        await maybeSpawnVisibleSession({
          raw: params,
          task,
          taskName,
          label,
          runtime,
          requestedAgentId,
          runTimeoutSeconds,
          sandbox,
          options: opts,
        });
      const visibleResult = opts?.expectedParentSessionId
        ? await runWithScopedSessionAccess({
            cfg: visibilityCfg,
            expectedSessionId: opts.expectedParentSessionId,
            ...(opts.signal ? { signal: opts.signal } : {}),
            targetSessionKey: expectedParentSessionKey!,
            run: spawnVisible,
          })
        : await spawnVisible();
      if (visibleResult) {
        recordAcceptedSessionSpawn(visibleResult, context ?? "isolated");
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
      const parentExecutionIdentityToken = getGatewayToolCallerIdentity()?.executionIdentityToken;

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
            ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            cleanup,
            expectsCompletionMessage,
            streamTo,
            attachments: acpAttachments?.attachments,
          },
          withParentExecutionIdentity(
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
            parentExecutionIdentityToken,
          ),
        );
        recordAcceptedSessionSpawn(result, "isolated");
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
          ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
          collect: hasCollectParam ? collect : undefined,
          outputSchema:
            params.outputSchema && typeof params.outputSchema === "object"
              ? (params.outputSchema as Record<string, unknown>)
              : undefined,
          fastMode:
            params.fastMode === true || params.fastMode === false || params.fastMode === "auto"
              ? params.fastMode
              : undefined,
          groupId: readToolStringParam(params, "groupId"),
          swarmLaunchReplayKey:
            typeof params[SWARM_CODE_MODE_IDEMPOTENCY_KEY] === "string"
              ? params[SWARM_CODE_MODE_IDEMPOTENCY_KEY]
              : undefined,
          swarmLaunchRequestFingerprint:
            typeof params[SWARM_CODE_MODE_REQUEST_FINGERPRINT] === "string"
              ? params[SWARM_CODE_MODE_REQUEST_FINGERPRINT]
              : undefined,
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
              ? readToolStringParam(params.attachAs as Record<string, unknown>, "mountPath")
              : undefined,
        },
        withParentExecutionIdentity(
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
            sessionPermissionPolicy: opts?.sessionPermissionPolicy,
            inheritedToolAllowlist: opts?.inheritedToolAllowlist,
            inheritedToolDenylist: opts?.inheritedToolDenylist,
            requesterRunId: opts?.requesterRunId,
          },
          parentExecutionIdentityToken,
        ),
      );

      recordAcceptedSessionSpawn(result, result.context);
      return jsonResult(addRoleToFailureResult(result, requestedAgentId));
    },
  };
}
