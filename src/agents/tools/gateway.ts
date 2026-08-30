/**
 * Gateway call helpers for built-in tools.
 *
 * Resolves gateway URL/token overrides, local credentials, and least-privilege operator scopes.
 */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { getRuntimeConfig, resolveGatewayPort } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createAgentRuntimeExecutionLineageHandoff,
  readAgentRuntimeExecutionLineage,
} from "../../gateway/agent-runtime-execution-lineage.js";
import { mintAgentRuntimeIdentityToken } from "../../gateway/agent-runtime-identity-token.js";
import { callGateway } from "../../gateway/call.js";
import { resolveGatewayCredentialsFromConfig, trimToUndefined } from "../../gateway/credentials.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import {
  resolveLeastPrivilegeOperatorScopesForMethod,
  type OperatorScope,
} from "../../gateway/method-scopes.js";
import { getOperatorApprovalRuntimeToken } from "../../gateway/operator-approval-runtime-token.js";
import { getActiveAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "../../infra/device-identity.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPositiveIntegerParam, readToolStringParam } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { getGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import { getGatewaySessionSpawnParentExecutionIdentityToken } from "./gateway-session-spawn-execution-identity.js";

/** Optional gateway connection overrides accepted by agent tools. */
export type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

type GatewayOverrideTarget = "local" | "remote";

/** Reads common gateway options from tool parameters while preserving explicit token whitespace. */
export function readGatewayCallOptions(params: Record<string, unknown>): GatewayCallOptions {
  return {
    gatewayUrl: readToolStringParam(params, "gatewayUrl", { trim: false }),
    gatewayToken: readToolStringParam(params, "gatewayToken", { trim: false }),
    timeoutMs: readPositiveIntegerParam(params, "timeoutMs"),
  };
}

/**
 * Canonicalizes websocket URLs for allowlist comparisons without retaining paths or credentials.
 */
function canonicalizeToolGatewayWsUrl(raw: string): { origin: string; key: string } {
  const input = raw.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    const message = formatErrorMessage(error);
    throw new Error(`invalid gatewayUrl: ${input} (${message})`, { cause: error });
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`invalid gatewayUrl protocol: ${url.protocol} (expected ws:// or wss://)`);
  }
  if (url.username || url.password) {
    throw new Error("invalid gatewayUrl: credentials are not allowed");
  }
  if (url.search || url.hash) {
    throw new Error("invalid gatewayUrl: query/hash not allowed");
  }
  // Agents/tools expect the gateway websocket on the origin, not arbitrary paths.
  if (url.pathname && url.pathname !== "/") {
    throw new Error("invalid gatewayUrl: path not allowed");
  }

  const origin = url.origin;
  // Key: protocol + host only, lowercased. (host includes IPv6 brackets + port when present)
  const key = `${url.protocol}//${normalizeLowercaseStringOrEmpty(url.host)}`;
  return { origin, key };
}

function resolveLocalGatewayUrlKeys(cfg: OpenClawConfig): Set<string> {
  const port = resolveGatewayPort(cfg);
  return new Set<string>([
    `ws://127.0.0.1:${port}`,
    `wss://127.0.0.1:${port}`,
    `ws://localhost:${port}`,
    `wss://localhost:${port}`,
    `ws://[::1]:${port}`,
    `wss://[::1]:${port}`,
  ]);
}

function resolveConfiguredRemoteGatewayKey(cfg: OpenClawConfig): string | undefined {
  let remoteKey: string | undefined;
  const remoteUrl = normalizeOptionalString(cfg.gateway?.remote?.url) ?? "";
  if (remoteUrl) {
    try {
      const remote = canonicalizeToolGatewayWsUrl(remoteUrl);
      remoteKey = remote.key;
    } catch {
      // Misconfigured remote URL should not make ordinary tool calls fail; only explicit
      // gatewayUrl overrides need strict validation.
    }
  }
  return remoteKey;
}

function resolveDefaultGatewayTarget(params: {
  cfg: OpenClawConfig;
  envGatewayUrl?: string;
}): GatewayOverrideTarget {
  if (params.envGatewayUrl) {
    // Match operator-approvals-client: env-selected URLs may be tunnels or other gateways,
    // so loopback alone must not grant local approval-runtime authority.
    return "remote";
  }
  if (
    params.cfg.gateway?.mode === "remote" &&
    normalizeOptionalString(params.cfg.gateway.remote?.url)
  ) {
    return "remote";
  }
  return "local";
}

function validateGatewayUrlOverrideForAgentTools(params: {
  cfg: OpenClawConfig;
  urlOverride: string;
}): { url: string; target: GatewayOverrideTarget } {
  const { cfg } = params;
  const localAllowed = resolveLocalGatewayUrlKeys(cfg);
  const remoteKey = resolveConfiguredRemoteGatewayKey(cfg);

  const parsed = canonicalizeToolGatewayWsUrl(params.urlOverride);
  if (localAllowed.has(parsed.key)) {
    return { url: parsed.origin, target: "local" };
  }
  if (remoteKey && parsed.key === remoteKey) {
    return { url: parsed.origin, target: "remote" };
  }
  const port = resolveGatewayPort(cfg);
  throw new Error(
    [
      "gatewayUrl override rejected.",
      `Allowed: ws(s) loopback on port ${port} (127.0.0.1/localhost/[::1])`,
      "Or: configure gateway.remote.url and omit gatewayUrl to use the configured remote gateway.",
    ].join(" "),
  );
}

function resolveGatewayOverrideToken(params: {
  cfg: OpenClawConfig;
  target: GatewayOverrideTarget;
  explicitToken?: string;
}): string | undefined {
  if (params.explicitToken) {
    return params.explicitToken;
  }
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: process.env,
    modeOverride: params.target,
    remoteTokenFallback: params.target === "remote" ? "remote-only" : "remote-env-local",
    remotePasswordFallback: params.target === "remote" ? "remote-only" : "remote-env-local",
  }).token;
}

/**
 * Resolves the gateway URL, token, and timeout for agent tool calls.
 */
export function resolveGatewayOptions(opts?: GatewayCallOptions) {
  const cfg = getRuntimeConfig();
  const validatedOverride =
    trimToUndefined(opts?.gatewayUrl) !== undefined
      ? validateGatewayUrlOverrideForAgentTools({
          cfg,
          urlOverride: String(opts?.gatewayUrl),
        })
      : undefined;
  const explicitToken = trimToUndefined(opts?.gatewayToken);
  const token = validatedOverride
    ? resolveGatewayOverrideToken({
        cfg,
        target: validatedOverride.target,
        explicitToken,
      })
    : explicitToken;
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : 30_000;
  const envGatewayUrl = trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);
  const target =
    validatedOverride?.target ??
    resolveDefaultGatewayTarget({
      cfg,
      envGatewayUrl,
    });
  return { url: validatedOverride?.url, token, timeoutMs, target };
}

const APPROVAL_RUNTIME_METHODS = new Set<string>([
  "exec.approval.request",
  "exec.approval.resolve",
  "exec.approval.waitDecision",
  "plugin.approval.request",
  "plugin.approval.waitDecision",
]);

const AGENT_RUNTIME_IDENTITY_METHODS = new Set<string>([
  "exec.approval.request",
  "plugin.approval.request",
  "wake",
  "cron.list",
  "cron.get",
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.run",
  "cron.runs",
  "secrets.store.delete",
]);

const OPTIONAL_LOCAL_AGENT_RUNTIME_IDENTITY_METHODS = new Set<string>([
  "node.invoke",
  "question.request",
]);

function resolveApprovalRuntimeTokenForGatewayTool(params: {
  method: string;
  opts: GatewayCallOptions;
  target: GatewayOverrideTarget;
}): string | undefined {
  if (!APPROVAL_RUNTIME_METHODS.has(params.method)) {
    return undefined;
  }
  if (trimToUndefined(params.opts.gatewayUrl) !== undefined) {
    // Runtime approval tokens are scoped to the local approval bridge, not arbitrary
    // caller-supplied gateway URLs.
    return undefined;
  }
  if (params.target !== "local") {
    return undefined;
  }
  return getOperatorApprovalRuntimeToken();
}

function isApprovalReplayNodeSystemRun(method: string, callParams: unknown): boolean {
  const invoke = method === "node.invoke" ? asNullableRecord(callParams) : null;
  const run = invoke?.command === "system.run" ? asNullableRecord(invoke.params) : null;
  const decision = normalizeOptionalString(run?.approvalDecision);
  return run?.approved === true || decision === "allow-once" || decision === "allow-always";
}

function attachNodeInvokeTurnSource(method: string, params: unknown): unknown {
  if (method !== "node.invoke") {
    return params;
  }
  const invoke = asNullableRecord(params);
  const caller = getGatewayToolCallerIdentity();
  if (!invoke || !caller) {
    return params;
  }
  return {
    ...omitNodeInvokeTurnSource(invoke),
    ...(caller.turnSourceChannel ? { turnSourceChannel: caller.turnSourceChannel } : {}),
    ...(caller.turnSourceTo ? { turnSourceTo: caller.turnSourceTo } : {}),
    ...(caller.turnSourceAccountId ? { turnSourceAccountId: caller.turnSourceAccountId } : {}),
    ...(caller.turnSourceThreadId !== undefined
      ? { turnSourceThreadId: caller.turnSourceThreadId }
      : {}),
  };
}

function omitNodeInvokeTurnSource(invoke: Record<string, unknown>): Record<string, unknown> {
  const legacyParams = { ...invoke };
  delete legacyParams.turnSourceChannel;
  delete legacyParams.turnSourceTo;
  delete legacyParams.turnSourceAccountId;
  delete legacyParams.turnSourceThreadId;
  return legacyParams;
}

function stripNodeInvokeTurnSource(params: unknown): unknown {
  const invoke = asNullableRecord(params);
  return invoke ? omitNodeInvokeTurnSource(invoke) : params;
}

function resolveApprovalRequesterDeviceIdentityForGatewayTool(params: {
  method: string;
  callParams: unknown;
  opts: GatewayCallOptions;
  approvalRuntimeToken: string | undefined;
}): DeviceIdentity | undefined {
  const isApprovalRuntimeMethod = APPROVAL_RUNTIME_METHODS.has(params.method);
  const isNodeApprovalReplay = isApprovalReplayNodeSystemRun(params.method, params.callParams);
  if (!isApprovalRuntimeMethod && !isNodeApprovalReplay) {
    return undefined;
  }
  if (isApprovalRuntimeMethod && trimToUndefined(params.opts.gatewayUrl) !== undefined) {
    return undefined;
  }
  if (params.approvalRuntimeToken !== undefined) {
    // The approval-runtime token already proves this is the local approval bridge, and
    // the gateway grants record visibility from it. Sending the shared device identity
    // too would put the connect back under that device's paired role/scope baseline,
    // so an operator paired before operator.approvals existed can never reach the
    // prompt that would re-pair it. Same rule as the operator approvals client.
    return undefined;
  }
  try {
    if (isNodeApprovalReplay) {
      // Replay must reuse the identity present when the approval was registered.
      // Creating one here could turn a device-less record into a different identity.
      const identity = loadDeviceIdentityIfPresent();
      if (!identity) {
        throw new Error("device identity is not persisted");
      }
      return identity;
    }
    const identity = loadOrCreateDeviceIdentity();
    return identity;
  } catch (error) {
    if (isNodeApprovalReplay) {
      throw new Error(
        [
          "approved node gateway calls require a stable device identity.",
          "Fix the OpenClaw state directory permissions and retry the approval.",
        ].join(" "),
        { cause: error },
      );
    }
    throw new Error(
      [
        "remote approval gateway calls require a stable device identity.",
        "Fix the OpenClaw state directory permissions or use the local approval-runtime gateway.",
      ].join(" "),
      { cause: error },
    );
  }
}

async function resolveAgentRuntimeIdentityTokenForGatewayTool(params: {
  method: string;
  opts: GatewayCallOptions;
  target: GatewayOverrideTarget;
  required?: boolean;
}): Promise<string | undefined> {
  const optionalLocalIdentity = OPTIONAL_LOCAL_AGENT_RUNTIME_IDENTITY_METHODS.has(params.method);
  if (
    !params.required &&
    !AGENT_RUNTIME_IDENTITY_METHODS.has(params.method) &&
    !optionalLocalIdentity
  ) {
    return undefined;
  }
  const identity = getGatewayToolCallerIdentity();
  if (!identity) {
    if (params.required) {
      throw new Error("trusted agent runtime identity required for this gateway call");
    }
    return undefined;
  }
  const hasGatewayUrlOverride = trimToUndefined(params.opts.gatewayUrl) !== undefined;
  const hasGatewayTokenOverride = trimToUndefined(params.opts.gatewayToken) !== undefined;
  if (hasGatewayUrlOverride || hasGatewayTokenOverride || params.target !== "local") {
    // Optional provenance must never turn a supported remote call into an auth failure.
    if (optionalLocalIdentity && !params.required) {
      return undefined;
    }
    throw new Error("agent gateway calls require the trusted local gateway context");
  }
  if (identity.signedAgentRuntimeIdentityToken) {
    return identity.signedAgentRuntimeIdentityToken;
  }
  // Independent CLI runs have local claims, not authority in the target Gateway.
  if (optionalLocalIdentity && !params.required && !identity.gatewayContextResolver) {
    return undefined;
  }
  if (!identity.operationalRunInstance) {
    if (optionalLocalIdentity && !params.required) {
      return undefined;
    }
    throw new Error("trusted operational run instance required for this gateway call");
  }
  try {
    const sessionSpawnContext = getGatewaySessionSpawnContext();
    const parentExecutionIdentityToken = getGatewaySessionSpawnParentExecutionIdentityToken();
    const activeAuthority = getActiveAgentRunDelegatedAuthority(identity.operationalRunInstance);
    const executionLineage = readAgentRuntimeExecutionLineage(sessionSpawnContext);
    if (executionLineage && !activeAuthority) {
      throw new Error("execution lineage handoff requires active parent authority");
    }
    const lineageHandoff =
      sessionSpawnContext && executionLineage && activeAuthority
        ? createAgentRuntimeExecutionLineageHandoff({
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            operationalRunInstance: identity.operationalRunInstance,
            delegatedAuthority: activeAuthority,
            ...(parentExecutionIdentityToken
              ? { executionIdentity: parentExecutionIdentityToken }
              : {}),
            sessionSpawnContext,
          })
        : undefined;
    if (executionLineage && !lineageHandoff) {
      throw new Error("execution lineage handoff could not bind the parent admission");
    }
    try {
      return await mintAgentRuntimeIdentityToken({
        ...identity,
        operationalRunInstance: identity.operationalRunInstance,
        ...(lineageHandoff ? { executionIdentityToken: undefined } : {}),
        ...(lineageHandoff
          ? { executionLineageHandoffId: lineageHandoff.id }
          : sessionSpawnContext
            ? { executionIdentityToken: parentExecutionIdentityToken, sessionSpawnContext }
            : {}),
      });
    } catch (error) {
      lineageHandoff?.revoke();
      throw error;
    }
  } catch (error) {
    if (optionalLocalIdentity && !params.required) {
      return undefined;
    }
    throw error;
  }
}

export async function resolveMessageActionAgentRuntimeIdentityToken(params: {
  opts: GatewayCallOptions;
  target: "local" | "remote";
  turnCapability?: string;
  turnCapabilitySessionKey?: string;
  runId?: string;
  sessionId?: string;
  sourceReplyFinal?: boolean;
  sourceReplyToolCallId?: string;
  callerOwnsTerminalReceipt?: boolean;
}): Promise<string | undefined> {
  const terminalSourceReply = params.sourceReplyFinal === true;
  const sourceReplyToolCallId = normalizeOptionalString(params.sourceReplyToolCallId);
  if (terminalSourceReply && !sourceReplyToolCallId) {
    throw new Error("terminal source reply requires tool-call correlation");
  }
  const identity = getGatewayToolCallerIdentity();
  if (!identity) {
    if (terminalSourceReply) {
      throw new Error("terminal source reply requires trusted agent runtime identity");
    }
    return undefined;
  }
  const hasGatewayUrlOverride = trimToUndefined(params.opts.gatewayUrl) !== undefined;
  const hasGatewayTokenOverride = trimToUndefined(params.opts.gatewayToken) !== undefined;
  const usesUntrustedGatewayContext =
    hasGatewayUrlOverride || hasGatewayTokenOverride || params.target !== "local";
  if (usesUntrustedGatewayContext && !terminalSourceReply) {
    return undefined;
  }
  const turnCapabilitySessionKey =
    normalizeOptionalString(params.turnCapabilitySessionKey) ?? identity.sessionKey;
  const messageActionContext = resolveMessageActionTurnCapability({
    token: params.turnCapability,
    agentId: identity.agentId,
    runId: params.runId,
    sessionKey: turnCapabilitySessionKey,
    sessionId: params.sessionId,
  });
  if (!messageActionContext) {
    if (terminalSourceReply) {
      throw new Error("terminal source reply requires an active turn capability");
    }
    return undefined;
  }
  if (
    terminalSourceReply &&
    !normalizeOptionalString(messageActionContext.toolContext?.currentSourceTurnId)
  ) {
    throw new Error("terminal source reply requires source-turn correlation");
  }
  if (usesUntrustedGatewayContext) {
    if (params.callerOwnsTerminalReceipt !== true) {
      throw new Error("terminal source reply requires the trusted local gateway context");
    }
    // Remote gateways cannot trust caller-supplied turn metadata. The agent
    // process owns the durable receipt and sends no source authority over RPC.
    return undefined;
  }
  if (!identity.operationalRunInstance) {
    if (terminalSourceReply) {
      throw new Error("terminal source reply requires a trusted operational run instance");
    }
    return undefined;
  }
  const resolvedMessageActionContext = terminalSourceReply
    ? {
        ...messageActionContext,
        turnCapability: params.turnCapability,
        sourceReplyFinal: true as const,
        sourceReplyToolCallId: sourceReplyToolCallId!,
      }
    : {
        ...messageActionContext,
        turnCapability: params.turnCapability,
        ...(params.sourceReplyFinal === false ? { sourceReplyFinal: false as const } : {}),
        ...(sourceReplyToolCallId ? { sourceReplyToolCallId } : {}),
      };
  return await mintAgentRuntimeIdentityToken({
    ...identity,
    sessionKey: turnCapabilitySessionKey,
    operationalRunInstance: identity.operationalRunInstance,
    messageActionContext: resolvedMessageActionContext,
  });
}

function isStaleGatewayAgentRuntimeIdentityRejection(error: unknown): boolean {
  const message = formatErrorMessage(error);
  if (
    message.includes(
      "gateway rejected required agent runtime identity auth field; refusing to retry without it",
    )
  ) {
    return true;
  }
  return (
    message.includes("invalid connect params") &&
    message.includes("/auth") &&
    message.includes("unexpected property 'agentRuntimeIdentityToken'")
  );
}

function isStaleGatewayNodeInvokeTurnSourceRejection(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const requestError = error as Error & { gatewayCode?: unknown; details?: unknown };
  if (requestError.gatewayCode !== ErrorCodes.INVALID_REQUEST) {
    return false;
  }
  const details = asNullableRecord(requestError.details);
  // Only explicit pre-dispatch provenance makes a second invoke safe. Older
  // gateways without this fact must fail rather than risk duplicate execution.
  if (details?.nodeCommandDispatched !== false) {
    return false;
  }
  const message = formatErrorMessage(error);
  if (!message.includes("invalid node.invoke params:")) {
    return false;
  }
  return ["turnSourceChannel", "turnSourceTo", "turnSourceAccountId", "turnSourceThreadId"].some(
    (field) => message.includes(`unexpected property '${field}'`),
  );
}

function staleGatewayAgentRuntimeIdentityError(cause: unknown): Error {
  return new Error(
    [
      "The running Gateway is from an older OpenClaw build and rejected current agent runtime connection metadata.",
      "Restart the Gateway with `openclaw gateway restart`, then retry.",
    ].join(" "),
    { cause },
  );
}

/**
 * Calls a gateway method as the agent-tool backend client with least-privilege scopes.
 */
export async function callGatewayTool<T = Record<string, unknown>>(
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: {
    expectFinal?: boolean;
    scopes?: OperatorScope[];
    requireAgentRuntimeIdentity?: boolean;
    signal?: AbortSignal;
  },
) {
  const gateway = resolveGatewayOptions(opts);
  const resolveGatewayContext = getGatewayToolCallerIdentity()?.gatewayContextResolver;
  const callParams = attachNodeInvokeTurnSource(method, params);
  const scopes = Array.isArray(extra?.scopes)
    ? extra.scopes
    : resolveLeastPrivilegeOperatorScopesForMethod(method, callParams);
  const approvalRuntimeToken = resolveApprovalRuntimeTokenForGatewayTool({
    method,
    opts,
    target: gateway.target,
  });
  const agentRuntimeIdentityToken = await resolveAgentRuntimeIdentityTokenForGatewayTool({
    method,
    opts,
    target: gateway.target,
    required: extra?.requireAgentRuntimeIdentity,
  });
  const deviceIdentity = resolveApprovalRequesterDeviceIdentityForGatewayTool({
    method,
    callParams,
    opts,
    approvalRuntimeToken,
  });
  const callOptions = {
    url: gateway.url,
    token: gateway.token,
    method,
    params: callParams,
    timeoutMs: gateway.timeoutMs,
    signal: extra?.signal,
    expectFinal: extra?.expectFinal,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    ...(approvalRuntimeToken ? { approvalRuntimeToken } : {}),
    ...(agentRuntimeIdentityToken ? { agentRuntimeIdentityToken } : {}),
    ...(deviceIdentity ? { deviceIdentity } : {}),
    scopes,
  };
  const dispatch = (options: typeof callOptions) => {
    // Token minting and a prior RPC may await; never downgrade a retired owner.
    if (resolveGatewayContext && !resolveGatewayContext()) {
      throw new Error("The admitting Gateway is no longer available. Retry from a new agent run.");
    }
    return callGateway<T>(options);
  };
  try {
    return await dispatch(callOptions);
  } catch (error) {
    if (method === "node.invoke" && isStaleGatewayNodeInvokeTurnSourceRejection(error)) {
      return await dispatch({
        ...callOptions,
        params: stripNodeInvokeTurnSource(callOptions.params),
      });
    }
    if (agentRuntimeIdentityToken && isStaleGatewayAgentRuntimeIdentityRejection(error)) {
      if (method === "node.invoke" && extra?.requireAgentRuntimeIdentity !== true) {
        return await dispatch({
          ...callOptions,
          params: stripNodeInvokeTurnSource(callOptions.params),
          agentRuntimeIdentityToken: undefined,
        });
      }
      throw staleGatewayAgentRuntimeIdentityError(error);
    }
    throw error;
  }
}
