// Purpose-scoped local agent runtime identity token for Gateway clients.
import { createHmac } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
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
import {
  redeemAgentRuntimeExecutionLineageHandoff,
  withAgentRuntimeExecutionLineageRedemption,
} from "./agent-runtime-execution-lineage.js";
import type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-session-spawn-context.js";
import type { CronCreatorAuthorityGrant } from "./cron-creator-authority-grant.js";
import {
  resolveMessageActionTurnCapability,
  type AgentRuntimeMessageActionContext,
} from "./message-action-turn-capability.js";
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
  /** Explicit admission fact; omission is unknown, never inferred from session routing. */
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  messageActionContext?: AgentRuntimeMessageActionContext;
  cronSelfManagementContext?: AgentRuntimeCronSelfManagementContext;
  cronToolsAllowCapture?: "final-executable-surface";
  cronExecToolTarget?: { host: "gateway"; ask?: "always" };
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

export type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-session-spawn-context.js";

type AgentRuntimeIdentityTokenPayload = {
  kind: typeof AGENT_RUNTIME_IDENTITY_TOKEN_KIND;
  agentId: string;
  sessionKey: string;
  operationalRunInstance: OperationalRunInstanceRef;
  delegatedAuthority: AgentRuntimeDelegatedAuthority;
  approvalOwnerPluginId?: string;
  executionIdentity?: ExecutionIdentityAdmissionToken;
  turnSourceChannel?: string;
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  messageActionContext?: AgentRuntimeMessageActionContext;
  cronSelfManagementContext?: AgentRuntimeCronSelfManagementContext;
  cronToolsAllowCapture?: "final-executable-surface";
  cronExecToolTarget?: { host: "gateway"; ask?: "always" };
  cronCreatorAuthorityGrant?: CronCreatorAuthorityGrant;
  sessionSpawnContext?: AgentRuntimeSessionSpawnContext;
  executionLineageHandoffId?: string;
};

const normalizedRequiredStringSchema = z
  .string()
  .transform(normalizeOptionalString)
  .pipe(z.string());
const ignoredOptionalStringSchema = z.unknown().transform(normalizeOptionalString).optional();
const safeNonNegativeIntegerSchema = z
  .number()
  .refine(Number.isSafeInteger)
  .refine((value) => value >= 0);
const operationalRunInstanceSchema = z.object({
  instanceId: normalizedRequiredStringSchema,
  runId: normalizedRequiredStringSchema,
});
const workerTurnClaimSchema = z
  .object({
    sessionId: normalizedRequiredStringSchema,
    claimId: normalizedRequiredStringSchema,
    runId: normalizedRequiredStringSchema,
    placementGeneration: safeNonNegativeIntegerSchema,
    owner: z.object({
      kind: z.literal("worker"),
      environmentId: normalizedRequiredStringSchema,
      ownerEpoch: safeNonNegativeIntegerSchema,
    }),
  })
  .transform(
    (claim): WorkerSessionTurnClaim => ({
      sessionId: claim.sessionId,
      claimId: claim.claimId,
      runId: claim.runId,
      placementGeneration: claim.placementGeneration,
      owner: claim.owner,
    }),
  );
const delegatedAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    lifecycleGeneration: normalizedRequiredStringSchema,
    claimId: normalizedRequiredStringSchema,
    operationalRunInstance: operationalRunInstanceSchema,
  }),
  z.object({
    kind: z.literal("worker"),
    lifecycleGeneration: normalizedRequiredStringSchema,
    claimId: normalizedRequiredStringSchema,
    operationalRunInstance: operationalRunInstanceSchema,
    turnClaim: workerTurnClaimSchema,
  }),
]);
const stringListSchema = z
  .array(z.string())
  .transform((entries) => entries.map((entry) => entry.trim()).filter(Boolean));
const sessionSpawnContextSchema = z
  .object({
    completionOwnerSessionKey: normalizedRequiredStringSchema.optional(),
    inheritedToolPolicy: z.object({
      version: z.literal(1),
      allow: stringListSchema,
      deny: stringListSchema,
    }),
  })
  .transform(
    (context): AgentRuntimeSessionSpawnContext => ({
      ...(context.completionOwnerSessionKey
        ? { completionOwnerSessionKey: context.completionOwnerSessionKey }
        : {}),
      inheritedToolPolicy: context.inheritedToolPolicy,
    }),
  );
const cronCreatorAuthorityGrantSchema = z
  .object({
    runId: normalizedRequiredStringSchema,
    token: normalizedRequiredStringSchema,
  })
  .transform((grant): CronCreatorAuthorityGrant => grant);
const messageActionToolContextSchema = z
  .object({
    currentChannelId: ignoredOptionalStringSchema,
    currentChatType: z
      .unknown()
      .transform((value) => normalizeChatType(typeof value === "string" ? value : undefined))
      .optional(),
    currentMessagingTarget: ignoredOptionalStringSchema,
    currentGraphChannelId: ignoredOptionalStringSchema,
    currentChannelProvider: ignoredOptionalStringSchema,
    currentThreadTs: ignoredOptionalStringSchema,
    currentMessageId: z.union([z.string(), z.number()]).optional(),
    currentSourceTurnId: ignoredOptionalStringSchema,
    replyToMode: z.enum(["off", "first", "all", "batched"]).optional(),
    hasRepliedRef: z.object({ value: z.boolean() }).optional(),
    sameChannelThreadRequired: z.boolean().optional().catch(undefined),
    skipCrossContextDecoration: z.boolean().optional().catch(undefined),
  })
  .transform(
    (context): InternalChannelThreadingToolContext => ({
      ...context,
      currentChannelProvider: context.currentChannelProvider as ChannelId | undefined,
    }),
  );
const messageActionContextSchema = z.object({
  expiresAtMs: z.number().finite(),
  turnCapability: normalizedRequiredStringSchema.optional(),
  sourceReplyFinal: z.boolean().optional(),
  sourceReplyToolCallId: normalizedRequiredStringSchema.optional(),
  sessionId: ignoredOptionalStringSchema,
  sourceReplySessionKey: ignoredOptionalStringSchema,
  requesterAccountId: ignoredOptionalStringSchema,
  requesterSenderId: ignoredOptionalStringSchema,
  requesterSenderName: ignoredOptionalStringSchema,
  requesterSenderUsername: ignoredOptionalStringSchema,
  requesterSenderE164: ignoredOptionalStringSchema,
  toolContext: messageActionToolContextSchema.optional(),
});
const cronSelfManagementContextSchema = z.object({
  jobId: normalizedRequiredStringSchema,
  expiresAtMs: z.number().finite(),
});
const agentRuntimeIdentityTokenPayloadSchema = z.object({
  kind: z.literal(AGENT_RUNTIME_IDENTITY_TOKEN_KIND),
  agentId: z.string(),
  sessionKey: z.string(),
  operationalRunInstance: operationalRunInstanceSchema,
  delegatedAuthority: delegatedAuthoritySchema,
  approvalOwnerPluginId: z.string().optional().catch(undefined),
  executionIdentity: z.unknown().optional(),
  turnSourceChannel: z.string().optional().catch(undefined),
  turnSourceLocal: z.literal(true).optional(),
  turnSourceTo: z.string().optional().catch(undefined),
  turnSourceAccountId: z.string().optional().catch(undefined),
  turnSourceThreadId: z.union([z.string(), z.number()]).optional().catch(undefined),
  messageActionContext: messageActionContextSchema.optional(),
  cronSelfManagementContext: cronSelfManagementContextSchema.optional(),
  cronToolsAllowCapture: z.literal("final-executable-surface").optional(),
  cronExecToolTarget: z
    .object({ host: z.literal("gateway"), ask: z.literal("always").optional() })
    .optional(),
  cronCreatorAuthorityGrant: cronCreatorAuthorityGrantSchema.optional(),
  sessionSpawnContext: sessionSpawnContextSchema.optional(),
  executionLineageHandoffId: normalizedRequiredStringSchema.optional(),
});

function decodeDelegatedAuthority(
  value: z.infer<typeof delegatedAuthoritySchema>,
  operationalRunInstance: OperationalRunInstanceRef,
): AgentRuntimeDelegatedAuthority | undefined {
  const { lifecycleGeneration, claimId } = value;
  const { instanceId, runId } = value.operationalRunInstance;
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
  return value.turnClaim.runId === operationalRunInstance.runId
    ? { kind: "worker", ...owner, turnClaim: value.turnClaim }
    : undefined;
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
  value: z.infer<typeof messageActionContextSchema>,
  nowMs: number,
): AgentRuntimeMessageActionContext | undefined {
  if (nowMs >= value.expiresAtMs) {
    return undefined;
  }
  const context = {
    expiresAtMs: value.expiresAtMs,
    turnCapability: value.turnCapability,
    sessionId: value.sessionId,
    sourceReplySessionKey: value.sourceReplySessionKey,
    requesterAccountId: value.requesterAccountId,
    requesterSenderId: value.requesterSenderId,
    requesterSenderName: value.requesterSenderName,
    requesterSenderUsername: value.requesterSenderUsername,
    requesterSenderE164: value.requesterSenderE164,
    toolContext: value.toolContext,
  };
  if (value.sourceReplyFinal === true) {
    if (!value.sourceReplyToolCallId) {
      return undefined;
    }
    return {
      ...context,
      sourceReplyFinal: true,
      sourceReplyToolCallId: value.sourceReplyToolCallId,
    };
  }
  return {
    ...context,
    ...(value.sourceReplyFinal === false ? { sourceReplyFinal: false as const } : {}),
    ...(value.sourceReplyToolCallId ? { sourceReplyToolCallId: value.sourceReplyToolCallId } : {}),
  };
}

function decodePayload(value: string, nowMs: number): AgentRuntimeIdentityTokenPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const result = agentRuntimeIdentityTokenPayloadSchema.safeParse(parsed);
    if (!result.success) {
      return undefined;
    }
    const raw = result.data;
    const agentId = normalizeAgentId(raw.agentId);
    const sessionKey = raw.sessionKey.trim();
    const approvalOwnerPluginId = normalizeOptionalString(raw.approvalOwnerPluginId);
    const operationalInstanceId = raw.operationalRunInstance.instanceId;
    const operationalRunId = raw.operationalRunInstance.runId;
    const turnSourceAccountId = normalizeOptionalAccountId(raw.turnSourceAccountId);
    const turnSourceChannel = normalizeOptionalString(raw.turnSourceChannel);
    const turnSourceLocal = raw.turnSourceLocal;
    if (turnSourceLocal && turnSourceChannel) {
      return undefined;
    }
    const turnSourceTo = normalizeOptionalString(raw.turnSourceTo);
    const turnSourceThreadId = raw.turnSourceThreadId;
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
    const messageActionContext = raw.messageActionContext
      ? decodeMessageActionContext(raw.messageActionContext, nowMs)
      : undefined;
    if (raw.messageActionContext !== undefined && !messageActionContext) {
      return undefined;
    }
    const cronSelfManagementContext =
      raw.cronSelfManagementContext && nowMs < raw.cronSelfManagementContext.expiresAtMs
        ? raw.cronSelfManagementContext
        : undefined;
    if (raw.cronSelfManagementContext !== undefined && !cronSelfManagementContext) {
      return undefined;
    }
    const sessionSpawnContext = raw.sessionSpawnContext;
    const executionLineageHandoffId = raw.executionLineageHandoffId;
    const cronToolsAllowCapture = raw.cronToolsAllowCapture;
    const cronExecToolTarget = cronToolsAllowCapture ? raw.cronExecToolTarget : undefined;
    const cronCreatorAuthorityGrant = raw.cronCreatorAuthorityGrant;
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
      ...(turnSourceLocal ? { turnSourceLocal } : {}),
      ...(turnSourceTo ? { turnSourceTo } : {}),
      ...(turnSourceAccountId ? { turnSourceAccountId } : {}),
      ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
      ...(messageActionContext ? { messageActionContext } : {}),
      ...(cronSelfManagementContext ? { cronSelfManagementContext } : {}),
      ...(sessionSpawnContext ? { sessionSpawnContext } : {}),
      ...(executionLineageHandoffId ? { executionLineageHandoffId } : {}),
      ...(cronToolsAllowCapture ? { cronToolsAllowCapture } : {}),
      ...(cronExecToolTarget ? { cronExecToolTarget } : {}),
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
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  messageActionContext?: AgentRuntimeMessageActionContext;
  cronSelfManagementJobId?: string;
  cronToolsAllowCapture?: "final-executable-surface";
  cronExecToolTarget?: { host: "gateway"; ask?: "always" };
  cronCreatorAuthorityGrant?: CronCreatorAuthorityGrant;
  sessionSpawnContext?: AgentRuntimeSessionSpawnContext;
  executionLineageHandoffId?: string;
  workerTurnClaim?: WorkerSessionTurnClaim;
};

function prepareAgentRuntimeIdentityTokenPayload(params: AgentRuntimeIdentityTokenParams): string {
  const operationalInstanceId = normalizeOptionalString(params.operationalRunInstance.instanceId);
  const operationalRunId = normalizeOptionalString(params.operationalRunInstance.runId);
  if (!operationalInstanceId || !operationalRunId) {
    throw new Error("agent runtime identity requires an operational run instance");
  }
  const parsedSessionSpawnContext = params.sessionSpawnContext
    ? sessionSpawnContextSchema.safeParse(params.sessionSpawnContext)
    : undefined;
  if (parsedSessionSpawnContext && !parsedSessionSpawnContext.success) {
    throw new Error("agent runtime session spawn context violates its bounded contract");
  }
  const sessionSpawnContext = parsedSessionSpawnContext?.data;
  const executionLineageHandoffId = normalizeOptionalString(params.executionLineageHandoffId);
  if (executionLineageHandoffId && (sessionSpawnContext || params.executionIdentityToken)) {
    throw new Error("execution lineage handoff cannot duplicate private spawn facts");
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
  if (params.turnSourceLocal === true && turnSourceChannel) {
    throw new Error("agent runtime turn source cannot be both local and channel-bound");
  }
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
    ...(params.turnSourceLocal === true ? { turnSourceLocal: true } : {}),
    ...(turnSourceTo ? { turnSourceTo } : {}),
    ...(turnSourceAccountId ? { turnSourceAccountId } : {}),
    ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
    ...(messageActionContext ? { messageActionContext } : {}),
    ...(cronSelfManagementContext ? { cronSelfManagementContext } : {}),
    ...(params.cronToolsAllowCapture === "final-executable-surface"
      ? { cronToolsAllowCapture: params.cronToolsAllowCapture }
      : {}),
    ...(params.cronToolsAllowCapture === "final-executable-surface" &&
    params.cronExecToolTarget?.host === "gateway"
      ? { cronExecToolTarget: { ...params.cronExecToolTarget } }
      : {}),
    ...(params.cronCreatorAuthorityGrant
      ? { cronCreatorAuthorityGrant: params.cronCreatorAuthorityGrant }
      : {}),
    ...(sessionSpawnContext ? { sessionSpawnContext } : {}),
    ...(executionLineageHandoffId ? { executionLineageHandoffId } : {}),
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
  const handoff = payload.executionLineageHandoffId
    ? redeemAgentRuntimeExecutionLineageHandoff({
        id: payload.executionLineageHandoffId,
        agentId: payload.agentId,
        sessionKey: payload.sessionKey,
        operationalRunInstance: payload.operationalRunInstance,
        delegatedAuthority: payload.delegatedAuthority,
      })
    : undefined;
  if (payload.executionLineageHandoffId && !handoff) {
    return undefined;
  }
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    operationalRunInstance: payload.operationalRunInstance,
    delegatedAuthority: payload.delegatedAuthority,
    ...(payload.approvalOwnerPluginId
      ? { approvalOwnerPluginId: payload.approvalOwnerPluginId }
      : {}),
    ...(handoff?.executionIdentity
      ? { executionIdentity: handoff.executionIdentity }
      : payload.executionIdentity
        ? { executionIdentity: payload.executionIdentity }
        : {}),
    ...(payload.turnSourceChannel ? { turnSourceChannel: payload.turnSourceChannel } : {}),
    ...(payload.turnSourceLocal === true ? { turnSourceLocal: true } : {}),
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
    ...(payload.cronExecToolTarget ? { cronExecToolTarget: payload.cronExecToolTarget } : {}),
    ...(payload.cronCreatorAuthorityGrant
      ? { cronCreatorAuthorityGrant: payload.cronCreatorAuthorityGrant }
      : {}),
    ...(handoff?.sessionSpawnContext
      ? { sessionSpawnContext: handoff.sessionSpawnContext }
      : payload.sessionSpawnContext
        ? { sessionSpawnContext: payload.sessionSpawnContext }
        : {}),
  };
  return handoff
    ? withAgentRuntimeExecutionLineageRedemption(identity, handoff.redemption)
    : identity;
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
  return (identity) => {
    if (!validateAgentRuntimeDelegatedAuthority(identity.delegatedAuthority, placements)) {
      return false;
    }
    const messageActionContext = identity.messageActionContext;
    if (!messageActionContext) {
      return true;
    }
    if (!messageActionContext.turnCapability) {
      return false;
    }
    return Boolean(
      resolveMessageActionTurnCapability({
        token: messageActionContext.turnCapability,
        agentId: identity.agentId,
        runId: identity.operationalRunInstance.runId,
        sessionKey: identity.sessionKey,
        sessionId: messageActionContext.sessionId,
      }),
    );
  };
}
