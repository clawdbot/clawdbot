import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const allowMissing = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const suite = available || !allowMissing ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

suite("OpenCode and Pi external session catalogs", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows both paired-node catalogs and opens their view-only transcripts", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

    await page.goto(`${server.baseUrl}chat`);
    await page.locator('[data-session-section="work"] .sidebar-session-group-toggle').click();
    await page.getByText("OpenCode release review", { exact: true }).click();
    await expect.poll(() => page.getByText("OpenCode transcript loaded").count()).toBe(1);
    await page.getByText("Pi architecture notes", { exact: true }).click();
    await expect.poll(() => page.getByText("Pi transcript loaded").count()).toBe(1);
    expect(await page.locator(".agent-chat__composer-combobox > textarea").isDisabled()).toBe(true);
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
