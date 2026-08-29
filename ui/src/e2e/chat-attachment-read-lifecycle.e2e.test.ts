import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
} from "../lib/chat/outbox-store.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedState } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat attachment read lifecycle",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

type DeferredAttachmentProof = {
  aborts: number;
  finish: (() => void) | undefined;
};

async function installDeferredAttachmentReader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proof = { aborts: 0, finish: undefined as (() => void) | undefined };
    (globalThis as unknown as { attachmentReadProof: typeof proof }).attachmentReadProof = proof;
    // Keep the native methods before overriding them so deferred completion and
    // cancellation cannot recursively call their own test hooks.
    const readAsDataURL = Reflect.get(
      FileReader.prototype,
      "readAsDataURL",
    ) as FileReader["readAsDataURL"];
    const abort = Reflect.get(FileReader.prototype, "abort") as FileReader["abort"];
    FileReader.prototype.readAsDataURL = function (blob: Blob) {
      proof.finish = () => readAsDataURL.call(this, blob);
    };
    FileReader.prototype.abort = function () {
      proof.aborts += 1;
      return abort.call(this);
    };
  });
}

async function pastePng(composer: Locator): Promise<void> {
  await composer.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  }, ONE_PIXEL_PNG_B64);
}

async function waitForCommittedAttachmentDraft(
  page: Page,
  sessionKey: string,
  text: string,
): Promise<void> {
  const gatewayUrl = await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: { context: { gateway: { connection: { gatewayUrl: string } } } };
    };
    return app.runtime?.context.gateway.connection.gatewayUrl ?? null;
  });
  if (!gatewayUrl) {
    throw new Error("OpenClaw application Gateway URL is unavailable");
  }
  const storedScope = resolveStoredChatOutboxScope({ settings: { gatewayUrl } }, sessionKey);
  await waitForCommittedState(
    page,
    async (expected) => {
      const { gatewayOwner, recoveryScope, scopeKey, draftText, attachmentCount } = expected;
      if (
        typeof gatewayOwner !== "string" ||
        typeof recoveryScope !== "string" ||
        typeof scopeKey !== "string" ||
        typeof draftText !== "string" ||
        typeof attachmentCount !== "number"
      ) {
        return false;
      }
      try {
        const storeUrl = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => /\/composer-draft-store\.runtime-[^/]+\.js$/u.test(name));
        if (!storeUrl) {
          return false;
        }
        const draftStore = (await import(
          /* @vite-ignore */ storeUrl
        )) as typeof import("../lib/chat/composer-draft-store.runtime.ts");
        const result = await draftStore.readDurableComposerDraft({
          gatewayOwner,
          recoveryScope,
          scopeKey,
        });
        return (
          result.status === "found" &&
          result.draft.text === draftText &&
          result.draft.attachments.length === attachmentCount
        );
      } catch {
        return false;
      }
    },
    {
      gatewayOwner: storageTargetForGateway(gatewayUrl).gatewayOwner,
      recoveryScope: "e2e-recovery-scope",
      scopeKey: storedChatOutboxScopeKey(storedScope),
      draftText: text,
      attachmentCount: 1,
    },
  );
}

suite.define(() => {
  it("restores an attachment staged offline after reload and reconnect", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        const sessionKey = "global";
        const text = "offline attachment draft";
        const contents = "offline attachment contents";
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();

        await gateway.setOnline(false);
        await page.locator('.agent-chat__composer-underlaps[data-tone="warn"]').waitFor();
        await composer.fill(text);
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "offline.txt",
          mimeType: "text/plain",
          buffer: Buffer.from(contents),
        });
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(1);
        await waitForCommittedAttachmentDraft(page, sessionKey, text);

        await page.reload();
        await gateway.setOnline(true);
        await expect.poll(() => composer.inputValue()).toBe(text);
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(1);
        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({ path: path.join(artifactDir, "offline-draft-restored.png") });
        }
        await composer.press("Enter");

        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({
          attachments: [
            {
              content: Buffer.from(contents).toString("base64"),
              fileName: "offline.txt",
              mimeType: "text/plain",
            },
          ],
          message: text,
        });
      },
    );
  });

  it("restores isolated session drafts across fresh pages and retires sent or removed attachments", async () => {
    const firstSession = "agent:main:restart-session-a";
    const secondSession = "agent:main:restart-session-b";
    const sessionsList = {
      count: 2,
      defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
      path: "",
      sessions: [
        { key: firstSession, kind: "direct", updatedAt: 2 },
        { key: secondSession, kind: "direct", updatedAt: 1 },
      ],
      ts: Date.now(),
    };
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const activeComposer = (page: Page) =>
      page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox textarea',
      );
    const activeAttachments = (page: Page) =>
      page.locator('openclaw-chat-pane[aria-hidden="false"] .chat-attachment-thumb');
    try {
      const firstPage = await context.newPage();
      await installMockGateway(firstPage, {
        methodResponses: { "sessions.list": sessionsList },
        sessionKey: firstSession,
      });
      await firstPage.goto(controlUiSessionUrl(suite.server.baseUrl, firstSession));
      await activeComposer(firstPage).fill("restart draft A with image");
      await pastePng(activeComposer(firstPage));
      await expect.poll(() => activeAttachments(firstPage).count()).toBe(1);
      await waitForCommittedAttachmentDraft(firstPage, firstSession, "restart draft A with image");

      await navigateToControlUiSession(firstPage, secondSession);
      await activeComposer(firstPage).fill("restart draft B with removable file");
      await firstPage
        .locator('openclaw-chat-pane[aria-hidden="false"] .agent-chat__file-input')
        .setInputFiles({
          name: "remove-me.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("remove this attachment"),
        });
      await expect.poll(() => activeAttachments(firstPage).count()).toBe(1);
      await waitForCommittedAttachmentDraft(
        firstPage,
        secondSession,
        "restart draft B with removable file",
      );
      await firstPage.close();

      const restoredPage = await context.newPage();
      const restoredGateway = await installMockGateway(restoredPage, {
        methodResponses: { "sessions.list": sessionsList },
        sessionKey: firstSession,
      });
      await restoredPage.goto(controlUiSessionUrl(suite.server.baseUrl, firstSession));
      await expect
        .poll(() => activeComposer(restoredPage).inputValue())
        .toBe("restart draft A with image");
      await activeAttachments(restoredPage).first().waitFor();
      expect(await activeAttachments(restoredPage).count()).toBe(1);
      if (artifactDir) {
        await restoredPage.screenshot({
          path: path.join(artifactDir, "existing-session-restart-draft-restored.png"),
        });
      }

      await navigateToControlUiSession(restoredPage, secondSession);
      await expect
        .poll(() => activeComposer(restoredPage).inputValue())
        .toBe("restart draft B with removable file");
      await activeAttachments(restoredPage).first().waitFor();
      expect(await activeAttachments(restoredPage).count()).toBe(1);
      await restoredPage
        .locator('openclaw-chat-pane[aria-hidden="false"] .chat-attachment-remove')
        .click();
      await expect.poll(() => activeAttachments(restoredPage).count()).toBe(0);

      await navigateToControlUiSession(restoredPage, firstSession);
      await activeComposer(restoredPage).press("Enter");
      const send = await restoredGateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({
        sessionKey: firstSession,
        message: "restart draft A with image",
        attachments: [{ content: ONE_PIXEL_PNG_B64, fileName: "pixel.png", mimeType: "image/png" }],
      });
      await expect.poll(() => activeComposer(restoredPage).inputValue()).toBe("");
      await expect.poll(() => activeAttachments(restoredPage).count()).toBe(0);
      await restoredPage.close();

      const clearedPage = await context.newPage();
      await installMockGateway(clearedPage, {
        methodResponses: { "sessions.list": sessionsList },
        sessionKey: firstSession,
      });
      await clearedPage.goto(controlUiSessionUrl(suite.server.baseUrl, firstSession));
      await expect.poll(() => activeComposer(clearedPage).inputValue()).toBe("");
      await expect.poll(() => activeAttachments(clearedPage).count()).toBe(0);
      await navigateToControlUiSession(clearedPage, secondSession);
      await expect
        .poll(() => activeComposer(clearedPage).inputValue())
        .toBe("restart draft B with removable file");
      await expect.poll(() => activeAttachments(clearedPage).count()).toBe(0);
      if (artifactDir) {
        await clearedPage.screenshot({
          path: path.join(artifactDir, "existing-session-restart-drafts-cleaned.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("rejects a combined attachment frame before the Gateway connection is lost", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          attachmentMaxBytes: 256,
          maxPayload: 700,
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Send both files");
        await page.locator(".agent-chat__file-input").setInputFiles([
          { name: "first.txt", mimeType: "text/plain", buffer: Buffer.alloc(200, 0x61) },
          { name: "second.txt", mimeType: "text/plain", buffer: Buffer.alloc(200, 0x62) },
        ]);
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(2);

        await composer.press("Enter");

        const alert = page
          .getByRole("alert")
          .filter({ hasText: "Remove one or more attachments and retry" });
        const outcome = await Promise.race([
          alert.waitFor().then(() => "rejected" as const),
          gateway.waitForRequest("chat.send").then(() => "sent" as const),
        ]);
        expect(outcome).toBe("rejected");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(2);
        await expect.poll(() => composer.inputValue()).toBe("Send both files");

        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({ path: path.join(artifactDir, "attachment-frame-rejected.png") });
        }

        await page.locator(".chat-attachment-remove").first().click();
        await composer.press("Enter");
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({
          attachments: [{ fileName: "second.txt", mimeType: "text/plain" }],
          message: "Send both files",
        });
      },
    );
  });

  it("waits for a pasted image before sending its complete gateway payload", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installDeferredAttachmentReader(page);
        const gateway = await installMockGateway(page);

        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const send = page.getByRole("button", { name: "Send message" });
        await composer.fill("Include the image that is still loading");
        await pastePng(composer);

        await expect.poll(() => send.isDisabled()).toBe(true);
        await composer.press("Enter");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await page.evaluate(() => {
          const proof = (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
            .attachmentReadProof;
          if (!proof.finish) {
            throw new Error("Pasted image read was not started");
          }
          proof.finish();
        });
        await page.getByRole("img", { name: "pixel.png" }).waitFor();
        await expect.poll(() => send.isEnabled()).toBe(true);
        await send.click();

        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({
          attachments: [
            { content: ONE_PIXEL_PNG_B64, fileName: "pixel.png", mimeType: "image/png" },
          ],
          message: "Include the image that is still loading",
        });
      },
    );
  });

  it("keeps a session's pending image isolated while another session is active", async () => {
    const firstSession = "agent:main:attachment-session-a";
    const secondSession = "agent:main:attachment-session-b";
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installDeferredAttachmentReader(page);
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.list": {
              count: 2,
              defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
              path: "",
              sessions: [
                { key: firstSession, kind: "direct", updatedAt: 2 },
                { key: secondSession, kind: "direct", updatedAt: 1 },
              ],
              ts: Date.now(),
            },
          },
          sessionKey: firstSession,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstSession));
        const activeComposer = () =>
          page.locator(
            'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox textarea',
          );
        await activeComposer().fill("Private session A attachment");
        await pastePng(activeComposer());
        await expect
          .poll(() => page.getByRole("button", { name: "Send message" }).isDisabled())
          .toBe(true);

        await navigateToControlUiSession(page, secondSession);

        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
                  .attachmentReadProof.aborts,
            ),
          )
          .toBe(0);
        await expect
          .poll(() =>
            page.locator('openclaw-chat-pane[aria-hidden="false"] .chat-attachment-thumb').count(),
          )
          .toBe(0);

        await activeComposer().fill("Safe session B message");
        await activeComposer().press("Enter");
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({
          message: "Safe session B message",
          sessionKey: secondSession,
        });
        expect((request.params as { attachments?: unknown }).attachments).toBeUndefined();

        await navigateToControlUiSession(page, firstSession);
        await page.evaluate(() => {
          const proof = (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
            .attachmentReadProof;
          if (!proof.finish) {
            throw new Error("Pasted image read was not retained");
          }
          proof.finish();
        });
        await page
          .locator('openclaw-chat-pane[aria-hidden="false"]')
          .getByRole("img", { name: "pixel.png" })
          .waitFor();
      },
    );
  });
});
