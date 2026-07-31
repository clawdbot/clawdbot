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
import { composeInbound, composeOutbound, PipelineError } from "./pipeline.js";
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
    const outbound = await composeOutbound({
      id: "01JZ0000000000000000000000",
      from: "alice#1",
      to: "bob#1",
      body: { text: "hello" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
      guard: mockGuard(allow),
      audit: outboundAudit,
      policyVersion: "v1",
    });
    const inboundAudit = audit();
    const inboundGuard = mockGuard(allow);
    const replayStore = new MemoryReplayStore();
    const inboundOptions = {
      envelope: outbound.envelope,
      self: "bob#1",
      recipientEncryptionSecretKey: bob.encryption.secretKey,
      recipientSigningSecretKey: bob.signing.secretKey,
      senderSigningPublicKey: alice.signing.publicKey,
      replayStore,
      now,
      guard: inboundGuard,
      audit: inboundAudit,
      policyVersion: "v1",
    };
    const inbound = await composeInbound(inboundOptions);
    expect(inbound.disposition).toBe("accepted");
    if (inbound.disposition !== "accepted") {
      throw new Error("expected accepted result");
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
    const duplicate = await composeInbound({ ...inboundOptions, now: now + 10 * 60 });
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
      composeInbound({
        envelope,
        self: "bob#1",
        recipientEncryptionSecretKey: bob.encryption.secretKey,
        recipientSigningSecretKey: bob.signing.secretKey,
        senderSigningPublicKey: alice.signing.publicKey,
        replayStore: new MemoryReplayStore(),
        now,
        guard,
        audit: audit(),
        policyVersion: "v1",
      }),
    ).rejects.toMatchObject({ code: "malformed" });
    expect(guard.calls).toBe(0);
  });

  it("stops a deterministic outbound denial before guard and sealing", async () => {
    const { alice, bob } = identities();
    const guard = mockGuard(allow);
    let rngCalls = 0;
    await expect(
      composeOutbound({
        id: "01JZ0000000000000000000000",
        from: "alice#1",
        to: "bob#1",
        body: { text: ["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("") },
        senderSigningSecretKey: alice.signing.secretKey,
        recipientEncryptionPublicKey: bob.encryption.publicKey,
        guard,
        audit: audit(),
        policyVersion: "v1",
        rng(length) {
          rngCalls++;
          return new Uint8Array(length);
        },
      }),
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
      composeOutbound({
        id: "01JZ0000000000000000000000",
        from: "alice#1",
        to: "bob#1",
        body: { text: "ordinary text" },
        senderSigningSecretKey: alice.signing.secretKey,
        recipientEncryptionPublicKey: bob.encryption.publicKey,
        guard: mockGuard(deny),
        audit: audit(),
        policyVersion: "v1",
        rng(length) {
          rngCalls++;
          return new Uint8Array(length);
        },
      }),
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
        composeOutbound({
          id: "01JZ0000000000000000000008",
          from: "alice#1",
          to: "bob#1",
          body: { text: `case ${name}` },
          senderSigningSecretKey: alice.signing.secretKey,
          recipientEncryptionPublicKey: bob.encryption.publicKey,
          guard: structuralGuard(pinnedModel, rawVerdict),
          audit: audit(),
          policyVersion: "v1",
          rng(length) {
            rngCalls++;
            return new Uint8Array(length);
          },
        }),
      ).rejects.toMatchObject({
        stage: "guard",
        verdict: { decision: "deny", category: "guard_failure" },
      });
      expect(rngCalls).toBe(0);
    }
  });

  it("accepts a valid structural adapter and admits the post-review verdict again", async () => {
    const { alice, bob } = identities();
    const common = {
      id: "01JZ0000000000000000000009",
      from: "alice#1",
      to: "bob#1",
      body: { text: "structural adapter" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      audit: audit(),
      policyVersion: "v1",
    };
    await expect(
      composeOutbound({ ...common, guard: structuralGuard(allow.model, allow) }),
    ).resolves.toMatchObject({ verdict: allow });
    const review: Verdict = {
      ...allow,
      decision: "review",
      category: "ambiguous",
      reason: "Review.",
    };
    const invalidAfterApproval = { ...allow, model: "wrong-2026-07-12" };
    await expect(
      composeOutbound({
        ...common,
        audit: audit(),
        guard: structuralGuard(allow.model, review, invalidAfterApproval),
        reviewGate: async ({ approvalDigest }) => ({ approved: true, approvalDigest }),
      }),
    ).rejects.toMatchObject({
      stage: "guard",
      verdict: { decision: "deny", category: "guard_failure" },
    });
  });

  it("rejects an invalid structural inbound verdict instead of accepting it", async () => {
    const { alice, bob } = identities();
    const envelope = seal({
      id: "01JZ0000000000000000000010",
      from: "alice#1",
      to: "bob#1",
      body: { text: "inbound structural adapter" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
    });
    await expect(
      composeInbound({
        envelope,
        self: "bob#1",
        recipientEncryptionSecretKey: bob.encryption.secretKey,
        recipientSigningSecretKey: bob.signing.secretKey,
        senderSigningPublicKey: alice.signing.publicKey,
        replayStore: new MemoryReplayStore(),
        now,
        guard: structuralGuard(allow.model, { ...allow, policyVersion: "wrong" }),
        audit: audit(),
        policyVersion: "v1",
      }),
    ).rejects.toMatchObject({
      stage: "guard",
      verdict: { decision: "deny", category: "guard_failure" },
      receipt: { status: "rejected", category: "guard_deny" },
    });
  });

  it("requires exact full-proposal approval and fresh classification for review", async () => {
    const { alice, bob } = identities();
    const review: Verdict = {
      ...allow,
      decision: "review",
      category: "ambiguous",
      reason: "Review.",
    };
    const common = {
      id: "01JZ0000000000000000000000",
      from: "alice#1",
      to: "bob#1",
      body: { text: "ordinary text" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      policyVersion: "v1",
    };
    await expect(
      composeOutbound({ ...common, audit: audit(), guard: mockGuard(review) }),
    ).rejects.toMatchObject({ stage: "review" });
    await expect(
      composeOutbound({
        ...common,
        audit: audit(),
        guard: mockGuard(review),
        reviewGate: async ({ approvalDigest }) => ({ approved: false, approvalDigest }),
      }),
    ).rejects.toMatchObject({ stage: "review", reviewOutcome: "denied", receipt: undefined });
    await expect(
      composeOutbound({
        ...common,
        audit: audit(),
        guard: mockGuard(review),
        reviewGate: async () => ({ approved: true, approvalDigest: "wrong" }),
      }),
    ).rejects.toMatchObject({ stage: "review" });
    const guard = mockGuard(review, allow);
    const result = await composeOutbound({
      ...common,
      audit: audit(),
      guard,
      reviewGate: async ({ approvalDigest }) => ({ approved: true, approvalDigest }),
    });
    expect(result.verdict.decision).toBe("allow");
    expect(guard.calls).toBe(2);
  });

  it("does not reuse an approval across recipients", async () => {
    const { alice, bob } = identities();
    const review: Verdict = {
      ...allow,
      decision: "review",
      category: "ambiguous",
      reason: "Review.",
    };
    const common = {
      id: "01JZ0000000000000000000007",
      from: "sender#1",
      body: { text: "identical body" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      policyVersion: "v1",
    };
    let vincentDigest = "";
    await expect(
      composeOutbound({
        ...common,
        to: "vincent#1",
        audit: audit(),
        guard: mockGuard(review),
        reviewGate: async (request) => {
          vincentDigest = request.approvalDigest;
          expect(request).toMatchObject({
            id: common.id,
            from: common.from,
            to: "vincent#1",
            direction: "outbound",
          });
          expect(request.bodyHash).toMatch(/^[0-9a-f]{64}$/);
          return undefined;
        },
      }),
    ).rejects.toMatchObject({ stage: "review", reviewOutcome: "pending" });
    await expect(
      composeOutbound({
        ...common,
        to: "alice#1",
        audit: audit(),
        guard: mockGuard(review),
        reviewGate: async () => ({ approved: true, approvalDigest: vincentDigest }),
      }),
    ).rejects.toMatchObject({ stage: "review", message: "approval digest mismatch" });
  });

  it("releases a replay claim after transient audit failure and retries successfully", async () => {
    const { alice, bob } = identities();
    const envelope = seal({
      id: "01JZ0000000000000000000001",
      from: "alice#1",
      to: "bob#1",
      body: { text: "retry me" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
    });
    const replayStore = new MemoryReplayStore();
    const inboundAudit = new FailOnceAuditStore();
    const options = {
      envelope,
      self: "bob#1",
      recipientEncryptionSecretKey: bob.encryption.secretKey,
      recipientSigningSecretKey: bob.signing.secretKey,
      senderSigningPublicKey: alice.signing.publicKey,
      replayStore,
      now,
      guard: mockGuard(allow),
      audit: inboundAudit,
      policyVersion: "v1",
    };
    await expect(composeInbound(options)).rejects.toThrow("transient audit failure");
    const retried = await composeInbound(options);
    expect(retried.disposition).toBe("accepted");
    expect(retried.receipt.status).toBe("accepted");
  });

  it("returns an identical cached rejection receipt on guard-deny redelivery", async () => {
    const { alice, bob } = identities();
    const envelope = seal({
      id: "01JZ0000000000000000000002",
      from: "alice#1",
      to: "bob#1",
      body: { text: "classify me" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
    });
    const replayStore = new MemoryReplayStore();
    const inboundAudit = audit();
    const deny: Verdict = { ...allow, decision: "deny", category: "injection", reason: "Denied." };
    const guard = mockGuard(deny);
    const options = {
      envelope,
      self: "bob#1",
      recipientEncryptionSecretKey: bob.encryption.secretKey,
      recipientSigningSecretKey: bob.signing.secretKey,
      senderSigningPublicKey: alice.signing.publicKey,
      replayStore,
      now,
      guard,
      audit: inboundAudit,
      policyVersion: "v1",
    };
    let rejection: PipelineError | undefined;
    try {
      await composeInbound(options);
    } catch (error) {
      if (error instanceof PipelineError) {
        rejection = error;
      } else {
        throw error;
      }
    }
    expect(rejection?.receipt).toMatchObject({ status: "rejected", category: "guard_deny" });
    const entryCount = (await inboundAudit.entries()).length;
    const duplicate = await composeInbound({ ...options, now: now + 1_000 });
    expect(duplicate).toEqual({ disposition: "duplicate", receipt: rejection!.receipt });
    expect(duplicate).not.toHaveProperty("body");
    expect((await inboundAudit.entries()).length).toBe(entryCount);
    expect(guard.calls).toBe(1);
  });

  it("completes explicit inbound review denial and caches its receipt", async () => {
    const { alice, bob } = identities();
    const envelope = seal({
      id: "01JZ0000000000000000000005",
      from: "alice#1",
      to: "bob#1",
      body: { text: "review me" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
    });
    const review: Verdict = {
      ...allow,
      decision: "review",
      category: "ambiguous",
      reason: "Review.",
    };
    const guard = mockGuard(review);
    const replayStore = new MemoryReplayStore();
    const inboundAudit = audit();
    const options = {
      envelope,
      self: "bob#1",
      recipientEncryptionSecretKey: bob.encryption.secretKey,
      recipientSigningSecretKey: bob.signing.secretKey,
      senderSigningPublicKey: alice.signing.publicKey,
      replayStore,
      now,
      guard,
      audit: inboundAudit,
      policyVersion: "v1",
      reviewGate: async ({ approvalDigest }: { approvalDigest: string }) => ({
        approved: false,
        approvalDigest,
      }),
    };
    let rejection: PipelineError | undefined;
    try {
      await composeInbound(options);
    } catch (error) {
      if (error instanceof PipelineError) {
        rejection = error;
      } else {
        throw error;
      }
    }
    expect(rejection).toMatchObject({
      stage: "review",
      reviewOutcome: "denied",
      receipt: { status: "rejected", category: "review_denied" },
    });
    const entryCount = (await inboundAudit.entries()).length;
    await expect(composeInbound(options)).resolves.toEqual({
      disposition: "duplicate",
      receipt: rejection!.receipt,
    });
    expect((await inboundAudit.entries()).length).toBe(entryCount);
    expect(guard.calls).toBe(1);
  });

  it("releases pending inbound review and accepts a later approved retry", async () => {
    const { alice, bob } = identities();
    const envelope = seal({
      id: "01JZ0000000000000000000006",
      from: "alice#1",
      to: "bob#1",
      body: { text: "decide later" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
    });
    const review: Verdict = {
      ...allow,
      decision: "review",
      category: "ambiguous",
      reason: "Review.",
    };
    const guard = mockGuard(review, review, allow);
    let decided = false;
    const options = {
      envelope,
      self: "bob#1",
      recipientEncryptionSecretKey: bob.encryption.secretKey,
      recipientSigningSecretKey: bob.signing.secretKey,
      senderSigningPublicKey: alice.signing.publicKey,
      replayStore: new MemoryReplayStore(),
      now,
      guard,
      audit: audit(),
      policyVersion: "v1",
      reviewGate: async ({ approvalDigest }: { approvalDigest: string }) =>
        decided ? { approved: true, approvalDigest } : undefined,
    };
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

  it("completes deterministic inbound denial with a signed rejection", async () => {
    const { alice, bob } = identities();
    const envelope = seal({
      id: "01JZ0000000000000000000003",
      from: "alice#1",
      to: "bob#1",
      body: { text: ["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("") },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
    });
    const guard = mockGuard(allow);
    await expect(
      composeInbound({
        envelope,
        self: "bob#1",
        recipientEncryptionSecretKey: bob.encryption.secretKey,
        recipientSigningSecretKey: bob.signing.secretKey,
        senderSigningPublicKey: alice.signing.publicKey,
        replayStore: new MemoryReplayStore(),
        now,
        guard,
        audit: audit(),
        policyVersion: "v1",
      }),
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
