import type { BrowserContext, Page } from "playwright";
import { expect } from "vitest";
import type { ChatQueueItem } from "../lib/chat/chat-types.ts";
import { readOutboxPayloadAttachments } from "./chat-flow.test-support.ts";

export const outboxPayloadFile = {
  name: "mock-original.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Exact synthetic outbox bytes\n".repeat(1000)),
};
export const outboxPayloadHistory = [
  { role: "assistant", content: "Mock Gateway: payload lifecycle proof." },
];
export const outboxPaneFor = (page: Page) =>
  page.locator('openclaw-chat-pane[aria-hidden="false"]');
export const outboxComposerFor = (page: Page) =>
  outboxPaneFor(page).locator(".agent-chat__composer-combobox textarea");

export async function readOutboxQueue(page: Page): Promise<ChatQueueItem[]> {
  return page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith("openclaw.control.chatComposer.v4:"))
      .flatMap((key) => {
        const store = JSON.parse(sessionStorage.getItem(key)!) as {
          sessions: Record<string, { queue?: ChatQueueItem[] }>;
        };
        return Object.values(store.sessions).flatMap((session) => session.queue ?? []);
      }),
  );
}

export async function countOutboxPayloads(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("openclaw-control-ui");
      request.onsuccess = () => resolve(request.result);
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("IndexedDB request failed")),
      );
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = database
          .transaction("outboxPayloads")
          .objectStore("outboxPayloads")
          .count();
        request.onsuccess = () => resolve(request.result);
        request.addEventListener("error", () =>
          reject(request.error ?? new Error("IndexedDB request failed")),
        );
      });
    } finally {
      database.close();
    }
  });
}

export async function readOutboxPayloadBytes(page: Page, key: string): Promise<string[] | null> {
  return (
    (await readOutboxPayloadAttachments(page, key))?.map((attachment) => attachment.base64) ?? null
  );
}

export async function stageOutboxAttachment(page: Page, message: string) {
  await outboxComposerFor(page).fill(message);
  await outboxPaneFor(page).locator(".agent-chat__file-input").setInputFiles(outboxPayloadFile);
  await expect.poll(() => outboxPaneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
}

export async function outboxChatUrl(
  context: BrowserContext,
  baseUrl: string,
  origin: "localhost" | "plain HTTP",
) {
  const url = new URL("chat", baseUrl);
  if (origin === "plain HTTP") {
    url.hostname = "plain-http.test";
    await context.route(`${url.origin}/**`, async (route) => {
      const target = new URL(route.request().url());
      target.hostname = "127.0.0.1";
      const response = await route.fetch({ url: target.href });
      await route.fulfill({ response });
    });
  }
  return url.href;
}
