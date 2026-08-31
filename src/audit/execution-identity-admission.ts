/** Bounded execution-identity facts captured at authoritative run admission. */
import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { executionIdentitySpawnAdmission } from "./execution-identity-spawn-admission.js";

const EXECUTION_IDENTITY_ADMISSION_MAX_BYTES = 16 * 1024;
const EXECUTION_IDENTITY_ADMISSION_MAX_ITEMS = 16;
const RAW_REF_MAX_LENGTH = 4_096;
const PROCESS_RUNTIME_INSTANCE_ID = randomUUID();
const log = createSubsystemLogger("audit/events");

const boundedRef = () => Type.String({ minLength: 1, maxLength: 256 });
const rawRef = () => Type.String({ minLength: 1, maxLength: RAW_REF_MAX_LENGTH });
const evidenceState = () =>
  Type.Union([
    Type.Literal("present"),
    Type.Literal("absent"),
    Type.Literal("unknown"),
    Type.Literal("unsupported"),
  ]);
const closedObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const ingressKind = () =>
  Type.Union([
    Type.Literal("local-cli"),
    Type.Literal("gateway-client"),
    Type.Literal("channel"),
    Type.Literal("api"),
    Type.Literal("schedule"),
    Type.Literal("webhook"),
    Type.Literal("task"),
    Type.Literal("subagent"),
    Type.Literal("acp"),
    Type.Literal("worker"),
    Type.Literal("plugin"),
    Type.Literal("recovery"),
    Type.Literal("system"),
  ]);
const runtimeKind = () =>
  Type.Union([
    Type.Literal("gateway"),
    Type.Literal("embedded"),
    Type.Literal("worker"),
    Type.Literal("plugin-harness"),
    Type.Literal("acp"),
  ]);
const admissionGrant = () => closedObject({ rawGrantRef: rawRef(), state: evidenceState() });
const admissionGrants = () =>
  Type.Array(admissionGrant(), { maxItems: EXECUTION_IDENTITY_ADMISSION_MAX_ITEMS });
const admissionAssurance = () =>
  Type.Array(
    closedObject({
      kind: Type.Union([
        Type.Literal("durable-profile"),
        Type.Literal("trusted-proxy"),
        Type.Literal("tailscale-whois"),
        Type.Literal("device-proof"),
        Type.Literal("channel-admission"),
        Type.Literal("local-process"),
        Type.Literal("spawn-lineage"),
        Type.Literal("worker-admission"),
        Type.Literal("runtime-binding"),
        Type.Literal("other"),
      ]),
      rawEvidenceRef: rawRef(),
      strength: Type.Union([
        Type.Literal("self-asserted"),
        Type.Literal("boundary-verified"),
        Type.Literal("cryptographic"),
      ]),
    }),
    { maxItems: EXECUTION_IDENTITY_ADMISSION_MAX_ITEMS },
  );

const ExecutionIdentityAdmissionInvokerSchema = Type.Union([
  closedObject({
    state: Type.Literal("present"),
    kind: Type.Union([
      Type.Literal("person"),
      Type.Literal("agent"),
      Type.Literal("service"),
      Type.Literal("schedule"),
      Type.Literal("webhook"),
      Type.Literal("system"),
      Type.Literal("local-account"),
      Type.Literal("runtime"),
    ]),
    rawPrincipalRef: rawRef(),
    displayLabel: Type.Optional(Type.String({ maxLength: 128 })),
  }),
  closedObject({ state: Type.Literal("unknown") }),
]);

const ExecutionIdentityAdmissionEnvelopeSchema = closedObject({
  envelopeVersion: Type.Literal(1),
  contextId: boundedRef(),
  executionId: boundedRef(),
  runId: boundedRef(),
  createdAt: Type.Integer({ minimum: 0 }),
  runtimeInstanceId: rawRef(),
  agentId: boundedRef(),
  ingress: closedObject({
    kind: ingressKind(),
    boundary: boundedRef(),
    state: evidenceState(),
    rawSourceRef: Type.Optional(rawRef()),
  }),
  runtime: closedObject({
    kind: runtimeKind(),
  }),
  invoker: Type.Optional(ExecutionIdentityAdmissionInvokerSchema),
  applicableGrants: admissionGrants(),
  assurance: admissionAssurance(),
});

const ExecutionIdentityAdmissionFactsSchema = closedObject({
  runId: boundedRef(),
  agentId: boundedRef(),
  ingress: closedObject({
    kind: ingressKind(),
    boundary: boundedRef(),
    state: Type.Optional(evidenceState()),
    rawSourceRef: Type.Optional(rawRef()),
  }),
  runtime: closedObject({ kind: runtimeKind() }),
  invoker: Type.Optional(ExecutionIdentityAdmissionInvokerSchema),
  applicableGrants: Type.Optional(admissionGrants()),
  assurance: Type.Optional(admissionAssurance()),
});

const ExecutionIdentityAdmissionTokenSchema = closedObject({
  tokenVersion: Type.Literal(1),
  contextId: boundedRef(),
  executionId: boundedRef(),
  runId: boundedRef(),
  createdAt: Type.Integer({ minimum: 0 }),
});

export type ExecutionIdentityAdmissionEnvelope = Static<
  typeof ExecutionIdentityAdmissionEnvelopeSchema
>;
export type ExecutionIdentityAdmissionFacts = Omit<
  ExecutionIdentityAdmissionEnvelope,
  | "envelopeVersion"
  | "contextId"
  | "executionId"
  | "createdAt"
  | "runtimeInstanceId"
  | "ingress"
  | "applicableGrants"
  | "assurance"
> & {
  ingress: Omit<ExecutionIdentityAdmissionEnvelope["ingress"], "state"> & {
    state?: ExecutionIdentityAdmissionEnvelope["ingress"]["state"];
  };
  applicableGrants?: ExecutionIdentityAdmissionEnvelope["applicableGrants"];
  assurance?: ExecutionIdentityAdmissionEnvelope["assurance"];
};
export type ExecutionIdentityAdmissionToken = Static<typeof ExecutionIdentityAdmissionTokenSchema>;
export type ExecutionIdentityAdmissionWork =
  | { kind: "capture"; envelope: ExecutionIdentityAdmissionEnvelope }
  | { kind: "retry-reference"; token: ExecutionIdentityAdmissionToken };
type ExecutionIdentityAdmissionSink = (work: ExecutionIdentityAdmissionWork) => boolean;

let admissionSink: ExecutionIdentityAdmissionSink | undefined;
let admissionFailureWarned = false;

function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()].toSorted((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function freezeEnvelope<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    freezeEnvelope(nested, seen);
  }
  return Object.freeze(value);
}

// Snapshot descriptors before schema or projection: TypeBox accepts inherited
// keys, which would otherwise turn prototype data into diagnostic provenance.
function copyOwnedData<T>(value: T, ancestors = new WeakSet<object>()): T {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (typeof value !== "object" || isProxy(value)) {
    throw new Error("execution identity admission data must be clone-safe plain data");
  }
  if (ancestors.has(value)) {
    throw new Error("execution identity admission data must be clone-safe plain data");
  }
  ancestors.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    const array = Array.isArray(value);
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        prototype !== Array.prototype ||
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        keys.length !== lengthDescriptor.value + 1 ||
        keys.at(-1) !== "length"
      ) {
        throw new Error("execution identity admission data must be clone-safe plain data");
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("execution identity admission data must be clone-safe plain data");
    }
    const copy: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    for (const [index, key] of keys.entries()) {
      if (key === "length" && array) {
        continue;
      }
      if (typeof key !== "string" || (array && key !== String(index))) {
        throw new Error("execution identity admission data must be clone-safe plain data");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error("execution identity admission data must be clone-safe plain data");
      }
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: copyOwnedData(descriptor.value, ancestors),
        writable: true,
      });
    }
    return copy as T;
  } finally {
    ancestors.delete(value);
  }
}

function validateEnvelope(
  value: unknown,
): ExecutionIdentityAdmissionEnvelope & Record<string, unknown> {
  const owned = copyOwnedData(value);
  const baseEnvelope = executionIdentitySpawnAdmission({
    operation: "base-envelope",
    value: owned,
  });
  if (
    !Value.Check(ExecutionIdentityAdmissionEnvelopeSchema, baseEnvelope) ||
    typeof baseEnvelope.createdAt !== "number" ||
    !Number.isSafeInteger(baseEnvelope.createdAt)
  ) {
    throw new Error("execution identity admission envelope violates its bounded contract");
  }
  if (!owned || typeof owned !== "object" || Array.isArray(owned)) {
    throw new Error("execution identity admission envelope violates its bounded contract");
  }
  const encoded = JSON.stringify(owned);
  if (Buffer.byteLength(encoded, "utf8") > EXECUTION_IDENTITY_ADMISSION_MAX_BYTES) {
    throw new Error("execution identity admission envelope exceeds 16 KiB");
  }
  return owned as ExecutionIdentityAdmissionEnvelope & Record<string, unknown>;
}

function validateFacts(value: unknown): ExecutionIdentityAdmissionFacts {
  const baseFacts = executionIdentitySpawnAdmission({ operation: "base-facts", value });
  const owned = copyOwnedData(baseFacts);
  if (!Value.Check(ExecutionIdentityAdmissionFactsSchema, owned)) {
    throw new Error("execution identity admission facts violate their bounded contract");
  }
  const spawnFacts = executionIdentitySpawnAdmission({ operation: "read", value });
  return executionIdentitySpawnAdmission({ operation: "attach", value: owned, extra: spawnFacts });
}

function validateToken(value: unknown): ExecutionIdentityAdmissionToken {
  const owned = copyOwnedData(value);
  if (
    !Value.Check(ExecutionIdentityAdmissionTokenSchema, owned) ||
    !Number.isSafeInteger(owned.createdAt)
  ) {
    throw new Error("execution identity admission token violates its bounded contract");
  }
  return owned;
}

/** Allocate the immutable correlation owned by one outer admitted turn. */
export function createExecutionIdentityAdmissionToken(
  runId: string,
  options: { contextId?: string; executionId?: string; now?: number } = {},
): ExecutionIdentityAdmissionToken {
  const token = {
    tokenVersion: 1 as const,
    contextId: options.contextId ?? randomUUID(),
    executionId: options.executionId ?? randomUUID(),
    runId,
    createdAt: options.now ?? Date.now(),
  };
  return freezeEnvelope(validateToken(token));
}

export function parseExecutionIdentityAdmissionToken(
  value: unknown,
): ExecutionIdentityAdmissionToken {
  return freezeEnvelope(validateToken(value));
}

function redactDisplayLabel(value: string): string {
  // The shared redactor's secret-prefix pass becomes stable on its second pass.
  // Stabilizing here lets the worker reject any altered structured-clone payload.
  return truncateUtf16Safe(
    redactSensitiveText(redactSensitiveText(value, { mode: "tools" }), { mode: "tools" }),
    128,
  );
}

/** Capture owned admission facts without touching filesystem or database state. */
function captureExecutionIdentityAdmissionEnvelope(
  facts: ExecutionIdentityAdmissionFacts,
  options: {
    runtimeInstanceId?: string;
    token: ExecutionIdentityAdmissionToken;
  },
): ExecutionIdentityAdmissionEnvelope {
  const ownedToken = validateToken(options.token);
  if (ownedToken.runId !== facts.runId) {
    throw new Error("execution identity admission token disagrees with the admitted run");
  }
  const runtimeInstanceId = options.runtimeInstanceId ?? PROCESS_RUNTIME_INSTANCE_ID;
  const assurance = facts.assurance ?? [
    {
      kind: "runtime-binding" as const,
      rawEvidenceRef: runtimeInstanceId,
      strength: "boundary-verified" as const,
    },
  ];
  const serializedSpawnFacts = executionIdentitySpawnAdmission({ operation: "read", value: facts });
  const baseEnvelope = {
    envelopeVersion: 1 as const,
    contextId: ownedToken.contextId,
    executionId: ownedToken.executionId,
    runId: ownedToken.runId,
    createdAt: ownedToken.createdAt,
    runtimeInstanceId,
    agentId: facts.agentId,
    ingress: { ...facts.ingress, state: facts.ingress.state ?? "present" },
    runtime: { ...facts.runtime },
    ...(facts.invoker?.state === "present"
      ? {
          invoker: {
            state: "present" as const,
            kind: facts.invoker.kind,
            rawPrincipalRef: facts.invoker.rawPrincipalRef,
            ...(facts.invoker.displayLabel !== undefined
              ? { displayLabel: redactDisplayLabel(facts.invoker.displayLabel) }
              : {}),
          },
        }
      : facts.invoker?.state === "unknown"
        ? { invoker: { state: "unknown" as const } }
        : {}),
    applicableGrants: uniqueSorted(
      facts.applicableGrants ?? [],
      (grant) => `${grant.rawGrantRef}\0${grant.state}`,
    ).map((grant) => ({ rawGrantRef: grant.rawGrantRef, state: grant.state })),
    assurance: uniqueSorted(
      assurance,
      (item) => `${item.kind}\0${item.rawEvidenceRef}\0${item.strength}`,
    ).map((item) => ({
      kind: item.kind,
      rawEvidenceRef: item.rawEvidenceRef,
      strength: item.strength,
    })),
  };
  const envelope = executionIdentitySpawnAdmission({
    operation: "extend-envelope",
    value: baseEnvelope,
    extra: serializedSpawnFacts,
  });
  return freezeEnvelope(validateEnvelope(envelope));
}

/** Revalidate a structured-cloned queue payload before any persistence work. */
export function parseExecutionIdentityAdmissionEnvelope(
  value: unknown,
): ExecutionIdentityAdmissionEnvelope {
  const envelope = validateEnvelope(value);
  const spawnFacts = executionIdentitySpawnAdmission({ operation: "read", value: envelope });
  if (!spawnFacts) {
    throw new Error("execution identity admission envelope is missing spawn evidence state");
  }
  const parsed = captureExecutionIdentityAdmissionEnvelope(
    executionIdentitySpawnAdmission({ operation: "attach", value: envelope, extra: spawnFacts }),
    {
      token: createExecutionIdentityAdmissionToken(envelope.runId, {
        contextId: envelope.contextId,
        executionId: envelope.executionId,
        now: envelope.createdAt,
      }),
      runtimeInstanceId: envelope.runtimeInstanceId,
    },
  );
  if (JSON.stringify(parsed) !== JSON.stringify(envelope)) {
    throw new Error("execution identity admission envelope is not canonical");
  }
  return parsed;
}

/** Revalidate either bounded queue payload before schema, key, or database work. */
export function parseExecutionIdentityAdmissionWork(
  value: unknown,
): ExecutionIdentityAdmissionWork {
  const owned = copyOwnedData(value);
  if (!owned || typeof owned !== "object") {
    throw new Error("execution identity admission work violates its bounded contract");
  }
  const work = owned as { kind?: unknown; envelope?: unknown; token?: unknown };
  if (work.kind === "capture") {
    return freezeEnvelope({
      kind: "capture" as const,
      envelope: parseExecutionIdentityAdmissionEnvelope(work.envelope),
    });
  }
  if (work.kind === "retry-reference") {
    return freezeEnvelope({
      kind: "retry-reference" as const,
      token: parseExecutionIdentityAdmissionToken(work.token),
    });
  }
  throw new Error("execution identity admission work violates its bounded contract");
}

/** Install the current process lifecycle's writer without creating a second queue. */
export function configureExecutionIdentityAdmissionSink(
  sink: ExecutionIdentityAdmissionSink,
): () => void {
  admissionSink = sink;
  return () => {
    if (admissionSink === sink) {
      admissionSink = undefined;
    }
  };
}

export function hasExecutionIdentityAdmissionSink(): boolean {
  return admissionSink !== undefined;
}

/**
 * Capture and enqueue evidence. The returned ID is only a candidate until async persistence wins.
 */
export function enqueueExecutionIdentityContextAtAdmission(
  facts: ExecutionIdentityAdmissionFacts,
  options: {
    enabled: boolean;
    contextId?: string;
    executionId?: string;
    now?: number;
    runtimeInstanceId?: string;
    token?: ExecutionIdentityAdmissionToken;
    retryOnly?: boolean;
  },
):
  | {
      candidateContextId: string;
      candidateExecutionId: string;
      accepted: boolean;
    }
  | undefined {
  if (!options.enabled) {
    return undefined;
  }
  try {
    const ownedFacts = validateFacts(facts);
    const token = validateToken(
      options.token ??
        createExecutionIdentityAdmissionToken(ownedFacts.runId, {
          contextId: options.contextId,
          executionId: options.executionId,
          now: options.now,
        }),
    );
    const work: ExecutionIdentityAdmissionWork = options.retryOnly
      ? { kind: "retry-reference", token }
      : {
          kind: "capture",
          envelope: captureExecutionIdentityAdmissionEnvelope(ownedFacts, {
            token,
            runtimeInstanceId: options.runtimeInstanceId,
          }),
        };
    if (!admissionSink) {
      throw new Error("audit writer unavailable");
    }
    return {
      candidateContextId: token.contextId,
      candidateExecutionId: token.executionId,
      accepted: admissionSink(work),
    };
  } catch {
    if (!admissionFailureWarned) {
      admissionFailureWarned = true;
      log.warn("audit execution identity admission evidence was not queued; continuing without it");
    }
    return undefined;
  }
}
