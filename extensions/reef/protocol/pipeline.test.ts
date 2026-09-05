import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { MemoryAuditStore, type AuditEntry, type AuditStore } from "./audit.js";
import { canonicalBytes } from "./canonical.js";
import { base64, fromBase64url, utf8 } from "./encoding.js";
import { seal, type Envelope } from "./envelope.js";
import type { GuardAdapter, Verdict } from "./guard.js";
import { generateIdentity } from "./identity.js";
import {
  composeInbound,
  composeOutbound,
  PipelineError,
  type ReviewApproval,
  type ReviewDecisionState,
  type ReviewGate,
  type ReviewRequest,
} from "./pipeline.js";
import { MemoryReplayStore } from "./replay.js";

const now = 1_752_300_000;
const auditKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const allow: Verdict = {
  decision: "allow",
  category: "safe",
  reason: "Safe.",
  model: "mock-2026-07-12",
  policyVersion: "v1",
};

function audit(): MemoryAuditStore {
  return new MemoryAuditStore(auditKey);
}

function mockGuard(...verdicts: Verdict[]): GuardAdapter & { calls: number } {
  return {
    providerId: "mock",
    pinnedModel: "mock-2026-07-12",
    calls: 0,
    async classify() {
      return verdicts[this.calls++] ?? verdicts.at(-1)!;
    },
  };
}

function structuralGuard(
  pinnedModel: string,
  ...results: unknown[]
): GuardAdapter & { calls: number } {
  return {
    providerId: "structural",
    pinnedModel,
    calls: 0,
    async classify() {
      return (results[this.calls++] ?? results.at(-1)) as Verdict;
    },
  };
}

function identities() {
  return { alice: generateIdentity(), bob: generateIdentity() };
}

type Identity = ReturnType<typeof generateIdentity>;
type OutboundOptions = Parameters<typeof composeOutbound>[0];
type InboundOptions = Parameters<typeof composeInbound>[0];

function outboundOptions(
  alice: Identity,
  bob: Identity,
  overrides: Partial<OutboundOptions> = {},
): OutboundOptions {
  return {
    id: "01JZ0000000000000000000000",
    from: "alice#1",
    to: "bob#1",
    body: { text: "ordinary text" },
    senderSigningSecretKey: alice.signing.secretKey,
    recipientEncryptionPublicKey: bob.encryption.publicKey,
    guard: mockGuard(allow),
    audit: audit(),
    policyVersion: "v1",
    ...overrides,
  };
}

function sealedEnvelope(
  alice: Identity,
  bob: Identity,
  id: string,
  body: Parameters<typeof seal>[0]["body"],
): Envelope {
  return seal({
    id,
    from: "alice#1",
    to: "bob#1",
    body,
    senderSigningSecretKey: alice.signing.secretKey,
    recipientEncryptionPublicKey: bob.encryption.publicKey,
    ts: now,
  });
}

function inboundOptions(
  envelope: Envelope,
  alice: Identity,
  bob: Identity,
  overrides: Partial<InboundOptions> = {},
): InboundOptions {
  return {
    envelope,
    self: "bob#1",
    recipientEncryptionSecretKey: bob.encryption.secretKey,
    recipientSigningSecretKey: bob.signing.secretKey,
    senderSigningPublicKey: alice.signing.publicKey,
    replayStore: new MemoryReplayStore(),
    now,
    guard: mockGuard(allow),
    audit: audit(),
    policyVersion: "v1",
    ...overrides,
  };
}

function reviewVerdict(): Verdict {
  return {
    ...allow,
    decision: "review",
    category: "ambiguous",
    reason: "Review.",
  };
}

function gateOf(
  request: (review: ReviewRequest) => Promise<ReviewApproval | undefined>,
  lookup: (approvalDigest: string) => Promise<ReviewDecisionState> = async () => "none",
): ReviewGate {
  return { lookup, request };
}

async function capturePipelineError(promise: Promise<unknown>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PipelineError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected pipeline error");
}

class FailOnceAuditStore implements AuditStore {
  readonly inner = audit();
  #fail = true;

  async appendEvent(type: string, payload: unknown, ts?: number): Promise<AuditEntry> {
    if (this.#fail) {
      this.#fail = false;
      throw new Error("transient audit failure");
    }
    return this.inner.appendEvent(type, payload, ts);
  }

  entries(): Promise<AuditEntry[]> {
    return this.inner.entries();
  }
}

describe("pipeline", () => {
  it("runs an allowed outbound and inbound exchange end to end", async () => {
    const { alice, bob } = identities();
    const outboundAudit = audit();
    const outbound = await composeOutbound(
      outboundOptions(alice, bob, { body: { text: "hello" }, ts: now, audit: outboundAudit }),
    );
    const inboundAudit = audit();
    const inboundGuard = mockGuard(allow);
    const replayStore = new MemoryReplayStore();
    const options = inboundOptions(outbound.envelope, alice, bob, {
      replayStore,
      guard: inboundGuard,
      audit: inboundAudit,
    });
    const inbound = await composeInbound(options);
    expect(inbound.disposition).toBe("accepted");
    if (inbound.disposition !== "accepted" || "federation" in inbound) {
      throw new Error("expected accepted chat result");
    }
    expect(inbound.body.text).toBe("hello");
    expect(inbound.receipt).toMatchObject({ id: outbound.envelope.id, status: "accepted" });
    const outboundEntries = await outboundAudit.entries();
    const inboundEntries = await inboundAudit.entries();
    expect(outboundEntries.map((entry) => entry.event.type)).toEqual([
      "proposal",
      "guard_verdict",
      "envelope",
    ]);
    expect(inboundEntries.map((entry) => entry.event.type)).toEqual([
      "guard_verdict",
      "inbox",
      "receipt",
    ]);
    expect(
      new Set(
        outboundEntries.map(
          (entry) => (entry.event.payload as { approvalDigest: string }).approvalDigest,
        ),
      ).size,
    ).toBe(1);
    expect(
      new Set(
        inboundEntries.map(
          (entry) => (entry.event.payload as { approvalDigest: string }).approvalDigest,
        ),
      ).size,
    ).toBe(1);
    const duplicate = await composeInbound({ ...options, now: now + 10 * 60 });
    expect(duplicate).toEqual({
      disposition: "duplicate",
      body: inbound.body,
      receipt: inbound.receipt,
    });
    expect(inboundGuard.calls).toBe(1);
    expect(await inboundAudit.entries()).toHaveLength(inboundEntries.length);
  });

  it("rejects a decrypted free-form thread before guard admission", async () => {
    const { alice, bob } = identities();
    const guard = mockGuard(allow);
    const envelope = craftEnvelope({ text: "hello", thread: "free-form thread" }, alice, bob);
    await expect(
      composeInbound(inboundOptions(envelope, alice, bob, { guard })),
    ).rejects.toMatchObject({ code: "malformed" });
    expect(guard.calls).toBe(0);
  });

  it("stops a deterministic outbound denial before guard and sealing", async () => {
    const { alice, bob } = identities();
    const guard = mockGuard(allow);
    let rngCalls = 0;
    await expect(
      composeOutbound(
        outboundOptions(alice, bob, {
          body: { text: ["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("") },
          guard,
          rng(length) {
            rngCalls++;
            return new Uint8Array(length);
          },
        }),
      ),
    ).rejects.toMatchObject({ stage: "deterministic" });
    expect(guard.calls).toBe(0);
    expect(rngCalls).toBe(0);
  });

  it("stops an outbound guard denial before sealing", async () => {
    const { alice, bob } = identities();
    const deny: Verdict = {
      ...allow,
      decision: "deny",
      category: "confidential",
      reason: "Denied.",
    };
    let rngCalls = 0;
    await expect(
      composeOutbound(
        outboundOptions(alice, bob, {
          guard: mockGuard(deny),
          rng(length) {
            rngCalls++;
            return new Uint8Array(length);
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PipelineError);
    expect(rngCalls).toBe(0);
  });

  it("centrally rejects invalid verdicts from structural guard adapters", async () => {
    const { alice, bob } = identities();
    const cases: Array<[string, string, unknown]> = [
      ["wrong model", "mock-2026-07-12", { ...allow, model: "other-2026-07-12" }],
      ["floating model", "mock-latest", { ...allow, model: "mock-latest" }],
      ["wrong policy", "mock-2026-07-12", { ...allow, policyVersion: "v2" }],
      ["unknown decision", "mock-2026-07-12", { ...allow, decision: "maybe" }],
    ];
    for (const [name, pinnedModel, rawVerdict] of cases) {
      let rngCalls = 0;
      await expect(
        composeOutbound(
          outboundOptions(alice, bob, {
            id: "01JZ0000000000000000000008",
            body: { text: `case ${name}` },
            guard: structuralGuard(pinnedModel, rawVerdict),
            rng(length) {
              rngCalls++;
              return new Uint8Array(length);
            },
          }),
        ),
      ).rejects.toMatchObject({
        stage: "guard",
        verdict: { decision: "deny", category: "guard_failure" },
      });
      expect(rngCalls).toBe(0);
    }
  });

  it("accepts a valid structural adapter and admits the post-review verdict again", async () => {
    const { alice, bob } = identities();
    const common = outboundOptions(alice, bob, {
      id: "01JZ0000000000000000000009",
      body: { text: "structural adapter" },
    });
    await expect(
      composeOutbound({ ...common, guard: structuralGuard(allow.model, allow) }),
    ).resolves.toMatchObject({ verdict: allow });
    const review = reviewVerdict();
    const invalidAfterApproval = { ...allow, model: "wrong-2026-07-12" };
    await expect(
      composeOutbound({
        ...common,
        audit: audit(),
        guard: structuralGuard(allow.model, review, invalidAfterApproval),
        reviewGate: gateOf(async ({ approvalDigest }) => ({ approved: true, approvalDigest })),
      }),
    ).rejects.toMatchObject({
      stage: "guard",
      verdict: { decision: "deny", category: "guard_failure" },
    });
  });

  it("parks an invalid structural inbound verdict instead of accepting or rejecting it", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000010", {
      text: "inbound structural adapter",
    });
    // guard_failure records classifier unavailability, not a content decision:
    // the message stays un-acked for retry instead of rejecting the peer.
    await expect(
      composeInbound(
        inboundOptions(envelope, alice, bob, {
          guard: structuralGuard(allow.model, { ...allow, policyVersion: "wrong" }),
        }),
      ),
    ).rejects.toMatchObject({
      stage: "guard",
      verdict: { decision: "deny", category: "guard_failure" },
      receipt: undefined,
    });
  });

  it("requires exact full-proposal approval and fresh classification for review", async () => {
    const { alice, bob } = identities();
    const review = reviewVerdict();
    const common = outboundOptions(alice, bob);
    await expect(
      composeOutbound({ ...common, audit: audit(), guard: mockGuard(review) }),
    ).rejects.toMatchObject({ stage: "review" });
    await expect(
      composeOutbound({
        ...common,
        audit: audit(),
        guard: mockGuard(review),
        reviewGate: gateOf(async ({ approvalDigest }) => ({ approved: false, approvalDigest })),
      }),
    ).rejects.toMatchObject({ stage: "review", reviewOutcome: "denied", receipt: undefined });
    await expect(
      composeOutbound({
        ...common,
        audit: audit(),
        guard: mockGuard(review),
        reviewGate: gateOf(async () => ({ approved: true, approvalDigest: "wrong" })),
      }),
    ).rejects.toMatchObject({ stage: "review" });
    const guard = mockGuard(review, allow);
    const result = await composeOutbound({
      ...common,
      audit: audit(),
      guard,
      reviewGate: gateOf(async ({ approvalDigest }) => ({ approved: true, approvalDigest })),
    });
    expect(result.verdict.decision).toBe("allow");
    expect(guard.calls).toBe(2);
  });

  it("does not reuse an approval across recipients", async () => {
    const { alice, bob } = identities();
    const review = reviewVerdict();
    const common = outboundOptions(alice, bob, {
      id: "01JZ0000000000000000000007",
      from: "sender#1",
      body: { text: "identical body" },
    });
    let vincentDigest = "";
    await expect(
      composeOutbound({
        ...common,
        to: "vincent#1",
        audit: audit(),
        guard: mockGuard(review),
        reviewGate: gateOf(async (request) => {
          vincentDigest = request.approvalDigest;
          expect(request).toMatchObject({
            id: common.id,
            from: common.from,
            to: "vincent#1",
            direction: "outbound",
          });
          expect(request.bodyHash).toMatch(/^[0-9a-f]{64}$/);
          return undefined;
        }),
      }),
    ).rejects.toMatchObject({ stage: "review", reviewOutcome: "pending" });
    await expect(
      composeOutbound({
        ...common,
        to: "alice#1",
        audit: audit(),
        guard: mockGuard(review),
        reviewGate: gateOf(async () => ({ approved: true, approvalDigest: vincentDigest })),
      }),
    ).rejects.toMatchObject({ stage: "review", message: "approval digest mismatch" });
  });

  it("releases a replay claim after transient audit failure and retries successfully", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000001", {
      text: "retry me",
    });
    const replayStore = new MemoryReplayStore();
    const inboundAudit = new FailOnceAuditStore();
    const options = inboundOptions(envelope, alice, bob, {
      replayStore,
      audit: inboundAudit,
    });
    await expect(composeInbound(options)).rejects.toThrow("transient audit failure");
    const retried = await composeInbound(options);
    expect(retried.disposition).toBe("accepted");
    expect(retried.receipt.status).toBe("accepted");
  });

  it("returns an identical cached rejection receipt on guard-deny redelivery", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000002", {
      text: "classify me",
    });
    const replayStore = new MemoryReplayStore();
    const inboundAudit = audit();
    const deny: Verdict = { ...allow, decision: "deny", category: "injection", reason: "Denied." };
    const guard = mockGuard(deny);
    const options = inboundOptions(envelope, alice, bob, {
      replayStore,
      guard,
      audit: inboundAudit,
    });
    const rejection = await capturePipelineError(composeInbound(options));
    expect(rejection.receipt).toMatchObject({ status: "rejected", category: "guard_deny" });
    const entryCount = (await inboundAudit.entries()).length;
    const duplicate = await composeInbound({ ...options, now: now + 1_000 });
    expect(duplicate).toEqual({ disposition: "duplicate", receipt: rejection.receipt });
    expect(duplicate).not.toHaveProperty("body");
    expect((await inboundAudit.entries()).length).toBe(entryCount);
    expect(guard.calls).toBe(1);
  });

  it("completes explicit inbound review denial and caches its receipt", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000005", {
      text: "review me",
    });
    const review = reviewVerdict();
    const guard = mockGuard(review);
    const replayStore = new MemoryReplayStore();
    const inboundAudit = audit();
    const options = inboundOptions(envelope, alice, bob, {
      replayStore,
      guard,
      audit: inboundAudit,
      reviewGate: gateOf(async ({ approvalDigest }) => ({
        approved: false,
        approvalDigest,
      })),
    });
    const rejection = await capturePipelineError(composeInbound(options));
    expect(rejection).toMatchObject({
      stage: "review",
      reviewOutcome: "denied",
      receipt: { status: "rejected", category: "review_denied" },
    });
    const entryCount = (await inboundAudit.entries()).length;
    await expect(composeInbound(options)).resolves.toEqual({
      disposition: "duplicate",
      receipt: rejection.receipt,
    });
    expect((await inboundAudit.entries()).length).toBe(entryCount);
    expect(guard.calls).toBe(1);
  });

  it("releases pending inbound review and accepts a later approved retry", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000006", {
      text: "decide later",
    });
    const review = reviewVerdict();
    const guard = mockGuard(review, review, allow);
    let decided = false;
    const options = inboundOptions(envelope, alice, bob, {
      guard,
      reviewGate: gateOf(async ({ approvalDigest }) =>
        decided ? { approved: true, approvalDigest } : undefined,
      ),
    });
    await expect(composeInbound(options)).rejects.toMatchObject({
      stage: "review",
      reviewOutcome: "pending",
      receipt: undefined,
    });
    decided = true;
    await expect(composeInbound({ ...options, now: now + 10 * 60 })).resolves.toMatchObject({
      disposition: "accepted",
      body: { text: "decide later" },
    });
    expect(guard.calls).toBe(3);
  });

  it("holds a pending review on redelivery without re-classifying", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000011", {
      text: "parked while pending",
    });
    const guard = mockGuard(allow);
    const inboundAudit = audit();
    const options = inboundOptions(envelope, alice, bob, {
      guard,
      audit: inboundAudit,
      reviewGate: gateOf(
        async () => undefined,
        async () => "pending",
      ),
    });
    await expect(composeInbound(options)).rejects.toMatchObject({
      stage: "review",
      reviewOutcome: "pending",
      receipt: undefined,
    });
    // The recorded review owns redelivery: no fresh guard roll may resolve it,
    // and re-attempts must not grow the audit chain.
    expect(guard.calls).toBe(0);
    expect((await inboundAudit.entries()).length).toBe(0);
    await expect(
      composeOutbound(
        outboundOptions(alice, bob, {
          guard,
          reviewGate: gateOf(
            async () => undefined,
            async () => "pending",
          ),
        }),
      ),
    ).rejects.toMatchObject({ stage: "review", reviewOutcome: "pending" });
    expect(guard.calls).toBe(0);
  });

  it("completes a decided-approved review on redelivery with one classification", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000012", {
      text: "approved while parked",
    });
    const guard = mockGuard(allow);
    const inboundAudit = audit();
    const result = await composeInbound(
      inboundOptions(envelope, alice, bob, {
        guard,
        audit: inboundAudit,
        reviewGate: gateOf(
          async () => undefined,
          async () => ({ approved: true }),
        ),
      }),
    );
    expect(result.disposition).toBe("accepted");
    expect(guard.calls).toBe(1);
    const entries = await inboundAudit.entries();
    expect(entries.some((entry) => entry.event.type === "review_approval")).toBe(true);
  });

  it("completes a decided-denied review on redelivery without classifying", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000013", {
      text: "denied while parked",
    });
    const guard = mockGuard(allow);
    const rejection = await capturePipelineError(
      composeInbound(
        inboundOptions(envelope, alice, bob, {
          guard,
          reviewGate: gateOf(
            async () => undefined,
            async () => ({ approved: false }),
          ),
        }),
      ),
    );
    expect(rejection).toMatchObject({
      stage: "review",
      reviewOutcome: "denied",
      receipt: { status: "rejected", category: "review_denied" },
    });
    expect(guard.calls).toBe(0);
  });

  it("parks an inbound guard failure instead of rejecting the peer", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000014", {
      text: "guard outage",
    });
    const failure: Verdict = {
      ...allow,
      decision: "deny",
      category: "guard_failure",
      reason: "Guard unavailable or invalid.",
    };
    const replayStore = new MemoryReplayStore();
    const inboundAudit = audit();
    const failing = inboundOptions(envelope, alice, bob, {
      replayStore,
      guard: mockGuard(failure),
      audit: inboundAudit,
    });
    const parked = await capturePipelineError(composeInbound(failing));
    expect(parked).toMatchObject({
      stage: "guard",
      verdict: { category: "guard_failure" },
      receipt: undefined,
    });
    expect(
      (await inboundAudit.entries()).some((entry) => entry.event.type === "inbox_rejected"),
    ).toBe(false);
    // The replay claim released, so recovery retries once the guard is back.
    const retried = await composeInbound({
      ...failing,
      guard: mockGuard(allow),
      now: now + 60,
    });
    expect(retried.disposition).toBe("accepted");
  });

  it("completes deterministic inbound denial with a signed rejection", async () => {
    const { alice, bob } = identities();
    const envelope = sealedEnvelope(alice, bob, "01JZ0000000000000000000003", {
      text: ["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join(""),
    });
    const guard = mockGuard(allow);
    await expect(
      composeInbound(inboundOptions(envelope, alice, bob, { guard })),
    ).rejects.toMatchObject({
      stage: "deterministic",
      receipt: { status: "rejected", category: "deterministic_deny" },
    });
    expect(guard.calls).toBe(0);
  });
});

function craftEnvelope(
  body: unknown,
  alice: ReturnType<typeof generateIdentity>,
  bob: ReturnType<typeof generateIdentity>,
): Envelope {
  const ephemeral = x25519.keygen(new Uint8Array(32).fill(7));
  const shared = x25519.getSharedSecret(
    ephemeral.secretKey,
    fromBase64url(bob.encryption.publicKey),
  );
  const key = hkdf(sha256, shared, undefined, utf8("reef-v1"), 32);
  const nonce = new Uint8Array(12).fill(9);
  const unsigned = {
    v: 1 as const,
    id: "01JZ0000000000000000000004",
    from: "alice#1",
    to: "bob#1",
    ts: now,
    epk: base64(ephemeral.publicKey),
    n: base64(nonce),
    ct: base64(gcm(key, nonce).encrypt(canonicalBytes(body))),
  };
  return {
    ...unsigned,
    sig: base64(ed25519.sign(canonicalBytes(unsigned), fromBase64url(alice.signing.secretKey))),
  };
}
