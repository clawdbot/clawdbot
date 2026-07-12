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

suite("Codex native session catalog", () => {
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

  it("adopts from the native chat composer, navigates, and auto-sends", async () => {
    const page = await browser.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
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
                  sessions: [
                    {
                      threadId: "thread-1",
                      name: "Release checklist",
                      status: "idle",
                      source: "cli",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
        "sessions.catalog.read": {
          hostId: "gateway:local",
          threadId: "thread-1",
          items: [{ id: "u1", type: "userMessage", text: "prepare release" }],
        },
        "sessions.catalog.continue": { sessionKey: "agent:main:adopted-codex" },
        "chat.send": { runId: "run-adopted", status: "started" },
      },
    });
    await page.goto(`${server.baseUrl}chat`);
    await page.getByText("Release checklist", { exact: true }).click();
    await expect.poll(() => page.getByText("prepare release", { exact: true }).count()).toBe(1);
    const composer = page.locator(".agent-chat__composer-combobox > textarea");
    await composer.fill("continue with the final checks");
    await composer.press("Enter");
    const continued = await gateway.waitForRequest("sessions.catalog.continue");
    expect(continued.params).toEqual({
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    const sent = await gateway.waitForRequest("chat.send");
    expect(sent.params).toMatchObject({
      sessionKey: "agent:main:adopted-codex",
      message: "continue with the final checks",
    });
    await expect.poll(() => page.url()).toMatch(/session=agent%3Amain%3Aadopted-codex/);
    await page.close();
  });
});
