import { describe, expect, it } from "vitest";
import {
  decodeUpdateGenerationBrokerReceipt,
  decodeUpdateGenerationBrokerRequest,
} from "./update-generation-broker-decoder.js";
import {
  assertUpdateGenerationBrokerReceiptIsValid,
  digestUpdateGenerationBrokerReceiptPayload,
  digestUpdateGenerationBrokerRequest,
  UpdateGenerationConfinedFilesystem,
  type UpdateGenerationBrokerReceipt,
  type UpdateGenerationBrokerRequest,
} from "./update-generation-confined-filesystem.js";

const SIGNATURE = Buffer.alloc(64, 5).toString("base64");
const WINDOWS_DEVICE_PATHS = [
  "CON",
  "con.txt",
  "NUL.mjs",
  "PrN.js",
  "AUX",
  "CONIN$",
  "conout$",
  "CoNiN$.js",
  "CONOUT$.txt",
  "dir/CONIN$/index.js",
  "dir\\conout$.mjs",
  "COM1.txt",
  "com9",
  "LPT1.js",
  "dir/lpt9/index.js",
];
const ORDINARY_DOLLAR_PATHS = [
  "CLOCK$",
  "clock$",
  "Clock$.js",
  "CLOCK$.txt",
  "dir/CLOCK$/index.js",
  "normal$.js",
  "dir/price$.mjs",
];
const NONCANONICAL_ENTRYPOINT_PATHS = ["dir\\entry.mjs", "dir\\clock$.mjs", "dir\\price$.mjs"];

function selection(character: string) {
  return {
    formatVersion: 1 as const,
    generationId: character.repeat(32),
    manifestSha256: character.repeat(64),
    entrypointRelativePath: "openclaw.mjs",
  };
}

function requestFixtures(): UpdateGenerationBrokerRequest[] {
  const base = {
    formatVersion: 1 as const,
    brokerId: "protected-update-broker",
    namespaceKey: "openclaw-global-owner",
    transactionId: "transaction-1",
    expectedRevision: "revision-1",
  };
  return [
    {
      ...base,
      kind: "materialize-generation",
      operationId: "materialize",
      role: "candidate",
      sourceArtifactId: "staging-artifact",
      manifest: {
        algorithm: "sha256",
        digest: "b".repeat(64),
        entryCount: 2,
        totalBytes: 100,
      },
      generation: { ...selection("b"), packageVersion: "2.0.0" },
    },
    {
      ...base,
      kind: "sync-parent-directory",
      operationId: "sync",
      parent: "generations",
      afterOperationId: "materialize",
    },
    {
      ...base,
      kind: "switch-selector",
      operationId: "switch",
      expected: selection("a"),
      next: selection("b"),
    },
    {
      ...base,
      kind: "cleanup-generations",
      operationId: "cleanup",
      generationIds: ["c".repeat(32)],
      protectedGenerationIds: ["a".repeat(32), "b".repeat(32)],
    },
    {
      ...base,
      kind: "verify-retained-pair",
      operationId: "verify",
      selected: selection("b"),
      rollback: selection("a"),
    },
    { ...base, kind: "observe-recovery", operationId: "observe" },
  ];
}

function materializationFixture(): Extract<
  UpdateGenerationBrokerRequest,
  { kind: "materialize-generation" }
> {
  const request = requestFixtures()[0];
  if (request?.kind !== "materialize-generation") {
    throw new Error("materialization fixture is missing");
  }
  return request;
}

function signature() {
  return {
    algorithm: "ed25519" as const,
    keyId: "broker-key",
    signedPayloadSha256: "0".repeat(64),
    valueBase64: SIGNATURE,
  };
}

function sign<Receipt extends UpdateGenerationBrokerReceipt>(receipt: Receipt): Receipt {
  receipt.signature.signedPayloadSha256 = digestUpdateGenerationBrokerReceiptPayload(receipt);
  return receipt;
}

function receiptFor(request: UpdateGenerationBrokerRequest): UpdateGenerationBrokerReceipt {
  const readonly = request.kind === "verify-retained-pair" || request.kind === "observe-recovery";
  const base = {
    formatVersion: 1 as const,
    kind: request.kind,
    brokerId: request.brokerId,
    namespaceKey: request.namespaceKey,
    transactionId: request.transactionId,
    operationId: request.operationId,
    requestSha256: digestUpdateGenerationBrokerRequest(request),
    previousRevision: request.expectedRevision,
    revision: readonly ? request.expectedRevision : "revision-2",
    recordedAtMs: 1_788_300_000_000,
    signature: signature(),
  };
  if (request.kind === "materialize-generation") {
    return sign({
      ...base,
      kind: request.kind,
      role: request.role,
      sourceArtifactId: request.sourceArtifactId,
      manifest: request.manifest,
      generation: request.generation,
    });
  }
  if (request.kind === "sync-parent-directory") {
    return sign({
      ...base,
      kind: request.kind,
      parent: request.parent,
      afterOperationId: request.afterOperationId,
      durable: true,
    });
  }
  if (request.kind === "switch-selector") {
    return sign({
      ...base,
      kind: request.kind,
      previous: request.expected,
      selected: request.next,
    });
  }
  if (request.kind === "cleanup-generations") {
    return sign({
      ...base,
      kind: request.kind,
      generationIds: request.generationIds,
      removedGenerationIds: [],
      deferred: request.generationIds.map((generationId) => ({
        generationId,
        reason: "still in use",
      })),
      protectedGenerationIds: request.protectedGenerationIds,
    });
  }
  const retainedPair = {
    selected: request.kind === "verify-retained-pair" ? request.selected : selection("b"),
    rollback: request.kind === "verify-retained-pair" ? request.rollback : selection("a"),
    selectedManifestVerified: true as const,
    rollbackManifestVerified: true as const,
  };
  if (request.kind === "verify-retained-pair") {
    return sign({ ...base, kind: request.kind, retainedPair });
  }
  return sign({
    ...base,
    kind: request.kind,
    selector: retainedPair.selected,
    selectorDurable: true,
    generations: [retainedPair.selected, retainedPair.rollback].map((entry) => ({
      generationId: entry.generationId,
      manifestSha256: entry.manifestSha256,
      parentDirectoryDurable: true,
    })),
    retainedPair,
  });
}

function receiptFixtures(): UpdateGenerationBrokerReceipt[] {
  return requestFixtures().map(receiptFor);
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function assertDeepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child);
  }
}

type ObjectMutation = { label: string; apply(value: Record<string, unknown>): void };

const objectMutations: ObjectMutation[] = [
  { label: "extraneous", apply: (value) => void Reflect.set(value, "extraneous", true) },
  {
    label: "missing",
    apply: (value) => void Reflect.deleteProperty(value, Object.keys(value)[0]!),
  },
  {
    label: "undefined",
    apply: (value) => void Reflect.set(value, Object.keys(value)[0]!, undefined),
  },
  {
    label: "accessor",
    apply: (value) => {
      const key = Object.hasOwn(value, "kind") ? "kind" : Object.keys(value)[0]!;
      Object.defineProperty(value, key, { enumerable: true, get: () => value });
    },
  },
  {
    label: "inherited",
    apply: (value) => {
      const key = Object.keys(value)[0]!;
      const inherited = { [key]: value[key] };
      Reflect.deleteProperty(value, key);
      Object.setPrototypeOf(value, inherited);
    },
  },
];

type NestedFixture = {
  label: string;
  make(): { root: UpdateGenerationBrokerRequest | UpdateGenerationBrokerReceipt; nested: object };
  decode(value: unknown): unknown;
};

function requestNested(
  label: string,
  kind: UpdateGenerationBrokerRequest["kind"],
  locate: (request: Record<string, unknown>) => object,
): NestedFixture {
  return {
    label,
    make: () => {
      const root = structuredClone(requestFixtures().find((entry) => entry.kind === kind)!);
      return { root, nested: locate(record(root)) };
    },
    decode: decodeUpdateGenerationBrokerRequest,
  };
}

function receiptNested(
  label: string,
  kind: UpdateGenerationBrokerReceipt["kind"],
  locate: (receipt: Record<string, unknown>) => object,
): NestedFixture {
  return {
    label,
    make: () => {
      const root = structuredClone(receiptFixtures().find((entry) => entry.kind === kind)!);
      return { root, nested: locate(record(root)) };
    },
    decode: decodeUpdateGenerationBrokerReceipt,
  };
}

const nestedFixtures: NestedFixture[] = [
  requestNested("request manifest", "materialize-generation", (root) => record(root.manifest)),
  requestNested("request descriptor", "materialize-generation", (root) => record(root.generation)),
  requestNested("request selection", "switch-selector", (root) => record(root.next)),
  receiptNested("receipt manifest", "materialize-generation", (root) => record(root.manifest)),
  receiptNested("receipt descriptor", "materialize-generation", (root) => record(root.generation)),
  receiptNested("receipt selection", "switch-selector", (root) => record(root.selected)),
  receiptNested("signature", "observe-recovery", (root) => record(root.signature)),
  receiptNested("retained pair", "verify-retained-pair", (root) => record(root.retainedPair)),
  receiptNested("retained selection", "verify-retained-pair", (root) =>
    record(record(root.retainedPair).selected),
  ),
  receiptNested("observed generation", "observe-recovery", (root) =>
    record((root.generations as object[])[0]),
  ),
  receiptNested("deferred cleanup", "cleanup-generations", (root) =>
    record((root.deferred as object[])[0]),
  ),
];

type ArrayMutation = { label: string; apply(value: unknown[]): void };
const arrayMutations: ArrayMutation[] = [
  { label: "extraneous", apply: (value) => void Reflect.set(value, "extra", true) },
  { label: "hole", apply: (value) => void Reflect.deleteProperty(value, "0") },
  { label: "undefined", apply: (value) => void Reflect.set(value, "0", undefined) },
  {
    label: "accessor",
    apply: (value) => Object.defineProperty(value, "0", { get: () => "c".repeat(32) }),
  },
  { label: "prototype", apply: (value) => void Object.setPrototypeOf(value, {}) },
];

class CapturingFilesystem extends UpdateGenerationConfinedFilesystem {
  readonly brokerId = "protected-update-broker";
  readonly namespaceKey = "openclaw-global-owner";
  invoked: UpdateGenerationBrokerRequest | null = null;
  verified: UpdateGenerationBrokerReceipt | null = null;

  static create(): CapturingFilesystem {
    return new CapturingFilesystem();
  }

  protected async invokeBroker(
    request: UpdateGenerationBrokerRequest,
  ): Promise<UpdateGenerationBrokerReceipt> {
    this.invoked = request;
    return receiptFor(request);
  }

  protected async verifyBrokerSignature(receipt: UpdateGenerationBrokerReceipt): Promise<boolean> {
    this.verified = receipt;
    return true;
  }
}

describe("update-generation broker trust-boundary decoder", () => {
  it("decodes every request and signed receipt into an immutable exact graph", () => {
    for (const request of requestFixtures()) {
      const decoded = decodeUpdateGenerationBrokerRequest(request);
      expect(decoded).toEqual(request);
      expect(decoded).not.toBe(request);
      assertDeepFrozen(decoded);
    }
    for (const receipt of receiptFixtures()) {
      const decoded = decodeUpdateGenerationBrokerReceipt(receipt);
      expect(decoded).toEqual(receipt);
      expect(decoded).not.toBe(receipt);
      assertDeepFrozen(decoded);
      expect(() => assertUpdateGenerationBrokerReceiptIsValid(receipt)).not.toThrow();
    }
  });

  it("accepts null-prototype records and rebuilds them as immutable ordinary records", () => {
    const request = structuredClone(materializationFixture());
    Object.setPrototypeOf(request, null);
    Object.setPrototypeOf(request.manifest, null);
    const decoded = decodeUpdateGenerationBrokerRequest(request);
    if (decoded.kind !== "materialize-generation") {
      throw new Error("decoded the wrong request kind");
    }
    expect(decoded).toEqual(materializationFixture());
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(decoded.manifest)).toBe(Object.prototype);
    assertDeepFrozen(decoded);
  });

  it("invokes and verifies with the immutable decoded objects, not caller-owned graphs", async () => {
    const request = materializationFixture();
    const filesystem = CapturingFilesystem.create();
    const receipt = await filesystem.perform(request);
    expect(filesystem.invoked).not.toBe(request);
    expect(filesystem.invoked).toEqual(request);
    assertDeepFrozen(filesystem.invoked);
    expect(filesystem.verified).toBe(receipt);
    assertDeepFrozen(receipt);
  });

  it("rejects every malformed request before broker invocation", async () => {
    for (const request of requestFixtures()) {
      const forged = structuredClone(request);
      Reflect.set(forged, "extraneous", true);
      const filesystem = CapturingFilesystem.create();
      await expect(filesystem.perform(forged)).rejects.toThrow("exactly its declared own keys");
      expect(filesystem.invoked, request.kind).toBeNull();
    }
  });

  it("rejects every malformed receipt before signature verification", async () => {
    for (const receipt of receiptFixtures()) {
      const forged = structuredClone(receipt);
      Reflect.set(forged, "extraneous", true);
      const filesystem = CapturingFilesystem.create();
      await expect(filesystem.authenticate(forged)).rejects.toThrow(
        "exactly its declared own keys",
      );
      expect(filesystem.verified, receipt.kind).toBeNull();
    }
  });

  it.each([
    ["requests", requestFixtures, decodeUpdateGenerationBrokerRequest],
    ["receipts", receiptFixtures, decodeUpdateGenerationBrokerReceipt],
  ] as const)("rejects every root-level structural forgery in all %s", (_label, make, decode) => {
    for (const value of make()) {
      for (const mutation of objectMutations) {
        const forged = structuredClone(value);
        mutation.apply(record(forged));
        expect(() => decode(forged), `${value.kind}: ${mutation.label}`).toThrow();
      }
    }
  });

  it("rejects every nested object shape when its ownership or descriptor contract changes", () => {
    for (const fixture of nestedFixtures) {
      for (const mutation of objectMutations) {
        const { root, nested } = fixture.make();
        mutation.apply(record(nested));
        expect(() => fixture.decode(root), `${fixture.label}: ${mutation.label}`).toThrow();
      }
    }
  });

  it("rejects malformed string and object arrays recursively", () => {
    const arrays = [
      requestNested(
        "generation ids",
        "cleanup-generations",
        (root) => root.generationIds as object,
      ),
      receiptNested(
        "observed generations",
        "observe-recovery",
        (root) => root.generations as object,
      ),
    ];
    for (const fixture of arrays) {
      for (const mutation of arrayMutations) {
        const { root, nested } = fixture.make();
        mutation.apply(nested as unknown[]);
        expect(() => fixture.decode(root), `${fixture.label}: ${mutation.label}`).toThrow();
      }
    }
  });

  it("rejects huge and bounded sparse arrays before expanding their declared length", () => {
    for (const length of [2, 100_000_000]) {
      const request = requestFixtures().find((entry) => entry.kind === "cleanup-generations");
      if (request?.kind !== "cleanup-generations") {
        throw new Error("cleanup fixture is missing");
      }
      const sparse: string[] = [];
      sparse.length = length;
      request.generationIds = sparse;
      if (length === 2) {
        request.generationIds[1] = "c".repeat(32);
      }
      expect(() => decodeUpdateGenerationBrokerRequest(request), `length ${length}`).toThrow();
    }
  });

  it("never evaluates an accessor while rejecting it", () => {
    const request = materializationFixture();
    let reads = 0;
    Object.defineProperty(request.manifest, "entryCount", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 2;
      },
    });
    expect(() => decodeUpdateGenerationBrokerRequest(request)).toThrow("data property");
    expect(reads).toBe(0);
  });

  it("rejects every official Windows device form in request and receipt selections", () => {
    for (const entrypointRelativePath of WINDOWS_DEVICE_PATHS) {
      const request = structuredClone(
        requestFixtures().find((entry) => entry.kind === "switch-selector")!,
      );
      if (request.kind !== "switch-selector") {
        throw new Error("switch-selector fixture is missing");
      }
      request.next.entrypointRelativePath = entrypointRelativePath;
      expect(
        () => decodeUpdateGenerationBrokerRequest(request),
        `request: ${entrypointRelativePath}`,
      ).toThrow("safe cross-platform entrypoint path");

      const receipt = structuredClone(
        receiptFixtures().find((entry) => entry.kind === "switch-selector")!,
      );
      if (receipt.kind !== "switch-selector") {
        throw new Error("switch-selector receipt fixture is missing");
      }
      receipt.selected.entrypointRelativePath = entrypointRelativePath;
      expect(
        () => decodeUpdateGenerationBrokerReceipt(receipt),
        `receipt: ${entrypointRelativePath}`,
      ).toThrow("safe cross-platform entrypoint path");
    }
  });

  it("accepts ordinary dollar-sign paths in request and receipt selections", () => {
    for (const entrypointRelativePath of ORDINARY_DOLLAR_PATHS) {
      const request = structuredClone(
        requestFixtures().find((entry) => entry.kind === "switch-selector")!,
      );
      if (request.kind !== "switch-selector") {
        throw new Error("switch-selector fixture is missing");
      }
      request.next.entrypointRelativePath = entrypointRelativePath;
      expect(decodeUpdateGenerationBrokerRequest(request)).toEqual(request);

      const receipt = receiptFor(request);
      expect(decodeUpdateGenerationBrokerReceipt(receipt)).toEqual(receipt);
    }
  });

  it("rejects backslash paths before request or receipt admission", () => {
    for (const entrypointRelativePath of NONCANONICAL_ENTRYPOINT_PATHS) {
      const request = structuredClone(
        requestFixtures().find((entry) => entry.kind === "switch-selector")!,
      );
      if (request.kind !== "switch-selector") {
        throw new Error("switch-selector fixture is missing");
      }
      request.next.entrypointRelativePath = entrypointRelativePath;
      expect(() => decodeUpdateGenerationBrokerRequest(request)).toThrow(
        "safe cross-platform entrypoint path",
      );

      const receipt = receiptFor({ ...request, next: selection("b") });
      if (receipt.kind !== "switch-selector") {
        throw new Error("switch-selector receipt fixture is missing");
      }
      receipt.selected.entrypointRelativePath = entrypointRelativePath;
      expect(() => decodeUpdateGenerationBrokerReceipt(receipt)).toThrow(
        "safe cross-platform entrypoint path",
      );
    }
  });
});
