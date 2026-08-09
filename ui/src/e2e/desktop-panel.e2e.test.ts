import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "cloud worker desktop panel",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

async function openPalette(page: import("playwright").Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
  });
  await page.getByRole("combobox", { name: "Search chats and commands…" }).waitFor();
}

suite.define(() => {
  it("hides the desktop command without the method or operator.admin", async () => {
    for (const scenario of [
      { featureMethods: ["environments.list"] },
      {
        featureMethods: ["environments.list", "worker.desktop.observe"],
        operatorScopes: ["operator.read"],
      },
    ]) {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        await installMockGateway(page, scenario);
        await page.goto(`${suite.server.baseUrl}chat`);
        await openPalette(page);
        expect(await page.getByRole("option", { name: "Desktop", exact: true }).count()).toBe(0);
      });
    }
  });

  it("lists a desktop worker and requests view then control observer leases", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["environments.list", "worker.desktop.observe"],
        methodResponses: {
          "environments.list": {
            environments: [
              {
                id: "worker-desktop-1",
                type: "worker",
                status: "available",
                worker: {
                  providerId: "crabbox",
                  state: "attached",
                  ageMs: 1_000,
                  attachedSessionIds: ["agent:main:desktop"],
                  tunnelStatus: "connected",
                  desktop: true,
                },
              },
            ],
          },
          "worker.desktop.observe": {
            cases: [
              {
                match: { environmentId: "worker-desktop-1", control: false },
                response: {
                  transport: "rfb",
                  wsPath: "/worker-desktop/observe?token=view",
                  expiresAtMs: 60_000,
                  control: false,
                },
              },
              {
                match: { environmentId: "worker-desktop-1", control: true },
                response: {
                  transport: "rfb",
                  wsPath: "/worker-desktop/observe?token=control",
                  expiresAtMs: 60_000,
                  control: true,
                },
              },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await openPalette(page);
      await page.getByRole("option", { name: "Desktop", exact: true }).click();

      const panel = page.locator("openclaw-desktop-panel");
      await panel.locator("section[aria-label='Desktop']").waitFor();
      await gateway.waitForRequest("environments.list");
      await panel.getByText("worker-desktop-1", { exact: true }).waitFor();
      await panel.getByText("agent:main:desktop", { exact: true }).waitFor();
      await panel.evaluate((element) => {
        (
          element as HTMLElement & {
            desktopClientFactory: () => {
              connect(options: { onConnect?: () => void }): Promise<{ disconnect(): void }>;
            };
          }
        ).desktopClientFactory = () => ({
          async connect(options) {
            queueMicrotask(() => options.onConnect?.());
            return { disconnect() {} };
          },
        });
      });

      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      const viewRequest = await gateway.waitForRequest("worker.desktop.observe");
      expect(viewRequest.params).toEqual({ environmentId: "worker-desktop-1", control: false });

      await panel.getByRole("button", { name: "Take control", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("worker.desktop.observe")).length)
        .toBe(2);
      const observeRequests = await gateway.getRequests("worker.desktop.observe");
      expect(observeRequests[1]?.params).toEqual({
        environmentId: "worker-desktop-1",
        control: true,
      });
      await panel.getByText("Controlling · view-only for others", { exact: true }).waitFor();
    });
  });
});
