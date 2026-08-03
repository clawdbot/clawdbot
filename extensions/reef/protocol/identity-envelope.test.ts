import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "./canonical.js";
import { base64, base64url, fromBase64url, utf8 } from "./encoding.js";
import {
  BadSignatureError,
  MalformedError,
  open,
  ProtocolError,
  seal,
  TooLargeError,
  type Envelope,
} from "./envelope.js";
import {
  fingerprint,
  formatHandleEpoch,
  generateIdentity,
  parseHandleEpoch,
  signRotation,
  verifyRotation,
} from "./identity.js";
import { MemoryReplayStore } from "./replay.js";

const now = 1_752_300_000;
const id = "01JZ0000000000000000000000";
const replyTo = "01JZ0000000000000000000001";
const thread = "01JZ0000000000000000000002";

function fixture() {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const envelope = seal({
    id,
    from: "alice#1",
    to: "bob#1",
    body: { text: "hello", replyTo, thread },
    senderSigningSecretKey: alice.signing.secretKey,
    recipientEncryptionPublicKey: bob.encryption.publicKey,
    ts: now,
  });
  return { alice, bob, envelope };
}

async function openFixture(
  envelope: Envelope,
  alice: ReturnType<typeof generateIdentity>,
  bob: ReturnType<typeof generateIdentity>,
  self = "bob#1",
  at = now,
) {
  return open({
    envelope,
    self,
    recipientEncryptionSecretKey: bob.encryption.secretKey,
    senderSigningPublicKey: alice.signing.publicKey,
    replayStore: new MemoryReplayStore(),
    now: at,
  });
}

describe("identity", () => {
  it("formats, parses, and fingerprints identities stably", () => {
    const identity = generateIdentity();
    expect(parseHandleEpoch(formatHandleEpoch("reef-bot", 3))).toEqual({
      handle: "reef-bot",
      keyEpoch: 3,
    });
    expect(fingerprint(identity.signing.publicKey, identity.encryption.publicKey)).toBe(
      fingerprint(identity.signing.publicKey, identity.encryption.publicKey),
    );
    expect(fingerprint(identity.signing.publicKey)).toMatch(/^(?:[0-9a-f]{4} ){15}[0-9a-f]{4}$/);
  });

  it("authenticates planned rotation with the old signing key", () => {
    const oldIdentity = generateIdentity();
    const next = generateIdentity();
    const rotation = signRotation(
      {
        newEd25519Pub: next.signing.publicKey,
        newX25519Pub: next.encryption.publicKey,
        newEpoch: 2,
      },
      oldIdentity.signing.secretKey,
    );
    expect(verifyRotation(rotation, oldIdentity.signing.publicKey)).toBe(true);
    expect(verifyRotation({ ...rotation, newEpoch: 3 }, oldIdentity.signing.publicKey)).toBe(false);
    const legacyStatement = {
      newEd25519Pub: next.signing.publicKey,
      newX25519Pub: next.encryption.publicKey,
      newEpoch: 2,
    };
    const legacy = {
      ...legacyStatement,
      signature: base64url(
        ed25519.sign(canonicalBytes(legacyStatement), fromBase64url(oldIdentity.signing.secretKey)),
      ),
    };
    expect(verifyRotation(legacy, oldIdentity.signing.publicKey)).toBe(false);
    expect(
      verifyRotation(
        { ...rotation, domain: "attacker-domain" } as typeof rotation,
        oldIdentity.signing.publicKey,
      ),
    ).toBe(false);
  });
});

describe("envelope", () => {
  it("seals and opens a text body", async () => {
    const { alice, bob, envelope } = fixture();
    await expect(openFixture(envelope, alice, bob)).resolves.toEqual({
      text: "hello",
      replyTo,
      thread,
    });
  });

  it("consumes a standalone envelope after one successful open", async () => {
    const { alice, bob, envelope } = fixture();
    const replayStore = new MemoryReplayStore();
    const options = {
      envelope,
      self: "bob#1",
      recipientEncryptionSecretKey: bob.encryption.secretKey,
      senderSigningPublicKey: alice.signing.publicKey,
      replayStore,
      now,
    };
    await expect(open(options)).resolves.toEqual({ text: "hello", replyTo, thread });
    await expect(open(options)).rejects.toMatchObject({
      code: "replayed",
      message: "duplicate envelope",
    });
    await expect(replayStore.completed("alice", id)).resolves.toBeUndefined();
  });

  it("releases a failed standalone open for retry", async () => {
    const { alice, bob, envelope } = fixture();
    const replayStore = new MemoryReplayStore();
    const options = {
      envelope,
      self: "bob#1",
      recipientEncryptionSecretKey: bob.encryption.secretKey,
      senderSigningPublicKey: alice.signing.publicKey,
      replayStore,
    };
    await expect(open({ ...options, now: now - 301 })).rejects.toMatchObject({ code: "expired" });
    await expect(open({ ...options, now })).resolves.toEqual({ text: "hello", replyTo, thread });
  });

  it("rejects free-form body identifiers when sealing", () => {
    const { alice, bob } = fixture();
    expect(() =>
      seal({
        id,
        from: "alice#1",
        to: "bob#1",
        body: { text: "hello", replyTo: "prior message" },
        senderSigningSecretKey: alice.signing.secretKey,
        recipientEncryptionPublicKey: bob.encryption.publicKey,
        ts: now,
      }),
    ).toThrow(MalformedError);
  });

  it("rejects a decrypted body containing a free-form thread", async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const envelope = craftEnvelope({ text: "hello", thread: "free-form thread" }, alice, bob);
    await expect(openFixture(envelope, alice, bob)).rejects.toBeInstanceOf(MalformedError);
  });

  it("verifies every signed field before acting on it", async () => {
    const { alice, bob, envelope } = fixture();
    const mutations: Envelope[] = [
      { ...envelope, v: 2 as 1 },
      { ...envelope, id: `${envelope.id.slice(0, -1)}1` },
      { ...envelope, from: "mallory#1" },
      { ...envelope, to: "mallory#1" },
      { ...envelope, ts: envelope.ts + 1 },
      { ...envelope, epk: flip(envelope.epk) },
      { ...envelope, n: flip(envelope.n) },
      { ...envelope, ct: flip(envelope.ct) },
      { ...envelope, sig: flip(envelope.sig) },
    ];
    for (const mutated of mutations) {
      await expect(openFixture(mutated, alice, bob)).rejects.toMatchObject({
        code: "bad_signature",
      });
    }
  });

  it("rejects an unpinned sender", async () => {
    const { bob, envelope } = fixture();
    await expect(
      open({
        envelope,
        self: "bob#1",
        recipientEncryptionSecretKey: bob.encryption.secretKey,
        replayStore: new MemoryReplayStore(),
        now,
      }),
    ).rejects.toMatchObject({ code: "not_pinned" });
  });

  it("rejects the wrong recipient", async () => {
    const { alice, bob, envelope } = fixture();
    await expect(openFixture(envelope, alice, bob, "carol#1")).rejects.toMatchObject({
      code: "wrong_recipient",
    });
  });

  it("accepts store-and-forward delivery ten minutes later", async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const envelope = seal({
      id,
      from: "alice#1",
      to: "bob#1",
      body: { text: "delayed" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now - 10 * 60,
    });
    await expect(openFixture(envelope, alice, bob)).resolves.toEqual({ text: "delayed" });
  });

  it("rejects envelopes beyond the future clock-skew bound", async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const envelope = seal({
      id,
      from: "alice#1",
      to: "bob#1",
      body: { text: "future" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now + 3_600,
    });
    await expect(openFixture(envelope, alice, bob)).rejects.toMatchObject({ code: "expired" });
  });

  it("rejects envelopes older than relay retention", async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const envelope = seal({
      id,
      from: "alice#1",
      to: "bob#1",
      body: { text: "ancient" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now - 40 * 24 * 60 * 60,
    });
    await expect(openFixture(envelope, alice, bob)).rejects.toMatchObject({ code: "expired" });
  });

  it("permanently binds an id to the first verified envelope hash", async () => {
    const { alice, bob, envelope } = fixture();
    const store = new MemoryReplayStore();
    await open({
      envelope,
      self: "bob#1",
      recipientEncryptionSecretKey: bob.encryption.secretKey,
      senderSigningPublicKey: alice.signing.publicKey,
      replayStore: store,
      now,
    });
    const replacement = seal({
      id,
      from: "alice#2",
      to: "bob#1",
      body: { text: "different" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
    });
    await expect(
      open({
        envelope: replacement,
        self: "bob#1",
        recipientEncryptionSecretKey: bob.encryption.secretKey,
        senderSigningPublicKey: alice.signing.publicKey,
        replayStore: store,
        now,
      }),
    ).rejects.toMatchObject({ code: "replayed", message: "replay id binding mismatch" });
  });

  it("namespaces identical envelope ids by authenticated sender handle", async () => {
    const alice = generateIdentity();
    const carol = generateIdentity();
    const bob = generateIdentity();
    const replayStore = new MemoryReplayStore();
    const aliceEnvelope = seal({
      id,
      from: "alice#1",
      to: "bob#1",
      body: { text: "from alice" },
      senderSigningSecretKey: alice.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
    });
    const carolEnvelope = seal({
      id,
      from: "carol#1",
      to: "bob#1",
      body: { text: "from carol" },
      senderSigningSecretKey: carol.signing.secretKey,
      recipientEncryptionPublicKey: bob.encryption.publicKey,
      ts: now,
    });
    await expect(
      open({
        envelope: aliceEnvelope,
        self: "bob#1",
        recipientEncryptionSecretKey: bob.encryption.secretKey,
        senderSigningPublicKey: alice.signing.publicKey,
        replayStore,
        now,
      }),
    ).resolves.toEqual({ text: "from alice" });
    await expect(
      open({
        envelope: carolEnvelope,
        self: "bob#1",
        recipientEncryptionSecretKey: bob.encryption.secretKey,
        senderSigningPublicKey: carol.signing.publicKey,
        replayStore,
        now,
      }),
    ).resolves.toEqual({ text: "from carol" });
  });

  it("atomically admits exactly one concurrent open", async () => {
    const { alice, bob, envelope } = fixture();
    const replayStore = new MemoryReplayStore();
    const options = {
      envelope,
      self: "bob#1",
      recipientEncryptionSecretKey: bob.encryption.secretKey,
      senderSigningPublicKey: alice.signing.publicKey,
      replayStore,
      now,
    };
    const results = await Promise.allSettled([open(options), open(options)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "replayed", message: "in flight" },
    });
  });

  it("enforces the plaintext cap", () => {
    const { alice, bob } = fixture();
    expect(() =>
      seal({
        id,
        from: "alice#1",
        to: "bob#1",
        body: { text: "x".repeat(33 * 1024) },
        senderSigningSecretKey: alice.signing.secretKey,
        recipientEncryptionPublicKey: bob.encryption.publicKey,
        ts: now,
      }),
    ).toThrow(ProtocolError);
  });

  it("rejects oversized ciphertext before base64 decoding", async () => {
    const { alice, bob, envelope } = fixture();
    const oversized = { ...envelope, ct: "!".repeat(44_753) };
    await expect(openFixture(oversized, alice, bob)).rejects.toBeInstanceOf(TooLargeError);
  });

  it("accepts the ciphertext size boundary for signature validation", async () => {
    const { alice, bob, envelope } = fixture();
    const boundary = { ...envelope, ct: "A".repeat(44_752) };
    await expect(openFixture(boundary, alice, bob)).rejects.toBeInstanceOf(BadSignatureError);
  });

  it("rejects huge peer fields before decoding ciphertext", async () => {
    const { alice, bob, envelope } = fixture();
    const oversized = { ...envelope, from: "a".repeat(10 * 1024 * 1024), ct: "!" };
    await expect(openFixture(oversized, alice, bob)).rejects.toBeInstanceOf(TooLargeError);
  });
});

function flip(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

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
    id,
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
