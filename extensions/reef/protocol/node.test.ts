import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAudit, verifyChain } from "./audit.js";
import { generateIdentity } from "./identity.js";
import { JsonlAuditStore, FileReplayStore } from "./node.js";
import { signReceipt } from "./receipts.js";

const auditKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const replayBodyKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const receiptId = "01JZ0000000000000000000000";

describe("Node stores", () => {
  it("persists serialized audit JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reef-audit-"));
    const path = join(directory, "audit.jsonl");
    const store = new JsonlAuditStore(path, auditKey);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendAudit(store, "test", { id: index }, 10 + index),
      ),
    );
    const reopened = await new JsonlAuditStore(path, auditKey).entries();
    expect(reopened).toHaveLength(20);
    expect(verifyChain(reopened)).toBe(true);
  });

  it("drops a torn final JSONL record and permits a durable append", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reef-audit-torn-"));
    const path = join(directory, "audit.jsonl");
    const store = new JsonlAuditStore(path, auditKey);
    await store.appendEvent("one", { id: 1 }, 10);
    await store.appendEvent("two", { id: 2 }, 11);
    await appendFile(path, '{"event":{"seq":3');
    const recovered = new JsonlAuditStore(path, auditKey);
    expect(await recovered.entries()).toHaveLength(2);
    await recovered.appendEvent("three", { id: 3 }, 12);
    expect(await new JsonlAuditStore(path, auditKey).entries()).toHaveLength(3);
  });

  it("rejects a corrupt middle JSONL record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reef-audit-corrupt-"));
    const path = join(directory, "audit.jsonl");
    const store = new JsonlAuditStore(path, auditKey);
    await store.appendEvent("one", { id: 1 }, 10);
    await store.appendEvent("two", { id: 2 }, 11);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, `${lines[0]}\n{"broken"\n${lines[1]}\n`);
    await expect(new JsonlAuditStore(path, auditKey).entries()).rejects.toThrow();
  });

  it("persists replay bindings and completed receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reef-replay-"));
    const path = join(directory, "replay.jsonl");
    const identity = generateIdentity();
    const receipt = signReceipt(
      {
        id: receiptId,
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "accepted",
      },
      identity.signing.secretKey,
    );
    const body = { text: "RECOVERABLE SECRET BODY" };
    const store = new FileReplayStore(path, replayBodyKey, () => new Uint8Array(12).fill(7));
    expect(await store.claim("alice", receiptId, "c".repeat(64))).toBe("new");
    expect(await store.claim("alice", receiptId, "c".repeat(64))).toBe("in_flight");
    await store.complete("alice", receiptId, receipt, body);
    expect(await readFile(path, "utf8")).not.toContain(body.text);
    const reopened = new FileReplayStore(path, replayBodyKey);
    expect(await reopened.claim("alice", receiptId, "c".repeat(64))).toBe("duplicate");
    expect(await reopened.completed("alice", receiptId)).toEqual({ receipt, body });
    expect(await reopened.claim("alice", receiptId, "d".repeat(64))).toBe("mismatch");
    expect(await reopened.claim("carol", receiptId, "d".repeat(64))).toBe("new");
  });

  it("persists consumed replay bindings without receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reef-replay-consumed-"));
    const path = join(directory, "replay.jsonl");
    const store = new FileReplayStore(path, replayBodyKey);
    expect(await store.claim("alice", receiptId, "c".repeat(64))).toBe("new");
    await store.release("alice", receiptId);
    expect(await store.claim("alice", receiptId, "c".repeat(64))).toBe("new");
    await store.consume("alice", receiptId);
    const reopened = new FileReplayStore(path, replayBodyKey);
    expect(await reopened.claim("alice", receiptId, "c".repeat(64))).toBe("duplicate");
    expect(await reopened.completed("alice", receiptId)).toBeUndefined();
    expect(await reopened.claim("alice", receiptId, "d".repeat(64))).toBe("mismatch");
  });
});
