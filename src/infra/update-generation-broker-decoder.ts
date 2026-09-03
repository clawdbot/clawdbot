import { isProxy } from "node:util/types";
import type {
  UpdateGenerationBrokerReceipt,
  UpdateGenerationBrokerRequest,
} from "./update-generation-confined-filesystem.js";
import { isSafeUpdateGenerationEntrypointPath } from "./update-generation-entrypoint-path.js";

type Literal = boolean | number | string;
type DecodeShape =
  | { kind: "array"; element: DecodeShape }
  | { kind: "boolean" }
  | { kind: "entrypoint-path" }
  | { kind: "literal"; value: Literal }
  | { kind: "nullable"; value: DecodeShape }
  | { kind: "number" }
  | { kind: "object"; fields: Readonly<Record<string, DecodeShape>> }
  | { kind: "string" };

export const UPDATE_GENERATION_BROKER_MAX_ARRAY_LENGTH = 10_000;
const stringShape = { kind: "string" } as const;
const entrypointPathShape = { kind: "entrypoint-path" } as const;
const numberShape = { kind: "number" } as const;
const booleanShape = { kind: "boolean" } as const;
const literal = (value: Literal): DecodeShape => ({ kind: "literal", value });
const nullable = (value: DecodeShape): DecodeShape => ({ kind: "nullable", value });
const array = (element: DecodeShape): DecodeShape => ({ kind: "array", element });
const object = (fields: Readonly<Record<string, DecodeShape>>): DecodeShape => ({
  kind: "object",
  fields,
});

const selectionFields = {
  formatVersion: literal(1),
  generationId: stringShape,
  manifestSha256: stringShape,
  entrypointRelativePath: entrypointPathShape,
} satisfies Record<string, DecodeShape>;
const selectionShape = object(selectionFields);
const descriptorShape = object({ ...selectionFields, packageVersion: stringShape });
const manifestShape = object({
  algorithm: literal("sha256"),
  digest: stringShape,
  entryCount: numberShape,
  totalBytes: numberShape,
});
const signatureShape = object({
  algorithm: literal("ed25519"),
  keyId: stringShape,
  signedPayloadSha256: stringShape,
  valueBase64: stringShape,
});
const retainedPairShape = object({
  selected: selectionShape,
  rollback: selectionShape,
  selectedManifestVerified: literal(true),
  rollbackManifestVerified: literal(true),
});
const observedGenerationShape = object({
  generationId: stringShape,
  manifestSha256: stringShape,
  parentDirectoryDurable: booleanShape,
});
const deferredCleanupShape = object({ generationId: stringShape, reason: stringShape });

const requestBase = {
  formatVersion: literal(1),
  brokerId: stringShape,
  namespaceKey: stringShape,
  transactionId: stringShape,
  operationId: stringShape,
  expectedRevision: nullable(stringShape),
} satisfies Record<string, DecodeShape>;

const requestShapes = {
  "materialize-generation": object({
    ...requestBase,
    kind: literal("materialize-generation"),
    role: stringShape,
    sourceArtifactId: stringShape,
    manifest: manifestShape,
    generation: descriptorShape,
  }),
  "sync-parent-directory": object({
    ...requestBase,
    kind: literal("sync-parent-directory"),
    parent: stringShape,
    afterOperationId: stringShape,
  }),
  "switch-selector": object({
    ...requestBase,
    kind: literal("switch-selector"),
    expected: nullable(selectionShape),
    next: selectionShape,
  }),
  "cleanup-generations": object({
    ...requestBase,
    kind: literal("cleanup-generations"),
    generationIds: array(stringShape),
    protectedGenerationIds: array(stringShape),
  }),
  "verify-retained-pair": object({
    ...requestBase,
    kind: literal("verify-retained-pair"),
    selected: selectionShape,
    rollback: selectionShape,
  }),
  "observe-recovery": object({ ...requestBase, kind: literal("observe-recovery") }),
} satisfies Record<UpdateGenerationBrokerRequest["kind"], DecodeShape>;

const receiptBase = {
  formatVersion: literal(1),
  brokerId: stringShape,
  namespaceKey: stringShape,
  transactionId: stringShape,
  operationId: stringShape,
  requestSha256: stringShape,
  previousRevision: nullable(stringShape),
  revision: nullable(stringShape),
  recordedAtMs: numberShape,
  signature: signatureShape,
} satisfies Record<string, DecodeShape>;

const receiptShapes = {
  "materialize-generation": object({
    ...receiptBase,
    kind: literal("materialize-generation"),
    role: stringShape,
    sourceArtifactId: stringShape,
    manifest: manifestShape,
    generation: descriptorShape,
  }),
  "sync-parent-directory": object({
    ...receiptBase,
    kind: literal("sync-parent-directory"),
    parent: stringShape,
    afterOperationId: stringShape,
    durable: literal(true),
  }),
  "switch-selector": object({
    ...receiptBase,
    kind: literal("switch-selector"),
    previous: nullable(selectionShape),
    selected: selectionShape,
  }),
  "cleanup-generations": object({
    ...receiptBase,
    kind: literal("cleanup-generations"),
    generationIds: array(stringShape),
    removedGenerationIds: array(stringShape),
    deferred: array(deferredCleanupShape),
    protectedGenerationIds: array(stringShape),
  }),
  "verify-retained-pair": object({
    ...receiptBase,
    kind: literal("verify-retained-pair"),
    retainedPair: retainedPairShape,
  }),
  "observe-recovery": object({
    ...receiptBase,
    kind: literal("observe-recovery"),
    selector: nullable(selectionShape),
    selectorDurable: booleanShape,
    generations: array(observedGenerationShape),
    retainedPair: nullable(retainedPairShape),
  }),
} satisfies Record<UpdateGenerationBrokerReceipt["kind"], DecodeShape>;

function assertAllowedObject(value: object, path: string, arrayExpected: boolean): void {
  if (isProxy(value)) {
    throw new TypeError(`${path} must not be a proxy`);
  }
  if (Array.isArray(value) !== arrayExpected) {
    throw new TypeError(`${path} has the wrong container type`);
  }
  const prototype = Object.getPrototypeOf(value);
  const expectedPrototype = arrayExpected ? Array.prototype : Object.prototype;
  if (prototype !== expectedPrototype && prototype !== null) {
    throw new TypeError(`${path} has an unsupported prototype`);
  }
}

function readDataProperty(value: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    throw new TypeError(`${path}.${key} must be an own property`);
  }
  if (!("value" in descriptor)) {
    throw new TypeError(`${path}.${key} must be a data property`);
  }
  if (descriptor.value === undefined) {
    throw new TypeError(`${path}.${key} must not be undefined`);
  }
  return descriptor.value;
}

function assertExactOwnKeys(value: object, expected: readonly string[], path: string): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${path} must contain exactly its declared own keys`);
  }
}

function decodeArray(value: unknown, shape: Extract<DecodeShape, { kind: "array" }>, path: string) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${path} must be an array`);
  }
  assertAllowedObject(value, path, true);
  const lengthValue = readDataProperty(value, "length", path);
  if (
    typeof lengthValue !== "number" ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < 0 ||
    lengthValue > UPDATE_GENERATION_BROKER_MAX_ARRAY_LENGTH
  ) {
    throw new TypeError(`${path}.length is invalid`);
  }
  const length = lengthValue;
  const keys = Reflect.ownKeys(value);
  const indexes = keys.filter((key) => key !== "length");
  if (
    keys.some((key) => typeof key !== "string") ||
    indexes.length !== length ||
    indexes.some((key) => {
      const index = Number(key);
      return !Number.isInteger(index) || index < 0 || index >= length || String(index) !== key;
    })
  ) {
    throw new TypeError(`${path} must contain exactly its declared array indexes`);
  }
  const decoded: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    decoded.push(
      decodeValue(readDataProperty(value, String(index), path), shape.element, `${path}[${index}]`),
    );
  }
  return Object.freeze(decoded);
}

function decodeObject(
  value: unknown,
  shape: Extract<DecodeShape, { kind: "object" }>,
  path: string,
) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${path} must be an object`);
  }
  assertAllowedObject(value, path, false);
  const expected = Object.keys(shape.fields);
  assertExactOwnKeys(value, expected, path);
  const decoded: Record<string, unknown> = {};
  for (const key of expected) {
    decoded[key] = decodeValue(
      readDataProperty(value, key, path),
      shape.fields[key]!,
      `${path}.${key}`,
    );
  }
  return Object.freeze(decoded);
}

function decodeValue(value: unknown, shape: DecodeShape, path: string): unknown {
  if (shape.kind === "nullable" && value === null) {
    return null;
  }
  if (shape.kind === "nullable") {
    return decodeValue(value, shape.value, path);
  }
  if (shape.kind === "array") {
    return decodeArray(value, shape, path);
  }
  if (shape.kind === "object") {
    return decodeObject(value, shape, path);
  }
  if (shape.kind === "literal") {
    if (value !== shape.value) {
      throw new TypeError(`${path} must be the literal ${JSON.stringify(shape.value)}`);
    }
    return value;
  }
  if (shape.kind === "entrypoint-path") {
    if (typeof value !== "string" || !isSafeUpdateGenerationEntrypointPath(value)) {
      throw new TypeError(`${path} must be a safe cross-platform entrypoint path`);
    }
    return value;
  }
  if (typeof value !== shape.kind || (shape.kind === "number" && !Number.isFinite(value))) {
    throw new TypeError(`${path} must be a finite ${shape.kind}`);
  }
  return value;
}

function readOperationKind(value: unknown, path: string): UpdateGenerationBrokerRequest["kind"] {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${path} must be an object`);
  }
  assertAllowedObject(value, path, false);
  const kind = readDataProperty(value, "kind", path);
  if (typeof kind !== "string" || !Object.hasOwn(requestShapes, kind)) {
    throw new TypeError(`${path}.kind is unsupported`);
  }
  // SAFETY: The exact-shape table owns every accepted string discriminant.
  return kind as UpdateGenerationBrokerRequest["kind"];
}

export function decodeUpdateGenerationBrokerRequest(value: unknown): UpdateGenerationBrokerRequest {
  const kind = readOperationKind(value, "broker request");
  // SAFETY: The selected recursive schema exactly mirrors the discriminated request union.
  return decodeValue(value, requestShapes[kind], "broker request") as UpdateGenerationBrokerRequest;
}

export function decodeUpdateGenerationBrokerReceipt(value: unknown): UpdateGenerationBrokerReceipt {
  const kind = readOperationKind(value, "broker receipt");
  // SAFETY: The selected recursive schema exactly mirrors the discriminated receipt union.
  return decodeValue(value, receiptShapes[kind], "broker receipt") as UpdateGenerationBrokerReceipt;
}
