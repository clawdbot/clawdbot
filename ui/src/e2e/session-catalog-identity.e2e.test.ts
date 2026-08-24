import { expect, it } from "vitest";
import { CATALOG_SESSION_CONTINUED_EVENT } from "../lib/sessions/catalog-key.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

function catalogResponse(
  sessions: Array<{
    threadId: string;
    name: string;
    cwd: string;
    sessionKey?: string;
  }>,
) {
  return {
    catalogs: [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: sessions.map((session) => ({
              ...session,
              status: "idle",
              archived: false,
              canContinue: true,
              canArchive: true,
            })),
          },
        ],
      },
    ],
  };
}

suite.define(() => {
  it("preserves a focused catalog row when project groups reorder", async () => {
    const context = await suite.newBrowserContext({});
    const page = await context.newPage();
    const first = { threadId: "thread-project-a", name: "Project A", cwd: "/work/project-a" };
    const second = { threadId: "thread-project-b", name: "Project B", cwd: "/work/project-b" };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
        "sessions.catalog.list": catalogResponse([first, second]),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const catalog = page.locator('[data-session-section="catalog:codex"]');
      await catalog.waitFor({ state: "visible" });
      const toggle = catalog.locator(".sidebar-session-group-toggle");
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }
      const row = catalog.locator('[data-session-key$=":thread-project-a"]');
      const menu = row.locator("[data-catalog-session-menu]");
      await menu.focus();
      await row.evaluate((element) => element.setAttribute("data-identity-probe", "kept"));

      const requestCount = (await gateway.getRequests("sessions.catalog.list")).length;
      await gateway.setMethodResponse("sessions.catalog.list", catalogResponse([second, first]));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBeGreaterThan(requestCount);
      await expect
        .poll(() =>
          catalog
            .locator("[data-session-catalog-project]")
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-session-catalog-project")),
            ),
        )
        .toEqual(["/work/project-b", "/work/project-a"]);
      expect(await row.getAttribute("data-identity-probe")).toBe("kept");
      await expect
        .poll(() => menu.evaluate((element) => element === document.activeElement))
        .toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["Escape", "Tab"])(
    "returns focus to the adopted row when its open catalog menu closes with %s",
    async (dismissKey) => {
      const context = await suite.newBrowserContext({});
      const page = await context.newPage();
      const sessionKey = "agent:main:adopted-open-menu";
      const catalogSession = {
        threadId: "thread-adopted-open-menu",
        name: "Adopt while its menu is open",
        cwd: "/work/openclaw",
      };
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
        methodResponses: {
          "sessions.list": chatSessionListResponse([
            { key: sessionKey, kind: "direct", label: catalogSession.name, updatedAt: 1 },
          ]),
          "sessions.catalog.list": catalogResponse([catalogSession]),
        },
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const catalog = page.locator('[data-session-section="catalog:codex"]');
        await catalog.waitFor({ state: "visible" });
        const toggle = catalog.locator(".sidebar-session-group-toggle");
        if ((await toggle.getAttribute("aria-expanded")) === "false") {
          await toggle.click();
        }
        const catalogRow = catalog.locator('[data-session-key$=":thread-adopted-open-menu"]');
        await catalogRow.hover();
        await catalogRow.locator("[data-catalog-session-menu]").click();
        const popup = page.locator("openclaw-catalog-session-menu");
        await popup.waitFor({ state: "visible" });
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.localName))
          .toBe("wa-dropdown-item");

        await page.evaluate(
          ({ eventName, adoptedSessionKey }) => {
            document.dispatchEvent(
              new CustomEvent(eventName, {
                detail: {
                  agentId: "main",
                  catalogId: "codex",
                  hostId: "gateway:local",
                  sessionKey: adoptedSessionKey,
                  threadId: "thread-adopted-open-menu",
                },
              }),
            );
          },
          { eventName: CATALOG_SESSION_CONTINUED_EVENT, adoptedSessionKey: sessionKey },
        );
        const adoptedMenu = catalog.locator(
          `[data-session-key="${sessionKey}"] [data-session-menu]`,
        );
        await adoptedMenu.waitFor({ state: "attached" });
        await expect.poll(() => adoptedMenu.getAttribute("aria-expanded")).toBe("true");
        await popup.getByRole("menuitem").first().press(dismissKey);
        await popup.waitFor({ state: "detached" });
        if (dismissKey === "Escape") {
          await expect
            .poll(() => adoptedMenu.evaluate((element) => element === document.activeElement))
            .toBe(true);
        } else {
          await expect
            .poll(() =>
              page.evaluate(() => {
                const active = document.activeElement;
                return Boolean(active?.isConnected && active !== document.body);
              }),
            )
            .toBe(true);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
