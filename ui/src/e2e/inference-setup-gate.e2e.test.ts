import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "inference-setup-gate");

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

suite.define(() => {
  it("blocks empty chat home until a model is connected", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("heading", { name: "Connect an AI model" }).waitFor();

      await expect.poll(() => page.locator(".agent-chat__composer-shell").count()).toBe(0);
      await expect.poll(() => page.locator("textarea").count()).toBe(0);
      await expect.poll(() => page.getByRole("button", { name: "Connect AI" }).count()).toBe(1);
      await captureProof(page, "chat-home-desktop.png");
      await page.getByRole("button", { name: "Connect AI" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
    } finally {
      await context.close();
    }
  });

  it("blocks the new-session composer until a model is connected", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.getByRole("heading", { name: "Connect an AI model" }).waitFor();

      await expect.poll(() => page.locator(".new-session-page__composer").count()).toBe(0);
      await expect.poll(() => page.locator("textarea").count()).toBe(0);
      await captureProof(page, "new-session-desktop.png");
      await page.getByRole("button", { name: "Connect AI" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
    } finally {
      await context.close();
    }
  });

  it("shows the setup splash before starting custodian chat", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1660 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}custodian`);
      await page.getByRole("heading", { name: "Connect an AI model" }).waitFor();

      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await expect.poll(() => page.locator(".custodian__error").count()).toBe(0);
      await expect.poll(() => page.locator(".agent-chat__composer-shell").count()).toBe(0);
      await expect.poll(() => page.locator("textarea").count()).toBe(0);
      await expect
        .poll(async () => (await page.locator(".custodian__header").boundingBox())?.width ?? 0)
        .toBeGreaterThan(1_000);
      await captureProof(page, "custodian-desktop.png");

      await page.setViewportSize({ height: 520, width: 900 });
      await expect
        .poll(() => page.getByRole("button", { name: "Connect AI" }).isVisible())
        .toBe(true);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
      await captureProof(page, "custodian-short-window.png");

      await page.setViewportSize({ height: 900, width: 1660 });
      await page.getByRole("button", { name: "Connect AI" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
      const modelsLink = page.locator('.settings-sidebar__item[href="/settings/model-providers"]');
      await expect.poll(() => modelsLink.getAttribute("aria-current")).toBe("page");
      await captureProof(page, "custodian-model-setup-selected.png");
    } finally {
      await context.close();
    }
  });
});
