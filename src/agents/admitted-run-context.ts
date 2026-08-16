/** Canonical operational instance and optional enabled execution-identity evidence. */
import { randomUUID } from "node:crypto";
import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import {
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionFacts,
  type ExecutionIdentityAdmissionToken,
} from "../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";

/** Operational lifecycle correlation. This is never identity or authorization evidence. */
export type OperationalRunInstanceRef = Readonly<{
  instanceId: string;
  runId: string;
}>;

/** Exact context carried by one admitted execution and every retry/fallback it owns. */
export type AdmittedRunContext = Readonly<{
  operationalRunInstance: OperationalRunInstanceRef;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
}>;

export type PreparedAgentRunAdmission = Readonly<{
  operationalRunInstance: OperationalRunInstanceRef;
  /** Exact post-prepare owner; repeated fallback/retry returns the same object. */
  admit: (
    runtimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"],
    runtimeInstanceId?: string,
  ) => Promise<AdmittedRunContext>;
  /** Idempotently closes the exact delegated approval lease, if admission occurred. */
  close: () => void;
}>;

type DelegatedAuthorityLease = {
  authority: AgentRunDelegatedAuthority;
  foregroundClosed: boolean;
  retained: boolean;
};

const delegatedAuthorityLeases = new WeakMap<AdmittedRunContext, DelegatedAuthorityLease>();

function bindAdmittedRunDelegatedAuthority(
  context: AdmittedRunContext,
): AgentRunDelegatedAuthority {
  const authority = claimAgentRunDelegatedAuthority(context.operationalRunInstance);
  delegatedAuthorityLeases.set(context, { authority, foregroundClosed: false, retained: false });
  return authority;
}

/** Reads the immutable outer-run authority without reviving a closed claim. */
export function getAdmittedRunDelegatedAuthority(
  context: AdmittedRunContext,
): AgentRunDelegatedAuthority | undefined {
  const lease = delegatedAuthorityLeases.get(context);
  return lease && !lease.foregroundClosed && validateAgentRunDelegatedAuthority(lease.authority)
    ? lease.authority
    : undefined;
}

/** Idempotently compare-releases the authority captured by this admission. */
export function closeAdmittedRunDelegatedAuthority(context: AdmittedRunContext): boolean {
  const lease = delegatedAuthorityLeases.get(context);
  if (!lease || lease.foregroundClosed) {
    return false;
  }
  lease.foregroundClosed = true;
  if (!lease.retained) {
    releaseAgentRunDelegatedAuthority(lease.authority);
  }
  return true;
}

/** Internal relay claim; it never revives the ordinary foreground lookup. */
export function retainAdmittedRunDelegatedAuthority(
  context: AdmittedRunContext,
): (() => void) | undefined {
  const lease = delegatedAuthorityLeases.get(context);
  if (!lease || lease.retained || !validateAgentRunDelegatedAuthority(lease.authority)) {
    return undefined;
  }
  lease.retained = true;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    lease.retained = false;
    if (lease.foregroundClosed) {
      releaseAgentRunDelegatedAuthority(lease.authority);
    }
  };
}

export function isRetainedAdmittedRunDelegatedAuthorityActive(
  context: AdmittedRunContext,
): boolean {
  const lease = delegatedAuthorityLeases.get(context);
  return Boolean(lease?.retained && validateAgentRunDelegatedAuthority(lease.authority));
}

type ExecutionIdentityRecoveryAdmission = Readonly<{
  /** Recovery retries never manufacture replacement identity when exact evidence is absent. */
  retryOnly: boolean;
  consume: (runId: string) => Readonly<{
    accepted: boolean;
    token?: ExecutionIdentityAdmissionToken;
  }>;
}>;

/** Creates a one-shot recovery admission owned by the durable recovery resolver. */
export function createExecutionIdentityRecoveryAdmission(params: {
  retryOnly: boolean;
  token?: ExecutionIdentityAdmissionToken;
}): ExecutionIdentityRecoveryAdmission {
  let consumed = false;
  return Object.freeze({
    retryOnly: params.retryOnly,
    consume: (runId: string) => {
      if (consumed) {
        return Object.freeze({ accepted: false });
      }
      consumed = true;
      const token = params.token?.runId === runId ? params.token : undefined;
      return Object.freeze({ accepted: true, ...(token ? { token } : {}) });
    },
  });
}

export function createOperationalRunInstanceRef(runId: string): OperationalRunInstanceRef {
  return Object.freeze({ instanceId: randomUUID(), runId });
}

/** Prepares a system-owned run without selecting its eventual execution runtime early. */
export function prepareSystemAgentRunAdmission(
  cfg: OpenClawConfig,
  runId: string,
  agentId: string,
  boundary: string,
): PreparedAgentRunAdmission {
  return prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId,
      ingress: { kind: "system", boundary, state: "present" },
    },
  });
}

/**
 * Freezes ingress facts before preparation while deferring allocation/capture until the
 * authoritative runtime owner is selected immediately before execution.
 */
export function prepareAgentRunAdmission(params: {
  cfg: OpenClawConfig;
  facts: Omit<ExecutionIdentityAdmissionFacts, "runtime">;
  operationalRunInstance: OperationalRunInstanceRef;
  recovery?: ExecutionIdentityRecoveryAdmission;
  onAdmitted?: (context: AdmittedRunContext) => void | Promise<void>;
}): PreparedAgentRunAdmission {
  const operationalRunInstance = params.operationalRunInstance;
  if (operationalRunInstance.runId !== params.facts.runId) {
    throw new Error("operational run instance disagrees with prepared admission");
  }
  let admittedRuntimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"] | undefined;
  let admittedRuntimeInstanceId: string | undefined;
  let admitted: Promise<AdmittedRunContext> | undefined;
  let admittedContext: AdmittedRunContext | undefined;
  let closed = false;
  return Object.freeze({
    operationalRunInstance,
    close: () => {
      closed = true;
      if (admittedContext) {
        closeAdmittedRunDelegatedAuthority(admittedContext);
      } else {
        void admitted?.then(closeAdmittedRunDelegatedAuthority).catch(() => undefined);
      }
    },
    admit: (runtimeKind, runtimeInstanceId) => {
      if (closed) {
        return Promise.reject(new Error("prepared execution context is already closed"));
      }
      // The first runtime that actually executes fixes the captured runtime fact.
      // Later fallback paths reuse this exact admission instead of recapturing identity.
      const fixedRuntimeKind = (admittedRuntimeKind ??= runtimeKind);
      admittedRuntimeInstanceId ??= runtimeInstanceId?.trim() || undefined;
      admitted ??= (async () => {
        const context = admitPreparedAgentRun({
          cfg: params.cfg,
          facts: { ...params.facts, runtime: { kind: fixedRuntimeKind } },
          operationalRunInstance,
          runtimeInstanceId: admittedRuntimeInstanceId,
          ...(params.recovery ? { recovery: params.recovery } : {}),
        });
        admittedContext = context;
        try {
          await params.onAdmitted?.(context);
          if (closed || !getAdmittedRunDelegatedAuthority(context)) {
            throw new Error("prepared execution authority closed during admission");
          }
          return context;
        } catch (error) {
          closeAdmittedRunDelegatedAuthority(context);
          throw error;
        }
      })();
      return admitted;
    },
  });
}

/** Resolves a host-only continuation or validates an already-admitted internal caller. */
export async function resolvePreparedRunAdmission(params: {
  runId: string;
  runtimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"];
  runtimeInstanceId?: string;
  admittedRunContext?: AdmittedRunContext;
  preparedRunAdmission?: PreparedAgentRunAdmission;
}): Promise<AdmittedRunContext> {
  if (params.admittedRunContext && params.preparedRunAdmission) {
    throw new Error("run cannot carry both prepared and admitted execution contexts");
  }
  const admitted = params.preparedRunAdmission
    ? await params.preparedRunAdmission.admit(params.runtimeKind, params.runtimeInstanceId)
    : params.admittedRunContext;
  if (!admitted || admitted.operationalRunInstance.runId !== params.runId) {
    throw new Error("prepared execution context is unavailable or disagrees with the run");
  }
  const lease = delegatedAuthorityLeases.get(admitted);
  if (lease && !getAdmittedRunDelegatedAuthority(admitted)) {
    throw new Error("prepared execution authority is no longer active");
  }
  return admitted;
}

function consumeRecoveryAdmission(params: {
  admission: ExecutionIdentityRecoveryAdmission | undefined;
  runId: string;
}): Readonly<{ accepted: boolean; token?: ExecutionIdentityAdmissionToken }> {
  const consumed: Readonly<{
    accepted: boolean;
    token?: ExecutionIdentityAdmissionToken;
  }> =
    typeof params.admission?.consume === "function"
      ? params.admission.consume(params.runId)
      : Object.freeze({ accepted: false });
  const token = consumed.token;
  if (!token) {
    return consumed;
  }
  return Object.freeze({
    accepted: consumed.accepted,
    token: Object.isFrozen(token) ? token : Object.freeze(token),
  });
}

/**
 * Owns the single post-prepare allocation/adoption/capture decision for an execution.
 * Queue loss remains audit loss only; the admitted execution keeps its exact token object.
 */
function admitPreparedAgentRun(params: {
  cfg: OpenClawConfig;
  facts: ExecutionIdentityAdmissionFacts;
  operationalRunInstance: OperationalRunInstanceRef;
  runtimeInstanceId?: string;
  recovery?: ExecutionIdentityRecoveryAdmission;
}): AdmittedRunContext {
  if (params.operationalRunInstance.runId !== params.facts.runId) {
    throw new Error("operational run instance disagrees with prepared admission");
  }
  const operationalRunInstance = params.operationalRunInstance;
  // Consume the one-shot recovery lease even while collection is disabled so a
  // later operational instance cannot adopt evidence that belonged to this run.
  const recovery = consumeRecoveryAdmission({
    admission: params.recovery,
    runId: params.facts.runId,
  });
  if (!isExecutionIdentityCollectionEnabled(params.cfg)) {
    const context = Object.freeze({ operationalRunInstance });
    bindAdmittedRunDelegatedAuthority(context);
    return context;
  }
  const executionIdentityToken =
    recovery.token ??
    (!params.recovery || (recovery.accepted && !params.recovery.retryOnly)
      ? createExecutionIdentityAdmissionToken(params.facts.runId)
      : undefined);
  if (!executionIdentityToken) {
    const context = Object.freeze({ operationalRunInstance });
    bindAdmittedRunDelegatedAuthority(context);
    return context;
  }

  enqueueExecutionIdentityContextAtAdmission(params.facts, {
    enabled: true,
    token: executionIdentityToken,
    runtimeInstanceId: params.runtimeInstanceId,
    retryOnly: params.recovery?.retryOnly === true,
  });
  const context = Object.freeze({ operationalRunInstance, executionIdentityToken });
  bindAdmittedRunDelegatedAuthority(context);
  return context;
}
