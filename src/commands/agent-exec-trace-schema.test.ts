import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  sealAgentExecInvocationReceipt,
  type AgentExecInvocationReceiptContents,
} from "./agent-exec-invocation-receipt-schema.internal.js";
import { canonicalJson } from "./agent-exec-trace-schema-support.js";
import {
  buildAgentExecTrace,
  type AgentExecTraceSourceContents,
} from "./agent-exec-trace-schema.internal.js";
import * as publicSchema from "./agent-exec-trace-schema.js";
import {
  normalizeAgentExecInvocationReceipt,
  normalizeAgentExecTrace,
  verifyAgentExecInvocationReceipt,
  verifyAgentExecTrace,
  type AgentExecInvocationReceipt,
  type AgentExecTrace,
} from "./agent-exec-trace-schema.js";

const exact = (value: number) => ({ state: "exact" as const, value });

function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function persist(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("test value is not JSON-serializable");
  }
  return serialized;
}

function validReceipt(): AgentExecInvocationReceipt {
  const receipt = sealAgentExecInvocationReceipt({
    complete: true,
    truncated: false,
    incompleteReasons: [],
    route: { provider: "openai", model: "openai/gpt-5.6", api: "responses" },
    logicalCalls: 2,
    modelFacingApiCalls: 3,
    calls: [
      {
        ordinal: 1,
        callIdSha256: "a".repeat(64),
        outcome: "completed",
        finalized: true,
      },
      {
        ordinal: 2,
        callIdSha256: "b".repeat(64),
        outcome: "completed",
        finalized: true,
      },
    ],
    invocations: [
      {
        sequence: 1,
        logicalCallOrdinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "initial",
        transport: "responses",
      },
      {
        sequence: 2,
        logicalCallOrdinal: 2,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "initial",
        transport: "responses",
      },
      {
        sequence: 3,
        logicalCallOrdinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 2,
        reason: "initial",
        transport: "responses",
      },
    ],
  });
  expect(receipt).toBeDefined();
  return receipt!;
}

function validSource(receipt = validReceipt()): AgentExecTraceSourceContents {
  return {
    mode: { configured: true, engaged: true },
    route: {
      provider: "openai",
      model: "openai/gpt-5.6",
      api: "responses",
      runtime: "embedded",
    },
    invocationReceipt: receipt,
    facts: {
      auditReasons: [],
      accounting: {
        effectiveTurns: exact(1),
        logicalModelCalls: exact(2),
        providerAttempts: {
          total: exact(2),
          initial: exact(2),
          retries: exact(0),
          authRecoveries: exact(0),
          payloadRecoveries: exact(0),
          transportFallbacks: exact(0),
        },
      },
      tools: {
        outerToolCalls: exact(2),
        codeModeBridgeCalls: exact(1),
      },
      usage: {
        input: exact(1_000),
        cachedInput: exact(400),
        firstLogicalCallCachedInput: exact(300),
        output: exact(200),
        reasoning: exact(100),
        total: exact(1_300),
      },
      duration: {
        agentDurationMs: exact(1_500),
        commandExecutionDurationMs: exact(1_700),
        wallLatencyMs: exact(1_800),
      },
    },
  };
}

function validTrace(): AgentExecTrace {
  const trace = buildAgentExecTrace(validSource());
  expect(trace).toBeDefined();
  return trace!;
}

function resealReceipt(receipt: AgentExecInvocationReceipt): void {
  const { sha256: _sha256, ...contents } = receipt;
  receipt.sha256 = domainDigest("openclaw.agent-exec.invocation-receipt.v2", contents);
}

function resealTrace(trace: AgentExecTrace): void {
  const { sha256: _sha256, ...contents } = trace;
  trace.sha256 = domainDigest("openclaw.agent-exec.trace.v2", contents);
}

function resealSource(trace: AgentExecTrace): void {
  const { sha256: _sha256, ...contents } = trace.source;
  trace.source.sha256 = domainDigest("openclaw.agent-exec.trace-source.v2", contents);
}

function resealAll(trace: AgentExecTrace): void {
  if (trace.source.invocationReceipt) {
    resealReceipt(trace.source.invocationReceipt);
  }
  resealSource(trace);
  resealTrace(trace);
}

function setPrototypeToJson(prototype: object, value: () => unknown): void {
  Object.defineProperty(prototype, "toJSON", { configurable: true, value });
}

function restorePrototypeToJson(
  prototype: object,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(prototype, "toJSON", descriptor);
  } else {
    Reflect.deleteProperty(prototype, "toJSON");
  }
}

describe("agent exec trace schema v2", () => {
  it("keeps integrity construction out of the public verification module", () => {
    expect(publicSchema).not.toHaveProperty("buildAgentExecTrace");
    expect(publicSchema).not.toHaveProperty("sealAgentExecInvocationReceipt");
    expect(validTrace().source).toMatchObject({
      kind: "agent_exec_source_facts",
      invocationReceipt: { kind: "transport_invocation_receipt" },
    });
    expect(validTrace().source).not.toHaveProperty("authority");
    expect(validTrace().source.invocationReceipt).not.toHaveProperty("authority");
  });

  it("seals, persists, and freshly normalizes a valid trace", () => {
    const trace = validTrace();
    const persisted = persist(trace);
    const normalized = normalizeAgentExecTrace(persisted);

    expect(verifyAgentExecTrace(persisted)).toBe(true);
    expect(typeof persisted).toBe("string");
    expect(normalized).toEqual(trace);
    expect(normalized).not.toBe(persisted);
    expect(normalized?.audit).toEqual({ state: "valid" });
    expect(normalized?.projection.metrics).toMatchObject({
      modelFacingApiCalls: exact(3),
      totalToolOperations: exact(3),
      underlyingTotalCalls: exact(6),
    });
  });

  it("accepts concurrent interleaving but rejects order and lifecycle repair", () => {
    const receipt = validReceipt();
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(true);
    expect(verifyAgentExecInvocationReceipt(persist(receipt))).toBe(true);

    for (const invocations of [
      [receipt.invocations[1]!, receipt.invocations[0]!, receipt.invocations[2]!],
      [
        { ...receipt.invocations[2]!, sequence: 1 },
        receipt.invocations[1]!,
        { ...receipt.invocations[0]!, sequence: 3 },
      ],
      [
        receipt.invocations[0]!,
        receipt.invocations[1]!,
        {
          ...receipt.invocations[2]!,
          attemptOrdinal: 3,
          hopOrdinal: 1,
          reason: "retry" as const,
        },
      ],
    ]) {
      const forged = structuredClone(receipt);
      forged.invocations = invocations;
      resealReceipt(forged);
      expect(normalizeAgentExecInvocationReceipt(persist(forged))).toBeUndefined();
    }

    const {
      schemaVersion: _schemaVersion,
      kind: _kind,
      sha256: _sha256,
      ...receiptContents
    } = structuredClone(receipt);
    const reopenedContents: AgentExecInvocationReceiptContents = {
      ...receiptContents,
      invocations: [
        receipt.invocations[0]!,
        receipt.invocations[1]!,
        {
          ...receipt.invocations[2]!,
          sequence: 3,
          attemptOrdinal: 2,
          hopOrdinal: 1,
          reason: "retry",
        },
        {
          ...receipt.invocations[2]!,
          sequence: 4,
          attemptOrdinal: 1,
          hopOrdinal: 2,
        },
      ],
      modelFacingApiCalls: 4,
    };
    expect(sealAgentExecInvocationReceipt(reopenedContents)).toBeUndefined();
  });

  it("rejects forged derived metrics and audit even with a fresh outer digest", () => {
    const metricForgery = structuredClone(validTrace());
    metricForgery.projection.metrics.underlyingTotalCalls = exact(99);
    resealTrace(metricForgery);
    expect(verifyAgentExecTrace(persist(metricForgery))).toBe(false);

    const auditForgery = structuredClone(validTrace());
    auditForgery.audit = { state: "inconclusive", reasons: ["not_observed"] };
    resealTrace(auditForgery);
    expect(verifyAgentExecTrace(persist(auditForgery))).toBe(false);
  });

  it("recomputes accounting and receipt conservation into the audit", () => {
    const source = validSource();
    source.facts.accounting.providerAttempts.total = exact(3);
    const trace = buildAgentExecTrace(source);

    expect(trace?.audit).toEqual({
      state: "inconclusive",
      reasons: ["provider_attempt_conservation_mismatch"],
    });
  });

  it("rejects old, unknown, extra, raw, secret, and path-like input", () => {
    const trace = structuredClone(validTrace());
    expect(verifyAgentExecTrace(persist({ ...trace, schemaVersion: 1 }))).toBe(false);
    expect(
      verifyAgentExecTrace(
        persist({
          ...trace,
          source: { ...trace.source, kind: "simulated" },
        }),
      ),
    ).toBe(false);
    expect(
      verifyAgentExecTrace(
        persist({
          ...trace,
          raw: { prompt: "hidden" },
        }),
      ),
    ).toBe(false);
    expect(
      buildAgentExecTrace({
        ...validSource(),
        route: {
          provider: "openai",
          model: "sk-secret",
          api: "responses",
          runtime: "embedded",
        },
      }),
    ).toBeUndefined();
    expect(
      sealAgentExecInvocationReceipt({
        ...validReceipt(),
        route: { provider: "openai", model: "/Users/private/model", api: "responses" },
      }),
    ).toBeUndefined();
  });

  it("rejects noncanonical and unknown reason arrays", () => {
    const incomplete = sealAgentExecInvocationReceipt({
      complete: false,
      truncated: true,
      incompleteReasons: ["provider_events_truncated", "invocation_ledger_incomplete"],
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      invocations: [],
    });
    expect(incomplete).toBeDefined();

    const noncanonical = structuredClone(incomplete!);
    noncanonical.incompleteReasons.reverse();
    resealReceipt(noncanonical);
    expect(verifyAgentExecInvocationReceipt(persist(noncanonical))).toBe(false);

    const unknown = structuredClone(incomplete!);
    unknown.incompleteReasons = ["looks_valid_but_unknown"];
    resealReceipt(unknown);
    expect(verifyAgentExecInvocationReceipt(persist(unknown))).toBe(false);

    const knownSemantic = buildAgentExecTrace({
      ...validSource(),
      facts: {
        ...validSource().facts,
        auditReasons: ["terminal_metadata_unavailable"],
      },
    });
    expect(knownSemantic?.audit).toEqual({
      state: "inconclusive",
      reasons: ["terminal_metadata_unavailable"],
    });
  });

  it("enforces numeric, collection, and byte-size caps", () => {
    for (const value of [
      -0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1_000_000_000_000_001,
    ]) {
      const invalidMetric = validSource();
      invalidMetric.facts.usage.input = exact(value);
      expect(buildAgentExecTrace(invalidMetric)).toBeUndefined();
    }

    const maxCalls = sealAgentExecInvocationReceipt({
      complete: false,
      incompleteReasons: ["transport_details_truncated"],
      truncated: true,
      logicalCalls: 64,
      calls: Array.from({ length: 64 }, (_, index) => ({
        ordinal: index + 1,
        callIdSha256: index.toString(16).padStart(64, "0"),
        finalized: false,
      })),
      modelFacingApiCalls: 0,
      invocations: [],
    });
    expect(maxCalls).toBeDefined();
    const oneExtraCall = structuredClone(maxCalls!);
    oneExtraCall.calls.push({
      ordinal: 65,
      callIdSha256: "f".repeat(64),
      finalized: false,
    });
    oneExtraCall.logicalCalls = 65;
    resealReceipt(oneExtraCall);
    expect(verifyAgentExecInvocationReceipt(persist(oneExtraCall))).toBe(false);

    const maxInvocations = sealAgentExecInvocationReceipt({
      complete: true,
      incompleteReasons: [],
      truncated: false,
      route: { provider: "openai", model: "openai/gpt-5.6", api: "responses" },
      logicalCalls: 1,
      calls: [
        {
          ordinal: 1,
          callIdSha256: "c".repeat(64),
          outcome: "completed",
          finalized: true,
        },
      ],
      modelFacingApiCalls: 128,
      invocations: Array.from({ length: 128 }, (_, index) => ({
        sequence: index + 1,
        logicalCallOrdinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: index + 1,
        reason: "initial" as const,
        transport: "responses",
      })),
    });
    expect(maxInvocations).toBeDefined();
    const oneExtraInvocation = structuredClone(maxInvocations!);
    oneExtraInvocation.invocations.push({
      sequence: 129,
      logicalCallOrdinal: 1,
      attemptOrdinal: 1,
      hopOrdinal: 129,
      reason: "initial",
      transport: "responses",
    });
    oneExtraInvocation.modelFacingApiCalls = 129;
    resealReceipt(oneExtraInvocation);
    expect(verifyAgentExecInvocationReceipt(persist(oneExtraInvocation))).toBe(false);

    expect(
      normalizeAgentExecTrace(
        persist({
          ...validTrace(),
          padding: "x".repeat(256 * 1024),
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects digest replay and all receipt digest tampering", () => {
    const trace = validTrace();
    const receipt = structuredClone(trace.source.invocationReceipt!);
    receipt.sha256 = trace.sha256;
    expect(verifyAgentExecInvocationReceipt(persist(receipt))).toBe(false);

    for (const mutate of [
      (value: AgentExecInvocationReceipt) => {
        value.modelFacingApiCalls += 1;
      },
      (value: AgentExecInvocationReceipt) => {
        value.calls[0]!.finalized = false;
      },
      (value: AgentExecInvocationReceipt) => {
        value.route!.model = "openai/gpt-5.5";
      },
    ]) {
      const forged = structuredClone(trace.source.invocationReceipt!);
      mutate(forged);
      expect(verifyAgentExecInvocationReceipt(persist(forged))).toBe(false);
    }
  });

  it("uses UTF-8 byte order and never throws on hostile unknown input", () => {
    expect(canonicalJson({ "\u{10000}": 1, "\uE000": 2 })).toBe('{"":2,"𐀀":1}');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      null,
      [],
      cyclic,
      { schemaVersion: 2, source: Object.create(null) },
      {
        get schemaVersion() {
          throw new Error("hostile");
        },
      },
    ]) {
      expect(() => normalizeAgentExecTrace(value)).not.toThrow();
      expect(normalizeAgentExecTrace(value)).toBeUndefined();
    }
  });

  it("rejects hidden, symbolic, accessor, exotic, and prototype-polluting input", () => {
    let toJsonCalls = 0;
    const hidden = structuredClone(validTrace());
    Object.defineProperty(hidden, "toJSON", {
      enumerable: false,
      value: () => {
        toJsonCalls += 1;
        return { schemaVersion: 999, raw: "unsealed" };
      },
    });
    expect(normalizeAgentExecTrace(hidden)).toBeUndefined();
    expect(toJsonCalls).toBe(0);

    const symbolic = structuredClone(validTrace());
    Object.defineProperty(symbolic, Symbol("secret"), {
      enumerable: true,
      value: "hidden",
    });
    expect(normalizeAgentExecTrace(symbolic)).toBeUndefined();

    const accessor = structuredClone(validTrace());
    Object.defineProperty(accessor, "schemaVersion", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    expect(() => normalizeAgentExecTrace(accessor)).not.toThrow();
    expect(normalizeAgentExecTrace(accessor)).toBeUndefined();

    const polluted = structuredClone(validTrace()) as AgentExecTrace & {
      __proto__?: unknown;
    };
    Object.defineProperty(polluted, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    expect(normalizeAgentExecTrace(polluted)).toBeUndefined();
    expect({}).not.toHaveProperty("polluted");

    expect(normalizeAgentExecTrace(new Date())).toBeUndefined();
    expect(normalizeAgentExecTrace(new Map())).toBeUndefined();
  });

  it("persists normalized output without inherited serialization hooks", () => {
    const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const persisted = persist(validTrace());
    let serialized: string | undefined;
    let normalized: AgentExecTrace | undefined;
    try {
      setPrototypeToJson(Object.prototype, () => ({ raw: "polluted-object" }));
      setPrototypeToJson(Array.prototype, () => ["polluted-array"]);
      normalized = normalizeAgentExecTrace(persisted);
      serialized = JSON.stringify(normalized);
    } finally {
      restorePrototypeToJson(Object.prototype, objectToJson);
      restorePrototypeToJson(Array.prototype, arrayToJson);
    }
    expect(normalized).toBeDefined();
    expect(verifyAgentExecTrace(normalized)).toBe(true);
    expect(verifyAgentExecInvocationReceipt(normalized!.source.invocationReceipt)).toBe(true);
    expect(verifyAgentExecTrace(serialized)).toBe(true);
    expect(Object.getPrototypeOf(normalized!)).toBeNull();
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Array.isArray(normalized!.source.invocationReceipt!.invocations)).toBe(true);
    expect(Object.isFrozen(normalized!.source.invocationReceipt!.invocations)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(normalized!.source.invocationReceipt!.invocations, "toJSON"),
    ).toMatchObject({ enumerable: false, value: undefined });
    expect(JSON.parse(serialized!)).toMatchObject({
      schemaVersion: 2,
      source: {
        kind: "agent_exec_source_facts",
        invocationReceipt: { kind: "transport_invocation_receipt" },
      },
    });
    expect(serialized).not.toContain("polluted");
  });

  it("never escapes on hostile proxy traps or bounded-shape fuzz cases", () => {
    const trapNames = ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const;
    for (const trapName of trapNames) {
      const target = structuredClone(validTrace());
      const proxy = new Proxy(target, {
        [trapName]() {
          throw new Error(`hostile ${trapName}`);
        },
      });
      expect(() => normalizeAgentExecTrace(proxy)).not.toThrow();
      expect(normalizeAgentExecTrace(proxy)).toBeUndefined();
    }

    let ownKeysCalls = 0;
    const wideObject = new Proxy(Object.create(null), {
      ownKeys() {
        ownKeysCalls += 1;
        return Array.from({ length: 1_000_000 }, (_, index) => `key_${index}`);
      },
    });
    expect(normalizeAgentExecTrace(wideObject)).toBeUndefined();
    expect(ownKeysCalls).toBe(0);

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 33; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const hostileValues: unknown[] = [
      undefined,
      1n,
      Symbol("value"),
      () => undefined,
      deep,
      Array.from({ length: 16_385 }, () => null),
      Object.assign(Object.create({ inherited: true }), validTrace()),
    ];
    for (const value of hostileValues) {
      expect(() => normalizeAgentExecTrace(value)).not.toThrow();
      expect(normalizeAgentExecTrace(value)).toBeUndefined();
    }

    const fuzzSeed = 0x5eedc0de;
    let seed = fuzzSeed;
    const next = () => {
      seed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed);
      return (seed ^ (seed >>> 14)) >>> 0;
    };
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const trace = structuredClone(validTrace());
      let candidate: unknown = trace;
      const mutationKind = iteration < 12 ? iteration : next() % 12;
      switch (mutationKind) {
        case 0: {
          const targets: Array<Record<PropertyKey, unknown>> = [
            trace,
            trace.source,
            trace.projection,
            trace.source.facts,
            trace.source.facts.accounting,
            trace.source.facts.usage,
          ];
          targets[next() % targets.length]![`unexpected_${next().toString(16)}`] = next();
          resealAll(trace);
          candidate = persist(trace);
          break;
        }
        case 1:
          delete (trace.source.facts.usage as Partial<typeof trace.source.facts.usage>).total;
          resealAll(trace);
          candidate = persist(trace);
          break;
        case 2:
          (trace.source.mode as { engaged: unknown }).engaged = `invalid_${next().toString(16)}`;
          resealAll(trace);
          candidate = persist(trace);
          break;
        case 3:
          if ((next() & 1) === 0) {
            trace.source.invocationReceipt!.invocations.reverse();
          } else {
            trace.source.invocationReceipt!.invocations.push(
              trace.source.invocationReceipt!.invocations.shift()!,
            );
          }
          resealAll(trace);
          candidate = persist(trace);
          break;
        case 4: {
          let nested: Record<string, unknown> = {};
          const root = nested;
          for (let depth = 0; depth < 33; depth += 1) {
            nested.next = {};
            nested = nested.next as Record<string, unknown>;
          }
          (trace as AgentExecTrace & { unexpected?: unknown }).unexpected = root;
          resealAll(trace);
          candidate = persist(trace);
          break;
        }
        case 5:
          (trace as AgentExecTrace & { unexpected?: unknown }).unexpected = "x".repeat(
            256 * 1024 + 1,
          );
          resealAll(trace);
          candidate = persist(trace);
          break;
        case 6:
          Object.defineProperty(trace.source.facts, `unexpected_${next().toString(16)}`, {
            enumerable: true,
            get() {
              throw new Error("fuzz getter must not execute");
            },
          });
          break;
        case 7:
          candidate = new Proxy(trace, {
            ownKeys() {
              throw new Error("fuzz proxy must not escape");
            },
          });
          break;
        case 8:
          trace.source.invocationReceipt!.sha256 = next().toString(16).padStart(64, "0");
          resealSource(trace);
          resealTrace(trace);
          candidate = persist(trace);
          break;
        case 9:
          trace.source.sha256 = next().toString(16).padStart(64, "0");
          resealTrace(trace);
          candidate = persist(trace);
          break;
        case 10:
          trace.source.facts.auditReasons =
            (next() & 1) === 0
              ? ["not_observed", "candidate_failed"]
              : ["not_observed", `unknown_${next().toString(16)}`];
          resealSource(trace);
          resealTrace(trace);
          candidate = persist(trace);
          break;
        case 11: {
          const call = trace.source.invocationReceipt!.calls[next() % 2]!;
          if ((next() & 1) === 0) {
            call.ordinal += 1;
          } else {
            call.finalized = false;
          }
          resealAll(trace);
          candidate = persist(trace);
          break;
        }
      }
      expect(
        () => normalizeAgentExecTrace(candidate),
        `seed=${fuzzSeed} case=${iteration}`,
      ).not.toThrow();
      expect(
        normalizeAgentExecTrace(candidate),
        `seed=${fuzzSeed} case=${iteration}`,
      ).toBeUndefined();
    }
  });
});
