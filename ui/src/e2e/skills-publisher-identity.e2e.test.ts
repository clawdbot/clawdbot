// Control UI E2E coverage for preserving ClawHub publisher identity from search selection.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI ClawHub publisher identity",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for ClawHub publisher identity proof at ${executablePath}`,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "skills-publishers");

async function setThemeMode(page: Page, mode: "dark" | "light") {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.classList.toggle("wa-light", nextMode === "light");
    root.classList.toggle("wa-dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
}

suite.define(() => {
  it("keeps same-slug publishers distinct through detail and install", async () => {
    if (captureUiProof) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["skills.detail", "skills.install", "skills.search"],
      methodResponses: {
        "agents.list": {
          agents: [{ id: "main", identity: { name: "Main" }, name: "Main" }],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "skills.detail": {
          skill: { slug: "weather", displayName: "Alice Weather", createdAt: 1, updatedAt: 1 },
          latestVersion: { version: "1.0.0", createdAt: 1 },
          owner: { handle: "alice", displayName: "Alice" },
        },
        "skills.install": { message: "Installed Bob Weather" },
        "skills.search": {
          results: [
            {
              score: 1,
              slug: "weather",
              ownerHandle: "alice",
              displayName: "Alice Weather",
              summary: "Forecasts from Alice",
              version: "1.0.0",
            },
            {
              score: 0.9,
              slug: "weather",
              ownerHandle: "bob",
              displayName: "Bob Weather",
              summary: "Forecasts from Bob",
              version: "2.0.0",
            },
          ],
        },
        "skills.status": {
          workspaceDir: "/tmp/openclaw-e2e/workspace",
          managedSkillsDir: "/tmp/openclaw-e2e/skills",
          skills: [],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}skills`);
      await page.locator('input[name="clawhub-search"]').fill("weather");
      await gateway.waitForRequest("skills.search");

      const aliceRow = page.locator(".settings-row", { hasText: "Alice Weather" });
      const bobRow = page.locator(".settings-row", { hasText: "Bob Weather" });
      await expect.poll(() => aliceRow.getByText("@alice/weather").isVisible()).toBe(true);
      await expect.poll(() => bobRow.getByText("@bob/weather").isVisible()).toBe(true);

      for (const theme of ["light", "dark"] as const) {
        await setThemeMode(page, theme);
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, `same-slug-publishers-${theme}.png`),
          });
        }
      }

      await aliceRow.getByRole("button", { name: "Open Alice Weather details" }).click();
      const detailRequest = await gateway.waitForRequest("skills.detail");
      expect(detailRequest.params).toEqual({ slug: "@alice/weather" });
      await page.getByRole("button", { name: "Close" }).click();

      await bobRow.getByRole("button", { name: "Install" }).click();
      const installRequest = await gateway.waitForRequest("skills.install");
      expect(installRequest.params).toMatchObject({
        source: "clawhub",
        slug: "@bob/weather",
      });
    } finally {
      await context.close();
    }
  });
});
