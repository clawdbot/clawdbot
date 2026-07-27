import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
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

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI chat attachment read lifecycle", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("waits for a pasted image before sending its complete gateway payload", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installDeferredAttachmentReader(page);
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
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
        attachments: [{ content: ONE_PIXEL_PNG_B64, fileName: "pixel.png", mimeType: "image/png" }],
        message: "Include the image that is still loading",
      });
    } finally {
      await context.close();
    }
  });

  it("aborts a session's pending image before the pane adopts another session", async () => {
    const firstSession = "agent:main:attachment-session-a";
    const secondSession = "agent:main:attachment-session-b";
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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

    try {
      await page.goto(controlUiSessionUrl(server.baseUrl, firstSession));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Private session A attachment");
      await pastePng(composer);
      await expect
        .poll(() => page.getByRole("button", { name: "Send message" }).isDisabled())
        .toBe(true);

      await page.locator("openclaw-chat-pane").evaluate((pane, sessionKey) => {
        (pane as HTMLElement & { sessionKey: string }).sessionKey = sessionKey;
      }, secondSession);

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
                .attachmentReadProof.aborts,
          ),
        )
        .toBe(1);
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);

      await composer.fill("Safe session B message");
      await composer.press("Enter");
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        message: "Safe session B message",
        sessionKey: secondSession,
      });
      expect((request.params as { attachments?: unknown }).attachments).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});
