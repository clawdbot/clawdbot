import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI shared composer editor contract" });

const COMPOSERS = [
  {
    name: "active chat",
    path: "chat/main",
    input: ".agent-chat__input--chat textarea",
    shell: ".agent-chat__input--chat",
    submitMethod: "chat.send",
  },
  {
    name: "new session",
    path: "new",
    input: ".new-session-page__message",
    shell: ".new-session-page__composer .agent-chat__input",
    submitMethod: "sessions.create",
  },
] as const;

suite.define(() => {
  it.each(COMPOSERS)("keeps the common editor contract in $name", async (target) => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        allowedSessionVisibilities: ["shared", "draft"],
        hasMultipleSessionSharingIdentities: true,
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
      });
      await page.goto(`${suite.server.baseUrl}${target.path}`);

      const shell = page.locator(target.shell);
      const textarea = page.locator(target.input);
      await textarea.waitFor({ state: "visible" });

      await textarea.fill("مرحبا بالعالم");
      expect(await textarea.getAttribute("dir")).toBe("rtl");
      expect(await textarea.getAttribute("aria-keyshortcuts")).toBe("Enter");

      await textarea.dispatchEvent("compositionstart", { data: "م" });
      await textarea.press("Enter");
      expect(await gateway.getRequests(target.submitMethod)).toHaveLength(0);
      await textarea.dispatchEvent("compositionend", { data: "م" });

      await textarea.fill("/");
      await page.locator(".slash-menu").waitFor({ state: "visible" });
      await shell.getByRole("button", { name: "Add attachment" }).click();
      await shell.locator("wa-dropdown.agent-chat__capability-menu").waitFor({ state: "visible" });
      await expect.poll(() => page.locator(".slash-menu").isVisible()).toBe(false);
      await page.keyboard.press("Escape");

      await textarea.blur();
      await shell.dispatchEvent("click");
      await expect
        .poll(() => textarea.evaluate((element) => document.activeElement === element))
        .toBe(true);
    });
  });
});
