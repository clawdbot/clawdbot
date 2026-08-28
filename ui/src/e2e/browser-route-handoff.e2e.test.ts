import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser route handoff E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it.each(["panel", "older card"])(
    "preserves browser routes when first opened through %s",
    async (firstOpen) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          await page.route("**/__openclaw__/assistant-media**", (route) =>
            route.fulfill({
              contentType: "image/png",
              body: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                "base64",
              ),
            }),
          );
          const hostTab = {
            targetId: "t1",
            target: "host",
            profile: "managed",
            title: "Managed tab",
            url: "https://managed.example/",
          };
          const nodeTab = {
            targetId: "t1",
            target: "node",
            node: "node-a",
            profile: "work",
            title: "Node tab",
            url: "https://work.example/",
          };
          const result = (
            browserTab: typeof hostTab | typeof nodeTab,
            id: string,
            timestamp: number,
            isError = false,
          ) => ({
            role: "toolResult",
            toolName: "browser",
            toolCallId: id,
            timestamp,
            content: isError ? "Failed" : "Opened",
            isError,
            details: { browserTab },
          });
          const routes = [hostTab, nodeTab];
          const gateway = await installMockGateway(page, {
            featureMethods: ["chat.metadata", "chat.startup", "browser.request"],
            historyMessages: [
              { role: "user", content: "Open the pages", timestamp: 1_000 },
              result(hostTab, "host-open", 2_000),
              result(nodeTab, "node-open", 3_000),
              result(hostTab, "failed-host-open", 4_000, true),
              { role: "assistant", content: "The pages are ready.", timestamp: 5_000 },
            ],
            methodResponses: {
              "browser.request": {
                cases: [
                  ...routes.flatMap((tab) => {
                    const address = {
                      target: tab.target,
                      ...("node" in tab ? { node: tab.node } : {}),
                      query: { profile: tab.profile },
                    };
                    return [
                      {
                        match: { ...address, path: "/tabs" },
                        response: { running: true, tabs: [{ ...tab, tabId: "t1" }] },
                      },
                      { match: { ...address, path: "/tabs/focus" }, response: { ok: true } },
                      {
                        match: { ...address, path: "/screenshot" },
                        response: {
                          path: `/proof/${tab.profile}.png`,
                          targetId: "t1",
                          url: tab.url,
                        },
                      },
                      {
                        match: { ...address, path: "/act" },
                        response: {
                          result: { cssWidth: 100, cssHeight: 100, title: tab.title, url: tab.url },
                        },
                      },
                    ];
                  }),
                  {
                    match: { path: "/tabs" },
                    response: {
                      running: true,
                      tabs: [
                        {
                          tabId: "t1",
                          targetId: "default",
                          title: "Default Chrome",
                          url: "https://default.example/",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("The pages are ready.", { exact: true }).waitFor();
          expect(await page.locator("section.bp").count()).toBe(0);
          expect(
            (await gateway.getRequests("browser.request")).some(
              (request) => asNullableRecord(request.params)?.path === "/tabs/focus",
            ),
          ).toBe(false);
          const panel = page.locator("section.bp");
          if (firstOpen === "panel") {
            await openChatSidePanelType(page, "Browser");
            await panel.locator('.bp-shot[alt="Node tab"]').waitFor();
            expect(await panel.locator(".bp-profile").textContent()).toBe("work");
            await expect
              .poll(async () =>
                (await gateway.getRequests("browser.request")).map((request) => request.params),
              )
              .toContainEqual({
                method: "POST",
                path: "/tabs/focus",
                target: "node",
                node: "node-a",
                query: { profile: "work" },
                body: { targetId: "t1" },
              });
          }
          const hostCard = page
            .locator("openclaw-browser-tab-card")
            .filter({ hasText: "Managed tab" });
          await hostCard.getByRole("button", { name: "Open", exact: true }).click();
          await panel.locator('.bp-shot[alt="Managed tab"]').waitFor();
          expect(await panel.locator(".bp-profile").textContent()).toBe("managed");
          await expect
            .poll(async () =>
              (await gateway.getRequests("browser.request")).map((request) => request.params),
            )
            .toContainEqual({
              method: "POST",
              path: "/screenshot",
              target: "host",
              query: { profile: "managed" },
              body: { targetId: "t1", type: "png" },
            });
          expect(await gateway.getRequests("config.set")).toEqual([]);
          expect(await gateway.getRequests("config.patch")).toEqual([]);
        },
      );
    },
  );
});
