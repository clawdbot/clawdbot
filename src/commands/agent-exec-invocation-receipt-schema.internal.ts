import { AI_MODEL_TRANSPORT_ATTEMPT_REASONS } from "@openclaw/ai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  digest,
  hasKeys,
  MAX_CALLS,
  MAX_INVOCATIONS,
  MAX_RECEIPT_BYTES,
  isolatePlainDataForPersistence,
  normalizePlainData,
  normalizeReasons,
  parseBoundedJson,
  parseRoute,
  RECEIPT_SCHEMA_VERSION,
  safeInteger,
  safeLabel,
  SHA256_PATTERN,
  sortedKnownReasons,
  type SchemaRoute as Route,
} from "./agent-exec-trace-schema-support.js";

export type AgentExecInvocationReceipt = {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  kind: "transport_invocation_receipt";
  complete: boolean;
  truncated: boolean;
  incompleteReasons: string[];
  route?: Route;
  logicalCalls: number;
  modelFacingApiCalls: number;
  calls: Array<{
    ordinal: number;
    callIdSha256: string;
    outcome?: "completed" | "failed" | "aborted";
    finalized: boolean;
  }>;
  invocations: Array<{
    sequence: number;
    logicalCallOrdinal: number;
    attemptOrdinal: number;
    hopOrdinal: number;
    reason: (typeof AI_MODEL_TRANSPORT_ATTEMPT_REASONS)[number];
    transport: string;
  }>;
  sha256: string;
};

export type AgentExecInvocationReceiptContents = Omit<
  AgentExecInvocationReceipt,
  "schemaVersion" | "kind" | "sha256"
>;

const trustedReceipts = new WeakSet<object>();

export function trustAgentExecInvocationReceipt(receipt: AgentExecInvocationReceipt): void {
  trustedReceipts.add(receipt);
}

function parseReceiptContents(
  value: unknown,
): Omit<AgentExecInvocationReceipt, "sha256"> | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      "schemaVersion",
      "kind",
      "complete",
      "truncated",
      "incompleteReasons",
      ...(value.route === undefined ? [] : ["route"]),
      "logicalCalls",
      "modelFacingApiCalls",
      "calls",
      "invocations",
    ]) ||
    value.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    value.kind !== "transport_invocation_receipt" ||
    typeof value.complete !== "boolean" ||
    typeof value.truncated !== "boolean" ||
    !sortedKnownReasons(value.incompleteReasons, true) ||
    !safeInteger(value.logicalCalls) ||
    !safeInteger(value.modelFacingApiCalls) ||
    !Array.isArray(value.calls) ||
    value.calls.length > MAX_CALLS ||
    !Array.isArray(value.invocations) ||
    value.invocations.length > MAX_INVOCATIONS
  ) {
    return undefined;
  }
  const route = value.route === undefined ? undefined : parseRoute(value.route, false);
  if (value.route !== undefined && !route) {
    return undefined;
  }
  const calls: AgentExecInvocationReceipt["calls"] = [];
  for (const [index, call] of value.calls.entries()) {
    if (
      !isRecord(call) ||
      !hasKeys(call, [
        "ordinal",
        "callIdSha256",
        ...(call.outcome === undefined ? [] : ["outcome"]),
        "finalized",
      ]) ||
      call.ordinal !== index + 1 ||
      typeof call.callIdSha256 !== "string" ||
      !SHA256_PATTERN.test(call.callIdSha256) ||
      typeof call.finalized !== "boolean" ||
      (call.outcome !== undefined &&
        call.outcome !== "completed" &&
        call.outcome !== "failed" &&
        call.outcome !== "aborted")
    ) {
      return undefined;
    }
    calls.push({
      ordinal: call.ordinal,
      callIdSha256: call.callIdSha256,
      ...(call.outcome ? { outcome: call.outcome } : {}),
      finalized: call.finalized,
    });
  }
  const invocations: AgentExecInvocationReceipt["invocations"] = [];
  const perCall = new Map<
    number,
    { attempt: number; hop: number; reason: string; transport: string }
  >();
  const counts = new Map<number, number>();
  for (const [index, invocation] of value.invocations.entries()) {
    if (
      !isRecord(invocation) ||
      !hasKeys(invocation, [
        "sequence",
        "logicalCallOrdinal",
        "attemptOrdinal",
        "hopOrdinal",
        "reason",
        "transport",
      ]) ||
      invocation.sequence !== index + 1 ||
      !safeInteger(invocation.logicalCallOrdinal) ||
      invocation.logicalCallOrdinal < 1 ||
      invocation.logicalCallOrdinal > calls.length ||
      !safeInteger(invocation.attemptOrdinal) ||
      invocation.attemptOrdinal < 1 ||
      !safeInteger(invocation.hopOrdinal) ||
      invocation.hopOrdinal < 1 ||
      !AI_MODEL_TRANSPORT_ATTEMPT_REASONS.includes(
        invocation.reason as (typeof AI_MODEL_TRANSPORT_ATTEMPT_REASONS)[number],
      ) ||
      !safeLabel(invocation.transport)
    ) {
      return undefined;
    }
    const prior = perCall.get(invocation.logicalCallOrdinal);
    if (
      (!prior &&
        (invocation.attemptOrdinal !== 1 ||
          invocation.hopOrdinal !== 1 ||
          invocation.reason !== "initial")) ||
      (prior &&
        !(
          (invocation.attemptOrdinal === prior.attempt &&
            invocation.hopOrdinal === prior.hop + 1 &&
            invocation.reason === prior.reason &&
            invocation.transport === prior.transport) ||
          (invocation.attemptOrdinal === prior.attempt + 1 &&
            invocation.hopOrdinal === 1 &&
            invocation.reason !== "initial")
        ))
    ) {
      return undefined;
    }
    const reason = invocation.reason as AgentExecInvocationReceipt["invocations"][number]["reason"];
    perCall.set(invocation.logicalCallOrdinal, {
      attempt: invocation.attemptOrdinal,
      hop: invocation.hopOrdinal,
      reason,
      transport: invocation.transport,
    });
    counts.set(invocation.logicalCallOrdinal, (counts.get(invocation.logicalCallOrdinal) ?? 0) + 1);
    invocations.push({
      sequence: invocation.sequence,
      logicalCallOrdinal: invocation.logicalCallOrdinal,
      attemptOrdinal: invocation.attemptOrdinal,
      hopOrdinal: invocation.hopOrdinal,
      reason,
      transport: invocation.transport,
    });
  }
  if (
    value.logicalCalls !== calls.length ||
    value.modelFacingApiCalls !== invocations.length ||
    value.truncated !== value.incompleteReasons.some((reason) => reason.includes("truncated")) ||
    (value.complete &&
      (value.truncated ||
        value.incompleteReasons.length > 0 ||
        !route ||
        calls.length === 0 ||
        calls.some((call) => !call.outcome || !call.finalized || !counts.has(call.ordinal)))) ||
    (!value.complete && value.incompleteReasons.length === 0)
  ) {
    return undefined;
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: "transport_invocation_receipt",
    complete: value.complete,
    truncated: value.truncated,
    incompleteReasons: [...value.incompleteReasons],
    ...(route ? { route: route as Route } : {}),
    logicalCalls: value.logicalCalls,
    modelFacingApiCalls: value.modelFacingApiCalls,
    calls,
    invocations,
  };
}

export function normalizeAgentExecInvocationReceiptData(
  value: unknown,
): AgentExecInvocationReceipt | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      "schemaVersion",
      "kind",
      "complete",
      "truncated",
      "incompleteReasons",
      ...(value.route === undefined ? [] : ["route"]),
      "logicalCalls",
      "modelFacingApiCalls",
      "calls",
      "invocations",
      "sha256",
    ])
  ) {
    return undefined;
  }
  const { sha256, ...rawContents } = value;
  const contents = parseReceiptContents(rawContents);
  if (
    !contents ||
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256) ||
    sha256 !== digest("openclaw.agent-exec.invocation-receipt.v2", contents)
  ) {
    return undefined;
  }
  const receipt = isolatePlainDataForPersistence({
    ...contents,
    sha256,
  }) as AgentExecInvocationReceipt;
  trustAgentExecInvocationReceipt(receipt);
  return receipt;
}

export function normalizeAgentExecInvocationReceipt(
  value: unknown,
): AgentExecInvocationReceipt | undefined {
  if (value !== null && typeof value === "object" && trustedReceipts.has(value)) {
    return value as AgentExecInvocationReceipt;
  }
  const parsed = parseBoundedJson(value, MAX_RECEIPT_BYTES);
  const data = parsed === undefined ? undefined : normalizePlainData(parsed, MAX_RECEIPT_BYTES);
  return data === undefined ? undefined : normalizeAgentExecInvocationReceiptData(data);
}

export function verifyAgentExecInvocationReceipt(value: unknown): boolean {
  return normalizeAgentExecInvocationReceipt(value) !== undefined;
}

export function sealAgentExecInvocationReceipt(
  input: AgentExecInvocationReceiptContents,
): AgentExecInvocationReceipt | undefined {
  const candidate = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: "transport_invocation_receipt" as const,
    ...input,
    incompleteReasons: normalizeReasons(input.incompleteReasons),
  };
  const contents = parseReceiptContents(candidate);
  if (!contents) {
    return undefined;
  }
  const receipt = isolatePlainDataForPersistence({
    ...contents,
    sha256: digest("openclaw.agent-exec.invocation-receipt.v2", contents),
  }) as AgentExecInvocationReceipt;
  trustAgentExecInvocationReceipt(receipt);
  return receipt;
}
