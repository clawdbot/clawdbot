// Gateway tool invocation engine.
// Shared implementation behind HTTP and RPC tool invocation adapters.
import type { Result } from "@openclaw/normalization-core/result";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { resolveToolLoopDetectionConfig } from "../agents/agent-tools.js";
import { getChannelAgentToolMeta } from "../agents/channel-tools.js";
import { isKnownCoreToolId } from "../agents/tool-catalog.js";
import {
  AUTOMATIONS_TOOL_NAME,
  isAutomationsToolName,
} from "../agents/tools/automations-tool-name.js";
import { ToolInputError, type AnyAgentTool } from "../agents/tools/common.js";
import {
  normalizeConversationReadInvocationOrigin,
  type ConversationReadInvocationOrigin,
} from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { isTestDefaultMemorySlotDisabled } from "../plugins/config-state.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionStoreEntryProtected,
} from "../sessions/agent-harness-session-key.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  authorizeResolvedSessionMutation,
  resolveSessionSharingTarget,
} from "./session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
type RegisterRunCleanup = NonNullable<
  Parameters<typeof resolveGatewayScopedTools>[0]["registerRunCleanup"]
>;

/** Protocol input shape accepted by gateway tool invocation surfaces. */
export type ToolsInvokeInput = {
  tool?: unknown;
  name?: unknown;
  action?: unknown;
  args?: unknown;
  sessionKey?: unknown;
  agentId?: unknown;
  idempotencyKey?: unknown;
  dryRun?: unknown;
};

type ToolsInvokeErrorType = "invalid_request" | "not_found" | "tool_call_blocked" | "tool_error";

type ToolsInvokeOutcome =
  | {
      ok: true;
      status: 200;
      toolName: string;
      source: "core" | "plugin" | "channel";
      result: unknown;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 500;
      toolName: string;
      error: {
        type: ToolsInvokeErrorType;
        message: string;
        requiresApproval?: boolean;
      };
    };

function resolveSessionTarget(params: { cfg: OpenClawConfig; input: ToolsInvokeInput }) {
  const rawSessionKey = normalizeOptionalString(params.input.sessionKey) ?? "main";
  const resolved = resolveRequestedSessionAgentId(
    params.cfg,
    rawSessionKey,
    normalizeOptionalString(params.input.agentId),
  );
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true as const,
    agentId: resolved.agentId,
    sessionKey: resolveStoredSessionKeyForAgentStore({
      cfg: params.cfg,
      agentId: resolved.agentId,
      sessionKey: rawSessionKey,
    }),
  };
}

function resolveMemoryToolDisableReasons(cfg: OpenClawConfig): string[] {
  if (!process.env.VITEST) {
    return [];
  }
  const reasons: string[] = [];
  const plugins = cfg.plugins;
  const slotRaw = plugins?.slots?.memory;
  const slotDisabled = slotRaw === null || normalizeOptionalLowercaseString(slotRaw) === "none";
  const pluginsDisabled = plugins?.enabled === false;
  const defaultDisabled = isTestDefaultMemorySlotDisabled(cfg);

  if (pluginsDisabled) {
    reasons.push("plugins.enabled=false");
  }
  if (slotDisabled) {
    reasons.push(slotRaw === null ? "plugins.slots.memory=null" : 'plugins.slots.memory="none"');
  }
  if (!pluginsDisabled && !slotDisabled && defaultDisabled) {
    reasons.push("memory plugin disabled by test default");
  }
  return reasons;
}

function mergeActionIntoArgsIfSupported(params: {
  toolSchema: unknown;
  action: string | undefined;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const { toolSchema, action, args } = params;
  if (!action || args.action !== undefined) {
    return args;
  }
  const schemaObj = toolSchema as { properties?: Record<string, unknown> } | null;
  const hasAction = Boolean(
    schemaObj &&
    typeof schemaObj === "object" &&
    schemaObj.properties &&
    "action" in schemaObj.properties,
  );
  return hasAction ? { ...args, action } : args;
}

function resolveToolInputErrorStatus(err: unknown): number | null {
  if (err instanceof ToolInputError) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : 400;
  }
  if (typeof err !== "object" || err === null || !("name" in err)) {
    return null;
  }
  const name = (err as { name?: unknown }).name;
  if (name !== "ToolInputError" && name !== "ToolAuthorizationError") {
    return null;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    return status;
  }
  return name === "ToolAuthorizationError" ? 403 : 400;
}

function resolveToolSource(tool: AnyAgentTool): "core" | "plugin" | "channel" {
  if (getPluginToolMeta(tool)) {
    return "plugin";
  }
  if (getChannelAgentToolMeta(tool as never)) {
    return "channel";
  }
  return "core";
}

type InvokeGatewayToolParams = {
  cfg: OpenClawConfig;
  input: ToolsInvokeInput;
  messageChannel?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string;
  authenticatedUserProfile?: GatewayClient["authenticatedUserProfile"];
  /** Host-minted authority from the calling connection; never derived from wire params. */
  operatorRoleActor?: NonNullable<GatewayClient["internal"]>["operatorRoleActor"];
  operatorScopes?: readonly string[];
  senderIsOwner?: boolean;
  clientCaps?: string[];
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  toolCallIdPrefix: string;
  approvalMode?: "request" | "report";
  signal?: AbortSignal;
};

async function invokeGatewayToolWithSignal(
  params: InvokeGatewayToolParams & {
    signal: AbortSignal;
    toolName: string;
    registerRunCleanup: RegisterRunCleanup;
  },
): Promise<ToolsInvokeOutcome> {
  const { toolName } = params;
  const conversationReadOrigin = normalizeConversationReadInvocationOrigin(
    params.conversationReadOrigin,
  );

  if (process.env.VITEST && MEMORY_TOOL_NAMES.has(toolName)) {
    const reasons = resolveMemoryToolDisableReasons(params.cfg);
    if (reasons.length > 0) {
      const suffix = ` (${reasons.join(", ")})`;
      return {
        ok: false,
        status: 400,
        toolName,
        error: {
          type: "invalid_request",
          message:
            `memory tools are disabled in tests${suffix}. ` +
            `Enable by setting plugins.slots.memory="${defaultSlotIdForKey("memory")}" (and ensure plugins.enabled is not false).`,
        },
      };
    }
  }

  const knownCoreTool = isKnownCoreToolId(toolName);
  const gatewayRequestedTools = knownCoreTool ? [] : [toolName];

  const action = normalizeOptionalString(params.input.action);
  const argsRaw = params.input.args;
  const args =
    argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {};
  const sessionTarget = resolveSessionTarget({ cfg: params.cfg, input: params.input });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      status: 400,
      toolName,
      error: { type: "invalid_request", message: sessionTarget.error.message },
    };
  }
  const { agentId: selectedAgentId, sessionKey } = sessionTarget;
  const authenticatedUserProfile = params.cfg.gateway?.roles
    ? params.authenticatedUserProfile
    : undefined;
  const withAuthority = <T>(operation: () => Promise<T>): Promise<T> =>
    authenticatedUserProfile
      ? withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile,
            operatorRoleActor: params.operatorRoleActor,
            scopes: params.operatorScopes ?? [],
          },
          operation,
        )
      : operation();
  // HTTP and RPC auth boundaries supply authority independently of profile attribution.
  const client = createSyntheticPluginRuntimeClient({
    ...(authenticatedUserProfile ? { authenticatedUserProfile } : {}),
    operatorRoleActor: params.operatorRoleActor,
    scopes: params.senderIsOwner ? [ADMIN_SCOPE] : [...(params.operatorScopes ?? [])],
  });
  const primarySessionAuthorizationError = authorizeResolvedSessionMutation({
    cfg: params.cfg,
    client,
    sessionKey,
    agentId: selectedAgentId,
  });
  if (primarySessionAuthorizationError) {
    return {
      ok: false,
      status: 403,
      toolName,
      error: {
        type: "tool_call_blocked",
        message: primarySessionAuthorizationError.message,
      },
    };
  }
  if (authenticatedUserProfile && (toolName === "sessions_spawn" || toolName === "sessions_send")) {
    const nestedSessionKey = normalizeOptionalString(args.sessionKey);
    const nestedAgentId = normalizeOptionalString(args.agentId);
    const targetAgent = nestedSessionKey
      ? resolveRequestedSessionAgentId(params.cfg, nestedSessionKey, nestedAgentId)
      : undefined;
    if (targetAgent && !targetAgent.ok) {
      return {
        ok: false,
        status: 400,
        toolName,
        error: { type: "invalid_request", message: targetAgent.error.message },
      };
    }
    const targetAgentId = targetAgent?.agentId ?? nestedAgentId ?? selectedAgentId;
    const existingTarget =
      toolName === "sessions_send" && nestedSessionKey
        ? resolveSessionSharingTarget({
            cfg: params.cfg,
            sessionKey: nestedSessionKey,
            agentId: targetAgentId,
          })
        : null;
    const authorizationError =
      (toolName === "sessions_send" && nestedSessionKey
        ? authorizeResolvedSessionMutation({
            cfg: params.cfg,
            client,
            sessionKey: nestedSessionKey,
            agentId: targetAgentId,
          })
        : null) ??
      (!existingTarget
        ? authorizeGatewaySessionCreation({
            cfg: params.cfg,
            client,
            agentId: targetAgentId,
          })
        : null);
    if (authorizationError) {
      return {
        ok: false,
        status: 403,
        toolName,
        error: { type: "tool_call_blocked", message: authorizationError.message },
      };
    }
  }
  const sessionEntry = loadGatewaySessionEntryReadOnly(sessionKey, {
    agentId: selectedAgentId,
  }).entry;
  if (
    isAgentHarnessSessionKey(sessionKey) &&
    (!sessionEntry || isAgentHarnessSessionStoreEntryProtected(sessionKey, sessionEntry))
  ) {
    return {
      ok: false,
      status: 400,
      toolName,
      error: {
        type: "invalid_request",
        message: AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
      },
    };
  }
  const resolveTools = (disablePluginTools: boolean) =>
    resolveGatewayScopedTools({
      cfg: params.cfg,
      sessionKey,
      sessionId: sessionEntry?.sessionId,
      agentId: selectedAgentId,
      messageProvider: params.messageChannel,
      accountId: params.accountId,
      agentTo: params.agentTo,
      agentThreadId: params.agentThreadId,
      senderIsOwner: params.senderIsOwner,
      clientCaps: params.clientCaps,
      conversationReadOrigin,
      allowGatewaySubagentBinding: true,
      allowMediaInvokeCommands: true,
      surface: "http",
      registerRunCleanup: (cleanup) => {
        params.registerRunCleanup((reason) => withAuthority(() => cleanup(reason)));
      },
      disablePluginTools,
      gatewayRequestedTools,
    });

  let { agentId, tools, workspaceDir } = resolveTools(knownCoreTool);
  if (knownCoreTool && !tools.some((candidate) => candidate.name === toolName)) {
    ({ agentId, tools, workspaceDir } = resolveTools(false));
  }
  const requestedAgentId = normalizeOptionalString(params.input.agentId);
  if (requestedAgentId && agentId && requestedAgentId !== agentId) {
    return {
      ok: false,
      status: 400,
      toolName,
      error: {
        type: "invalid_request",
        message: `agent id "${requestedAgentId}" does not match session agent "${agentId}"`,
      },
    };
  }
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return {
      ok: false,
      status: 404,
      toolName,
      error: { type: "not_found", message: `Tool not available: ${toolName}` },
    };
  }

  const idempotencyKey = normalizeOptionalString(params.input.idempotencyKey);
  const toolCallId = idempotencyKey
    ? `${params.toolCallIdPrefix}-${conversationReadOrigin}-${idempotencyKey}`
    : `${params.toolCallIdPrefix}-${conversationReadOrigin}-${Date.now()}`;
  const toolArgs = mergeActionIntoArgsIfSupported({
    toolSchema: tool.parameters,
    action,
    args,
  });
  const hookResult = await runBeforeToolCallHook({
    toolName,
    params: toolArgs,
    toolCallId,
    ctx: {
      agentId,
      config: params.cfg,
      sessionKey,
      workspaceDir,
      loopDetection: resolveToolLoopDetectionConfig({ cfg: params.cfg, agentId }),
    },
    signal: params.signal,
    approvalMode: params.approvalMode,
  });
  if (hookResult.blocked) {
    return {
      ok: false,
      status: 403,
      toolName,
      error: {
        type: "tool_call_blocked",
        message: hookResult.reason,
        requiresApproval: hookResult.deniedReason === "plugin-approval",
      },
    };
  }
  params.signal.throwIfAborted();
  const result = await withAuthority(async () =>
    tool.execute?.(toolCallId, hookResult.params, params.signal),
  );
  return {
    ok: true,
    status: 200,
    toolName,
    source: resolveToolSource(tool),
    result,
  };
}

/** Resolves, authorizes, and invokes one gateway-visible core/plugin/channel tool. */
export async function invokeGatewayTool(
  params: InvokeGatewayToolParams,
): Promise<ToolsInvokeOutcome> {
  const requestedToolName = normalizeOptionalString(params.input.name ?? params.input.tool) ?? "";
  // "cron" is a permanently accepted inbound alias (RFC 0026). Normalize it
  // before dispatch so execution and cleanup failures report the same tool.
  const toolName = isAutomationsToolName(requestedToolName)
    ? AUTOMATIONS_TOOL_NAME
    : requestedToolName;
  if (!toolName) {
    return {
      ok: false,
      status: 400,
      toolName,
      error: { type: "invalid_request", message: "tools.invoke requires name" },
    };
  }
  const runCleanups: Array<Parameters<RegisterRunCleanup>[0]> = [];
  const requestAbort = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, requestAbort.signal])
    : requestAbort.signal;
  let outcome: Result<ToolsInvokeOutcome, unknown>;
  try {
    const value = await invokeGatewayToolWithSignal({
      ...params,
      signal,
      toolName,
      registerRunCleanup: (cleanup) => {
        runCleanups.push(cleanup);
      },
    });
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    // This endpoint constructs one tool bundle per request. Fence it before
    // cleanup, and do not acknowledge success while its resources remain owned.
    requestAbort.abort();
  }
  const cleanupReason = params.signal?.aborted
    ? "cancel"
    : outcome.ok && outcome.value.ok
      ? "completion"
      : "error";
  const cleanupResults = await Promise.allSettled(
    runCleanups.map(async (cleanup) => cleanup(cleanupReason)),
  );
  const cleanupErrors = cleanupResults.flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (cleanupErrors.length > 0) {
    if (!outcome.ok) {
      cleanupErrors.unshift(outcome.error);
    }
    outcome = {
      ok: false,
      error: new AggregateError(cleanupErrors, "Tool execution cleanup failed"),
    };
  }
  if (outcome.ok) {
    return outcome.value;
  }
  const inputStatus = resolveToolInputErrorStatus(outcome.error);
  if (inputStatus !== null) {
    return {
      ok: false,
      status: inputStatus === 403 ? 403 : 400,
      toolName,
      error: {
        type: "tool_error",
        message: formatErrorMessage(outcome.error) || "invalid tool arguments",
      },
    };
  }
  if (!params.signal?.aborted || cleanupErrors.length > 0) {
    logWarn(`tools-invoke: tool execution failed: ${formatErrorMessage(outcome.error)}`);
  }
  const message =
    cleanupErrors.length > 0
      ? "tool cleanup failed; inspect current state before retrying"
      : "tool execution failed";
  return {
    ok: false,
    status: 500,
    toolName,
    error: { type: "tool_error", message },
  };
}
