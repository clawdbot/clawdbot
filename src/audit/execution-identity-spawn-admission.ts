import { isRecord } from "@openclaw/normalization-core/record-coerce";

const EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS = Symbol("executionIdentitySpawnAdmissionFacts");

type ExecutionIdentitySpawnLineage = {
  parentContextId?: string;
  parentExecutionId?: string;
  parentRunId?: string;
  parentAgentId: string;
  relation: "sessions_spawn";
  rawRequesterRef: string;
  rawControllerRef: string;
  depth: number;
  localPolicyRefs: string[];
  targetPolicyRefs: string[];
};

type ExecutionIdentitySpawnAdmissionExtension = {
  lineage?: ExecutionIdentitySpawnLineage;
  missingEvidence: string[];
};

type ExecutionIdentitySpawnAdmissionInput =
  | { operation: "serialize"; value: unknown; extra: unknown }
  | { operation: "parse"; value: unknown }
  | { operation: "attach"; value: unknown; extra?: unknown }
  | { operation: "base-facts"; value: unknown }
  | { operation: "extend-envelope"; value: unknown; extra?: unknown }
  | { operation: "base-envelope"; value: unknown }
  | { operation: "read"; value: unknown };

function ownDataDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("execution identity spawn admission carrier is invalid");
  }
  return descriptor;
}

function copyBaseFacts(value: object): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("execution identity spawn admission carrier is invalid");
  }
  const descriptors: Record<PropertyKey, PropertyDescriptor> =
    Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      (typeof key !== "string" &&
        (key !== EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS || typeof descriptor.value !== "string"))
    ) {
      throw new Error("execution identity spawn admission carrier is invalid");
    }
    if (typeof key !== "string") {
      delete descriptors[key];
    }
  }
  return Object.create(null, descriptors);
}

function validRef(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

function validateEnvelopeExtension(
  lineage: unknown,
  missingEvidence: unknown,
): ExecutionIdentitySpawnAdmissionExtension {
  if (
    !Array.isArray(missingEvidence) ||
    missingEvidence.length > 16 ||
    !missingEvidence.every((item) => validRef(item, 256))
  ) {
    throw new Error("execution identity spawn missing-evidence facts are invalid");
  }
  if (lineage === undefined || lineage === null) {
    return { missingEvidence };
  }
  if (
    !isRecord(lineage) ||
    (lineage.parentContextId !== undefined && !validRef(lineage.parentContextId, 256)) ||
    (lineage.parentExecutionId !== undefined && !validRef(lineage.parentExecutionId, 256)) ||
    (lineage.parentRunId !== undefined && !validRef(lineage.parentRunId, 256)) ||
    !validRef(lineage.parentAgentId, 256) ||
    lineage.relation !== "sessions_spawn" ||
    !validRef(lineage.rawRequesterRef, 4_096) ||
    !validRef(lineage.rawControllerRef, 4_096) ||
    !Number.isSafeInteger(lineage.depth) ||
    typeof lineage.depth !== "number" ||
    lineage.depth < 1 ||
    lineage.depth > 64 ||
    !Array.isArray(lineage.localPolicyRefs) ||
    lineage.localPolicyRefs.length > 16 ||
    !lineage.localPolicyRefs.every((item) => validRef(item, 4_096)) ||
    !Array.isArray(lineage.targetPolicyRefs) ||
    lineage.targetPolicyRefs.length > 16 ||
    !lineage.targetPolicyRefs.every((item) => validRef(item, 4_096))
  ) {
    throw new Error("execution identity spawn lineage facts are invalid");
  }
  return {
    lineage: {
      ...(lineage.parentContextId !== undefined
        ? { parentContextId: lineage.parentContextId }
        : {}),
      ...(lineage.parentExecutionId !== undefined
        ? { parentExecutionId: lineage.parentExecutionId }
        : {}),
      ...(lineage.parentRunId !== undefined ? { parentRunId: lineage.parentRunId } : {}),
      parentAgentId: lineage.parentAgentId,
      relation: lineage.relation,
      rawRequesterRef: lineage.rawRequesterRef,
      rawControllerRef: lineage.rawControllerRef,
      depth: lineage.depth,
      localPolicyRefs: lineage.localPolicyRefs,
      targetPolicyRefs: lineage.targetPolicyRefs,
    },
    missingEvidence,
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

export function executionIdentitySpawnAdmission(input: {
  operation: "serialize";
  value: unknown;
  extra: unknown;
}): string;
export function executionIdentitySpawnAdmission(input: {
  operation: "parse";
  value: unknown;
}): readonly [ExecutionIdentitySpawnLineage | undefined, string[]];
export function executionIdentitySpawnAdmission<T extends object>(input: {
  operation: "attach";
  value: T;
  extra?: unknown;
}): T;
export function executionIdentitySpawnAdmission(input: {
  operation: "base-facts";
  value: unknown;
}): Record<string, unknown>;
export function executionIdentitySpawnAdmission<T extends object>(input: {
  operation: "extend-envelope";
  value: T;
  extra?: unknown;
}): T & ExecutionIdentitySpawnAdmissionExtension;
export function executionIdentitySpawnAdmission(input: {
  operation: "base-envelope";
  value: unknown;
}): Record<string, unknown>;
export function executionIdentitySpawnAdmission(input: {
  operation: "read";
  value: unknown;
}): string | undefined;
export function executionIdentitySpawnAdmission(
  operationInput: ExecutionIdentitySpawnAdmissionInput,
): unknown {
  const { operation, value } = operationInput;
  if (operation === "serialize") {
    const extension = validateEnvelopeExtension(value, operationInput.extra);
    return JSON.stringify([extension.lineage ?? null, extension.missingEvidence]);
  }
  if (operation === "parse") {
    if (typeof value !== "string") {
      throw new Error("execution identity spawn admission facts are invalid");
    }
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      throw new Error("execution identity spawn admission facts are invalid");
    }
    const extension = validateEnvelopeExtension(parsed[0], parsed[1]);
    return [extension.lineage, extension.missingEvidence];
  }
  if (!isRecord(value)) {
    throw new Error("execution identity spawn admission carrier is invalid");
  }
  if (operation === "attach") {
    if (typeof operationInput.extra !== "string") {
      return value;
    }
    const carried = Object.create(
      Object.getPrototypeOf(value),
      Object.getOwnPropertyDescriptors(value),
    );
    Object.defineProperty(carried, EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS, {
      configurable: true,
      enumerable: true,
      value: operationInput.extra,
      writable: true,
    });
    return carried;
  }
  if (operation === "base-facts") {
    return copyBaseFacts(value);
  }
  if (operation === "extend-envelope") {
    const serialized =
      typeof operationInput.extra === "string" ? operationInput.extra : JSON.stringify([null, []]);
    const [lineage, missingEvidence] = executionIdentitySpawnAdmission({
      operation: "parse",
      value: serialized,
    });
    const normalizedLineage = lineage
      ? {
          ...lineage,
          localPolicyRefs: uniqueSorted(lineage.localPolicyRefs),
          targetPolicyRefs: uniqueSorted(lineage.targetPolicyRefs),
        }
      : undefined;
    return {
      ...value,
      ...(normalizedLineage ? { lineage: normalizedLineage } : {}),
      missingEvidence: uniqueSorted(missingEvidence),
    };
  }
  if (operation === "base-envelope") {
    const baseEnvelope = copyBaseFacts(value);
    const { lineage, missingEvidence } = baseEnvelope;
    validateEnvelopeExtension(lineage, missingEvidence);
    delete baseEnvelope.lineage;
    delete baseEnvelope.missingEvidence;
    return baseEnvelope;
  }
  const attached = ownDataDescriptor(value, EXECUTION_IDENTITY_SPAWN_ADMISSION_FACTS)?.value;
  if (attached !== undefined) {
    if (typeof attached !== "string") {
      throw new Error("execution identity spawn admission carrier is invalid");
    }
    return attached;
  }
  const missingEvidence = ownDataDescriptor(value, "missingEvidence")?.value;
  if (!Array.isArray(missingEvidence)) {
    return undefined;
  }
  const lineage = ownDataDescriptor(value, "lineage")?.value;
  const extension = validateEnvelopeExtension(lineage, missingEvidence);
  return JSON.stringify([extension.lineage ?? null, extension.missingEvidence]);
}
