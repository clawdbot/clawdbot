import { describe, expect, it } from "vitest";
import { extractAuditableProviderTransportAccountingSnapshot } from "./provider-transport-accounting-audit.js";
import { createProviderTransportAccountingCollector } from "./provider-transport-accounting.js";
import type {
  ProviderTransportAccountingCoverage,
  ProviderTransportAccountingSnapshot,
} from "./provider-transport-accounting.types.js";

const ROUTE = { provider: "openai", model: "gpt-test", api: "openai-responses" } as const;

function projectComplete(
  build: (collector: ReturnType<typeof createProviderTransportAccountingCollector>) => void,
): {
  snapshot: ProviderTransportAccountingSnapshot;
  coverage: ProviderTransportAccountingCoverage;
} {
  const collector = createProviderTransportAccountingCollector();
  build(collector);
  collector.seal();
  const projected = collector.project();
  if (!projected.snapshot || projected.coverage.state !== "complete") {
    throw new Error(`expected complete fixture: ${JSON.stringify(projected.coverage)}`);
  }
  return {
    snapshot: projected.snapshot,
    coverage: projected.coverage,
  };
}

function retryFixture() {
  return projectComplete((collector) => {
    const first = { callId: "call-one", ...ROUTE };
    const second = { callId: "call-two", ...ROUTE };
    collector.observer.onLogicalCallStarted(first);
    collector.observer.onLogicalCallStarted(second);
    for (const event of [
      {
        eventId: "invocation-1",
        type: "invocation" as const,
        ...first,
        transport: "http",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "initial" as const,
      },
      {
        eventId: "invocation-2",
        type: "invocation" as const,
        ...second,
        transport: "http",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "initial" as const,
      },
      {
        eventId: "invocation-3",
        type: "invocation" as const,
        ...first,
        transport: "http",
        ordinal: 2,
        attemptOrdinal: 1,
        hopOrdinal: 2,
        reason: "initial" as const,
      },
      {
        eventId: "attempt-1-1",
        type: "attempt" as const,
        ...first,
        transport: "http",
        ordinal: 1,
        reason: "initial" as const,
        outcome: "failed" as const,
      },
      {
        eventId: "attempt-2-1",
        type: "attempt" as const,
        ...second,
        transport: "http",
        ordinal: 1,
        reason: "initial" as const,
        outcome: "completed" as const,
      },
      {
        eventId: "invocation-4",
        type: "invocation" as const,
        ...first,
        transport: "http",
        ordinal: 3,
        attemptOrdinal: 2,
        hopOrdinal: 1,
        reason: "retry" as const,
      },
      {
        eventId: "attempt-1-2",
        type: "attempt" as const,
        ...first,
        transport: "http",
        ordinal: 2,
        reason: "retry" as const,
        outcome: "completed" as const,
      },
    ]) {
      collector.observer.onTransportEvent(event);
    }
    collector.observer.onLogicalCallSettled(first.callId, "completed", {
      state: "exact",
      tokens: 1,
    });
    collector.observer.onLogicalCallSettled(second.callId, "completed", {
      state: "exact",
      tokens: 2,
    });
    collector.finalize(first.callId);
    collector.finalize(second.callId);
  });
}

function fallbackFixture() {
  return projectComplete((collector) => {
    const call = { callId: "fallback-call", ...ROUTE };
    collector.observer.onLogicalCallStarted(call);
    for (const event of [
      {
        eventId: "invocation-1",
        type: "invocation" as const,
        ...call,
        transport: "http",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "initial" as const,
      },
      {
        eventId: "attempt-1",
        type: "attempt" as const,
        ...call,
        transport: "http",
        ordinal: 1,
        reason: "initial" as const,
        outcome: "failed" as const,
      },
      {
        eventId: "fallback-1",
        type: "fallback" as const,
        ...call,
        fromTransport: "http",
        toTransport: "websocket",
        reason: "stream_failure" as const,
      },
      {
        eventId: "invocation-2",
        type: "invocation" as const,
        ...call,
        transport: "websocket",
        ordinal: 2,
        attemptOrdinal: 2,
        hopOrdinal: 1,
        reason: "transport_fallback" as const,
      },
      {
        eventId: "attempt-2",
        type: "attempt" as const,
        ...call,
        transport: "websocket",
        ordinal: 2,
        reason: "transport_fallback" as const,
        outcome: "completed" as const,
      },
    ]) {
      collector.observer.onTransportEvent(event);
    }
    collector.observer.onLogicalCallSettled(call.callId, "completed");
    collector.finalize(call.callId);
  });
}

function providerFallbackFixture() {
  return projectComplete((collector) => {
    const call = { callId: "provider-fallback-call", ...ROUTE };
    collector.observer.onLogicalCallStarted(call);
    collector.observer.onTransportEvent({
      eventId: "provider-fallback-1",
      type: "provider_fallback",
      ...call,
      transport: "http",
      fromModel: "gpt-test",
      toModel: "gpt-served-one",
    });
    collector.observer.onTransportEvent({
      eventId: "provider-fallback-2",
      type: "provider_fallback",
      ...call,
      transport: "http",
      fromModel: "gpt-served-one",
      toModel: "gpt-served-two",
    });
    collector.observer.onTransportEvent({
      eventId: "invocation-1",
      type: "invocation",
      ...call,
      transport: "http",
      ordinal: 1,
      attemptOrdinal: 1,
      hopOrdinal: 1,
      reason: "initial",
    });
    collector.observer.onTransportEvent({
      eventId: "attempt-1",
      type: "attempt",
      ...call,
      transport: "http",
      ordinal: 1,
      reason: "initial",
      outcome: "completed",
    });
    collector.observer.onLogicalCallSettled(call.callId, "completed");
    collector.finalize(call.callId);
  });
}

function cloneSnapshot(
  fixture: ReturnType<typeof retryFixture>,
): ProviderTransportAccountingSnapshot {
  return structuredClone(fixture.snapshot);
}

describe("extractAuditableProviderTransportAccountingSnapshot", () => {
  it("accepts canonical interleaved retry, fallback, and provider-fallback lifecycles", () => {
    for (const fixture of [retryFixture(), fallbackFixture(), providerFallbackFixture()]) {
      expect(
        extractAuditableProviderTransportAccountingSnapshot(fixture.snapshot, fixture.coverage),
      ).toMatchObject({
        snapshot: fixture.snapshot,
        coverage: fixture.coverage,
        truncated: false,
      });
    }
  });

  it("accepts the same event id in independent call scopes", () => {
    const fixture = retryFixture();
    fixture.snapshot.events.entries[1]!.eventId = fixture.snapshot.events.entries[0]!.eventId;

    expect(
      extractAuditableProviderTransportAccountingSnapshot(fixture.snapshot, fixture.coverage),
    ).toMatchObject({
      snapshot: fixture.snapshot,
      coverage: fixture.coverage,
      truncated: false,
    });
  });

  it("accepts only canonical exact-zero and unknown cached-input observations", () => {
    const fixture = retryFixture();
    fixture.snapshot.logicalCalls.entries[0]!.cachedInput = { state: "exact", tokens: 0 };
    fixture.snapshot.logicalCalls.entries[1]!.cachedInput = { state: "unknown" };

    expect(
      extractAuditableProviderTransportAccountingSnapshot(fixture.snapshot, fixture.coverage),
    ).toMatchObject({
      snapshot: fixture.snapshot,
      coverage: fixture.coverage,
      truncated: false,
    });
  });

  it.each([
    { label: "negative tokens", cachedInput: { state: "exact", tokens: -1 } },
    { label: "fractional tokens", cachedInput: { state: "exact", tokens: 0.5 } },
    {
      label: "unsafe integer tokens",
      cachedInput: { state: "exact", tokens: Number.MAX_SAFE_INTEGER + 1 },
    },
    { label: "missing tokens", cachedInput: { state: "exact" } },
    { label: "extra exact field", cachedInput: { state: "exact", tokens: 0, extra: true } },
    { label: "extra unknown field", cachedInput: { state: "unknown", tokens: 0 } },
  ])("rejects $label in cached-input observations", ({ cachedInput }) => {
    const fixture = retryFixture();
    fixture.snapshot.logicalCalls.entries[0]!.cachedInput = cachedInput as never;

    expect(
      extractAuditableProviderTransportAccountingSnapshot(fixture.snapshot, fixture.coverage),
    ).not.toHaveProperty("snapshot");
  });

  it.each([
    {
      label: "accessor",
      cachedInput() {
        const value = { state: "exact" };
        Object.defineProperty(value, "tokens", {
          enumerable: true,
          get() {
            throw new Error("cached-input accessor");
          },
        });
        return value;
      },
    },
    {
      label: "proxy",
      cachedInput() {
        return new Proxy(
          { state: "exact", tokens: 0 },
          {
            getOwnPropertyDescriptor() {
              throw new Error("cached-input descriptor trap");
            },
          },
        );
      },
    },
  ])("rejects a cached-input $label without throwing", (testCase) => {
    const fixture = retryFixture();
    fixture.snapshot.logicalCalls.entries[0]!.cachedInput = testCase.cachedInput() as never;

    expect(() =>
      extractAuditableProviderTransportAccountingSnapshot(fixture.snapshot, fixture.coverage),
    ).not.toThrow();
    expect(
      extractAuditableProviderTransportAccountingSnapshot(fixture.snapshot, fixture.coverage),
    ).not.toHaveProperty("snapshot");
  });

  it("rejects coverage mismatch, missing or extra events, and mutated projections", () => {
    const fixture = retryFixture();
    expect(
      extractAuditableProviderTransportAccountingSnapshot(fixture.snapshot, {
        state: "partial",
        reasons: ["transport_totals_lower_bound"],
      }),
    ).not.toHaveProperty("snapshot");

    const missing = cloneSnapshot(fixture);
    missing.events.entries.pop();
    missing.events.total -= 1;
    expect(
      extractAuditableProviderTransportAccountingSnapshot(missing, fixture.coverage),
    ).not.toHaveProperty("snapshot");

    const extra = cloneSnapshot(fixture);
    extra.events.entries.push({
      ...extra.events.entries[0]!,
      eventId: "extra-event",
    });
    extra.events.total += 1;
    expect(
      extractAuditableProviderTransportAccountingSnapshot(extra, fixture.coverage),
    ).not.toHaveProperty("snapshot");

    const aggregate = cloneSnapshot(fixture);
    aggregate.attempts.retries += 1;
    expect(
      extractAuditableProviderTransportAccountingSnapshot(aggregate, fixture.coverage),
    ).not.toHaveProperty("snapshot");
  });

  it("rejects duplicate identities and mutated invocation, attempt, or hop ordinals", () => {
    const fixture = retryFixture();
    const mutations: Array<(snapshot: ProviderTransportAccountingSnapshot) => void> = [
      (snapshot) => {
        snapshot.logicalCalls.entries[1]!.callId = snapshot.logicalCalls.entries[0]!.callId;
      },
      (snapshot) => {
        snapshot.events.entries[2]!.eventId = snapshot.events.entries[0]!.eventId;
      },
      (snapshot) => {
        snapshot.invocations!.entries[1]!.sequence = 3;
      },
      (snapshot) => {
        snapshot.invocations!.entries[2]!.hopOrdinal = 3;
      },
      (snapshot) => {
        snapshot.attempts.entries![2]!.ordinal = 3;
      },
    ];
    for (const mutate of mutations) {
      const snapshot = cloneSnapshot(fixture);
      mutate(snapshot);
      expect(
        extractAuditableProviderTransportAccountingSnapshot(snapshot, fixture.coverage),
      ).not.toHaveProperty("snapshot");
    }
  });

  it("rejects completed-then-retry, stale fallback cause, and broken provider model chains", () => {
    const retry = retryFixture();
    const completedThenRetry = cloneSnapshot(retry);
    completedThenRetry.attempts.entries![0]!.outcome = "completed";
    const firstAttempt = completedThenRetry.events.entries.find(
      (event) => event.type === "attempt" && event.callId === "call-one" && event.ordinal === 1,
    );
    if (!firstAttempt || firstAttempt.type !== "attempt") {
      throw new Error("expected first attempt");
    }
    firstAttempt.outcome = "completed";
    expect(
      extractAuditableProviderTransportAccountingSnapshot(completedThenRetry, retry.coverage),
    ).not.toHaveProperty("snapshot");

    const fallback = fallbackFixture();
    const staleCause = structuredClone(fallback.snapshot);
    const failedAttempt = staleCause.events.entries.find(
      (event) => event.type === "attempt" && event.ordinal === 1,
    );
    if (!failedAttempt || failedAttempt.type !== "attempt") {
      throw new Error("expected failed attempt");
    }
    failedAttempt.outcome = "completed";
    staleCause.attempts.entries![0]!.outcome = "completed";
    expect(
      extractAuditableProviderTransportAccountingSnapshot(staleCause, fallback.coverage),
    ).not.toHaveProperty("snapshot");

    const providerFallback = providerFallbackFixture();
    const brokenChain = structuredClone(providerFallback.snapshot);
    const secondFallback = brokenChain.events.entries.find(
      (event) => event.eventId === "provider-fallback-2",
    );
    if (!secondFallback || secondFallback.type !== "provider_fallback") {
      throw new Error("expected second provider fallback");
    }
    secondFallback.fromModel = "wrong-model";
    expect(
      extractAuditableProviderTransportAccountingSnapshot(brokenChain, providerFallback.coverage),
    ).not.toHaveProperty("snapshot");
  });

  it("rejects terminal settlement mismatches and unfinalized calls", () => {
    const fixture = retryFixture();
    const outcome = cloneSnapshot(fixture);
    outcome.logicalCalls.entries[0]!.outcome = "failed";
    outcome.logicalCalls.completed -= 1;
    outcome.logicalCalls.failed += 1;
    expect(
      extractAuditableProviderTransportAccountingSnapshot(outcome, fixture.coverage),
    ).not.toHaveProperty("snapshot");

    const unfinalized = cloneSnapshot(fixture);
    unfinalized.logicalCalls.entries[0]!.finalized = false;
    expect(
      extractAuditableProviderTransportAccountingSnapshot(unfinalized, fixture.coverage),
    ).not.toHaveProperty("snapshot");
  });
});
