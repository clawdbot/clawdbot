import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI route readiness" });

suite.define(() => {
  it.each([
    { name: "root", basePath: "" },
    { name: "encoded mount", basePath: "/nested/$&;=()+,![]{}'`/%25PATH%25" },
  ])("navigates exact session keys at the $name", async ({ basePath }) => {
    await suite.withPage({ viewport: { width: 1200, height: 800 } }, async ({ page }) => {
      const initialSessionKey = "agent:runner:route:initial";
      await installMockGateway(page, { basePath, sessionKey: initialSessionKey });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, initialSessionKey));
      const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      await expect
        .poll(() => visiblePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey))
        .toBe(initialSessionKey);

      const mountUrl = new URL(suite.server.baseUrl);
      mountUrl.pathname = basePath || "/";
      const encodedBase = basePath ? mountUrl.pathname : "";
      for (const [rest, suffix] of [
        ["a/b", "a%2Fb"],
        ["a:b", "a/b"],
        ["%2F%25%3F%23", "%252F%2525%253F%2523"],
        ["a?b#c", "a%3Fb%23c"],
      ]) {
        const sessionKey = `agent:runner:route:${rest}`;
        await navigateToControlUiSession(page, sessionKey);
        expect(new URL(page.url()).pathname).toBe(`${encodedBase}/chat/runner/route/${suffix}`);
        expect(await visiblePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey)).toBe(
          sessionKey,
        );
      }
    });
  });
});
