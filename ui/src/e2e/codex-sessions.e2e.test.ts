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

  it("omits empty native session catalogs from the sidebar", async () => {
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
                  hostId: "gateway:codex",
                  label: "Local Codex",
                  kind: "gateway",
                  connected: true,
                  sessions: [],
                },
              ],
            },
            {
              id: "claude",
              label: "Claude Code",
              capabilities: { continueSession: true, archive: false },
              hosts: [
                {
                  hostId: "gateway:claude",
                  label: "Local Claude",
                  kind: "gateway",
                  connected: true,
                  sessions: [],
                },
              ],
            },
          ],
        },
      },
    });

    await page.goto(`${server.baseUrl}chat`);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
      .toBeGreaterThan(0);
    expect(await page.locator('[data-session-section="catalog:codex"]').count()).toBe(0);
    expect(await page.locator('[data-session-section="catalog:claude"]').count()).toBe(0);
    await page.close();
  });

  it("shows a catalog Load More rejection without losing the retry cursor", async () => {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
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
                  hostId: "gateway:codex",
                  label: "Local Codex",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "thread-1",
                      name: "Newest session",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
                  nextCursor: "page-2",
                },
              ],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBe(1);
      const loadMore = page.locator('[data-session-catalog-load-more="codex"]');
      await loadMore.waitFor({ state: "visible" });
      await gateway.deferNext("sessions.catalog.list");
      await loadMore.click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBe(2);
      await gateway.rejectDeferred("sessions.catalog.list", {
        code: "UNAVAILABLE",
        message: "Second catalog page unavailable",
      });

      const section = page.locator('[data-session-section="catalog:codex"]');
      await section.locator('[data-session-catalog-error="codex"]').waitFor({ state: "visible" });
      await expect
        .poll(() => section.locator(".sidebar-session-group-toggle").getAttribute("aria-label"))
        .toContain("Second catalog page unavailable");
      await expect.poll(() => loadMore.getAttribute("aria-busy")).toBe("false");
      expect(await loadMore.isEnabled()).toBe(true);
      expect(await page.getByText("Newest session", { exact: true }).count()).toBe(1);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
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
