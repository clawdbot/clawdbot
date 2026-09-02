import { describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  hasExecutionIdentityAdmissionSink,
  parseExecutionIdentityAdmissionEnvelope,
  parseExecutionIdentityAdmissionWork,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
  type ExecutionIdentityAdmissionWork,
} from "./execution-identity-admission.js";

const ADMISSION_MAX_BYTES = 16 * 1024;
const ADMISSION_MAX_ITEMS = 16;

function defineObjectPrototypeProperty(key: string, descriptor: PropertyDescriptor): void {
  // oxlint-disable-next-line no-extend-native -- Exercise hostile prototype pollution at the admission boundary.
  Object.defineProperty(Object.prototype, key, descriptor);
}

function restoreObjectPrototypeProperty(
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    defineObjectPrototypeProperty(key, descriptor);
  } else {
    delete (Object.prototype as Record<string, unknown>)[key];
  }
}

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
          { rawGrantRef: "é", state: "present" },
          { rawGrantRef: "z", state: "present" },
          { rawGrantRef: "é", state: "present" },
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
      { rawGrantRef: "z", state: "present" },
      { rawGrantRef: "é", state: "present" },
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

  it("omits inherited outer evidence instead of projecting it", () => {
    const inheritedRefs = {
      invoker: { state: "unknown" },
      applicableGrants: [{ rawGrantRef: "inherited-grant", state: "present" }],
      assurance: [
        {
          kind: "other",
          rawEvidenceRef: "inherited-assurance",
          strength: "self-asserted",
        },
      ],
    } as const;
    const prior = new Map(
      Object.keys(inheritedRefs).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(Object.prototype, key),
      ]),
    );
    let envelope: ExecutionIdentityAdmissionEnvelope;
    try {
      for (const [key, value] of Object.entries(inheritedRefs)) {
        defineObjectPrototypeProperty(key, {
          configurable: true,
          enumerable: false,
          value,
          writable: true,
        });
      }
      envelope = captureEnvelope(facts(), {
        contextId: "context-inherited",
        executionId: "execution-inherited",
        now: 1,
        runtimeInstanceId: "runtime-owned",
      });
    } finally {
      for (const [key, descriptor] of prior) {
        restoreObjectPrototypeProperty(key, descriptor);
      }
    }

    expect(Object.hasOwn(envelope!, "invoker")).toBe(false);
    expect(envelope!.applicableGrants).toEqual([]);
    expect(envelope!.assurance).toEqual([
      {
        kind: "runtime-binding",
        rawEvidenceRef: "runtime-owned",
        strength: "boundary-verified",
      },
    ]);
  });

  it("never reads inherited accessors while treating optional evidence as omitted", () => {
    const keys = ["invoker", "applicableGrants", "assurance"] as const;
    const prior = new Map(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]),
    );
    const getterReads = new Map(keys.map((key) => [key, 0]));
    let envelope: ExecutionIdentityAdmissionEnvelope;
    try {
      for (const key of keys) {
        defineObjectPrototypeProperty(key, {
          configurable: true,
          enumerable: false,
          get: () => {
            getterReads.set(key, getterReads.get(key)! + 1);
            return key === "invoker"
              ? { state: "unknown" }
              : key === "applicableGrants"
                ? [{ rawGrantRef: "inherited-grant", state: "present" }]
                : [
                    {
                      kind: "other",
                      rawEvidenceRef: "inherited-assurance",
                      strength: "self-asserted",
                    },
                  ];
          },
        });
      }
      envelope = captureEnvelope(facts(), {
        contextId: "context-inherited-getter",
        executionId: "execution-inherited-getter",
        now: 1,
        runtimeInstanceId: "runtime-owned",
      });
    } finally {
      for (const [key, descriptor] of prior) {
        restoreObjectPrototypeProperty(key, descriptor);
      }
    }

    expect(Object.fromEntries(getterReads)).toEqual({
      invoker: 0,
      applicableGrants: 0,
      assurance: 0,
    });
    expect(Object.hasOwn(envelope!, "invoker")).toBe(false);
    expect(envelope!.applicableGrants).toEqual([]);
    expect(envelope!.assurance).toEqual([
      {
        kind: "runtime-binding",
        rawEvidenceRef: "runtime-owned",
        strength: "boundary-verified",
      },
    ]);
  });

  it.each([
    {
      name: "ingress state",
      key: "state",
      value: "unknown",
      admissionFacts: () => facts(),
      assertOmitted: (envelope: ExecutionIdentityAdmissionEnvelope) => {
        expect(envelope.ingress.state).toBe("present");
      },
    },
    {
      name: "ingress source",
      key: "rawSourceRef",
      value: "inherited-source",
      admissionFacts: () => facts(),
      assertOmitted: (envelope: ExecutionIdentityAdmissionEnvelope) => {
        expect(Object.hasOwn(envelope.ingress, "rawSourceRef")).toBe(false);
      },
    },
    {
      name: "invoker label",
      key: "displayLabel",
      value: "inherited-label",
      admissionFacts: () =>
        facts({
          invoker: {
            state: "present",
            kind: "local-account",
            rawPrincipalRef: "owned-principal",
          },
        }),
      assertOmitted: (envelope: ExecutionIdentityAdmissionEnvelope) => {
        expect(envelope.invoker?.state).toBe("present");
        expect(Object.hasOwn(envelope.invoker!, "displayLabel")).toBe(false);
      },
    },
  ])("omits inherited optional $name data", ({ key, value, admissionFacts, assertOmitted }) => {
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, key);
    let dataEnvelope: ExecutionIdentityAdmissionEnvelope;
    let getterEnvelope: ExecutionIdentityAdmissionEnvelope;
    let getterReads = 0;
    try {
      defineObjectPrototypeProperty(key, {
        configurable: true,
        enumerable: false,
        value,
        writable: true,
      });
      dataEnvelope = captureEnvelope(admissionFacts(), {
        contextId: `context-${key}`,
        executionId: `execution-${key}`,
        now: 1,
        runtimeInstanceId: "runtime-owned",
      });
      defineObjectPrototypeProperty(key, {
        configurable: true,
        enumerable: false,
        get: () => {
          getterReads += 1;
          return value;
        },
      });
      getterEnvelope = captureEnvelope(admissionFacts(), {
        contextId: `context-${key}-getter`,
        executionId: `execution-${key}-getter`,
        now: 2,
        runtimeInstanceId: "runtime-owned",
      });
    } finally {
      restoreObjectPrototypeProperty(key, prior);
    }
    expect(getterReads).toBe(0);
    assertOmitted(dataEnvelope!);
    assertOmitted(getterEnvelope!);
  });

  it.each([
    ["outer run id", "runId", "inherited-run", () => omitOwn(facts(), "runId")],
    ["outer agent id", "agentId", "inherited-agent", () => omitOwn(facts(), "agentId")],
    ["outer ingress", "ingress", facts().ingress, () => omitOwn(facts(), "ingress")],
    ["outer runtime", "runtime", facts().runtime, () => omitOwn(facts(), "runtime")],
    [
      "ingress kind",
      "kind",
      "local-cli",
      () => facts({ ingress: { boundary: "agent-command.local" } as never }),
    ],
    [
      "ingress boundary",
      "boundary",
      "agent-command.local",
      () => facts({ ingress: { kind: "local-cli" } as never }),
    ],
    ["invoker state", "state", "unknown", () => facts({ invoker: {} as never })],
    [
      "invoker kind",
      "kind",
      "local-account",
      () => facts({ invoker: { state: "present", rawPrincipalRef: "owned" } as never }),
    ],
    [
      "invoker principal",
      "rawPrincipalRef",
      "inherited-principal",
      () => facts({ invoker: { state: "present", kind: "local-account" } as never }),
    ],
    [
      "grant reference",
      "rawGrantRef",
      "inherited-grant",
      () => facts({ applicableGrants: [{ state: "present" } as never] }),
    ],
    [
      "grant state",
      "state",
      "present",
      () => facts({ applicableGrants: [{ rawGrantRef: "owned-grant" } as never] }),
    ],
    [
      "assurance kind",
      "kind",
      "other",
      () =>
        facts({
          assurance: [{ rawEvidenceRef: "owned-evidence", strength: "self-asserted" } as never],
        }),
    ],
    [
      "assurance reference",
      "rawEvidenceRef",
      "inherited-evidence",
      () => facts({ assurance: [{ kind: "other", strength: "self-asserted" } as never] }),
    ],
    [
      "assurance strength",
      "strength",
      "self-asserted",
      () => facts({ assurance: [{ kind: "other", rawEvidenceRef: "owned-evidence" } as never] }),
    ],
  ] as const)(
    "rejects inherited required $0 before allocation and enqueue",
    (_name, key, inheritedValue, admissionFacts) => {
      const prior = Object.getOwnPropertyDescriptor(Object.prototype, key);
      let inheritedReads = 0;
      let allocationReads = 0;
      const sink = vi.fn(() => true);
      const clear = configureExecutionIdentityAdmissionSink(sink);
      try {
        defineObjectPrototypeProperty(key, {
          configurable: true,
          enumerable: false,
          get: () => {
            inheritedReads += 1;
            return inheritedValue;
          },
        });
        const options = { enabled: true, runtimeInstanceId: "runtime-owned" };
        Object.defineProperty(options, "contextId", {
          enumerable: true,
          get: () => {
            allocationReads += 1;
            return "must-not-allocate";
          },
        });
        expect(
          enqueueExecutionIdentityContextAtAdmission(admissionFacts() as never, options),
        ).toBeUndefined();
      } finally {
        clear();
        restoreObjectPrototypeProperty(key, prior);
      }
      expect(inheritedReads).toBe(0);
      expect(allocationReads).toBe(0);
      expect(sink).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "outer ingress",
      prepare: () => {
        const admissionFacts = facts();
        return { admissionFacts, target: admissionFacts, key: "ingress" };
      },
    },
    ...["invoker", "applicableGrants", "assurance"].map((key) => ({
      name: `outer ${key}`,
      prepare: () => {
        const admissionFacts = facts();
        return { admissionFacts, target: admissionFacts, key };
      },
    })),
    ...["kind", "boundary", "state", "rawSourceRef"].map((key) => ({
      name: `ingress ${key}`,
      prepare: () => {
        const admissionFacts = facts();
        return { admissionFacts, target: admissionFacts.ingress, key };
      },
    })),
    ...["state", "kind", "rawPrincipalRef", "displayLabel"].map((key) => ({
      name: `invoker ${key}`,
      prepare: () => {
        const invoker = {
          state: "present" as const,
          kind: "local-account" as const,
          rawPrincipalRef: "owned-principal",
          displayLabel: "owned-label",
        };
        const admissionFacts = facts({ invoker });
        return { admissionFacts, target: invoker, key };
      },
    })),
    ...["rawGrantRef", "state"].map((key) => ({
      name: `grant ${key}`,
      prepare: () => {
        const grant = { rawGrantRef: "owned-grant", state: "present" as const };
        const admissionFacts = facts({ applicableGrants: [grant] });
        return { admissionFacts, target: grant, key };
      },
    })),
    ...["kind", "rawEvidenceRef", "strength"].map((key) => ({
      name: `assurance ${key}`,
      prepare: () => {
        const assurance = {
          kind: "other" as const,
          rawEvidenceRef: "owned-evidence",
          strength: "self-asserted" as const,
        };
        const admissionFacts = facts({ assurance: [assurance] });
        return { admissionFacts, target: assurance, key };
      },
    })),
  ])("rejects an own accessor at $name without reading it or allocating", ({ prepare }) => {
    const { admissionFacts, target, key } = prepare();
    let accessorReads = 0;
    let allocationReads = 0;
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return "must-not-read";
      },
    });
    const options = { enabled: true, runtimeInstanceId: "runtime-owned" };
    Object.defineProperty(options, "contextId", {
      enumerable: true,
      get: () => {
        allocationReads += 1;
        return "must-not-allocate";
      },
    });
    const sink = vi.fn(() => true);
    const clear = configureExecutionIdentityAdmissionSink(sink);
    try {
      expect(
        enqueueExecutionIdentityContextAtAdmission(admissionFacts as never, options),
      ).toBeUndefined();
    } finally {
      clear();
    }
    expect(accessorReads).toBe(0);
    expect(allocationReads).toBe(0);
    expect(sink).not.toHaveBeenCalled();
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

  it("revalidates envelopes and worker messages from owned data only", () => {
    const envelope = captureEnvelope(facts(), {
      contextId: "context-revalidation",
      executionId: "execution-revalidation",
      now: 1,
      runtimeInstanceId: "runtime-owned",
    });
    const priorInvoker = Object.getOwnPropertyDescriptor(Object.prototype, "invoker");
    const priorIngress = Object.getOwnPropertyDescriptor(Object.prototype, "ingress");
    const priorKind = Object.getOwnPropertyDescriptor(Object.prototype, "kind");
    let inheritedReads = 0;
    let parsed: ExecutionIdentityAdmissionEnvelope;
    try {
      defineObjectPrototypeProperty("invoker", {
        configurable: true,
        enumerable: false,
        get: () => {
          inheritedReads += 1;
          return { state: "unknown" };
        },
      });
      parsed = parseExecutionIdentityAdmissionEnvelope(envelope);

      defineObjectPrototypeProperty("ingress", {
        configurable: true,
        enumerable: false,
        get: () => {
          inheritedReads += 1;
          return envelope.ingress;
        },
      });
      expect(() => parseExecutionIdentityAdmissionEnvelope(omitOwn(envelope, "ingress"))).toThrow(
        "execution identity admission envelope violates its bounded contract",
      );

      defineObjectPrototypeProperty("kind", {
        configurable: true,
        enumerable: false,
        get: () => {
          inheritedReads += 1;
          return "capture";
        },
      });
      expect(() => parseExecutionIdentityAdmissionWork({ envelope } as never)).toThrow(
        "execution identity admission work violates its bounded contract",
      );
    } finally {
      for (const [key, descriptor] of [
        ["invoker", priorInvoker],
        ["ingress", priorIngress],
        ["kind", priorKind],
      ] as const) {
        restoreObjectPrototypeProperty(key, descriptor);
      }
    }
    expect(inheritedReads).toBe(0);
    expect(Object.hasOwn(parsed!, "invoker")).toBe(false);
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

function omitOwn<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
