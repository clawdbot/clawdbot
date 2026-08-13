// Purpose-scoped local agent runtime identity token for Gateway clients.
import { createHmac } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  parseExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionToken,
} from "../audit/execution-identity-admission.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { InternalChannelThreadingToolContext } from "../channels/threading-tool-context-internal.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { ensureExecApprovalsSnapshot, loadExecApprovalsAsync } from "../infra/exec-approvals.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import type { CronCreatorAuthorityGrant } from "./cron-creator-authority-grant.js";
import type { AgentRuntimeMessageActionContext } from "./message-action-turn-capability.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

const AGENT_RUNTIME_IDENTITY_TOKEN_CONTEXT = "openclaw:gateway-agent-runtime-identity-token:v1";
const AGENT_RUNTIME_IDENTITY_TOKEN_KIND = "agent-runtime";
const MESSAGE_ACTION_TOKEN_TTL_MS = 60_000;
const CRON_SELF_MANAGEMENT_TOKEN_TTL_MS = 60_000;

type AgentRuntimeCronSelfManagementContext = {
  jobId: string;
  expiresAtMs: number;
};

export type AgentRuntimeIdentity = {
  kind: "agentRuntime";
  agentId: string;
  sessionKey: string;
  operationalRunInstance: OperationalRunInstanceRef;
  delegatedAuthority: AgentRuntimeDelegatedAuthority;
  approvalOwnerPluginId?: string;
  executionIdentity?: ExecutionIdentityAdmissionToken;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  messageActionContext?: AgentRuntimeMessageActionContext;
  cronSelfManagementContext?: AgentRuntimeCronSelfManagementContext;
  cronToolsAllowCapture?: "final-executable-surface";
  cronCreatorAuthorityGrant?: CronCreatorAuthorityGrant;
  sessionSpawnContext?: AgentRuntimeSessionSpawnContext;
};

export type AgentRuntimeDelegatedAuthority = AgentRunDelegatedAuthority &
  (
    | { kind: "local" }
    | {
        kind: "worker";
        turnClaim: WorkerSessionTurnClaim;
      }
  );

export type AgentRuntimeSessionSpawnContext = {
  completionOwnerSessionKey?: string;
  inheritedToolPolicy: {
    version: 1;
    allow: string[];
    deny: string[];
  };
};

type AgentRuntimeIdentityTokenPayload = {
  kind: typeof AGENT_RUNTIME_IDENTITY_TOKEN_KIND;
  agentId: string;
  sessionKey: string;
  operationalRunInstance: OperationalRunInstanceRef;
  delegatedAuthority: AgentRuntimeDelegatedAuthority;
  approvalOwnerPluginId?: string;
  executionIdentity?: ExecutionIdentityAdmissionToken;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  messageActionContext?: AgentRuntimeMessageActionContext;
  cronSelfManagementContext?: AgentRuntimeCronSelfManagementContext;
  cronToolsAllowCapture?: "final-executable-surface";
  cronCreatorAuthorityGrant?: CronCreatorAuthorityGrant;
  sessionSpawnContext?: AgentRuntimeSessionSpawnContext;
};

function decodeWorkerTurnClaim(value: unknown): WorkerSessionTurnClaim | undefined {
  if (!isRecord(value) || !isRecord(value.owner) || value.owner.kind !== "worker") {
    return undefined;
  }
  const sessionId = normalizeOptionalString(value.sessionId);
  const claimId = normalizeOptionalString(value.claimId);
  const runId = normalizeOptionalString(value.runId);
  const environmentId = normalizeOptionalString(value.owner.environmentId);
  const placementGeneration = value.placementGeneration;
  const ownerEpoch = value.owner.ownerEpoch;
  if (
    !sessionId ||
    !claimId ||
    !runId ||
    !environmentId ||
    !Number.isSafeInteger(placementGeneration) ||
    (placementGeneration as number) < 0 ||
    !Number.isSafeInteger(ownerEpoch) ||
    (ownerEpoch as number) < 0
  ) {
    return undefined;
  }
  return {
    sessionId,
    claimId,
    runId,
    placementGeneration: placementGeneration as number,
    owner: { kind: "worker", environmentId, ownerEpoch: ownerEpoch as number },
  };
}

function decodeDelegatedAuthority(
  value: unknown,
  operationalRunInstance: OperationalRunInstanceRef,
): AgentRuntimeDelegatedAuthority | undefined {
  if (!isRecord(value) || (value.kind !== "local" && value.kind !== "worker")) {
    return undefined;
  }
  const lifecycleGeneration = normalizeOptionalString(value.lifecycleGeneration);
  const claimId = normalizeOptionalString(value.claimId);
  const rawOperational = value.operationalRunInstance;
  const instanceId = isRecord(rawOperational)
    ? normalizeOptionalString(rawOperational.instanceId)
    : undefined;
  const runId = isRecord(rawOperational)
    ? normalizeOptionalString(rawOperational.runId)
    : undefined;
  if (
    !lifecycleGeneration ||
    !claimId ||
    instanceId !== operationalRunInstance.instanceId ||
    runId !== operationalRunInstance.runId
  ) {
    return undefined;
  }
  const owner = {
    operationalRunInstance,
    lifecycleGeneration,
    claimId,
  };
  if (value.kind === "local") {
    return { kind: "local", ...owner };
  }
  const turnClaim = decodeWorkerTurnClaim(value.turnClaim);
  return turnClaim?.runId === operationalRunInstance.runId
    ? { kind: "worker", ...owner, turnClaim }
    : undefined;
}

function decodeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function decodeSessionSpawnContext(value: unknown): AgentRuntimeSessionSpawnContext | undefined {
  if (!isRecord(value) || !isRecord(value.inheritedToolPolicy)) {
    return undefined;
  }
  const policy = value.inheritedToolPolicy;
  const allow = decodeStringList(policy.allow);
  const deny = decodeStringList(policy.deny);
  if (policy.version !== 1 || !allow || !deny) {
    return undefined;
  }
  const completionOwnerSessionKey = normalizeOptionalString(value.completionOwnerSessionKey);
  if (value.completionOwnerSessionKey !== undefined && !completionOwnerSessionKey) {
    return undefined;
  }
  return {
    ...(completionOwnerSessionKey ? { completionOwnerSessionKey } : {}),
    inheritedToolPolicy: { version: 1, allow, deny },
  };
}

function decodeCronCreatorAuthorityGrant(value: unknown): CronCreatorAuthorityGrant | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const runId = normalizeOptionalString(value.runId);
  const token = normalizeOptionalString(value.token);
  return runId && token ? { runId, token } : undefined;
}

async function readSharedAgentRuntimeIdentitySecret(): Promise<string | null> {
  return (await loadExecApprovalsAsync()).socket?.token?.trim() || null;
}

async function requireSharedAgentRuntimeIdentitySecret(): Promise<string> {
  const token = (await ensureExecApprovalsSnapshot()).file.socket?.token?.trim();
  if (!token) {
    throw new Error(
      "Unable to mint agent runtime identity token without local socket credentials.",
    );
  }
  return token;
}

function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(AGENT_RUNTIME_IDENTITY_TOKEN_CONTEXT)
    .update("\0")
    .update(payload)
    .digest("base64url");
}

function encodePayload(payload: AgentRuntimeIdentityTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeMessageActionContext(
  value: unknown,
  nowMs: number,
): AgentRuntimeMessageActionContext | undefined {
  if (
    !isRecord(value) ||
    typeof value.expiresAtMs !== "number" ||
    !Number.isFinite(value.expiresAtMs) ||
    nowMs >= value.expiresAtMs
  ) {
    return undefined;
  }
  const rawToolContext = value.toolContext;
  const sourceReplyFinal = value.sourceReplyFinal;
  const sourceReplyToolCallId = normalizeOptionalString(value.sourceReplyToolCallId);
  if (sourceReplyFinal !== undefined && typeof sourceReplyFinal !== "boolean") {
    return undefined;
  }
  if (value.sourceReplyToolCallId !== undefined && !sourceReplyToolCallId) {
    return undefined;
  }
  if (rawToolContext !== undefined && !isRecord(rawToolContext)) {
    return undefined;
  }
  const rawCurrentChatType = rawToolContext?.currentChatType;
  const currentChatType = normalizeChatType(
    typeof rawCurrentChatType === "string" ? rawCurrentChatType : undefined,
  );
  const currentMessageId = rawToolContext?.currentMessageId;
  const replyToMode = rawToolContext?.replyToMode;
  const hasRepliedRef = rawToolContext?.hasRepliedRef;
  if (
    (currentMessageId !== undefined &&
      typeof currentMessageId !== "string" &&
      typeof currentMessageId !== "number") ||
    (replyToMode !== undefined &&
      replyToMode !== "off" &&
      replyToMode !== "first" &&
      replyToMode !== "all" &&
      replyToMode !== "batched") ||
    (hasRepliedRef !== undefined &&
      (!isRecord(hasRepliedRef) || typeof hasRepliedRef.value !== "boolean"))
  ) {
    return undefined;
  }
  const readOptionalBoolean = (key: string): boolean | undefined => {
    const candidate = rawToolContext?.[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  };
  const toolContext: InternalChannelThreadingToolContext | undefined = rawToolContext
    ? ({
        currentChannelId: normalizeOptionalString(rawToolContext.currentChannelId),
        currentChatType,
        currentMessagingTarget: normalizeOptionalString(rawToolContext.currentMessagingTarget),
        currentGraphChannelId: normalizeOptionalString(rawToolContext.currentGraphChannelId),
        currentChannelProvider: normalizeOptionalString(rawToolContext.currentChannelProvider) as
          | ChannelId
          | undefined,
        currentThreadTs: normalizeOptionalString(rawToolContext.currentThreadTs),
        currentMessageId,
        currentSourceTurnId: normalizeOptionalString(rawToolContext.currentSourceTurnId),
        replyToMode:
          replyToMode === "off" ||
          replyToMode === "first" ||
          replyToMode === "all" ||
          replyToMode === "batched"
            ? replyToMode
            : undefined,
        hasRepliedRef:
          isRecord(hasRepliedRef) && typeof hasRepliedRef.value === "boolean"
            ? { value: hasRepliedRef.value }
            : undefined,
        sameChannelThreadRequired: readOptionalBoolean("sameChannelThreadRequired"),
        skipCrossContextDecoration: readOptionalBoolean("skipCrossContextDecoration"),
      } satisfies InternalChannelThreadingToolContext)
    : undefined;
  const context = {
    expiresAtMs: value.expiresAtMs,
    sessionId: normalizeOptionalString(value.sessionId),
    sourceReplySessionKey: normalizeOptionalString(value.sourceReplySessionKey),
    requesterAccountId: normalizeOptionalString(value.requesterAccountId),
    requesterSenderId: normalizeOptionalString(value.requesterSenderId),
    toolContext,
  };
  if (sourceReplyFinal === true) {
    if (!sourceReplyToolCallId) {
      return undefined;
    }
    return { ...context, sourceReplyFinal: true, sourceReplyToolCallId };
  }
  return {
    ...context,
    ...(sourceReplyFinal === false ? { sourceReplyFinal: false as const } : {}),
    ...(sourceReplyToolCallId ? { sourceReplyToolCallId } : {}),
  };
}

function decodePayload(value: string, nowMs: number): AgentRuntimeIdentityTokenPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const raw = parsed as {
      kind?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
      operationalRunInstance?: unknown;
      approvalOwnerPluginId?: unknown;
      turnSourceChannel?: unknown;
      turnSourceTo?: unknown;
      turnSourceAccountId?: unknown;
      turnSourceThreadId?: unknown;
      messageActionContext?: unknown;
      cronSelfManagementContext?: unknown;
      sessionSpawnContext?: unknown;
      cronToolsAllowCapture?: unknown;
      cronCreatorAuthorityGrant?: unknown;
      executionIdentity?: unknown;
      delegatedAuthority?: unknown;
    };
    if (
      raw.kind !== AGENT_RUNTIME_IDENTITY_TOKEN_KIND ||
      typeof raw.agentId !== "string" ||
      typeof raw.sessionKey !== "string"
    ) {
      return undefined;
    }
    const agentId = normalizeAgentId(raw.agentId);
    const sessionKey = raw.sessionKey.trim();
    const approvalOwnerPluginId = normalizeOptionalString(
      typeof raw.approvalOwnerPluginId === "string" ? raw.approvalOwnerPluginId : undefined,
    );
    const rawOperationalRunInstance = raw.operationalRunInstance;
    const operationalInstanceId = isRecord(rawOperationalRunInstance)
      ? normalizeOptionalString(rawOperationalRunInstance.instanceId)
      : undefined;
    const operationalRunId = isRecord(rawOperationalRunInstance)
      ? normalizeOptionalString(rawOperationalRunInstance.runId)
      : undefined;
    const turnSourceAccountId = normalizeOptionalAccountId(
      typeof raw.turnSourceAccountId === "string" ? raw.turnSourceAccountId : undefined,
    );
    const turnSourceChannel = normalizeOptionalString(
      typeof raw.turnSourceChannel === "string" ? raw.turnSourceChannel : undefined,
    );
    const turnSourceTo = normalizeOptionalString(
      typeof raw.turnSourceTo === "string" ? raw.turnSourceTo : undefined,
    );
    const turnSourceThreadId =
      typeof raw.turnSourceThreadId === "string" || typeof raw.turnSourceThreadId === "number"
        ? raw.turnSourceThreadId
        : undefined;
    if (!agentId || !sessionKey || !operationalInstanceId || !operationalRunId) {
      return undefined;
    }
    const operationalRunInstance = Object.freeze({
      instanceId: operationalInstanceId,
      runId: operationalRunId,
    });
    const delegatedAuthority = decodeDelegatedAuthority(
      raw.delegatedAuthority,
      operationalRunInstance,
    );
    if (!delegatedAuthority) {
      return undefined;
    }
    const messageActionContext =
      raw.messageActionContext === undefined
        ? undefined
        : decodeMessageActionContext(raw.messageActionContext, nowMs);
    if (raw.messageActionContext !== undefined && !messageActionContext) {
      return undefined;
    }
    const rawCronSelfManagement = raw.cronSelfManagementContext;
    const cronSelfManagementJobId =
      isRecord(rawCronSelfManagement) && typeof rawCronSelfManagement.jobId === "string"
        ? rawCronSelfManagement.jobId.trim()
        : "";
    const cronSelfManagementExpiresAtMs = isRecord(rawCronSelfManagement)
      ? rawCronSelfManagement.expiresAtMs
      : undefined;
    const cronSelfManagementContext =
      cronSelfManagementJobId &&
      typeof cronSelfManagementExpiresAtMs === "number" &&
      Number.isFinite(cronSelfManagementExpiresAtMs) &&
      nowMs < cronSelfManagementExpiresAtMs
        ? {
            jobId: cronSelfManagementJobId,
            expiresAtMs: cronSelfManagementExpiresAtMs,
          }
        : undefined;
    if (rawCronSelfManagement !== undefined && !cronSelfManagementContext) {
      return undefined;
    }
    const sessionSpawnContext =
      raw.sessionSpawnContext === undefined
        ? undefined
        : decodeSessionSpawnContext(raw.sessionSpawnContext);
    if (raw.sessionSpawnContext !== undefined && !sessionSpawnContext) {
      return undefined;
    }
    const cronToolsAllowCapture =
      raw.cronToolsAllowCapture === "final-executable-surface"
        ? raw.cronToolsAllowCapture
        : undefined;
    if (raw.cronToolsAllowCapture !== undefined && !cronToolsAllowCapture) {
      return undefined;
    }
    const cronCreatorAuthorityGrant =
      raw.cronCreatorAuthorityGrant === undefined
        ? undefined
        : decodeCronCreatorAuthorityGrant(raw.cronCreatorAuthorityGrant);
    if (raw.cronCreatorAuthorityGrant !== undefined && !cronCreatorAuthorityGrant) {
      return undefined;
    }
    if (cronCreatorAuthorityGrant && !cronToolsAllowCapture) {
      return undefined;
    }
    let executionIdentity: ExecutionIdentityAdmissionToken | undefined;
    if (raw.executionIdentity !== undefined) {
      try {
        executionIdentity = parseExecutionIdentityAdmissionToken(raw.executionIdentity);
      } catch {
        return undefined;
      }
    }
    if (executionIdentity?.runId !== operationalRunId) {
      executionIdentity = undefined;
    }
    return {
      kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND,
      agentId,
      sessionKey,
      operationalRunInstance,
      delegatedAuthority,
      ...(approvalOwnerPluginId ? { approvalOwnerPluginId } : {}),
      ...(turnSourceChannel ? { turnSourceChannel } : {}),
      ...(turnSourceTo ? { turnSourceTo } : {}),
      ...(turnSourceAccountId ? { turnSourceAccountId } : {}),
      ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
      ...(messageActionContext ? { messageActionContext } : {}),
      ...(cronSelfManagementContext ? { cronSelfManagementContext } : {}),
      ...(sessionSpawnContext ? { sessionSpawnContext } : {}),
      ...(cronToolsAllowCapture ? { cronToolsAllowCapture } : {}),
      ...(cronCreatorAuthorityGrant ? { cronCreatorAuthorityGrant } : {}),
      ...(executionIdentity ? { executionIdentity } : {}),
    };
  } catch {
    return undefined;
  }
}

export type AgentRuntimeIdentityTokenParams = {
  agentId: string;
  sessionKey: string;
  operationalRunInstance: OperationalRunInstanceRef;
  approvalOwnerPluginId?: string;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  messageActionContext?: AgentRuntimeMessageActionContext;
  cronSelfManagementJobId?: string;
  cronToolsAllowCapture?: "final-executable-surface";
  cronCreatorAuthorityGrant?: CronCreatorAuthorityGrant;
  sessionSpawnContext?: AgentRuntimeSessionSpawnContext;
  workerTurnClaim?: WorkerSessionTurnClaim;
};

function prepareAgentRuntimeIdentityTokenPayload(params: AgentRuntimeIdentityTokenParams): string {
  const operationalInstanceId = normalizeOptionalString(params.operationalRunInstance.instanceId);
  const operationalRunId = normalizeOptionalString(params.operationalRunInstance.runId);
  if (!operationalInstanceId || !operationalRunId) {
    throw new Error("agent runtime identity requires an operational run instance");
  }
  const activeAuthority = getActiveAgentRunDelegatedAuthority({
    instanceId: operationalInstanceId,
    runId: operationalRunId,
  });
  if (!activeAuthority) {
    throw new Error("agent runtime identity requires active delegated run authority");
  }
  if (
    params.workerTurnClaim &&
    (params.workerTurnClaim.owner.kind !== "worker" ||
      params.workerTurnClaim.runId !== operationalRunId)
  ) {
    throw new Error("worker delegated authority disagrees with the operational run");
  }
  const delegatedAuthority: AgentRuntimeDelegatedAuthority = params.workerTurnClaim
    ? { kind: "worker", ...activeAuthority, turnClaim: params.workerTurnClaim }
    : { kind: "local", ...activeAuthority };
  if (
    params.cronCreatorAuthorityGrant &&
    params.cronToolsAllowCapture !== "final-executable-surface"
  ) {
    throw new Error("cron creator authority grants require final tool-surface provenance");
  }
  if (
    params.messageActionContext?.sourceReplyFinal === true &&
    !normalizeOptionalString(params.messageActionContext.sourceReplyToolCallId)
  ) {
    throw new Error("terminal source reply requires tool-call correlation");
  }
  const messageActionContext = params.messageActionContext
    ? {
        ...params.messageActionContext,
        // The process-local turn capability may live for the whole run, but a
        // copied bearer must expire shortly after its individual tool action.
        expiresAtMs: Math.min(
          params.messageActionContext.expiresAtMs,
          Date.now() + MESSAGE_ACTION_TOKEN_TTL_MS,
        ),
      }
    : undefined;
  const turnSourceAccountId = normalizeOptionalAccountId(params.turnSourceAccountId);
  const turnSourceChannel = normalizeOptionalString(params.turnSourceChannel);
  const turnSourceTo = normalizeOptionalString(params.turnSourceTo);
  const turnSourceThreadId =
    typeof params.turnSourceThreadId === "string"
      ? normalizeOptionalString(params.turnSourceThreadId)
      : params.turnSourceThreadId;
  const cronSelfManagementJobId = normalizeOptionalString(params.cronSelfManagementJobId);
  const cronSelfManagementContext = cronSelfManagementJobId
    ? {
        jobId: cronSelfManagementJobId,
        expiresAtMs: Date.now() + CRON_SELF_MANAGEMENT_TOKEN_TTL_MS,
      }
    : undefined;
  return encodePayload({
    kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND,
    agentId: normalizeAgentId(params.agentId),
    sessionKey: params.sessionKey.trim(),
    operationalRunInstance: {
      instanceId: operationalInstanceId,
      runId: operationalRunId,
    },
    delegatedAuthority,
    ...(normalizeOptionalString(params.approvalOwnerPluginId)
      ? { approvalOwnerPluginId: normalizeOptionalString(params.approvalOwnerPluginId) }
      : {}),
    ...(turnSourceChannel ? { turnSourceChannel } : {}),
    ...(turnSourceTo ? { turnSourceTo } : {}),
    ...(turnSourceAccountId ? { turnSourceAccountId } : {}),
    ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
    ...(messageActionContext ? { messageActionContext } : {}),
    ...(cronSelfManagementContext ? { cronSelfManagementContext } : {}),
    ...(params.cronToolsAllowCapture === "final-executable-surface"
      ? { cronToolsAllowCapture: params.cronToolsAllowCapture }
      : {}),
    ...(params.cronCreatorAuthorityGrant
      ? { cronCreatorAuthorityGrant: params.cronCreatorAuthorityGrant }
      : {}),
    ...(params.sessionSpawnContext ? { sessionSpawnContext: params.sessionSpawnContext } : {}),
    ...(params.executionIdentityToken?.runId === operationalRunId
      ? { executionIdentity: params.executionIdentityToken }
      : {}),
  });
}

/** Measure the exact ASCII token size without reading signing credentials or minting a bearer. */
export function measureAgentRuntimeIdentityTokenBytes(
  params: AgentRuntimeIdentityTokenParams,
): number {
  const payload = prepareAgentRuntimeIdentityTokenPayload(params);
  return Buffer.byteLength(`${payload}.${signPayload("", payload)}`, "utf8");
}

/** Mint an opaque token that lets trusted local agent-tool clients identify their agent. */
export async function mintAgentRuntimeIdentityToken(
  params: AgentRuntimeIdentityTokenParams,
): Promise<string> {
  const payload = prepareAgentRuntimeIdentityTokenPayload(params);
  const signature = signPayload(await requireSharedAgentRuntimeIdentitySecret(), payload);
  return `${payload}.${signature}`;
}

/** Validate a presented agent runtime token and return the internal caller identity. */
export async function verifyAgentRuntimeIdentityToken(
  value: string | null | undefined,
  nowMs?: number,
): Promise<AgentRuntimeIdentity | undefined> {
  const token = value?.trim();
  if (!token) {
    return undefined;
  }
  const [payloadPart, signature, ...extra] = token.split(".");
  if (!payloadPart || !signature || extra.length > 0) {
    return undefined;
  }
  const sharedSecret = await readSharedAgentRuntimeIdentitySecret();
  if (!sharedSecret || !safeEqualSecret(signature, signPayload(sharedSecret, payloadPart))) {
    return undefined;
  }
  const payload = decodePayload(payloadPart, nowMs ?? Date.now());
  if (!payload) {
    return undefined;
  }
  return {
    kind: "agentRuntime",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    operationalRunInstance: payload.operationalRunInstance,
    delegatedAuthority: payload.delegatedAuthority,
    ...(payload.approvalOwnerPluginId
      ? { approvalOwnerPluginId: payload.approvalOwnerPluginId }
      : {}),
    ...(payload.executionIdentity ? { executionIdentity: payload.executionIdentity } : {}),
    ...(payload.turnSourceChannel ? { turnSourceChannel: payload.turnSourceChannel } : {}),
    ...(payload.turnSourceTo ? { turnSourceTo: payload.turnSourceTo } : {}),
    ...(payload.turnSourceAccountId ? { turnSourceAccountId: payload.turnSourceAccountId } : {}),
    ...(payload.turnSourceThreadId !== undefined
      ? { turnSourceThreadId: payload.turnSourceThreadId }
      : {}),
    ...(payload.messageActionContext ? { messageActionContext: payload.messageActionContext } : {}),
    ...(payload.cronSelfManagementContext
      ? { cronSelfManagementContext: payload.cronSelfManagementContext }
      : {}),
    ...(payload.cronToolsAllowCapture
      ? { cronToolsAllowCapture: payload.cronToolsAllowCapture }
      : {}),
    ...(payload.cronCreatorAuthorityGrant
      ? { cronCreatorAuthorityGrant: payload.cronCreatorAuthorityGrant }
      : {}),
    ...(payload.sessionSpawnContext ? { sessionSpawnContext: payload.sessionSpawnContext } : {}),
  };
}

export type AgentRuntimeApprovalAuthorityValidator = (identity: AgentRuntimeIdentity) => boolean;

type WorkerTurnClaimValidator = {
  validateTurnClaim(claim: WorkerSessionTurnClaim): boolean;
};

function validateAgentRuntimeDelegatedAuthority(
  authority: AgentRuntimeDelegatedAuthority,
  placements?: WorkerTurnClaimValidator,
): boolean {
  if (!validateAgentRunDelegatedAuthority(authority)) {
    return false;
  }
  return authority.kind === "local"
    ? true
    : placements?.validateTurnClaim?.(authority.turnClaim) === true;
}

/** Builds the use-time approval gate from the run owner and canonical worker store. */
export function createAgentRuntimeApprovalAuthorityValidator(
  placements?: WorkerTurnClaimValidator,
): AgentRuntimeApprovalAuthorityValidator {
  return (identity) =>
    validateAgentRuntimeDelegatedAuthority(identity.delegatedAuthority, placements);
}
