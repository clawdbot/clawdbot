/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import * as payloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import {
  readStoredOutboxStore,
  storageTargetForGateway,
  storedChatOutboxScopeKey,
  writeStoredOutboxStore,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";

const gatewayUrl = "ws://synthetic-blob-recovery.test";
const dataUrl = "data:text/plain;base64,Y29tcGxldGUgc291cmNlIGJ5dGVz";
const target = storageTargetForGateway(gatewayUrl);
function hostFor(recoveryScope = "principal-a") {
  const host = makeChatHost({
    requestHandlers: {},
    settings: { gatewayUrl },
    sessionKey: "agent:main:review",
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
  });
  vi.spyOn(
    expectDefined(host.client, "authenticated client"),
    "recoveryScope",
    "get",
  ).mockReturnValue(recoveryScope);
  return host;
}
async function prepare(host: ReturnType<typeof hostFor>, id: string, sessionKey = "global") {
  const item: ChatQueueItem = {
    id,
    text: id,
    createdAt: 10,
    orderKey: 5,
    sessionKey,
    agentId: "main",
    sendRunId: `original-${id}`,
    sendAttempts: 1,
    sendState: "unconfirmed",
    attachments: [
      { id: `${id}-file`, mimeType: "text/plain", fileName: "source.txt", sizeBytes: 21, dataUrl },
    ],
  };
  const result = await prepareOutboxPayload(host, item);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") {
    throw new Error("Expected complete stored payload");
  }
  const { attachmentStorageError: _, ...stored } = { ...item, ...result.update };
  return {
    ...stored,
    attachments: item.attachments?.map(({ id: attachmentId, mimeType, fileName, sizeBytes }) => ({
      id: attachmentId,
      mimeType,
      fileName,
      sizeBytes,
    })),
  };
}
function seed(items: ChatQueueItem[], sessionKey = "global", version = 3) {
  const key = `openclaw.control.chatComposer.v${version}:${encodeURIComponent(gatewayUrl)}`;
  const raw = JSON.stringify({
    version,
    gatewayOwner: gatewayUrl,
    sessions: {
      [storedChatOutboxScopeKey({ sessionKey, agentId: "main" })]: {
        updatedAt: 10,
        draftRevision: 42,
        queue: items,
      },
    },
  });
  sessionStorage.setItem(key, raw);
  return { key, raw };
}
async function expectBytes(host: ReturnType<typeof hostFor>, item: ChatQueueItem) {
  const result = await prepareOutboxPayload(host, item, "handoff");
  expect(result.status).toBe("ready");
  const attachments = result.status === "ready" ? result.update.attachments : [];
  expect(attachments).toHaveLength(1);
  const restoredUrl = expectDefined(
    getChatAttachmentDataUrl(expectDefined(attachments?.[0], "restored attachment")),
    "restored attachment data URL",
  );
  const comma = restoredUrl.indexOf(",");
  expect(comma).toBeGreaterThan(0);
  const metadata = restoredUrl.slice(0, comma).split(";");
  expect(metadata[0]).toBe("data:text/plain");
  expect(metadata.at(-1)).toBe("base64");
  expect(Buffer.from(restoredUrl.slice(comma + 1), "base64")).toEqual(
    Buffer.from("complete source bytes"),
  );
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  installOutboxBrowserStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Blob-preserving metadata migration", () => {
  it("stores attachment payloads without secure-context-only browser APIs", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends Exclude<BufferSource, ArrayBuffer>>(array: T): T => {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
        return array;
      },
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });

    const host = hostFor();
    const item = await prepare(host, "insecure-http");

    await expectBytes(host, item);
    expect(sessionStorage.getItem("openclaw.control.outboxTab.v1")).toBe(
      "07070707-0707-4707-8707-070707070707",
    );
  });

  it("does not settle payload preparation under a pending connected recovery owner", async () => {
    const host = hostFor();
    const original = await prepare(host, "pending-owner");
    const started = createDeferred();
    const release = createDeferred();
    const read = payloadStore.readOutboxPayload;
    vi.spyOn(payloadStore, "readOutboxPayload").mockImplementationOnce(async (...args) => {
      const value = await read(...args);
      started.resolve();
      await release.promise;
      return value;
    });
    const prepared = prepareOutboxPayload(host, original, "handoff");
    await started.promise;
    const ready = vi
      .spyOn(expectDefined(host.client, "connected client"), "recoveryScopeReady", "get")
      .mockReturnValue(false);
    release.resolve();
    expect(await prepared).toEqual({ status: "failed", reason: "unavailable" });
    ready.mockRestore();
    await expectBytes(host, original);
  });

  it.each(["agent:main:topic", "global"])(
    "migrates landed v3 %s without retiring its exact Blob or attempt",
    async (sessionKey) => {
      const host = hostFor();
      const item = await prepare(host, "legacy", sessionKey);
      const source = seed([item], sessionKey);
      const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads");
      const migrated = readStoredOutboxStore(sessionStorage, target);
      expect(sessionStorage.getItem(source.key)).toBeNull();
      expect(migrated.version).toBe(4);
      const rows = [
        ...Object.values(migrated.sessions),
        ...Object.values(migrated.recovery).map((entry) => entry.session),
      ];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ draftRevision: 42, queue: [item] });
      if (sessionKey === "global") {
        expect(listStoredChatOutboxes(host)).toEqual([]);
        const entry = expectDefined(readChatOutboxRecovery(host).entries[0], "owned recovery");
        const destination = expectDefined(
          captureChatOutboxRecoveryDestination(host, {
            sessionKey: host.sessionKey,
            agentId: "main",
          }),
          "empty target",
        );
        expect(restoreChatOutboxRecovery(host, entry, destination)).toBe("restored");
      }
      const restored = expectDefined(listStoredChatOutboxes(host)[0]?.queue[0], "restored input");
      expect(restored).toMatchObject({
        id: item.id,
        sendRunId: item.sendRunId,
        sendAttempts: 1,
        sendState: "unconfirmed",
        orderKey: 5,
        attachmentPayload: item.attachmentPayload,
      });
      await expectBytes(host, restored);
      expect(cleanup).not.toHaveBeenCalled();
      const reopened = readStoredOutboxStore(sessionStorage, target);
      reopened.sessions = {};
      writeStoredOutboxStore(sessionStorage, target, reopened);
      expect(cleanup).toHaveBeenCalledWith([item.attachmentPayload]);
      await Promise.all(
        cleanup.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
      );
      expect(await prepareOutboxPayload(host, restored, "handoff")).toEqual({
        status: "failed",
        reason: "missing",
      });
    },
  );

  it.each(["noop", "quota"])(
    "keeps source Blob bytes across %s migration and explicit transfer failures",
    async (failure) => {
      const host = hostFor();
      const item = await prepare(host, "retained");
      const source = seed([item]);
      const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads");
      const fail = () => {
        if (failure === "quota") {
          throw new DOMException("quota", "QuotaExceededError");
        }
      };
      let write = vi.spyOn(sessionStorage, "setItem").mockImplementation(fail);
      expect(readChatOutboxRecovery(host).entries[0]?.session.queue).toEqual([item]);
      expect(sessionStorage.getItem(source.key)).toBe(source.raw);
      await expectBytes(host, item);
      write.mockRestore();
      const entry = expectDefined(readChatOutboxRecovery(host).entries[0], "migrated source");
      const before = sessionStorage.getItem(target.key);
      const destination = expectDefined(
        captureChatOutboxRecoveryDestination(host, {
          sessionKey: host.sessionKey,
          agentId: "main",
        }),
        "empty destination",
      );
      write = vi.spyOn(sessionStorage, "setItem").mockImplementation(fail);
      expect(restoreChatOutboxRecovery(host, entry, destination)).toBe("storage-failed");
      expect(sessionStorage.getItem(target.key)).toBe(before);
      await expectBytes(host, item);
      expect(cleanup).not.toHaveBeenCalled();
      write.mockRestore();
      expect(restoreChatOutboxRecovery(host, entry, destination)).toBe("restored");
      await expectBytes(host, item);
      expect(cleanup).not.toHaveBeenCalled();
    },
  );

  it("partitions a mixed-principal v3 bucket while retaining foreign recovery across unrelated retirement", async () => {
    const a = hostFor();
    const b = hostFor("principal-b");
    const first = await prepare(a, "principal-a-input");
    const second = await prepare(b, "principal-b-input");
    const plain: ChatQueueItem = { id: "plain", text: "unbound legacy text", createdAt: 11 };
    seed([first, second, plain]);
    const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads");
    const entriesA = readChatOutboxRecovery(a).entries;
    const entriesB = readChatOutboxRecovery(b).entries;
    expect(entriesA.flatMap((entry) => entry.session.queue?.map((item) => item.id) ?? [])).toEqual([
      first.id,
      plain.id,
    ]);
    expect(entriesB.flatMap((entry) => entry.session.queue?.map((item) => item.id) ?? [])).toEqual([
      second.id,
      plain.id,
    ]);
    const ownedA = expectDefined(
      entriesA.find((entry) => entry.session.queue?.[0]?.id === first.id),
      "A entry",
    );
    const destination = expectDefined(
      captureChatOutboxRecoveryDestination(a, { sessionKey: a.sessionKey, agentId: "main" }),
      "A destination",
    );
    expect(restoreChatOutboxRecovery(b, ownedA, destination)).toBe("conflict");
    expect(restoreChatOutboxRecovery(a, ownedA, destination)).toBe("restored");
    const raw = readStoredOutboxStore(sessionStorage, target);
    raw.sessions = {};
    writeStoredOutboxStore(sessionStorage, target, raw);
    expect(cleanup).toHaveBeenCalledWith([first.attachmentPayload]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expectBytes(b, second);
    expect(readChatOutboxRecovery(b).entries).toEqual(entriesB);
    const client = expectDefined(b.client, "B client");
    const ready = vi.spyOn(client, "recoveryScopeReady", "get").mockReturnValue(false);
    expect(
      readChatOutboxRecovery(b).entries.flatMap(
        (entry) => entry.session.queue?.map((item) => item.id) ?? [],
      ),
    ).toEqual([plain.id]);
    expect(
      captureChatOutboxRecoveryDestination(b, { sessionKey: b.sessionKey, agentId: "main" }),
    ).toBeNull();
    b.connected = false;
    expect(readChatOutboxRecovery(b).entries).toEqual(entriesB);
    ready.mockRestore();
  });

  it.each(["noop-remove", "failed-remove", "deferred-legacy", "unreadable-legacy"])(
    "retains bytes when %s cannot establish complete retirement",
    async (failure) => {
      const host = hostFor();
      const item = await prepare(host, "retire", "agent:main:topic");
      seed([item], "agent:main:topic");
      const store = readStoredOutboxStore(sessionStorage, target);
      // Exercise removal rather than receipt-bearing writes as well as deferred sources.
      delete store.legacyReceipts;
      writeStoredOutboxStore(sessionStorage, target, store);
      const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads");
      if (failure === "noop-remove" || failure === "failed-remove") {
        vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {
          if (failure === "failed-remove") {
            throw new Error("blocked removal");
          }
        });
      } else {
        seed([item]);
        if (failure === "unreadable-legacy") {
          const get = sessionStorage.getItem.bind(sessionStorage);
          vi.spyOn(sessionStorage, "getItem").mockImplementation((key) => {
            if (key === target.blobKey) {
              throw new Error("blocked source read");
            }
            return get(key);
          });
        }
      }
      store.sessions = {};
      if (failure === "noop-remove" || failure === "failed-remove") {
        expect(() => writeStoredOutboxStore(sessionStorage, target, store)).toThrow();
      } else {
        writeStoredOutboxStore(sessionStorage, target, store);
      }
      expect(cleanup).not.toHaveBeenCalled();
      await expectBytes(host, item);
    },
  );
});
