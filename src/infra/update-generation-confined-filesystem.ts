/**
 * Opaque filesystem authority required by generation-addressed updates.
 *
 * This module deliberately contains no pathname-backed implementation or
 * factory. A production provider must be supplied by the protected update
 * broker and must authenticate every operation and receipt.
 */
import { createHash } from "node:crypto";
import {
  decodeUpdateGenerationBrokerReceipt,
  decodeUpdateGenerationBrokerRequest,
} from "./update-generation-broker-decoder.js";
import type {
  UpdateGenerationDescriptor,
  UpdateGenerationManifest,
  UpdateGenerationSelection,
} from "./update-generation-contract.js";

export type UpdateGenerationBrokerOperationKind =
  | "materialize-generation"
  | "sync-parent-directory"
  | "switch-selector"
  | "cleanup-generations"
  | "verify-retained-pair"
  | "observe-recovery";

export function buildUpdateGenerationBrokerOperationId(params: {
  intentReceiptId: string;
  kind: UpdateGenerationBrokerOperationKind;
}): string {
  assertNonEmpty(params.intentReceiptId, "intent receipt id");
  return `${params.intentReceiptId}:broker:${params.kind}`;
}

type UpdateGenerationBrokerRequestBase<Kind extends UpdateGenerationBrokerOperationKind> = {
  formatVersion: 1;
  kind: Kind;
  brokerId: string;
  namespaceKey: string;
  transactionId: string;
  operationId: string;
  expectedRevision: string | null;
};

export type UpdateGenerationBrokerRequest =
  | (UpdateGenerationBrokerRequestBase<"materialize-generation"> & {
      role: "previous" | "candidate";
      sourceArtifactId: string;
      manifest: UpdateGenerationManifest;
      generation: UpdateGenerationDescriptor;
    })
  | (UpdateGenerationBrokerRequestBase<"sync-parent-directory"> & {
      parent: "generations" | "selector";
      afterOperationId: string;
    })
  | (UpdateGenerationBrokerRequestBase<"switch-selector"> & {
      expected: UpdateGenerationSelection | null;
      next: UpdateGenerationSelection;
    })
  | (UpdateGenerationBrokerRequestBase<"cleanup-generations"> & {
      generationIds: string[];
      protectedGenerationIds: string[];
    })
  | (UpdateGenerationBrokerRequestBase<"verify-retained-pair"> & {
      selected: UpdateGenerationSelection;
      rollback: UpdateGenerationSelection;
    })
  | UpdateGenerationBrokerRequestBase<"observe-recovery">;

export type UpdateGenerationBrokerSignature = {
  algorithm: "ed25519";
  keyId: string;
  signedPayloadSha256: string;
  valueBase64: string;
};

export type UpdateGenerationObservedGeneration = {
  generationId: string;
  manifestSha256: string;
  parentDirectoryDurable: boolean;
};

export type UpdateGenerationRetainedPair = {
  selected: UpdateGenerationSelection;
  rollback: UpdateGenerationSelection;
  selectedManifestVerified: true;
  rollbackManifestVerified: true;
};

type UpdateGenerationBrokerReceiptBase<Kind extends UpdateGenerationBrokerOperationKind> = {
  formatVersion: 1;
  kind: Kind;
  brokerId: string;
  namespaceKey: string;
  transactionId: string;
  operationId: string;
  requestSha256: string;
  previousRevision: string | null;
  revision: string | null;
  recordedAtMs: number;
  signature: UpdateGenerationBrokerSignature;
};

export type UpdateGenerationBrokerReceipt =
  | (UpdateGenerationBrokerReceiptBase<"materialize-generation"> & {
      role: "previous" | "candidate";
      sourceArtifactId: string;
      manifest: UpdateGenerationManifest;
      generation: UpdateGenerationDescriptor;
    })
  | (UpdateGenerationBrokerReceiptBase<"sync-parent-directory"> & {
      parent: "generations" | "selector";
      afterOperationId: string;
      durable: true;
    })
  | (UpdateGenerationBrokerReceiptBase<"switch-selector"> & {
      previous: UpdateGenerationSelection | null;
      selected: UpdateGenerationSelection;
    })
  | (UpdateGenerationBrokerReceiptBase<"cleanup-generations"> & {
      generationIds: string[];
      removedGenerationIds: string[];
      deferred: Array<{ generationId: string; reason: string }>;
      protectedGenerationIds: string[];
    })
  | (UpdateGenerationBrokerReceiptBase<"verify-retained-pair"> & {
      retainedPair: UpdateGenerationRetainedPair;
    })
  | (UpdateGenerationBrokerReceiptBase<"observe-recovery"> & {
      selector: UpdateGenerationSelection | null;
      selectorDurable: boolean;
      generations: UpdateGenerationObservedGeneration[];
      retainedPair: UpdateGenerationRetainedPair | null;
    });

export type UpdateGenerationBrokerReceiptOf<Kind extends UpdateGenerationBrokerOperationKind> =
  Extract<UpdateGenerationBrokerReceipt, { kind: Kind }>;

declare const authenticatedBrokerReceipt: unique symbol;
export type UpdateGenerationAuthenticatedBrokerReceiptOf<
  Kind extends UpdateGenerationBrokerOperationKind,
> = UpdateGenerationBrokerReceiptOf<Kind> & {
  readonly [authenticatedBrokerReceipt]: true;
};

const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION_ID = /^[a-f0-9]{32}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const OPERATION_KINDS = new Set<UpdateGenerationBrokerOperationKind>([
  "materialize-generation",
  "sync-parent-directory",
  "switch-selector",
  "cleanup-generations",
  "verify-retained-pair",
  "observe-recovery",
]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Broker payload numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .toSorted()
      .filter((key) => Reflect.get(value, key) !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Broker payload is not serializable");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function digestUpdateGenerationBrokerRequest(
  request: UpdateGenerationBrokerRequest,
): string {
  const decoded = decodeUpdateGenerationBrokerRequest(request);
  assertRequest(decoded);
  return digestDecodedRequest(decoded);
}

export function digestUpdateGenerationBrokerReceiptPayload(receipt: object): string {
  const decoded = decodeUpdateGenerationBrokerReceipt(receipt);
  return digestDecodedReceiptPayload(decoded);
}

function digestDecodedRequest(request: UpdateGenerationBrokerRequest): string {
  return sha256(request);
}

function digestDecodedReceiptPayload(receipt: UpdateGenerationBrokerReceipt): string {
  const unsigned = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== "signature"),
  );
  return sha256(unsigned);
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} is required`);
  }
}

function selectionsEqual(
  left: UpdateGenerationSelection | null,
  right: UpdateGenerationSelection | null,
): boolean {
  return (
    left?.formatVersion === right?.formatVersion &&
    left?.generationId === right?.generationId &&
    left?.manifestSha256 === right?.manifestSha256 &&
    left?.entrypointRelativePath === right?.entrypointRelativePath
  );
}

function assertSelection(selection: unknown): asserts selection is UpdateGenerationSelection {
  if (!selection || typeof selection !== "object") {
    throw new TypeError("Invalid generation selection in broker operation");
  }
  // SAFETY: Every selection field is validated below before the value escapes this function.
  const candidate = selection as UpdateGenerationSelection;
  const normalizedEntrypoint = candidate.entrypointRelativePath?.replaceAll("\\", "/");
  if (
    candidate.formatVersion !== 1 ||
    typeof candidate.generationId !== "string" ||
    !GENERATION_ID.test(candidate.generationId) ||
    typeof candidate.manifestSha256 !== "string" ||
    !SHA256.test(candidate.manifestSha256) ||
    typeof candidate.entrypointRelativePath !== "string" ||
    !candidate.entrypointRelativePath ||
    !normalizedEntrypoint ||
    normalizedEntrypoint.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalizedEntrypoint) ||
    normalizedEntrypoint.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError("Invalid generation selection in broker operation");
  }
}

function assertDistinctGenerationIds(ids: unknown, label: string): asserts ids is string[] {
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || !GENERATION_ID.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new TypeError(`${label} must contain distinct generation ids`);
  }
}

function assertRequest(request: UpdateGenerationBrokerRequest): void {
  if (request.formatVersion !== 1 || !OPERATION_KINDS.has(request.kind)) {
    throw new TypeError("Unsupported update broker request version");
  }
  for (const [label, value] of [
    ["broker id", request.brokerId],
    ["namespace key", request.namespaceKey],
    ["transaction id", request.transactionId],
    ["operation id", request.operationId],
  ] as const) {
    assertNonEmpty(value, label);
  }
  if (request.expectedRevision !== null) {
    assertNonEmpty(request.expectedRevision, "expected broker revision");
  }
  if (request.kind === "materialize-generation") {
    if (request.role !== "previous" && request.role !== "candidate") {
      throw new TypeError("Materialization role is invalid");
    }
    assertNonEmpty(request.sourceArtifactId, "source artifact id");
    assertSelection(request.generation);
    assertNonEmpty(request.generation.packageVersion, "generation package version");
    if (
      request.manifest.algorithm !== "sha256" ||
      request.manifest.digest !== request.generation.manifestSha256 ||
      !Number.isSafeInteger(request.manifest.entryCount) ||
      request.manifest.entryCount < 0 ||
      !Number.isSafeInteger(request.manifest.totalBytes) ||
      request.manifest.totalBytes < 0
    ) {
      throw new TypeError("Materialization request manifest is invalid");
    }
  } else if (request.kind === "sync-parent-directory") {
    if (request.parent !== "generations" && request.parent !== "selector") {
      throw new TypeError("Parent-directory sync target is invalid");
    }
    assertNonEmpty(request.afterOperationId, "parent sync predecessor operation id");
  } else if (request.kind === "switch-selector") {
    if (request.expected !== null) {
      assertSelection(request.expected);
    }
    assertSelection(request.next);
    if (selectionsEqual(request.expected, request.next)) {
      throw new Error("Selector switch must change the selected generation");
    }
  } else if (request.kind === "cleanup-generations") {
    assertDistinctGenerationIds(request.generationIds, "cleanup generation ids");
    assertDistinctGenerationIds(request.protectedGenerationIds, "protected generation ids");
    const protectedIds = new Set(request.protectedGenerationIds);
    if (request.generationIds.some((id) => protectedIds.has(id))) {
      throw new Error("Cleanup request includes a protected generation");
    }
  } else if (request.kind === "verify-retained-pair") {
    assertSelection(request.selected);
    assertSelection(request.rollback);
    if (request.selected.generationId === request.rollback.generationId) {
      throw new Error("Retained pair must contain distinct generations");
    }
  }
}

function assertRetainedPair(
  pair: unknown,
  expected?: Extract<UpdateGenerationBrokerRequest, { kind: "verify-retained-pair" }>,
): asserts pair is UpdateGenerationRetainedPair {
  if (!pair || typeof pair !== "object") {
    throw new TypeError("Broker receipt does not contain a retained generation pair");
  }
  // SAFETY: Every retained-pair field is validated below before the value escapes this function.
  const candidate = pair as UpdateGenerationRetainedPair;
  assertSelection(candidate.selected);
  assertSelection(candidate.rollback);
  if (
    candidate.selected.generationId === candidate.rollback.generationId ||
    typeof candidate.selectedManifestVerified !== "boolean" ||
    !candidate.selectedManifestVerified ||
    typeof candidate.rollbackManifestVerified !== "boolean" ||
    !candidate.rollbackManifestVerified
  ) {
    throw new Error("Broker receipt does not prove two retained generations");
  }
  if (
    expected &&
    (!selectionsEqual(candidate.selected, expected.selected) ||
      !selectionsEqual(candidate.rollback, expected.rollback))
  ) {
    throw new Error("Broker retained-pair receipt differs from its request");
  }
}

function requestFromReceipt(receipt: UpdateGenerationBrokerReceipt): UpdateGenerationBrokerRequest {
  const base = {
    formatVersion: 1 as const,
    kind: receipt.kind,
    brokerId: receipt.brokerId,
    namespaceKey: receipt.namespaceKey,
    transactionId: receipt.transactionId,
    operationId: receipt.operationId,
    expectedRevision: receipt.previousRevision,
  };
  if (receipt.kind === "materialize-generation") {
    return {
      ...base,
      kind: receipt.kind,
      role: receipt.role,
      sourceArtifactId: receipt.sourceArtifactId,
      manifest: receipt.manifest,
      generation: receipt.generation,
    };
  }
  if (receipt.kind === "sync-parent-directory") {
    return {
      ...base,
      kind: receipt.kind,
      parent: receipt.parent,
      afterOperationId: receipt.afterOperationId,
    };
  }
  if (receipt.kind === "switch-selector") {
    return {
      ...base,
      kind: receipt.kind,
      expected: receipt.previous,
      next: receipt.selected,
    };
  }
  if (receipt.kind === "cleanup-generations") {
    return {
      ...base,
      kind: receipt.kind,
      generationIds: receipt.generationIds,
      protectedGenerationIds: receipt.protectedGenerationIds,
    };
  }
  if (receipt.kind === "verify-retained-pair") {
    return {
      ...base,
      kind: receipt.kind,
      selected: receipt.retainedPair.selected,
      rollback: receipt.retainedPair.rollback,
    };
  }
  return { ...base, kind: receipt.kind };
}

export function assertUpdateGenerationBrokerReceiptIsValid(
  value: unknown,
): asserts value is UpdateGenerationBrokerReceipt {
  const receipt = decodeUpdateGenerationBrokerReceipt(value);
  assertDecodedReceiptIsValid(receipt);
}

function assertDecodedReceiptIsValid(receipt: UpdateGenerationBrokerReceipt): void {
  const request = decodeUpdateGenerationBrokerRequest(requestFromReceipt(receipt));
  assertRequest(request);
  assertReceiptMatchesRequest(request, receipt);
}

function assertReceiptMatchesRequest(
  request: UpdateGenerationBrokerRequest,
  receipt: UpdateGenerationBrokerReceipt,
  requestSha256 = digestDecodedRequest(request),
): void {
  if (
    receipt.formatVersion !== 1 ||
    receipt.kind !== request.kind ||
    receipt.brokerId !== request.brokerId ||
    receipt.namespaceKey !== request.namespaceKey ||
    receipt.transactionId !== request.transactionId ||
    receipt.operationId !== request.operationId ||
    receipt.previousRevision !== request.expectedRevision ||
    receipt.requestSha256 !== requestSha256
  ) {
    throw new Error("Broker receipt identity differs from its operation request");
  }
  if (request.kind === "observe-recovery" || request.kind === "verify-retained-pair") {
    if (receipt.revision !== receipt.previousRevision) {
      throw new Error("Read-only broker evidence must not advance the namespace revision");
    }
  } else if (
    typeof receipt.revision !== "string" ||
    !receipt.revision.trim() ||
    receipt.revision === receipt.previousRevision
  ) {
    throw new Error("Broker receipt must advance the namespace revision");
  }
  if (!Number.isSafeInteger(receipt.recordedAtMs) || receipt.recordedAtMs < 0) {
    throw new TypeError("Broker receipt timestamp is invalid");
  }
  const signature = receipt.signature;
  if (
    signature.algorithm !== "ed25519" ||
    !signature.keyId ||
    !SHA256.test(signature.signedPayloadSha256) ||
    !BASE64.test(signature.valueBase64) ||
    Buffer.from(signature.valueBase64, "base64").byteLength !== 64 ||
    signature.signedPayloadSha256 !== digestDecodedReceiptPayload(receipt)
  ) {
    throw new Error("Broker receipt signature envelope is invalid");
  }
  if (request.kind === "materialize-generation" && receipt.kind === request.kind) {
    if (
      receipt.role !== request.role ||
      receipt.sourceArtifactId !== request.sourceArtifactId ||
      canonicalJson(receipt.manifest) !== canonicalJson(request.manifest) ||
      !selectionsEqual(receipt.generation, request.generation) ||
      receipt.generation.packageVersion !== request.generation.packageVersion
    ) {
      throw new Error("Materialization receipt differs from its request");
    }
  } else if (request.kind === "sync-parent-directory" && receipt.kind === request.kind) {
    if (
      receipt.parent !== request.parent ||
      receipt.afterOperationId !== request.afterOperationId ||
      typeof receipt.durable !== "boolean" ||
      !receipt.durable
    ) {
      throw new Error("Parent-directory sync receipt differs from its request");
    }
  } else if (request.kind === "switch-selector" && receipt.kind === request.kind) {
    if (
      !selectionsEqual(receipt.previous, request.expected) ||
      !selectionsEqual(receipt.selected, request.next)
    ) {
      throw new Error("Selector receipt differs from its request");
    }
  } else if (request.kind === "cleanup-generations" && receipt.kind === request.kind) {
    const completed = [
      ...receipt.removedGenerationIds,
      ...receipt.deferred.map((entry) => entry.generationId),
    ];
    assertDistinctGenerationIds(receipt.generationIds, "cleanup receipt generation ids");
    assertDistinctGenerationIds(receipt.protectedGenerationIds, "cleanup receipt protected ids");
    assertDistinctGenerationIds(receipt.removedGenerationIds, "removed generation ids");
    if (receipt.deferred.some((entry) => !entry.reason.trim())) {
      throw new Error("Deferred cleanup receipt requires a reason");
    }
    if (
      receipt.generationIds.join("\0") !== request.generationIds.join("\0") ||
      new Set(completed).size !== completed.length ||
      completed.toSorted().join("\0") !== request.generationIds.toSorted().join("\0") ||
      receipt.protectedGenerationIds.toSorted().join("\0") !==
        request.protectedGenerationIds.toSorted().join("\0")
    ) {
      throw new Error("Cleanup receipt differs from its request");
    }
  } else if (request.kind === "verify-retained-pair" && receipt.kind === request.kind) {
    assertRetainedPair(receipt.retainedPair, request);
  } else if (request.kind === "observe-recovery" && receipt.kind === request.kind) {
    if (typeof receipt.selectorDurable !== "boolean") {
      throw new TypeError("Recovery selector durability must be boolean");
    }
    if (receipt.selector !== null) {
      assertSelection(receipt.selector);
    }
    const generationIds = new Set<string>();
    for (const generation of receipt.generations) {
      if (
        !GENERATION_ID.test(generation.generationId) ||
        !SHA256.test(generation.manifestSha256) ||
        typeof generation.parentDirectoryDurable !== "boolean"
      ) {
        throw new TypeError("Recovery observation contains an invalid generation");
      }
      if (generationIds.has(generation.generationId)) {
        throw new Error("Recovery observation contains duplicate generations");
      }
      generationIds.add(generation.generationId);
    }
    if (receipt.retainedPair !== null) {
      assertRetainedPair(receipt.retainedPair);
      if (
        !receipt.selectorDurable ||
        !selectionsEqual(receipt.selector, receipt.retainedPair.selected)
      ) {
        throw new Error("Recovery retained pair does not match the durable selector");
      }
      for (const selection of [receipt.retainedPair.selected, receipt.retainedPair.rollback]) {
        const observed = receipt.generations.find(
          (generation) => generation.generationId === selection.generationId,
        );
        if (
          !observed ||
          observed.manifestSha256 !== selection.manifestSha256 ||
          !observed.parentDirectoryDurable
        ) {
          throw new Error("Recovery retained pair is missing durable generation evidence");
        }
      }
    }
  }
}

/**
 * Nominal capability implemented only by a future authenticated broker.
 *
 * The protected constructor prevents structurally compatible objects from
 * being passed accidentally. This repository intentionally ships no concrete
 * production subclass.
 */
export abstract class UpdateGenerationConfinedFilesystem {
  readonly #opaqueConfinedFilesystemCapability = true;

  abstract readonly brokerId: string;
  abstract readonly namespaceKey: string;

  protected constructor() {}

  /**
   * Execute or durably replay an operation by operationId and exact request digest.
   *
   * A completed operation MUST return its original receipt before applying the
   * expectedRevision check to new work. Reusing an operationId with a different
   * request MUST fail. This is the recovery boundary for a crash after the
   * broker mutation commits but before its receipt reaches the update ledger.
   */
  protected abstract invokeBroker(
    request: UpdateGenerationBrokerRequest,
  ): Promise<UpdateGenerationBrokerReceipt>;

  protected abstract verifyBrokerSignature(
    receipt: UpdateGenerationBrokerReceipt,
  ): Promise<boolean>;

  async perform<Kind extends UpdateGenerationBrokerOperationKind>(
    request: Extract<UpdateGenerationBrokerRequest, { kind: Kind }>,
  ): Promise<UpdateGenerationAuthenticatedBrokerReceiptOf<Kind>> {
    void this.#opaqueConfinedFilesystemCapability;
    // SAFETY: Recursive decoding preserves the request's already-typed Kind discriminant.
    const decodedRequest = decodeUpdateGenerationBrokerRequest(request) as Extract<
      UpdateGenerationBrokerRequest,
      { kind: Kind }
    >;
    assertRequest(decodedRequest);
    if (
      decodedRequest.brokerId !== this.brokerId ||
      decodedRequest.namespaceKey !== this.namespaceKey
    ) {
      throw new Error("Broker operation is outside the confined provider scope");
    }
    const requestSha256 = digestDecodedRequest(decodedRequest);
    const receipt = decodeUpdateGenerationBrokerReceipt(
      await this.invokeBroker(decodedRequest),
    ) as UpdateGenerationBrokerReceiptOf<Kind>; // SAFETY: Matching below proves Kind equality.
    assertDecodedReceiptIsValid(receipt);
    assertReceiptMatchesRequest(decodedRequest, receipt, requestSha256);
    // SAFETY: Receipt matching proves the broker response has the request's Kind discriminant.
    return await this.authenticateDecoded(receipt);
  }

  async authenticate<Kind extends UpdateGenerationBrokerOperationKind>(
    receipt: UpdateGenerationBrokerReceiptOf<Kind>,
  ): Promise<UpdateGenerationAuthenticatedBrokerReceiptOf<Kind>> {
    const decoded = decodeUpdateGenerationBrokerReceipt(
      receipt,
    ) as UpdateGenerationBrokerReceiptOf<Kind>; // SAFETY: Decoding preserves the typed Kind.
    assertDecodedReceiptIsValid(decoded);
    return await this.authenticateDecoded(decoded);
  }

  private async authenticateDecoded<Kind extends UpdateGenerationBrokerOperationKind>(
    receipt: UpdateGenerationBrokerReceiptOf<Kind>,
  ): Promise<UpdateGenerationAuthenticatedBrokerReceiptOf<Kind>> {
    if (receipt.brokerId !== this.brokerId || receipt.namespaceKey !== this.namespaceKey) {
      throw new Error("Broker receipt is outside the confined provider scope");
    }
    if (!(await this.verifyBrokerSignature(receipt))) {
      throw new Error("Update broker receipt signature was not authenticated");
    }
    // SAFETY: The immutable envelope, provider scope, and signature are verified before branding.
    return receipt as UpdateGenerationAuthenticatedBrokerReceiptOf<Kind>;
  }
}

export async function performUpdateGenerationBrokerOperation<
  Kind extends UpdateGenerationBrokerOperationKind,
>(params: {
  filesystem: UpdateGenerationConfinedFilesystem | null;
  request: Extract<UpdateGenerationBrokerRequest, { kind: Kind }>;
}): Promise<UpdateGenerationAuthenticatedBrokerReceiptOf<Kind>> {
  if (!params.filesystem) {
    throw new Error("Generation transaction requires a confined filesystem provider");
  }
  return await params.filesystem.perform(params.request);
}
