import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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

suite.define(() => {
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
        await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
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
          .locator(
            'openclaw-chat-pane[aria-hidden="false"] .chat-attachment-thumb img[alt="Attachment preview"]',
          )
          .waitFor();
      },
    );
  });
});
