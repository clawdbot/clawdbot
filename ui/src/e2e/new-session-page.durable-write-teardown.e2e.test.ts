import { Buffer } from "node:buffer";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  selectNewSessionMode,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const DURABLE_ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

type DurableWriteTeardownGlobal = typeof globalThis & {
  durableWriteTeardown: {
    blockNextRead: boolean;
    blockedRead: boolean;
    completedReads: number;
    teardownActive: boolean;
    teardownStartedWrite: boolean;
  };
};

async function rawDraftMatches(
  page: Page,
  expectedText: string,
  expectedAttachmentCount: number,
): Promise<boolean> {
  return page.evaluate(
    async ({ attachmentCount, text }) => {
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === "openclaw-control-ui")) {
        return false;
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("openclaw-control-ui");
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener(
          "error",
          () => reject(request.error ?? new Error("IndexedDB open failed")),
          { once: true },
        );
      });
      try {
        const transaction = database.transaction("composerDrafts", "readonly");
        const records = await new Promise<unknown[]>((resolve, reject) => {
          const request = transaction.objectStore("composerDrafts").getAll();
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener(
            "error",
            () => reject(request.error ?? new Error("IndexedDB read failed")),
            { once: true },
          );
        });
        return records.some((value) => {
          if (!value || typeof value !== "object") {
            return false;
          }
          const record = value as { attachments?: unknown; text?: unknown };
          return (
            record.text === text &&
            Array.isArray(record.attachments) &&
            record.attachments.length === attachmentCount
          );
        });
      } finally {
        database.close();
      }
    },
    { attachmentCount: expectedAttachmentCount, text: expectedText },
  );
}

suite.define(() => {
  it("coalesces a burst of near-limit attachment draft mutations into one write", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        const originalTransaction = Object.getOwnPropertyDescriptor(
          IDBDatabase.prototype,
          "transaction",
        )?.value as IDBDatabase["transaction"];
        const state = globalThis as typeof globalThis & {
          composerDraftReadwriteTransactions: number;
        };
        state.composerDraftReadwriteTransactions = 0;
        IDBDatabase.prototype.transaction = function (
          this: IDBDatabase,
          ...args: Parameters<IDBDatabase["transaction"]>
        ) {
          const [storeNames, mode] = args;
          const names = typeof storeNames === "string" ? [storeNames] : Array.from(storeNames);
          if (mode === "readwrite" && names.includes("composerDrafts")) {
            state.composerDraftReadwriteTransactions += 1;
          }
          return originalTransaction.apply(this, args);
        } as IDBDatabase["transaction"];
      });
      await installMockGateway(page, { attachmentMaxBytes: DURABLE_ATTACHMENT_CAP_BYTES });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: "near-durable-cap.txt",
        mimeType: "text/plain",
        buffer: Buffer.alloc(DURABLE_ATTACHMENT_CAP_BYTES - 64 * 1024, 0x61),
      });
      await expect.poll(() => rawDraftMatches(page, "", 1)).toBe(true);
      await page.evaluate(() => {
        (
          globalThis as typeof globalThis & { composerDraftReadwriteTransactions: number }
        ).composerDraftReadwriteTransactions = 0;
      });

      const message = page.locator(".new-session-page__message");
      await message.pressSequentially("burst", { delay: 20 });
      await expect.poll(() => rawDraftMatches(page, "burst", 1)).toBe(true);
      const transactionCount = await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { composerDraftReadwriteTransactions: number })
            .composerDraftReadwriteTransactions,
      );
      expect(transactionCount).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("starts an attachment write while an earlier text write is still pending", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    try {
      const text = "keep the attachment added during the pending text write";
      const fileName = "favicon-32.png";
      const firstPage = await context.newPage();
      await firstPage.addInitScript(() => {
        const originalTransaction = Object.getOwnPropertyDescriptor(
          IDBDatabase.prototype,
          "transaction",
        )?.value as IDBDatabase["transaction"];
        const originalGet = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "get")
          ?.value as IDBObjectStore["get"];
        const state = globalThis as DurableWriteTeardownGlobal;
        state.durableWriteTeardown = {
          blockNextRead: false,
          blockedRead: false,
          completedReads: 0,
          teardownActive: false,
          teardownStartedWrite: false,
        };
        IDBDatabase.prototype.transaction = function (
          this: IDBDatabase,
          ...args: Parameters<IDBDatabase["transaction"]>
        ) {
          const [storeNames, mode] = args;
          const names = typeof storeNames === "string" ? [storeNames] : Array.from(storeNames);
          if (
            state.durableWriteTeardown.teardownActive &&
            mode === "readwrite" &&
            names.includes("composerDrafts")
          ) {
            state.durableWriteTeardown.teardownStartedWrite = true;
          }
          return originalTransaction.apply(this, args);
        } as IDBDatabase["transaction"];
        IDBObjectStore.prototype.get = function (query: IDBValidKey | IDBKeyRange) {
          if (this.name !== "composerDrafts") {
            return originalGet.call(this, query);
          }
          if (state.durableWriteTeardown.blockNextRead) {
            state.durableWriteTeardown.blockNextRead = false;
            state.durableWriteTeardown.blockedRead = true;
            return new EventTarget() as IDBRequest;
          }
          const request = originalGet.call(this, query);
          request.addEventListener(
            "success",
            () => {
              state.durableWriteTeardown.completedReads += 1;
            },
            { once: true },
          );
          return request;
        };
      });
      await installMockGateway(firstPage);
      await firstPage.goto(`${suite.server.baseUrl}new`);
      await expect
        .poll(() =>
          firstPage.evaluate(
            () => (globalThis as DurableWriteTeardownGlobal).durableWriteTeardown.completedReads,
          ),
        )
        .toBeGreaterThan(0);
      await firstPage.evaluate(() => {
        (globalThis as DurableWriteTeardownGlobal).durableWriteTeardown.blockNextRead = true;
      });
      await firstPage.locator(".new-session-page__message").fill(text);
      await expect
        .poll(() =>
          firstPage.evaluate(
            () => (globalThis as DurableWriteTeardownGlobal).durableWriteTeardown.blockedRead,
          ),
        )
        .toBe(true);

      await firstPage
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));
      await firstPage.getByRole("button", { name: `Open image ${fileName}` }).waitFor();
      await firstPage.evaluate(() => {
        const state = (globalThis as DurableWriteTeardownGlobal).durableWriteTeardown;
        state.teardownActive = true;
        // The next task closes this window before the 200 ms debounce can start a write.
        globalThis.setTimeout(() => {
          state.teardownActive = false;
        }, 0);
        document.querySelector("openclaw-new-session-page")?.remove();
      });
      await expect
        .poll(() =>
          firstPage.evaluate(
            () =>
              (globalThis as DurableWriteTeardownGlobal).durableWriteTeardown.teardownStartedWrite,
          ),
        )
        .toBe(true);
      await waitForCommittedNewSessionDraft(firstPage, text, 1);
      await firstPage.close();

      const restoredPage = await context.newPage();
      await installMockGateway(restoredPage);
      await restoredPage.goto(`${suite.server.baseUrl}new`);
      await expect
        .poll(() => restoredPage.locator(".new-session-page__message").inputValue())
        .toBe(text);
      await restoredPage.getByRole("button", { name: `Open image ${fileName}` }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("isolates route drafts and retires incognito and submitted drafts", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      await installMockGateway(page, {
        methodResponses: {
          "sessions.create": { key: "agent:main:retired-draft", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      const message = page.locator(".new-session-page__message");
      await message.fill("main route draft");
      await navigateInApp(page, "new-session", "?agent=writer");
      await expect.poll(() => message.inputValue()).toBe("");
      await message.fill("writer route draft");
      await navigateInApp(page, "new-session", "?agent=main");
      await expect.poll(() => message.inputValue()).toBe("main route draft");

      await selectNewSessionMode(page, "Incognito");
      await waitForCommittedNewSessionDraft(page, null, 0);
      await page.reload();
      await expect.poll(() => message.inputValue()).toBe("");
      await navigateInApp(page, "new-session", "?agent=writer");
      await expect.poll(() => message.inputValue()).toBe("writer route draft");
      await page.getByRole("button", { name: "Start session" }).click();
      await page.waitForURL(
        (url) => url.pathname === controlUiSessionPath("agent:main:retired-draft"),
      );
      await page.close();
      const restoredPage = await context.newPage();
      await installMockGateway(restoredPage);
      await restoredPage.goto(`${suite.server.baseUrl}new?agent=writer`);
      await expect
        .poll(() => restoredPage.locator(".new-session-page__message").inputValue())
        .toBe("");
    } finally {
      await context.close();
    }
  });
});
