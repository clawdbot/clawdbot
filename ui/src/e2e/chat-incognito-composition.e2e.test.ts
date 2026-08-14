import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "chat-incognito");

const INCOGNITO_KEY = "agent:main:incognito-session";

/**
 * An incognito thread beside an ordinary one. Both stay listed: the gateway
 * serves incognito rows to the operator who created them, and this work changes
 * how the state is shown, never whether the session can be found.
 */
function incognitoSessions() {
  return chatSessionListResponse([
    {
      incognito: true,
      key: INCOGNITO_KEY,
      kind: "direct",
      label: "Draft the incident note",
      spawnedCwd: "/repo/openclaw",
      updatedAt: 2,
    },
    {
      key: "agent:main:session-b",
      kind: "direct",
      label: "Ordinary session",
      spawnedCwd: "/repo/openclaw",
      updatedAt: 1,
    },
  ]);
}

suite.define(() => {
  for (const theme of ["light", "dark"] as const) {
    it(`marks incognito at the title and the composer in ${theme} mode`, async () => {
      const context = await suite.newBrowserContext({
        colorScheme: theme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 640, width: 1120 },
      });
      const page = await context.newPage();
      const capture = async (name: string, selector: string) => {
        if (!captureUiProofEnabled) {
          return;
        }
        await mkdir(proofDir, { recursive: true });
        await page
          .locator(selector)
          .first()
          .screenshot({
            animations: "disabled",
            path: path.join(proofDir, `${name}-${theme}.png`),
          });
      };
      await page.addInitScript(
        ({ key, mode }) => {
          localStorage.setItem(key, JSON.stringify({ theme: "claw", themeMode: mode }));
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), mode: theme },
      );
      const gateway = await installMockGateway(page, {
        methodResponses: { "sessions.list": incognitoSessions() },
        sessionKey: INCOGNITO_KEY,
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const header = page.locator(".chat-pane__header").first();
        const composer = page.locator(".agent-chat__input").first();
        await header.waitFor();
        await composer.waitFor();

        // Still discoverable: the sidebar lists the thread and qualifies it.
        const sidebarRow = page.locator(`[data-session-key="${INCOGNITO_KEY}"]`).first();
        await sidebarRow.waitFor();
        expect(await sidebarRow.locator(".session-row-badge--incognito").count()).toBe(1);
        await capture("sidebar-row", `[data-session-key="${INCOGNITO_KEY}"]`);

        // The qualifier belongs to the session name, not to the project or the
        // header edge, and it is the same glyph the sidebar row uses.
        const placement = await header.evaluate((root) => {
          const badge = root.querySelector<HTMLElement>(".chat-pane__incognito");
          if (!badge) {
            throw new Error("missing header incognito qualifier");
          }
          return {
            insideIdentity: Boolean(badge.closest(".chat-pane__session-identity")),
            label: badge.getAttribute("aria-label"),
            left: badge.getBoundingClientRect().left,
            projectRight:
              root.querySelector(".chat-pane__workspace-chip")?.getBoundingClientRect().right ?? 0,
            titleLeft:
              root.querySelector(".chat-pane__session-title")?.getBoundingClientRect().left ?? 0,
          };
        });
        expect(placement.insideIdentity).toBe(true);
        expect(placement.label).toBe("Incognito session");
        expect(placement.left).toBeGreaterThan(placement.projectRight);
        expect(placement.left).toBeLessThan(placement.titleLeft);
        await capture("header", ".chat-pane__header");

        // The composer carries the explanation and wears the dashed boundary.
        const note = composer.locator(".agent-chat__incognito-note");
        expect((await note.locator(".agent-chat__incognito-label").textContent())?.trim()).toBe(
          "Incognito session",
        );
        expect((await note.locator(".agent-chat__incognito-detail").textContent())?.trim()).toBe(
          "Stays in memory and disappears when the Gateway restarts",
        );
        expect(await composer.evaluate((node) => getComputedStyle(node).borderStyle)).toBe(
          "dashed",
        );
        await capture("composer-rest", ".agent-chat__composer-shell");

        // Focus is still legible, and the boundary survives it.
        await page.locator(".agent-chat__composer-combobox textarea").first().focus();
        expect(await composer.getAttribute("class")).toContain("agent-chat__input--incognito");
        expect(await composer.evaluate((node) => getComputedStyle(node).borderStyle)).toBe(
          "dashed",
        );
        await capture("composer-focus", ".agent-chat__composer-shell");
        const incognitoBorderColor = await composer.evaluate(
          (node) => getComputedStyle(node).borderColor,
        );

        // Losing the connection must not dilute the offline warning: the
        // composer keeps the warning border rather than the quieter incognito
        // one, so the urgent, recoverable state stays the loud one.
        await gateway.setOnline(false);
        await gateway.closeLatest();
        await expect
          .poll(() => composer.locator(".agent-chat__offline-hint").count())
          .toBeGreaterThan(0);
        const offlineBorderColor = await composer.evaluate(
          (node) => getComputedStyle(node).borderColor,
        );
        expect(offlineBorderColor).not.toBe(incognitoBorderColor);
        await capture("composer-offline", ".agent-chat__composer-shell");
        await gateway.setOnline(true);

        // No invented exit: incognito is fixed at creation, so the session menu
        // must not offer a transition the gateway cannot perform.
        await header.locator(".chat-header-session-menu__trigger").click();
        const menu = page.locator("wa-dropdown.chat-header-session-menu");
        await menu.locator("wa-dropdown-item").first().waitFor();
        expect((await menu.textContent())?.toLowerCase()).not.toContain("incognito");
        await page.keyboard.press("Escape");

        // Phones drop the explanation and keep the label.
        await page.setViewportSize({ height: 640, width: 420 });
        expect(await note.locator(".agent-chat__incognito-label").isVisible()).toBe(true);
        await expect
          .poll(() => note.locator(".agent-chat__incognito-detail").isVisible())
          .toBe(false);
        await capture("composer-mobile", ".agent-chat__composer-shell");

        // An ordinary session gets none of it.
        await page.setViewportSize({ height: 640, width: 1120 });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-b"));
        await expect
          .poll(() => header.locator(".chat-pane__session-title-text").textContent())
          .toBe("Ordinary session");
        expect(await header.locator(".chat-pane__incognito").count()).toBe(0);
        expect(await composer.getAttribute("class")).not.toContain("agent-chat__input--incognito");
      } finally {
        await suite.closeBrowserContext(context);
      }
    });
  }
});
