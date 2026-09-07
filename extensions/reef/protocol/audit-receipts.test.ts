import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  appendAudit,
  appendInboxRead,
  decryptAuditText,
  exportRedactedJsonl,
  MemoryAuditStore,
  signCheckpoint,
  verifyChain,
  verifyCheckpoint,
  type AuditEntry,
} from "./audit.js";
import { base64url, fromBase64url, utf8 } from "./encoding.js";
import { generateIdentity } from "./identity.js";
import { confirmDelivery, signReceipt, verifyReceipt, type SignedReceipt } from "./receipts.js";

const auditKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

describe("audit", () => {
  it("builds and verifies a chain and signed checkpoint", async () => {
    const store = new MemoryAuditStore(auditKey);
    await appendAudit(store, "proposal", { id: "one", text: "secret message" }, 10);
    await appendAudit(
      store,
      "guard_verdict",
      { decision: "allow", reason: "looks safe", model: "model-20260101" },
      11,
    );
    await appendInboxRead(store, ["one"], 12);
    const entries = await store.entries();
    const identity = generateIdentity();
    const checkpoint = signCheckpoint(entries, identity.signing.secretKey);
    expect(verifyChain(entries, { head: entries.at(-1)!.entryHash, length: 3 })).toBe(true);
    expect(verifyCheckpoint(checkpoint, identity.signing.publicKey)).toBe(true);
    const legacy = {
      head: checkpoint.head,
      signature: base64url(
        ed25519.sign(utf8(checkpoint.head), fromBase64url(identity.signing.secretKey)),
      ),
    };
    expect(verifyCheckpoint(legacy, identity.signing.publicKey)).toBe(false);
    expect(entries.at(-1)!.event.type).toBe("read");
    expect(decryptAuditText(entries[0]!, auditKey).event.payload).toMatchObject({
      text: "secret message",
    });
    expect(decryptAuditText(entries[1]!, auditKey).event.payload).toMatchObject({
      reason: "looks safe",
    });
  });

  it("detects mutation and externally anchored truncation", async () => {
    const store = new MemoryAuditStore(auditKey);
    await appendAudit(store, "one", { value: 1 }, 10);
    await appendAudit(store, "two", { value: 2 }, 11);
    const entries = await store.entries();
    const expected = { head: entries[1]!.entryHash, length: 2 };
    expect(
      verifyChain(
        [{ ...entries[0]!, event: { ...entries[0]!.event, type: "changed" } }, entries[1]!],
        expected,
      ),
    ).toBe(false);
    expect(verifyChain(entries.slice(0, 1), expected)).toBe(false);
  });

  it("exports an unchanged, verifiable chain without plaintext", async () => {
    const store = new MemoryAuditStore(auditKey);
    await appendAudit(
      store,
      "inbox",
      {
        id: "one",
        text: "DO NOT LEAK ME",
        verdict: { decision: "deny", reason: "ALSO PRIVATE", model: "guard-20260101" },
      },
      10,
    );
    const entries = await store.entries();
    const exported = exportRedactedJsonl(entries);
    const parsed = exported
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuditEntry);
    expect(exported).not.toContain("DO NOT LEAK ME");
    expect(exported).not.toContain("ALSO PRIVATE");
    expect(exported).toContain('"enc"');
    expect(parsed).toEqual(entries);
    expect(verifyChain(parsed)).toBe(true);
  });

  it("serializes twenty concurrent appends into one valid chain", async () => {
    const store = new MemoryAuditStore(auditKey);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.appendEvent("concurrent", { index }, 100 + index),
      ),
    );
    const entries = await store.entries();
    expect(entries).toHaveLength(20);
    expect(entries.map((entry) => entry.event.seq)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(verifyChain(entries)).toBe(true);
  });
});

describe("receipts", () => {
  it("verifies and audits accepted and rejected delivery outcomes", async () => {
    const identity = generateIdentity();
    const audit = new MemoryAuditStore(auditKey);
    const accepted = signReceipt(
      {
        id: "01JZ0000000000000000000000",
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "accepted",
      },
      identity.signing.secretKey,
    );
    const rejected = signReceipt(
      {
        id: "01JZ0000000000000000000001",
        bodyHash: "c".repeat(64),
        auditHead: "d".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      identity.signing.secretKey,
    );
    expect(accepted.signature).toHaveLength(88);
    await confirmDelivery(accepted, identity.signing.publicKey, audit);
    await confirmDelivery(rejected, identity.signing.publicKey, audit);
    const entries = await audit.entries();
    expect(entries.map((entry) => entry.event.type)).toEqual([
      "confirm_delivery",
      "confirm_delivery",
    ]);
    expect(entries.map((entry) => (entry.event.payload as { status: string }).status)).toEqual([
      "accepted",
      "rejected",
    ]);
    expect(entries[0]!.event.payload).not.toHaveProperty("category");
    expect(entries[1]!.event.payload).toHaveProperty("category", "guard_deny");
    await expect(
      confirmDelivery({ ...accepted, bodyHash: "e".repeat(64) }, identity.signing.publicKey, audit),
    ).rejects.toThrow("invalid delivery receipt");
    await expect(
      confirmDelivery(accepted, identity.signing.publicKey, audit, {
        id: accepted.id,
        bodyHash: "e".repeat(64),
      }),
    ).rejects.toThrow("invalid delivery receipt");
    await expect(
      confirmDelivery(accepted, identity.signing.publicKey, audit, { status: "rejected" }),
    ).rejects.toThrow("invalid delivery receipt");
  });

  it("rejects unbounded and non-exact receipts before signature verification", () => {
    const identity = generateIdentity();
    const receipt = signReceipt(
      {
        id: "01JZ0000000000000000000000",
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "accepted",
      },
      identity.signing.secretKey,
    );
    expect(verifyReceipt({ ...receipt, signature: "A".repeat(10_000) }, "not-a-key")).toBe(false);
    expect(verifyReceipt({ ...receipt, category: "x".repeat(65) }, "not-a-key")).toBe(false);
    expect(verifyReceipt({ ...receipt, extra: true } as SignedReceipt, "not-a-key")).toBe(false);
  });
});
