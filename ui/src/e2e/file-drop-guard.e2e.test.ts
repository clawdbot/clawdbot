// Control UI tests cover browser-level file-drop routing against a mocked Gateway.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI file-drop guard",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}`,
});

suite.define(() => {
  it("rejects a stray file drop while preserving attachment inputs", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page);

        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible", timeout: 10_000 });
        await composer.fill("draft survives stray drop");

        const stray = await page.locator("openclaw-app-shell").evaluate((element) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(["stray"], "stray-proof.txt", { type: "text/plain" }));
          const beforeUrl = location.href;
          const beforeDraft = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox textarea",
          )?.value;
          const dragOver = new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          });
          const drop = new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          });
          element.dispatchEvent(dragOver);
          element.dispatchEvent(drop);
          return {
            draftUnchanged:
              document.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox textarea")
                ?.value === beforeDraft,
            dragOverPrevented: dragOver.defaultPrevented,
            dropEffect: transfer.dropEffect,
            dropPrevented: drop.defaultPrevented,
            urlUnchanged: location.href === beforeUrl,
          };
        });

        expect(stray).toEqual({
          draftUnchanged: true,
          dragOverPrevented: true,
          dropEffect: "none",
          dropPrevented: true,
          urlUnchanged: true,
        });

        const accepted = await page.locator("section.card.chat").evaluate((element) => {
          const transfer = new DataTransfer();
          transfer.items.add(
            new File(["accepted drop"], "accepted-drop.txt", { type: "text/plain" }),
          );
          const dragOver = new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          });
          const drop = new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          });
          element.dispatchEvent(dragOver);
          element.dispatchEvent(drop);
          return {
            dragOverPrevented: dragOver.defaultPrevented,
            dropPrevented: drop.defaultPrevented,
          };
        });

        expect(accepted).toEqual({
          dragOverPrevented: true,
          dropPrevented: true,
        });
        await page
          .locator(".chat-attachment-file__name", { hasText: "accepted-drop.txt" })
          .first()
          .waitFor({ timeout: 10_000 });
        await expect
          .poll(() =>
            page.locator(".chat-attachment-file__name", { hasText: "stray-proof.txt" }).count(),
          )
          .toBe(0);

        const nativeInput = page.locator(".agent-chat__file-input");
        expect(await nativeInput.isEnabled()).toBe(true);
        await nativeInput.setInputFiles({
          name: "native-input.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("native input"),
        });
        await page
          .locator(".chat-attachment-file__name", { hasText: "native-input.txt" })
          .first()
          .waitFor({ timeout: 10_000 });

        console.info(
          `[file-drop-proof] ${JSON.stringify({
            accepted,
            nativeInputAccepted: true,
            path: new URL(page.url()).pathname,
            stray,
          })}`,
        );
      },
    );
  });
});
