import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "OpenCode and Pi external session catalogs",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("shows both paired-node catalogs and opens their view-only transcripts", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1440, height: 900 } });
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.catalog.list",
        "sessions.catalog.read",
      ],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "opencode",
              label: "OpenCode",
              capabilities: { continueSession: false, archive: false },
              hosts: [
                {
                  hostId: "node:devbox",
                  label: "Dev Box",
                  kind: "node",
                  connected: true,
                  nodeId: "devbox",
                  sessions: [
                    {
                      threadId: "opencode-1",
                      name: "OpenCode release review",
                      status: "stored",
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
            {
              id: "pi",
              label: "Pi",
              capabilities: { continueSession: false, archive: false },
              hosts: [
                {
                  hostId: "node:devbox",
                  label: "Dev Box",
                  kind: "node",
                  connected: true,
                  nodeId: "devbox",
                  sessions: [
                    {
                      threadId: "pi-1",
                      name: "Pi architecture notes",
                      status: "stored",
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
        "sessions.catalog.read": {
          cases: [
            {
              match: { catalogId: "opencode", threadId: "opencode-1" },
              response: {
                hostId: "node:devbox",
                threadId: "opencode-1",
                items: [{ type: "agentMessage", text: "OpenCode transcript loaded" }],
              },
            },
            {
              match: { catalogId: "pi", threadId: "pi-1" },
              response: {
                hostId: "node:devbox",
                threadId: "pi-1",
                items: [{ type: "agentMessage", text: "Pi transcript loaded" }],
              },
            },
          ],
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await expect
      .poll(() =>
        page
          .locator('[data-session-section="catalog:opencode"] [data-provider-icon="opencode"]')
          .count(),
      )
      .toBe(1);
    await expect
      .poll(() =>
        page.locator('[data-session-section="catalog:pi"] [data-provider-icon="pi"]').count(),
      )
      .toBe(1);
    const piIconResponse = await page.request.get(
      new URL("provider-icons/ProviderIcon-pi.svg", suite.server.baseUrl).toString(),
    );
    expect(piIconResponse.ok()).toBe(true);

    await page.getByText("OpenCode release review", { exact: true }).click();
    await expect.poll(() => page.getByText("OpenCode transcript loaded").count()).toBe(1);
    await page.getByText("Pi architecture notes", { exact: true }).click();
    const piPane = page
      .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
      .filter({ hasText: "Pi transcript loaded" });
    await piPane.getByText("Pi transcript loaded").waitFor();
    expect(await piPane.locator(".agent-chat__composer-combobox > textarea").isDisabled()).toBe(
      true,
    );
    expect(await gateway.getRequests("sessions.catalog.read")).toHaveLength(2);

    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        path: path.join(artifactDir, "external-session-catalogs.png"),
        fullPage: true,
      });
    }
    await page.close();
  });
});
