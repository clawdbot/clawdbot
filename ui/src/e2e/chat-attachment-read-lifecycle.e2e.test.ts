import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { navigateInApp, replaceGatewayClient } from "./new-session-page.test-support.ts";

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
  it("keeps exact staged files across a same-Gateway client replacement", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(artifactDir ? { recordVideo: { dir: artifactDir } } : {}),
      },
      async ({ page }) => {
        const sessionKey = "agent:main:attachment-owner-rotation";
        const gateway = await installMockGateway(page, { sessionKey });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const files = [
          { name: "proof.txt", mimeType: "text/plain", buffer: Buffer.from("first-proof") },
          { name: "proof.txt", mimeType: "text/plain", buffer: Buffer.from("second-proof") },
        ];
        await composer.fill("Keep both exact files");
        await page.locator(".agent-chat__file-input").setInputFiles(files);
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(2);
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({ path: path.join(artifactDir, "01-staged-files.png") });
        }

        await navigateInApp(page, "new-session");
        await page.locator(".new-session-page__message").waitFor();
        const socketsBefore = await gateway.getSocketCount();
        await replaceGatewayClient(page);
        await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
        await waitForControlUiGatewayReady(page);
        await navigateInApp(page, "chat");
        await composer.waitFor();
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "02-restored-files.png") });
        }
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(2);
        await expect.poll(() => composer.inputValue()).toBe("Keep both exact files");

        await gateway.deferNext("chat.send");
        await composer.press("Enter");
        const rejectedRequest = await gateway.waitForRequest("chat.send");
        expect(rejectedRequest.params).toMatchObject({
          sessionKey,
          message: "Keep both exact files",
          attachments: [
            { content: Buffer.from("first-proof").toString("base64"), fileName: "proof.txt" },
            { content: Buffer.from("second-proof").toString("base64"), fileName: "proof.txt" },
          ],
        });
        await gateway.rejectDeferred("chat.send", { message: "Rejected for attachment proof" });
        await page
          .getByRole("alert")
          .filter({ hasText: "Rejected for attachment proof" })
          .waitFor();
        await expect.poll(() => composer.inputValue()).toBe("Keep both exact files");
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(2);
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "03-rejected-restored.png") });
        }

        await composer.press("Enter");
        await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
        const acceptedRequest = (await gateway.getRequests("chat.send"))[1]!;
        expect(acceptedRequest.params).toMatchObject({
          sessionKey,
          message: "Keep both exact files",
          attachments: [
            { content: Buffer.from("first-proof").toString("base64"), fileName: "proof.txt" },
            { content: Buffer.from("second-proof").toString("base64"), fileName: "proof.txt" },
          ],
        });
        const acceptedRunId = (acceptedRequest.params as { idempotencyKey?: unknown })
          .idempotencyKey;
        expect(typeof acceptedRunId).toBe("string");
        await gateway.emitChatFinal({
          runId: String(acceptedRunId),
          sessionKey,
          text: "Done.",
        });
        await page.getByText("Done.", { exact: true }).last().waitFor();
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
        await expect.poll(() => composer.inputValue()).toBe("");
        await page.getByRole("button", { name: "Remove queued message" }).click();
        await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(0);
        await navigateInApp(page, "new-session");
        await page.locator(".new-session-page__message").waitFor();
        await navigateInApp(page, "chat");
        await composer.waitFor();
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(2);
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "04-final-clean.png") });
        }
      },
    );
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
