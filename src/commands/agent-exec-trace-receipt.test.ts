import { describe, expect, it } from "vitest";
import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import { extractAuditableProviderTransportAccountingSnapshot } from "../agents/provider-transport-accounting-audit.js";
import { createProviderTransportAccountingCollector } from "../agents/provider-transport-accounting.js";
import {
  projectAgentExecInvocationAuthority,
  projectAgentExecInvocationReceipt,
} from "./agent-exec-trace-receipt.js";
import {
  normalizeAgentExecInvocationReceipt,
  verifyAgentExecInvocationReceipt,
} from "./agent-exec-trace-schema.js";

const ROUTE = { provider: "openai", model: "gpt-test", api: "openai-responses" } as const;

function snapshot(
  overrides: Partial<NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>> = {},
): AgentCommandRunAccountingSnapshot {
  const collector = createProviderTransportAccountingCollector();
  const firstCall = { callId: "private-call-one", ...ROUTE };
  const secondCall = { callId: "private-call-two", ...ROUTE };
  collector.observer.onLogicalCallStarted(firstCall);
  collector.observer.onLogicalCallStarted(secondCall);
  const emit = (event: Parameters<typeof collector.observer.onTransportEvent>[0]) =>
    collector.observer.onTransportEvent(event);
  emit({
    eventId: "invocation-1",
    type: "invocation",
    ...firstCall,
    transport: "http",
    ordinal: 1,
    attemptOrdinal: 1,
    hopOrdinal: 1,
    reason: "initial",
  });
  emit({
    eventId: "invocation-2",
    type: "invocation",
    ...secondCall,
    transport: "http",
    ordinal: 1,
    attemptOrdinal: 1,
    hopOrdinal: 1,
    reason: "initial",
  });
  emit({
    eventId: "invocation-3",
    type: "invocation",
    ...firstCall,
    transport: "http",
    ordinal: 2,
    attemptOrdinal: 1,
    hopOrdinal: 2,
    reason: "initial",
  });
  emit({
    eventId: "attempt-1-1",
    type: "attempt",
    ...firstCall,
    transport: "http",
    ordinal: 1,
    reason: "initial",
    outcome: "failed",
  });
  emit({
    eventId: "attempt-2-1",
    type: "attempt",
    ...secondCall,
    transport: "http",
    ordinal: 1,
    reason: "initial",
    outcome: "completed",
  });
  emit({
    eventId: "invocation-4",
    type: "invocation",
    ...firstCall,
    transport: "http",
    ordinal: 3,
    attemptOrdinal: 2,
    hopOrdinal: 1,
    reason: "retry",
  });
  emit({
    eventId: "attempt-1-2",
    type: "attempt",
    ...firstCall,
    transport: "http",
    ordinal: 2,
    reason: "retry",
    outcome: "completed",
  });
  collector.observer.onLogicalCallSettled(firstCall.callId, "completed", {
    state: "exact",
    tokens: 0,
  });
  collector.observer.onLogicalCallSettled(secondCall.callId, "completed", {
    state: "exact",
    tokens: 0,
  });
  collector.finalize(firstCall.callId);
  collector.finalize(secondCall.callId);
  collector.seal();
  const projected = collector.project();
  if (!projected.snapshot || projected.coverage.state !== "complete") {
    throw new Error("expected complete provider transport fixture");
  }
  const providerTransport = {
    ...projected.snapshot,
    ...overrides,
  };
  const complete = { state: "complete" as const };
  return {
    candidates: {
      total: 1,
      returned: 1,
      threw: 0,
      runtimes: { embedded: 1, cli: 0, native: 0, cloud: 0, unknown: 0 },
      entries: [],
      truncated: 0,
    },
    commandExecutionDurationMs: 1,
    providerTransport,
    coverage: {
      candidates: complete,
      agentSubmissions: complete,
      modelCalls: complete,
      assistantTurns: complete,
      usage: complete,
      usageBuckets: {
        input: complete,
        output: complete,
        cacheRead: complete,
        cacheWrite: complete,
        reasoningTokens: complete,
        total: complete,
      },
      tools: complete,
      cost: complete,
      agentTime: complete,
      commandExecutionDuration: complete,
      wallLatency: complete,
      providerTransport: complete,
    },
  };
}

function zeroSubmissionSnapshot(): AgentCommandRunAccountingSnapshot {
  const collector = createProviderTransportAccountingCollector();
  const call = { callId: "private-zero-submission", ...ROUTE };
  collector.observer.onLogicalCallStarted(call);
  collector.observer.onTransportEvent({
    eventId: "zero-submission",
    type: "submission",
    ...call,
    transport: "http",
    total: 0,
    outcome: "failed",
    reason: "failed_before_submission",
  });
  collector.observer.onLogicalCallSettled(call.callId, "failed", {
    state: "exact",
    tokens: 0,
  });
  collector.finalize(call.callId);
  collector.seal();
  const projected = collector.project();
  if (!projected.snapshot || projected.coverage.state !== "complete") {
    throw new Error("expected complete zero-submission transport fixture");
  }
  const source = snapshot();
  source.providerTransport = projected.snapshot;
  source.coverage.providerTransport = projected.coverage;
  return source;
}

describe("projectAgentExecInvocationReceipt", () => {
  it("preserves global invocation order and hashes private call ids", () => {
    const receipt = projectAgentExecInvocationReceipt(snapshot());

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      complete: true,
      logicalCalls: 2,
      modelFacingApiCalls: 4,
      invocations: [
        { sequence: 1, logicalCallOrdinal: 1, attemptOrdinal: 1 },
        { sequence: 2, logicalCallOrdinal: 2, attemptOrdinal: 1 },
        {
          sequence: 3,
          logicalCallOrdinal: 1,
          attemptOrdinal: 1,
          hopOrdinal: 2,
        },
        { sequence: 4, logicalCallOrdinal: 1, attemptOrdinal: 2 },
      ],
    });
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(true);
    expect(verifyAgentExecInvocationReceipt(JSON.stringify(receipt))).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("private-call");
    expect(receipt?.calls.every((call) => /^[a-f0-9]{64}$/u.test(call.callIdSha256))).toBe(true);
  });

  it("marks a terminal logical call without an invocation inconclusive", () => {
    const authority = projectAgentExecInvocationAuthority(zeroSubmissionSnapshot());

    expect(authority.receipt).toMatchObject({
      complete: false,
      incompleteReasons: ["invocation_receipt_conservation_mismatch"],
      logicalCalls: 1,
      modelFacingApiCalls: 0,
      calls: [
        {
          ordinal: 1,
          finalized: true,
          outcome: "failed",
        },
      ],
      invocations: [],
    });
    expect(authority.providerTransport).toBeUndefined();
    const persisted = normalizeAgentExecInvocationReceipt(JSON.stringify(authority.receipt));
    expect(persisted).toMatchObject({
      complete: false,
      incompleteReasons: ["invocation_receipt_conservation_mismatch"],
      logicalCalls: 1,
      modelFacingApiCalls: 0,
    });
    expect(verifyAgentExecInvocationReceipt(JSON.stringify(authority.receipt))).toBe(true);
    expect(JSON.stringify(authority.receipt)).not.toContain("zeroSubmission");
    expect(JSON.stringify(authority.receipt)).not.toContain("Proof");
  });

  it("rejects invalid stored order instead of sorting or renumbering facts", () => {
    const source = snapshot();
    const invocations = source.providerTransport?.invocations?.entries;
    if (!invocations) {
      throw new Error("expected invocation ledger");
    }
    invocations[1] = { ...invocations[1]!, sequence: 3 };
    invocations[2] = { ...invocations[2]!, sequence: 2 };

    const receipt = projectAgentExecInvocationReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
  });

  it("marks event conservation mismatches incomplete", () => {
    const source = snapshot();
    source.providerTransport!.events = {
      total: 0,
      totalKind: "exact",
      entries: [],
      entriesTruncated: false,
    };

    const receipt = projectAgentExecInvocationReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      invocations: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(true);
  });

  it("closes invocation authority when cached-input evidence is malformed", () => {
    const source = snapshot();
    source.providerTransport!.logicalCalls.entries[0]!.cachedInput = {
      state: "exact",
      tokens: -1,
    };

    const authority = projectAgentExecInvocationAuthority(source);

    expect(authority.providerTransport).toBeUndefined();
    expect(authority.receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      invocations: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(verifyAgentExecInvocationReceipt(authority.receipt)).toBe(true);
  });

  it("rejects type-balanced event substitutions and foreign call identities", () => {
    const substituted = snapshot();
    const substitutedEvents = substituted.providerTransport!.events.entries;
    const attempt = substitutedEvents.find((event) => event.type === "attempt");
    const invocationIndex = substitutedEvents.findIndex((event) => event.type === "invocation");
    if (!attempt || invocationIndex < 0) {
      throw new Error("expected invocation and attempt events");
    }
    substitutedEvents[invocationIndex] = {
      ...attempt,
      eventId: "substituted-attempt",
    };

    const substitutedReceipt = projectAgentExecInvocationReceipt(substituted);

    expect(substitutedReceipt?.complete).toBe(false);
    expect(substitutedReceipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");

    const foreign = snapshot();
    const foreignInvocation = foreign.providerTransport!.events.entries.find(
      (event) => event.type === "invocation",
    );
    if (!foreignInvocation || foreignInvocation.type !== "invocation") {
      throw new Error("expected invocation event");
    }
    foreignInvocation.callId = "foreign-call";

    const foreignReceipt = projectAgentExecInvocationReceipt(foreign);

    expect(foreignReceipt?.complete).toBe(false);
    expect(foreignReceipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");
  });

  it("rejects duplicated events and unsettled fallback phases", () => {
    const duplicated = snapshot();
    const duplicatedEvents = duplicated.providerTransport!.events.entries;
    duplicatedEvents[1] = { ...duplicatedEvents[0]! };

    const duplicatedReceipt = projectAgentExecInvocationReceipt(duplicated);

    expect(duplicatedReceipt?.complete).toBe(false);
    expect(duplicatedReceipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");

    const unsettled = snapshot();
    const transport = unsettled.providerTransport!;
    transport.fallbacks = {
      total: 1,
      totalKind: "exact",
      unsupported: 1,
      connectionFailures: 0,
      submissionFailures: 0,
      streamFailures: 0,
      policy: 0,
    };
    transport.events.entries.push({
      eventId: "unsettled-fallback",
      type: "fallback",
      ...ROUTE,
      callId: "private-call-one",
      fromTransport: "http",
      toTransport: "websocket",
      reason: "unsupported",
    });
    transport.events.total += 1;

    const unsettledReceipt = projectAgentExecInvocationReceipt(unsettled);

    expect(unsettledReceipt?.complete).toBe(false);
    expect(unsettledReceipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");
  });

  it("rejects duplicate logical call identities despite balanced ledgers", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    const duplicate = transport.logicalCalls.entries[0]!.callId;
    const replaced = transport.logicalCalls.entries[1]!.callId;
    transport.logicalCalls.entries[1]!.callId = duplicate;
    for (const invocation of transport.invocations!.entries) {
      if (invocation.callId === replaced) {
        invocation.callId = duplicate;
      }
    }
    for (const event of transport.events.entries) {
      if ("callId" in event && event.callId === replaced) {
        event.callId = duplicate;
      }
    }

    const receipt = projectAgentExecInvocationReceipt(source);

    expect(receipt?.complete).toBe(false);
    expect(receipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");
    expect(receipt?.calls).toEqual([]);
  });

  it("rejects cross-call ordinal aliasing while preserving same-call physical hops", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    const secondCallInvocation = transport.invocations!.entries.find(
      (invocation) => invocation.logicalCallOrdinal === 2,
    );
    if (!secondCallInvocation) {
      throw new Error("expected second-call invocation");
    }
    secondCallInvocation.logicalCallOrdinal = 1;

    const receipt = projectAgentExecInvocationReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(
      snapshot().providerTransport?.invocations?.entries.filter(
        (invocation) => invocation.logicalCallOrdinal === 1 && invocation.attemptOrdinal === 1,
      ),
    ).toHaveLength(2);
  });

  it("bounds oversized ledgers and marks the receipt truncated", () => {
    const source = snapshot();
    const transport = source.providerTransport;
    if (!transport?.invocations) {
      throw new Error("expected provider transport");
    }
    const call = transport.logicalCalls.entries[0]!;
    transport.logicalCalls.entries = Array.from({ length: 65 }, (_, index) => ({
      ...call,
      ordinal: index + 1,
      callId: `hidden-${String(index + 1)}`,
    }));
    transport.logicalCalls.total = 65;
    transport.logicalCalls.completed = 65;
    transport.attempts.entries = transport.logicalCalls.entries.map((_entry, index) => ({
      logicalCallOrdinal: index + 1,
      ordinal: 1,
      transport: "http",
      reason: "initial",
      outcome: "completed",
    }));
    transport.attempts.total = 65;
    transport.attempts.initial = 65;
    transport.attempts.retries = 0;
    transport.invocations.entries = [
      ...transport.logicalCalls.entries.map((entry, index) => ({
        sequence: index + 1,
        logicalCallOrdinal: index + 1,
        callId: entry.callId,
        ...ROUTE,
        transport: "http",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "initial" as const,
      })),
      ...Array.from({ length: 64 }, (_, index) => ({
        sequence: index + 66,
        logicalCallOrdinal: 1,
        callId: "hidden-1",
        ...ROUTE,
        transport: "http",
        ordinal: index + 2,
        attemptOrdinal: 1,
        hopOrdinal: index + 2,
        reason: "initial" as const,
      })),
    ];
    transport.invocations.total = 129;

    const receipt = projectAgentExecInvocationReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      truncated: true,
      logicalCalls: 0,
    });
    expect(receipt?.invocations).toEqual([]);
    expect(receipt?.incompleteReasons).toEqual(
      expect.arrayContaining([
        "provider_event_conservation_mismatch",
        "transport_details_truncated",
      ]),
    );
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("hidden-");
  });

  it("returns a sealed incomplete receipt when transport accounting is unavailable", () => {
    const source = snapshot();
    source.providerTransport = undefined;
    source.coverage.providerTransport = { state: "unavailable", reasons: ["not_observed"] };

    const receipt = projectAgentExecInvocationReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      truncated: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      incompleteReasons: expect.arrayContaining([
        "invocation_route_not_singular",
        "provider_transport_not_observed",
      ]),
    });
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(true);
  });

  it.each([
    {
      label: "nested accessor",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        Object.defineProperty(transport.events.entries[0]!, "provider", {
          enumerable: true,
          get() {
            throw new Error("provider accessor");
          },
        });
        return transport;
      },
    },
    {
      label: "get proxy",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        return new Proxy(transport, {
          get() {
            throw new Error("get trap");
          },
        });
      },
    },
    {
      label: "ownKeys proxy",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        return new Proxy(transport, {
          ownKeys() {
            throw new Error("ownKeys trap");
          },
        });
      },
    },
    {
      label: "descriptor proxy",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        return new Proxy(transport, {
          getOwnPropertyDescriptor() {
            throw new Error("descriptor trap");
          },
        });
      },
    },
    {
      label: "prototype proxy",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        return new Proxy(transport, {
          getPrototypeOf() {
            throw new Error("prototype trap");
          },
        });
      },
    },
    {
      label: "cycle",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        Object.defineProperty(transport, "cycle", {
          enumerable: true,
          value: transport,
        });
        return transport;
      },
    },
  ])("seals hostile $label transport input without leaking raw facts", (testCase) => {
    const source = snapshot();
    const hostile = testCase.mutate(source.providerTransport!);
    Object.defineProperty(source, "providerTransport", {
      enumerable: true,
      value: hostile,
      writable: true,
    });

    const audit = extractAuditableProviderTransportAccountingSnapshot(
      hostile,
      source.coverage.providerTransport,
    );
    const receipt = projectAgentExecInvocationReceipt(source);

    expect(audit.snapshot).toBeUndefined();
    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      invocations: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("private-call");
  });

  it("seals a top-level provider transport accessor without invoking it", () => {
    const source = snapshot();
    const get = () => {
      throw new Error("transport accessor");
    };
    Object.defineProperty(source, "providerTransport", {
      enumerable: true,
      get,
    });

    const receipt = projectAgentExecInvocationReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      invocations: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(true);
  });

  it.each([
    {
      label: "unknown coverage reason",
      reasons: ["unknown_transport_reason"],
    },
    {
      label: "inconsistent truncation reason",
      reasons: ["transport_details_truncated"],
    },
  ])("seals invalid $label without throwing", ({ reasons }) => {
    const source = snapshot();
    source.coverage.providerTransport = {
      state: "partial",
      reasons,
    } as never;

    const receipt = projectAgentExecInvocationReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      truncated: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      invocations: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(receipt?.incompleteReasons).not.toContain(reasons[0]);
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(true);
  });

  it.each([
    {
      label: "returns undefined",
      seal: () => undefined,
    },
    {
      label: "throws",
      seal: () => {
        throw new Error("seal failed");
      },
    },
  ])("falls back to closed invalid authority when the primary sealer $label", ({ seal }) => {
    const authority = projectAgentExecInvocationAuthority(snapshot(), seal);

    expect(authority.providerTransport).toBeUndefined();
    expect(authority.receipt).toEqual(
      expect.objectContaining({
        complete: false,
        truncated: false,
        logicalCalls: 0,
        modelFacingApiCalls: 0,
        calls: [],
        invocations: [],
        incompleteReasons: ["invocation_receipt_conservation_mismatch"],
      }),
    );
    expect(verifyAgentExecInvocationReceipt(authority.receipt)).toBe(true);
  });
});
