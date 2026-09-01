import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = captureProof
  ? createControlUiE2eArtifactDir("chat-submit-responsiveness")
  : undefined;

async function withChatPage(run: (page: Page) => Promise<void>): Promise<void> {
  const viewport = { height: 900, width: 1280 };
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(proofDir ? { recordVideo: { dir: path.join(proofDir, "video"), size: viewport } } : {}),
  });
  try {
    await run(await context.newPage());
  } finally {
    await suite.closeBrowserContext(context);
  }
}

suite.define(() => {
  it("returns to browser input before starting durable chat delivery", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("first prompt");
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "before-submit.png") });
        await page.waitForTimeout(400);
      }
      await composer.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        const order: string[] = [];
        const record = (value: string) => {
          order.push(value);
          textarea.dataset.submitTaskOrder = JSON.stringify(order);
        };
        const send = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send")
          ?.value as WebSocket["send"];
        WebSocket.prototype.send = function (data) {
          if (
            typeof data === "string" &&
            (JSON.parse(data) as { method?: string }).method === "chat.send"
          ) {
            record(`transport:${textarea.value}`);
          }
          Reflect.apply(send, this, [data]);
        };
        textarea.addEventListener(
          "keydown",
          () => {
            const channel = new MessageChannel();
            channel.port1.addEventListener(
              "message",
              () => {
                channel.port1.close();
                channel.port2.close();
                textarea.value = "second prompt";
                textarea.dispatchEvent(
                  new InputEvent("input", {
                    bubbles: true,
                    data: "second prompt",
                    inputType: "insertText",
                  }),
                );
                record("next-input-task");
              },
              { once: true },
            );
            channel.port1.start();
            channel.port2.postMessage(undefined);
          },
          { capture: true, once: true },
        );
      });

      await composer.press("Meta+Enter");
      await gateway.waitForRequest("chat.send");
      await expect
        .poll(() => composer.getAttribute("data-submit-task-order"))
        .toBe(JSON.stringify(["next-input-task", "transport:second prompt"]));
      expect(await composer.inputValue()).toBe("second prompt");
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "next-prompt-ready.png") });
        await page.waitForTimeout(700);
      }
    });
  });
});
