import fsSync from "node:fs";
import fs, { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendAudit, verifyChain } from "./audit.js";
import { generateIdentity } from "./identity.js";
import { JsonlAuditStore, FileReplayStore } from "./node.js";
import { signReceipt } from "./receipts.js";
import { useReefTempDirs } from "./test-support.js";

const durabilityTestState = vi.hoisted(() => ({
  afterEnsure: undefined as ((receipt: { path: string }) => Promise<void> | void) | undefined,
  parentSyncOutcome: undefined as
    | { status: "synced" }
    | { status: "unsupported"; code?: string }
    | undefined,
  syncOutcome: undefined as
    | { status: "synced" }
    | { status: "unsupported"; code?: string }
    | undefined,
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    ensureDurableDirectory: async (...args: Parameters<typeof actual.ensureDurableDirectory>) => {
      const receipt = await actual.ensureDurableDirectory(...args);
      await durabilityTestState.afterEnsure?.(receipt);
      return durabilityTestState.parentSyncOutcome
        ? { ...receipt, parentSync: durabilityTestState.parentSyncOutcome }
        : receipt;
    },
    syncDirectory: async (...args: Parameters<typeof actual.syncDirectory>) =>
      durabilityTestState.syncOutcome ?? (await actual.syncDirectory(...args)),
  };
});

const auditKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const replayBodyKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const receiptId = "01JZ0000000000000000000000";
const tempDirs = useReefTempDirs(afterEach);

afterEach(() => {
  durabilityTestState.afterEnsure = undefined;
  durabilityTestState.parentSyncOutcome = undefined;
  durabilityTestState.syncOutcome = undefined;
  vi.restoreAllMocks();
});

describe("Node stores", () => {
  it("persists serialized audit JSONL", async () => {
    const directory = tempDirs.make("reef-audit-");
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
    const directory = tempDirs.make("reef-audit-torn-");
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

  it.runIf(process.platform !== "win32")(
    "rejects an append when the journal directory cannot be synchronized",
    async () => {
      const directory = tempDirs.make("reef-audit-sync-failure-");
      const path = join(directory, "nested", "audit.jsonl");
      const parentPath = dirname(path);
      const originalOpen = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (
          typeof flags === "number" &&
          (flags & fsSync.constants.O_DIRECTORY) !== 0 &&
          resolve(String(filePath)) === (await fs.realpath(parentPath).catch(() => parentPath))
        ) {
          vi.spyOn(handle, "sync").mockRejectedValue(
            Object.assign(new Error("journal directory sync failed"), { code: "EIO" }),
          );
        }
        return handle;
      });

      try {
        await expect(
          new JsonlAuditStore(path, auditKey).appendEvent("one", { id: 1 }, 10),
        ).rejects.toMatchObject({ code: "EIO" });
      } finally {
        openSpy.mockRestore();
      }
    },
  );

  it.each(["parent", "final"] as const)(
    "rejects an append when %s journal directory synchronization is unsupported",
    async (stage) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const directory = tempDirs.make(`reef-audit-${stage}-unsupported-`);
      const path = join(directory, "nested", "audit.jsonl");
      if (stage === "parent") {
        durabilityTestState.parentSyncOutcome = { status: "unsupported", code: "ENOTSUP" };
      } else {
        durabilityTestState.syncOutcome = { status: "unsupported", code: "ENOTSUP" };
      }

      await expect(
        new JsonlAuditStore(path, auditKey).appendEvent("one", { id: 1 }, 10),
      ).rejects.toThrow(
        /Reef journal directory does not support crash-durable synchronization \(ENOTSUP\)/u,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "appends through the pinned canonical directory after a symlink retarget",
    async () => {
      const root = tempDirs.make("reef-audit-parent-retarget-");
      const firstDirectory = join(root, "first");
      const secondDirectory = join(root, "second");
      const requestedDirectory = join(root, "requested");
      await fs.mkdir(firstDirectory);
      await fs.mkdir(secondDirectory);
      await fs.symlink(firstDirectory, requestedDirectory);
      const requestedPath = join(requestedDirectory, "nested", "audit.jsonl");
      durabilityTestState.afterEnsure = async () => {
        await fs.unlink(requestedDirectory);
        await fs.symlink(secondDirectory, requestedDirectory);
      };

      await new JsonlAuditStore(requestedPath, auditKey).appendEvent("one", { id: 1 }, 10);

      await expect(
        readFile(join(firstDirectory, "nested", "audit.jsonl"), "utf8"),
      ).resolves.toContain('"type":"one"');
      await expect(fs.readdir(secondDirectory)).resolves.toEqual([]);
    },
  );

  it("accepts unsupported journal directory synchronization on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const directory = tempDirs.make("reef-audit-windows-unsupported-");
    const path = join(directory, "nested", "audit.jsonl");
    durabilityTestState.parentSyncOutcome = { status: "unsupported", code: "EPERM" };
    durabilityTestState.syncOutcome = { status: "unsupported", code: "EPERM" };

    await expect(
      new JsonlAuditStore(path, auditKey).appendEvent("one", { id: 1 }, 10),
    ).resolves.toMatchObject({ event: { seq: 1, type: "one" } });
  });

  it("rejects a corrupt middle JSONL record", async () => {
    const directory = tempDirs.make("reef-audit-corrupt-");
    const path = join(directory, "audit.jsonl");
    const store = new JsonlAuditStore(path, auditKey);
    await store.appendEvent("one", { id: 1 }, 10);
    await store.appendEvent("two", { id: 2 }, 11);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, `${lines[0]}\n{"broken"\n${lines[1]}\n`);
    await expect(new JsonlAuditStore(path, auditKey).entries()).rejects.toThrow();
  });

  it("persists replay bindings and completed receipts", async () => {
    const directory = tempDirs.make("reef-replay-");
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
    const directory = tempDirs.make("reef-replay-consumed-");
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
