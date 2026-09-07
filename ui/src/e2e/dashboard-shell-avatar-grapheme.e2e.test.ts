// Control UI E2E: dashboard author avatars and collapsed-shell env chrome keep
// complete emoji graphemes instead of UTF-16 .charAt(0) fragments.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard and shell grapheme avatars",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("dashboard-shell-avatar-grapheme");
  }
});

const flagAuthorLabel = "🇺🇸Team";
const flagGrapheme = "🇺🇸";
const emojiAssistantName = "😀Alice";
const emojiGrapheme = "😀";
const environment = { label: "edge", color: "amber" as const };
const dashboardKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const now = Date.now();

async function screenshot(page: Page, name: string, locator?: ReturnType<Page["locator"]>) {
  if (!captureUiProof) {
    return;
  }
  const target = locator ?? page;
  await target.screenshot({
    animations: "disabled",
    path: path.join(proofDir, name),
  });
}

async function fulfillBootstrap(
  page: Page,
  options: { assistantName: string; withEnvironment: boolean },
) {
  // Stacked after installMockGateway so this handler wins (Playwright LIFO).
  await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
    route.fulfill({
      json: {
        ...createControlUiMockBootstrapConfig({
          assistantName: options.assistantName || "OpenClaw",
        }),
        assistantName: options.assistantName,
        ...(options.withEnvironment ? { environment } : {}),
      },
    }),
  );
}

async function collapseNavigation(page: Page) {
  await page.locator(".sidebar-brand__collapse").click();
  await expect
    .poll(() => page.locator(".shell").getAttribute("class"))
    .toContain("shell--nav-collapsed");
  await page.locator(".shell-chrome-controls__nav-toggle").waitFor();
}

suite.define(() => {
  it("renders a complete flag grapheme in the dashboard author avatar", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          sessions: [
            {
              key: dashboardKey,
              kind: "direct",
              boardFace: "dashboard",
              displayName: "Deploy monitor",
              updatedAt: now,
              status: "done",
              createdActor: { type: "human", id: "team", label: flagAuthorLabel },
            },
          ],
        });

        const response = await page.goto(`${suite.server.baseUrl}dashboards`);
        expect(response?.status()).toBe(200);
        const gallery = page.locator("openclaw-dashboards-page");
        const card = gallery.locator("[data-dashboard-session]", { hasText: "Deploy monitor" });
        await card.waitFor();
        const avatar = card.locator(".dashboard-card__avatar");
        await expect.poll(() => avatar.textContent()).toBe(flagGrapheme);
        expect(await avatar.textContent()).not.toBe(flagAuthorLabel.charAt(0));
        await screenshot(page, "01-dashboard-author-avatar.png", card);
        await screenshot(page, "01-dashboard-author-avatar-crop.png", avatar);
      },
    );
  });

  it("sets collapsed shell data-env-avatar to a complete emoji grapheme", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, { assistantName: emojiAssistantName });
        await fulfillBootstrap(page, {
          assistantName: emojiAssistantName,
          withEnvironment: true,
        });

        const response = await page.goto(`${suite.server.baseUrl}dashboards`);
        expect(response?.status()).toBe(200);
        await page.locator("openclaw-dashboards-page").waitFor();
        await collapseNavigation(page);

        const toggle = page.locator(".shell-chrome-controls__nav-toggle");
        await expect.poll(() => toggle.getAttribute("data-env-avatar")).toBe(emojiGrapheme);
        expect(await toggle.getAttribute("data-env-avatar")).not.toBe(emojiAssistantName.charAt(0));
        await screenshot(page, "02-collapsed-shell-env-avatar.png");
        await screenshot(page, "02-collapsed-shell-env-avatar-crop.png", toggle);
      },
    );
  });

  it("omits collapsed shell data-env-avatar when the assistant name is empty", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        // Bootstrap empty names normalize to "Assistant", so start with a real
        // env chrome avatar then clear the live identity to hit the omit branch.
        await installMockGateway(page, { assistantName: emojiAssistantName });
        await fulfillBootstrap(page, {
          assistantName: emojiAssistantName,
          withEnvironment: true,
        });

        const response = await page.goto(`${suite.server.baseUrl}dashboards`);
        expect(response?.status()).toBe(200);
        await page.locator("openclaw-dashboards-page").waitFor();
        await collapseNavigation(page);

        const toggle = page.locator(".shell-chrome-controls__nav-toggle");
        await expect.poll(() => toggle.getAttribute("data-env-avatar")).toBe(emojiGrapheme);

        await page.locator("openclaw-app-shell").evaluate(async (element) => {
          const shell = element as HTMLElement & {
            requestUpdate?: () => void;
            updateComplete?: Promise<unknown>;
            runtime?: {
              context?: {
                config?: { current?: { assistantIdentity?: { name: string } } };
              };
            };
          };
          const identity = shell.runtime?.context?.config?.current?.assistantIdentity;
          if (!identity) {
            throw new Error("Assistant identity is unavailable on the shell runtime");
          }
          identity.name = "";
          shell.requestUpdate?.();
          await shell.updateComplete;
        });

        await expect
          .poll(() => toggle.evaluate((el) => el.hasAttribute("data-env-avatar")))
          .toBe(false);
        await screenshot(page, "03-collapsed-shell-empty-name.png");
        await screenshot(page, "03-collapsed-shell-empty-name-crop.png", toggle);
      },
    );
  });
});
