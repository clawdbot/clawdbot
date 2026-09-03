import { isRecord } from "@openclaw/normalization-core/record-coerce";
/** Private, bounded decision work projected by the canonical audit writer. */
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { validateDecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { pseudonymizeExecutionIdentityRef } from "./audit-identity.js";
import { recordExecutionDecisionFact } from "./execution-decision-facts.js";
import {
  parseExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionToken,
} from "./execution-identity-admission.js";

const EXECUTION_DECISION_WORK_MAX_BYTES = 16 * 1024;
const EXECUTION_DECISION_RAW_REF_MAX_LENGTH = 4_096;

type ExecutionDecisionReceiptFacts = Omit<
  DecisionReceiptV1,
  "contextId" | "executionId" | "runId" | "action"
> & {
  action: Omit<DecisionReceiptV1["action"], "resourceRef" | "targetRef">;
};

type ExecutionDecisionResourceRef = {
  namespace: "credential-profile";
  value: string;
};

type ExecutionDecisionTargetRef = {
  namespace: "model-route" | "session";
  value: string;
};

export type ExecutionDecisionWork = {
  workVersion: 1;
  token: ExecutionIdentityAdmissionToken;
  receipt: ExecutionDecisionReceiptFacts;
  refs?: {
    resource?: ExecutionDecisionResourceRef;
    target?: ExecutionDecisionTargetRef;
  };
};

type ExecutionDecisionWorkSink = (work: ExecutionDecisionWork) => boolean;

const state = resolveGlobalSingleton<{ sink: ExecutionDecisionWorkSink | undefined }>(
  Symbol.for("openclaw.executionDecisionWorkSink"),
  () => ({ sink: undefined }),
);

function isClosedPayloadRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function parseRawRef<TNamespace extends string>(params: {
  value: unknown;
  namespaces: readonly TNamespace[];
}): { namespace: TNamespace; value: string } {
  if (
    !isClosedPayloadRecord(params.value) ||
    !hasOnlyKeys(params.value, ["namespace", "value"]) ||
    typeof params.value.namespace !== "string" ||
    // SAFETY: membership in the caller's readonly namespace set narrows this string to TNamespace.
    !params.namespaces.includes(params.value.namespace as TNamespace) ||
    typeof params.value.value !== "string" ||
    params.value.value.length < 1 ||
    params.value.value.length > EXECUTION_DECISION_RAW_REF_MAX_LENGTH
  ) {
    throw new Error("execution decision work violates its bounded ref contract");
  }
  return {
    // SAFETY: the membership check above proved this value belongs to the TNamespace set.
    namespace: params.value.namespace as TNamespace,
    value: params.value.value,
  };
}

function buildReceipt(params: {
  token: ExecutionIdentityAdmissionToken;
  receipt: ExecutionDecisionReceiptFacts;
  resourceRef?: string;
  targetRef?: string;
}): DecisionReceiptV1 {
  return {
    ...params.receipt,
    contextId: params.token.contextId,
    executionId: params.token.executionId,
    runId: params.token.runId,
    action: {
      ...params.receipt.action,
      ...(params.resourceRef ? { resourceRef: params.resourceRef } : {}),
      ...(params.targetRef ? { targetRef: params.targetRef } : {}),
    },
  };
}

/** Revalidate closed work before queue cloning, key access, or database access. */
export function parseExecutionDecisionWork(value: unknown): ExecutionDecisionWork {
  if (
    !isClosedPayloadRecord(value) ||
    !hasOnlyKeys(value, ["workVersion", "token", "receipt", "refs"]) ||
    value.workVersion !== 1 ||
    !isClosedPayloadRecord(value.receipt) ||
    !hasOnlyKeys(value.receipt, [
      "schemaVersion",
      "receiptId",
      "actionId",
      "occurredAt",
      "action",
      "decision",
      "enforcement",
      "source",
      "missingEvidence",
      "remediation",
    ]) ||
    !isClosedPayloadRecord(value.receipt.action) ||
    !hasOnlyKeys(value.receipt.action, ["family", "operation", "summary"])
  ) {
    throw new Error("execution decision work violates its bounded contract");
  }
  const token = parseExecutionIdentityAdmissionToken(value.token);
  let refs: ExecutionDecisionWork["refs"];
  if (value.refs !== undefined) {
    if (!isClosedPayloadRecord(value.refs) || !hasOnlyKeys(value.refs, ["resource", "target"])) {
      throw new Error("execution decision work violates its bounded ref contract");
    }
    refs = {
      ...(value.refs.resource !== undefined
        ? {
            resource: parseRawRef({
              value: value.refs.resource,
              namespaces: ["credential-profile"] as const,
            }),
          }
        : {}),
      ...(value.refs.target !== undefined
        ? {
            target: parseRawRef({
              value: value.refs.target,
              namespaces: ["model-route", "session"] as const,
            }),
          }
        : {}),
    };
  }
  // SAFETY: closed key checks above and DecisionReceiptV1 validation below prove this private shape.
  const receipt = value.receipt as ExecutionDecisionReceiptFacts;
  const candidate = buildReceipt({
    token,
    receipt,
    ...(refs?.resource ? { resourceRef: "private-resource-ref" } : {}),
    ...(refs?.target ? { targetRef: "private-target-ref" } : {}),
  });
  if (!validateDecisionReceiptV1(candidate)) {
    throw new Error("execution decision work receipt violates DecisionReceiptV1");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > EXECUTION_DECISION_WORK_MAX_BYTES) {
    throw new Error("execution decision work exceeds 16 KiB");
  }
  return {
    workVersion: 1,
    token,
    receipt,
    ...(refs ? { refs } : {}),
  };
}

/** Project raw private refs at the audit owner, then persist only the bounded receipt. */
export function processExecutionDecisionWork(
  value: unknown,
  options: OpenClawStateDatabaseOptions = {},
): "inserted" | "existing" {
  const work = parseExecutionDecisionWork(value);
  const db = openOpenClawStateDatabase(options).db;
  const resourceRef = work.refs?.resource
    ? pseudonymizeExecutionIdentityRef({
        db,
        kind: "credential",
        scope: work.refs.resource.namespace,
        value: work.refs.resource.value,
      })
    : undefined;
  const targetRef = work.refs?.target
    ? pseudonymizeExecutionIdentityRef({
        db,
        kind: "target",
        scope: work.refs.target.namespace,
        value: work.refs.target.value,
      })
    : undefined;
  const receipt = buildReceipt({
    token: work.token,
    receipt: work.receipt,
    ...(resourceRef ? { resourceRef } : {}),
    ...(targetRef ? { targetRef } : {}),
  });
  if (!validateDecisionReceiptV1(receipt)) {
    throw new Error("execution decision work projection violates DecisionReceiptV1");
  }
  return recordExecutionDecisionFact(receipt, options);
}

/** Install the current process writer sink; callers never create a second writer. */
export function configureExecutionDecisionWorkSink(sink: ExecutionDecisionWorkSink): () => void {
  state.sink = sink;
  return () => {
    if (state.sink === sink) {
      state.sink = undefined;
    }
  };
}

/** Offer one private work item to the lifecycle-owned FIFO. */
export function recordExecutionDecisionWork(work: ExecutionDecisionWork): boolean {
  return state.sink?.(work) ?? false;
}
