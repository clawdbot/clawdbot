/* @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import * as payloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  cloneChatAttachmentsForIndependentOwner,
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { renderAssistantAttachments } from "./components/chat-message-attachments.ts";
import { projectMessageMedia } from "./components/chat-message-media.ts";
import { hydrateDurableComposerAttachments } from "./durable-composer-persistence.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

const dataUrl = "data:application/pdf;base64,JVBERi0xLjQK";
let created: Map<string, Blob>;
let revoked: string[];
let owned: ChatAttachment[];
let browserBlob: typeof Blob;
beforeEach(() => {
  browserBlob = Blob;
  vi.stubGlobal("sessionStorage", createStorageMock());
  installOutboxBrowserStorage();
  created = new Map();
  revoked = [];
  owned = [];
  const NativeURL = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static override createObjectURL(blob: Blob) {
        const value = `blob:http://localhost/preview-${created.size}`;
        created.set(value, blob);
        return value;
      }
      static override revokeObjectURL(value: string) {
        revoked.push(value);
      }
    },
  );
});
afterEach(() => {
  releaseChatAttachmentPayloads(owned);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function hostFor() {
  const host = makeChatHost({
    requestHandlers: {},
    settings: { gatewayUrl: "ws://synthetic-preview.test" },
    sessionKey: "agent:main:preview",
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
  });
  if (!host.client) {
    throw new Error("Missing fixture client");
  }
  vi.spyOn(host.client, "recoveryScope", "get").mockReturnValue("synthetic-preview-owner");
  return host;
}
function selected(): ChatAttachment {
  const attachment = registerChatAttachmentPayload({
    attachment: {
      id: "synthetic-pdf",
      mimeType: "application/pdf",
      fileName: "brief.pdf",
      sizeBytes: 9,
    },
    dataUrl,
    file: new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" }),
  });
  owned.push(attachment);
  return attachment;
}
function card(attachment: ChatAttachment) {
  const message = buildLocalUserMessage({
    attachments: [attachment],
    createdAt: 1,
    text: "Read brief",
  });
  const { attachments } = projectMessageMedia(message, normalizeMessage(message).content);
  const container = document.body.appendChild(document.createElement("div"));
  const onOpen = vi.fn();
  render(renderAssistantAttachments(attachments, {}, onOpen), container);
  return {
    container,
    onOpen,
    download: container.querySelector<HTMLAnchorElement>(
      ".chat-assistant-attachment-card__download",
    ),
    open: container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand"),
  };
}
async function persisted(host: ReturnType<typeof hostFor>): Promise<ChatQueueItem> {
  const item: ChatQueueItem = {
    id: "synthetic-queue",
    text: "Read brief",
    createdAt: 1,
    sessionKey: host.sessionKey,
    agentId: "main",
    sendRunId: "synthetic-original",
    sendAttempts: 1,
    sendState: "failed",
    attachments: [selected()],
  };
  const result = await prepareOutboxPayload(host, item);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") {
    throw new Error("Payload was not persisted");
  }
  releaseChatAttachmentPayloads(item.attachments);
  return {
    ...item,
    ...result.update,
    attachments: item.attachments?.map(({ id, mimeType, fileName, sizeBytes }) => ({
      id,
      mimeType,
      fileName,
      sizeBytes,
    })),
  };
}
it("retains document Open and Download after complete outbox hydration", async () => {
  const host = hostFor();
  const item = await persisted(host);
  const restored = await prepareOutboxPayload(host, item, "handoff");
  expect(restored.status).toBe("ready");
  if (restored.status !== "ready") {
    throw new Error("Payload was not restored");
  }
  const attachment = restored.update.attachments?.[0];
  if (!attachment) {
    throw new Error("Missing restored attachment");
  }
  owned.push(attachment);
  expect(getChatAttachmentDataUrl(attachment)).toBe(dataUrl);
  expect(attachment).toMatchObject({
    id: "synthetic-pdf",
    mimeType: "application/pdf",
    fileName: "brief.pdf",
    sizeBytes: 9,
  });
  const result = card(attachment);
  expect(result.container.textContent).toContain("brief.pdf");
  expect(result.download, "restored PDF Download must remain available").not.toBeNull();
  expect(result.open, "restored PDF Open must remain available").not.toBeNull();
  const href = result.download!.getAttribute("href")!;
  expect(href).toMatch(/^blob:/);
  const blob = created.get(href);
  expect(blob).toBeDefined();
  expect(
    createHash("sha256")
      .update(new Uint8Array(await blob!.arrayBuffer()))
      .digest("hex"),
  ).toBe("e5c62df5dab5c87b6a015ef3d43597074d1eec433b15f51aec63b8582d0e4ab4");
  result.open!.click();
  expect(result.onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "attachment", src: href, title: "brief.pdf" }),
  );
  releaseChatAttachmentPayloads([attachment]);
  expect(revoked.filter((value) => value === href)).toHaveLength(1);
});
it("reuses a selected document preview until its owner releases it", () => {
  const attachment = selected();
  const first = card(attachment);
  const second = card(attachment);
  expect(first.download?.getAttribute("href")).toBe(second.download?.getAttribute("href"));
  expect(first.open).not.toBeNull();
  expect(second.open).not.toBeNull();
  expect(created.size).toBe(1);
  expect(revoked).toEqual([]);
  releaseChatAttachmentPayloads([attachment]);
  expect(revoked).toEqual([...created.keys()]);
});
it("does not allocate a preview for an outbox read whose recovery owner changed", async () => {
  const host = hostFor();
  const item = await persisted(host);
  const started = createDeferred();
  const resume = createDeferred();
  const read = payloadStore.readOutboxPayload;
  vi.spyOn(payloadStore, "readOutboxPayload").mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    started.resolve();
    await resume.promise;
    return result;
  });
  const count = created.size;
  const pending = prepareOutboxPayload(host, item, "handoff");
  await started.promise;
  vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
  resume.resolve();
  expect(await pending).toEqual({ status: "failed", reason: "unavailable" });
  expect(created.size).toBe(count);
});

it("keeps restored and independently cloned preview ownership separate", async () => {
  const [restored] = await hydrateDurableComposerAttachments([
    {
      blob: new browserBlob(["%PDF-1.4\n"]),
      mimeType: "application/pdf",
      fileName: "brief.pdf",
      sizeBytes: 9,
    },
  ]);
  if (!restored) {
    throw new Error("Missing restored draft");
  }
  owned.push(restored);
  expect(created.size).toBe(0);
  expect(getChatAttachmentDataUrl(restored)).toBe(dataUrl);
  const [clone] = cloneChatAttachmentsForIndependentOwner([restored]);
  if (!clone) {
    throw new Error("Missing independent attachment");
  }
  owned.push(clone);
  expect(clone.id).not.toBe(restored.id);
  const first = getChatAttachmentPreviewUrl(restored);
  const second = getChatAttachmentPreviewUrl(clone);
  expect(first).toMatch(/^blob:/);
  expect(second).toMatch(/^blob:/);
  expect(second).not.toBe(first);
  expect(getChatAttachmentPreviewUrl(restored)).toBe(first);
  expect(created.size).toBe(2);
  releaseChatAttachmentPayloads([restored]);
  expect(revoked).toEqual([first]);
  expect(getChatAttachmentPreviewUrl(clone)).toBe(second);
  releaseChatAttachmentPayloads([clone]);
  expect(revoked).toEqual([first, second]);
});

it("releases a replaced selected preview without disturbing the replacement", () => {
  const first = selected();
  const previous = getChatAttachmentPreviewUrl(first);
  const replacement = selected();
  expect(revoked).toEqual([previous]);
  const current = getChatAttachmentPreviewUrl(replacement);
  expect(current).not.toBe(previous);
  expect(created.size).toBe(2);
  releaseChatAttachmentPayloads([replacement]);
  expect(revoked).toEqual([previous, current]);
});

it("retains inline previews when object URLs are unavailable", () => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: undefined });
  const attachment = selected();
  expect(getChatAttachmentPreviewUrl(attachment)).toBe(dataUrl);
  expect(created.size).toBe(0);
  releaseChatAttachmentPayloads([attachment]);
  expect(revoked).toEqual([]);
});
