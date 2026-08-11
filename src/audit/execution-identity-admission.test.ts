import { describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  hasExecutionIdentityAdmissionSink,
  parseExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
  type ExecutionIdentityAdmissionWork,
} from "./execution-identity-admission.js";

const ADMISSION_MAX_BYTES = 16 * 1024;
const ADMISSION_MAX_ITEMS = 16;

function facts(overrides: Partial<ExecutionIdentityAdmissionFacts> = {}) {
  return {
    runId: "run-1",
    agentId: "main",
    ingress: { kind: "local-cli" as const, boundary: "agent-command.local" },
    runtime: { kind: "embedded" as const },
    ...overrides,
  };
}

function captureEnvelope(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  options: {
    contextId?: string;
    executionId?: string;
    now?: number;
    runtimeInstanceId?: string;
  } = {},
) {
  let captured: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((work) => {
    if (work.kind === "capture") {
      captured = work.envelope;
    }
    return true;
  });
  try {
    const result = enqueueExecutionIdentityContextAtAdmission(admissionFacts, {
      ...options,
      enabled: true,
    });
    if (!result || !captured) {
      throw new Error("expected admission envelope");
    }
    return captured;
  } finally {
    clear();
  }
}

describe("execution identity admission envelope", () => {
  it("captures a deterministic, deeply frozen, redacted envelope with fixed identity", () => {
    const envelope = captureEnvelope(
      facts({
        invoker: {
          state: "present",
          kind: "local-account",
          rawPrincipalRef: "raw-principal",
          displayLabel: "Operator OPENAI_API_KEY=sk-1234567890abcdef",
        },
        applicableGrants: [
          { rawGrantRef: "z", state: "present" },
          { rawGrantRef: "a", state: "present" },
          { rawGrantRef: "a", state: "present" },
        ],
        assurance: [
          {
            kind: "runtime-binding",
            rawEvidenceRef: "z",
            strength: "boundary-verified",
          },
          {
            kind: "local-process",
            rawEvidenceRef: "a",
            strength: "boundary-verified",
          },
        ],
      }),
      {
        contextId: "context-1",
        executionId: "execution-1",
        now: 123,
        runtimeInstanceId: "runtime-1",
      },
    );

    expect(envelope).toMatchObject({
      envelopeVersion: 1,
      contextId: "context-1",
      executionId: "execution-1",
      runId: "run-1",
      createdAt: 123,
      runtimeInstanceId: "runtime-1",
      ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
    });
    expect(envelope.applicableGrants).toEqual([
      { rawGrantRef: "a", state: "present" },
      { rawGrantRef: "z", state: "present" },
    ]);
    expect(envelope.invoker?.state).toBe("present");
    if (envelope.invoker?.state !== "present") {
      throw new Error("expected present invoker");
    }
    expect(envelope.invoker.displayLabel).not.toContain("sk-1234567890abcdef");
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.ingress)).toBe(true);
    expect(Object.isFrozen(envelope.assurance)).toBe(true);
    expect(parseExecutionIdentityAdmissionEnvelope(structuredClone(envelope))).toEqual(envelope);
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(
      ADMISSION_MAX_BYTES,
    );
  });

  it("captures exact present, unknown, and omitted invoker variants", () => {
    const present = captureEnvelope(
      facts({
        invoker: {
          state: "present",
          kind: "local-account",
          rawPrincipalRef: "raw-principal",
        },
      }),
      { contextId: "context-present", executionId: "execution-present", now: 1 },
    );
    const unknown = captureEnvelope(facts({ invoker: { state: "unknown" } }), {
      contextId: "context-unknown",
      executionId: "execution-unknown",
      now: 2,
    });
    const absent = captureEnvelope(facts(), {
      contextId: "context-absent",
      executionId: "execution-absent",
      now: 3,
    });

    expect(present.invoker).toEqual({
      state: "present",
      kind: "local-account",
      rawPrincipalRef: "raw-principal",
    });
    expect(unknown.invoker).toEqual({ state: "unknown" });
    expect(absent).not.toHaveProperty("invoker");
    for (const envelope of [present, unknown, absent]) {
      expect(parseExecutionIdentityAdmissionEnvelope(structuredClone(envelope))).toEqual(envelope);
    }
  });

  it("rejects malformed, ambiguous, oversized, and noncanonical invoker variants", () => {
    const present = captureEnvelope(
      facts({
        invoker: {
          state: "present",
          kind: "local-account",
          rawPrincipalRef: "raw-principal",
        },
      }),
      { contextId: "context-present", executionId: "execution-present", now: 1 },
    );
    const invalidInvokers: unknown[] = [
      { kind: "local-account", rawPrincipalRef: "legacy-untagged" },
      { state: "invalid" },
      { state: "present", kind: "local-account" },
      { state: "present", rawPrincipalRef: "missing-kind" },
      { state: "unknown", kind: "local-account" },
      { state: "unknown", rawPrincipalRef: "raw-substitute-secret" },
      { state: "unknown", displayLabel: "replacement label" },
      { state: "unknown", extra: true },
      { state: "present", kind: "local-account", rawPrincipalRef: "x".repeat(4_097) },
      [{ state: "unknown" }],
    ];

    for (const invoker of invalidInvokers) {
      expect(() =>
        parseExecutionIdentityAdmissionEnvelope({ ...present, invoker } as never),
      ).toThrow("execution identity admission envelope violates its bounded contract");
    }
    expect(() =>
      parseExecutionIdentityAdmissionEnvelope({
        ...present,
        invoker: {
          kind: "local-account",
          state: "present",
          rawPrincipalRef: "raw-principal",
        },
      }),
    ).toThrow("execution identity admission envelope is not canonical");
  });

  it.each([
    ["malformed", { state: "invalid" }],
    ["mixed", { state: "unknown", rawPrincipalRef: "raw-substitute-secret" }],
    ["untagged", { kind: "local-account", rawPrincipalRef: "legacy-untagged" }],
    [
      "extra-field",
      {
        state: "present",
        kind: "local-account",
        rawPrincipalRef: "raw-principal",
        extra: true,
      },
    ],
  ])("rejects %s raw invoker facts before enqueue projection", (_variant, invoker) => {
    const sink = vi.fn(() => true);
    const clear = configureExecutionIdentityAdmissionSink(sink);
    try {
      expect(
        enqueueExecutionIdentityContextAtAdmission(facts({ invoker: invoker as never }), {
          enabled: true,
          contextId: "context-invalid",
          executionId: "execution-invalid",
          now: 1,
          runtimeInstanceId: "runtime-1",
        }),
      ).toBeUndefined();
      expect(sink).not.toHaveBeenCalled();
    } finally {
      clear();
    }
  });

  it("rejects non-plain or lossy clone data without invoking accessors", () => {
    const envelope = captureEnvelope(facts({ invoker: { state: "unknown" } }), {
      contextId: "context-unknown",
      executionId: "execution-unknown",
      now: 1,
    });
    let accessorReads = 0;
    const accessorEnvelope = { ...envelope };
    Object.defineProperty(accessorEnvelope, "invoker", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return { state: "unknown" };
      },
    });
    const symbolEnvelope = { ...envelope, [Symbol("private")]: "raw-symbol-secret" };
    const customPrototypeEnvelope = Object.assign(Object.create({ inherited: true }), envelope);
    const undefinedEnvelope = {
      ...envelope,
      invoker: { state: "unknown", displayLabel: undefined },
    };
    const proxyEnvelope = new Proxy({ ...envelope }, {});
    const customPrototypeFacts = Object.assign(Object.create({ inherited: true }), facts());
    const accessorFacts = facts();
    Object.defineProperty(accessorFacts, "invoker", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return { state: "unknown" };
      },
    });

    for (const invalid of [
      accessorEnvelope,
      symbolEnvelope,
      customPrototypeEnvelope,
      undefinedEnvelope,
      proxyEnvelope,
    ]) {
      expect(() => parseExecutionIdentityAdmissionEnvelope(invalid)).toThrow(
        "execution identity admission data must be clone-safe plain data",
      );
    }
    expect(() => captureEnvelope(customPrototypeFacts)).toThrow("expected admission envelope");
    expect(() => captureEnvelope(accessorFacts)).toThrow("expected admission envelope");
    expect(accessorReads).toBe(0);
  });

  it("rejects invalid owned facts, excess items, and oversized encoded envelopes", () => {
    expect(() =>
      captureEnvelope(facts({ runId: "" }), {
        runtimeInstanceId: "runtime-1",
      }),
    ).toThrow("expected admission envelope");
    expect(() =>
      captureEnvelope(
        facts({
          applicableGrants: Array.from({ length: ADMISSION_MAX_ITEMS + 1 }, (_, index) => ({
            rawGrantRef: `grant-${String(index)}`,
            state: "present" as const,
          })),
        }),
        { runtimeInstanceId: "runtime-1" },
      ),
    ).toThrow("expected admission envelope");
    expect(() =>
      captureEnvelope(
        facts({
          ingress: {
            kind: "local-cli",
            boundary: "agent-command.local",
            rawSourceRef: "a".repeat(4_096),
          },
          invoker: {
            state: "present",
            kind: "local-account",
            rawPrincipalRef: "b".repeat(4_096),
          },
          applicableGrants: [
            { rawGrantRef: "c".repeat(4_096), state: "present" },
            { rawGrantRef: "d".repeat(4_096), state: "present" },
          ],
        }),
        { runtimeInstanceId: "e".repeat(4_096) },
      ),
    ).toThrow("expected admission envelope");
  });

  it("reports queue acceptance without claiming persistence and keeps failures nonblocking", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const clearFirst = configureExecutionIdentityAdmissionSink(first);
    const clearSecond = configureExecutionIdentityAdmissionSink(second);
    clearFirst();
    expect(hasExecutionIdentityAdmissionSink()).toBe(true);
    expect(
      enqueueExecutionIdentityContextAtAdmission(facts(), {
        enabled: true,
        contextId: "context-queued",
        executionId: "execution-queued",
        now: 1,
        runtimeInstanceId: "runtime-1",
      }),
    ).toEqual({
      candidateContextId: "context-queued",
      candidateExecutionId: "execution-queued",
      accepted: true,
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    clearSecond();
    expect(hasExecutionIdentityAdmissionSink()).toBe(false);
    expect(() =>
      enqueueExecutionIdentityContextAtAdmission(
        facts({ ingress: { kind: "local-cli", boundary: "x", rawSourceRef: "raw-secret" } }),
        { enabled: true },
      ),
    ).not.toThrow();
    expect(enqueueExecutionIdentityContextAtAdmission(facts(), { enabled: false })).toBeUndefined();
  });

  it("allocates distinct execution identities for turns that share one run correlation", () => {
    const work = vi.fn<(item: ExecutionIdentityAdmissionWork) => boolean>(() => true);
    const clear = configureExecutionIdentityAdmissionSink(work);
    try {
      enqueueExecutionIdentityContextAtAdmission(facts({ runId: "session-1" }), {
        enabled: true,
      });
      enqueueExecutionIdentityContextAtAdmission(facts({ runId: "session-1" }), {
        enabled: true,
      });
    } finally {
      clear();
    }
    const captures = work.mock.calls
      .map(([item]) => item)
      .filter((item) => item.kind === "capture");
    expect(captures).toHaveLength(2);
    expect(captures[0]!.envelope.runId).toBe("session-1");
    expect(captures[1]!.envelope.runId).toBe("session-1");
    expect(captures[0]!.envelope.executionId).not.toBe(captures[1]!.envelope.executionId);
    expect(captures[0]!.envelope.contextId).not.toBe(captures[1]!.envelope.contextId);
  });

  it("queues only the safe token for a durable retry reference", () => {
    const work = vi.fn<(item: ExecutionIdentityAdmissionWork) => boolean>(() => true);
    const token = createExecutionIdentityAdmissionToken("run-recovery", {
      contextId: "context-recovery",
      executionId: "execution-recovery",
      now: 123,
    });
    const clear = configureExecutionIdentityAdmissionSink(work);
    try {
      enqueueExecutionIdentityContextAtAdmission(
        facts({
          runId: "run-recovery",
          ingress: {
            kind: "api",
            boundary: "agent-command.from-ingress",
            rawSourceRef: "raw-private-reference",
          },
        }),
        { enabled: true, token, retryOnly: true },
      );
    } finally {
      clear();
    }
    expect(work).toHaveBeenCalledWith({ kind: "retry-reference", token });
    expect(JSON.stringify(work.mock.calls)).not.toContain("raw-private-reference");
  });
});
