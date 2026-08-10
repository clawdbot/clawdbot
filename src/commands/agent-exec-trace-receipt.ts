import { createHash } from "node:crypto";
import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import { extractAuditableProviderTransportAccountingSnapshot } from "../agents/provider-transport-accounting-audit.js";
import {
  sealAgentExecInvocationReceipt,
  type AgentExecInvocationReceipt,
  type AgentExecInvocationReceiptContents,
} from "./agent-exec-invocation-receipt-schema.internal.js";
import { MAX_CALLS, MAX_INVOCATIONS, safeLabel } from "./agent-exec-trace-schema-support.js";

type Transport = NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>;
type SourceCall = Transport["logicalCalls"]["entries"][number];
type SourceInvocation = NonNullable<Transport["invocations"]>["entries"][number];
type SealInvocationReceipt = typeof sealAgentExecInvocationReceipt;

export type AgentExecInvocationAuthority = {
  receipt?: AgentExecInvocationReceipt;
  providerTransport?: Transport;
};

type CapturedProviderTransport = {
  valid: boolean;
  transport?: unknown;
  coverage?: unknown;
};

function readOwnDataProperty(value: unknown, key: string): { ok: boolean; value?: unknown } {
  if (!value || typeof value !== "object") {
    return { ok: false };
  }
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor
      ? { ok: true, value: descriptor.value }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function captureProviderTransport(snapshot: unknown): CapturedProviderTransport {
  const transport = readOwnDataProperty(snapshot, "providerTransport");
  const coverageContainer = readOwnDataProperty(snapshot, "coverage");
  const coverage = coverageContainer.ok
    ? readOwnDataProperty(coverageContainer.value, "providerTransport")
    : { ok: false };
  return {
    valid: transport.ok && coverage.ok,
    ...(transport.ok ? { transport: transport.value } : {}),
    ...(coverage.ok ? { coverage: coverage.value } : {}),
  };
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hashCallId(callId: string): string {
  return createHash("sha256").update(callId).digest("hex");
}

function projectRoute(
  calls: readonly SourceCall[],
  invocations: readonly SourceInvocation[],
  reasons: Set<string>,
): AgentExecInvocationReceipt["route"] | undefined {
  const first = calls[0];
  const route = first
    ? { provider: first.provider, model: first.model, api: first.api }
    : undefined;
  if (
    !route ||
    !safeLabel(route.provider) ||
    !safeLabel(route.model) ||
    !safeLabel(route.api) ||
    calls.some(
      (call) =>
        call.provider !== route.provider || call.model !== route.model || call.api !== route.api,
    ) ||
    invocations.some(
      (invocation) =>
        invocation.provider !== route.provider ||
        invocation.model !== route.model ||
        invocation.api !== route.api,
    )
  ) {
    reasons.add("invocation_route_not_singular");
    return undefined;
  }
  return route;
}

function projectInvocations(
  calls: readonly SourceCall[],
  source: readonly SourceInvocation[],
  reasons: Set<string>,
): AgentExecInvocationReceipt["invocations"] | undefined {
  const callsByOrdinal = new Map(calls.slice(0, MAX_CALLS).map((call) => [call.ordinal, call]));
  const projected: AgentExecInvocationReceipt["invocations"] = [];
  for (const [index, invocation] of source.slice(0, MAX_INVOCATIONS).entries()) {
    const call = callsByOrdinal.get(invocation.logicalCallOrdinal);
    if (!call && calls.length > MAX_CALLS && invocation.logicalCallOrdinal > MAX_CALLS) {
      break;
    }
    if (
      invocation.sequence !== index + 1 ||
      !call ||
      invocation.callId !== call.callId ||
      !safeLabel(invocation.transport)
    ) {
      reasons.add(
        invocation.sequence !== index + 1
          ? "invocation_global_sequence_invalid"
          : "invocation_orphan_fact",
      );
      return undefined;
    }
    projected.push({
      sequence: invocation.sequence,
      logicalCallOrdinal: invocation.logicalCallOrdinal,
      attemptOrdinal: invocation.attemptOrdinal,
      hopOrdinal: invocation.hopOrdinal,
      reason: invocation.reason,
      transport: invocation.transport,
    });
  }
  return projected;
}

export function projectAgentExecInvocationAuthority(
  snapshot: AgentCommandRunAccountingSnapshot | undefined,
  sealReceipt: SealInvocationReceipt = sealAgentExecInvocationReceipt,
): AgentExecInvocationAuthority {
  if (!snapshot) {
    return {};
  }
  const captured = captureProviderTransport(snapshot);
  const reasons = new Set<string>();
  const audit = captured.valid
    ? extractAuditableProviderTransportAccountingSnapshot(captured.transport, captured.coverage)
    : { truncated: false };
  if (!captured.valid) {
    reasons.add("provider_event_conservation_mismatch");
  } else if (captured.transport === undefined) {
    reasons.add("provider_transport_not_observed");
  } else if (audit.coverage?.state !== "complete") {
    for (const reason of audit.coverage?.reasons ?? []) {
      reasons.add(reason);
    }
  }
  const canonical = audit.snapshot;
  if (captured.transport !== undefined && !canonical) {
    reasons.add("provider_event_conservation_mismatch");
  }

  const sourceCalls = canonical?.logicalCalls.entries ?? [];
  const sourceInvocations = canonical?.invocations?.entries ?? [];
  const route = projectRoute(sourceCalls, sourceInvocations, reasons);
  const invocationCounts = new Map<number, number>();
  for (const invocation of sourceInvocations) {
    invocationCounts.set(
      invocation.logicalCallOrdinal,
      (invocationCounts.get(invocation.logicalCallOrdinal) ?? 0) + 1,
    );
  }
  const calls: AgentExecInvocationReceiptContents["calls"] = sourceCalls
    .slice(0, MAX_CALLS)
    .map((call) => ({
      ordinal: call.ordinal!,
      callIdSha256: hashCallId(call.callId),
      finalized: true,
      outcome: call.outcome!,
    }));
  const invocations = projectInvocations(sourceCalls, sourceInvocations, reasons);
  const truncated = audit.truncated;
  if (truncated) {
    reasons.add("transport_details_truncated");
  }
  let incompleteReasons = [...reasons].toSorted(bytewiseCompare);
  let contents: AgentExecInvocationReceiptContents = {
    complete: incompleteReasons.length === 0,
    truncated,
    incompleteReasons,
    ...(route ? { route } : {}),
    logicalCalls: calls.length,
    modelFacingApiCalls: invocations?.length ?? 0,
    calls,
    invocations: invocations ?? [],
  };
  const hasMissingInvocation = calls.some((call) => !invocationCounts.has(call.ordinal));
  if (hasMissingInvocation) {
    reasons.add("invocation_receipt_conservation_mismatch");
    incompleteReasons = [...reasons].toSorted(bytewiseCompare);
    contents = {
      ...contents,
      complete: false,
      incompleteReasons,
    };
  }
  let receipt: AgentExecInvocationReceipt | undefined;
  try {
    receipt = sealReceipt(contents);
  } catch {
    // A rejected seal is not producer evidence. Fall through to the closed
    // invalid-authority receipt so consumers cannot project partial raw facts.
  }
  receipt ??= sealAgentExecInvocationReceipt({
    complete: false,
    truncated: false,
    incompleteReasons: ["invocation_receipt_conservation_mismatch"],
    logicalCalls: 0,
    modelFacingApiCalls: 0,
    calls: [],
    invocations: [],
  });
  return {
    ...(receipt ? { receipt } : {}),
    ...(receipt?.complete && canonical ? { providerTransport: canonical } : {}),
  };
}

export function projectAgentExecInvocationReceipt(
  snapshot: AgentCommandRunAccountingSnapshot | undefined,
): AgentExecInvocationReceipt | undefined {
  return projectAgentExecInvocationAuthority(snapshot).receipt;
}
