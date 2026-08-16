import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI pasted text field action",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const pastedText = `Quarterly launch plan\n\n${"x".repeat(1100)}`;

suite.define(() => {
  it("returns a pasted text attachment to the text field without sending", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);

        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await composer.evaluate((element, text) => {
          const clipboard = new DataTransfer();
          clipboard.setData("text/plain", text);
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: clipboard,
            }),
          );
        }, pastedText);

        const showInTextField = page.getByRole("button", {
          name: "Show in text field",
          exact: true,
        });
        await showInTextField.waitFor({ state: "visible" });
        expect((await showInTextField.textContent())?.trim()).toBe("Show in text field");

        await showInTextField.click();

        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
        await expect.poll(() => composer.inputValue()).toBe(pastedText);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
