// Control UI tests cover shared Settings control styling through the mocked Gateway.
import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Settings controls mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "settings-controls",
);

async function resolvedBackground(page: Page, value: string): Promise<string> {
  return page.evaluate((background) => {
    const probe = document.createElement("div");
    probe.style.background = background;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, value);
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  return errors;
}

function browserConfigMocks() {
  const config = { browser: { enabled: true } };
  return {
    "config.get": {
      config,
      hash: "hash-1",
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    },
    "config.schema": {
      generatedAt: "2026-08-14T00:00:00.000Z",
      schema: {
        type: "object",
        properties: {
          browser: {
            type: "object",
            title: "Browser",
            properties: {
              enabled: {
                type: "boolean",
                title: "Browser Enabled",
              },
            },
          },
        },
      },
      uiHints: {},
      version: "e2e",
    },
  };
}

async function openBrowserSettings(page: Page, baseUrl: string) {
  const response = await page.goto(
    `${baseUrl}settings/infrastructure?section=browser&advanced=1#config-section-browser`,
  );
  expect(response?.status()).toBe(200);
  const section = page.locator("#config-section-browser");
  await section.waitFor();
  return section;
}

async function captureBrowserSettingProof(
  page: Page,
  section: ReturnType<Page["locator"]>,
  name: string,
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await section.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, `${name}-desktop.png`),
  });
  await page.setViewportSize({ height: 844, width: 390 });
  await section.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, `${name}-narrow.png`),
  });
}

suite.define(() => {
  it("keeps checked switches on the scene accent on the security page", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const config = { browser: { enabled: true } };
        await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config,
              hash: "hash-1",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/security`);
        expect(response?.status()).toBe(200);

        const overview = page.locator(".security-page");
        const browserSwitchRole = overview.getByRole("switch", {
          name: "Browser enabled",
          exact: true,
        });
        await browserSwitchRole.waitFor();
        expect(await browserSwitchRole.getAttribute("aria-checked")).toBe("true");
        const browserSwitch = overview.locator("wa-switch.settings-toggle").first();
        expect(
          await browserSwitch.evaluate((element) => {
            const control = element.shadowRoot?.querySelector<HTMLElement>('[part="control"]');
            return control ? getComputedStyle(control).backgroundColor : null;
          }),
        ).toBe(await resolvedBackground(page, "var(--accent)"));

        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await page.locator(".content-header").screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "01-settings-view.png"),
          });
          await overview
            .locator(".settings-section")
            .first()
            .screenshot({
              animations: "disabled",
              path: path.join(uiProofArtifactDir, "02-security-controls.png"),
            });
        }

        await browserSwitch.click();
        await expect.poll(() => browserSwitchRole.getAttribute("aria-checked")).toBe("false");
      },
    );
  });

  it("hides the link-routing preference when the Control UI browser is unavailable", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1180 },
      },
      async ({ page }) => {
        await installMockGateway(page, { methodResponses: browserConfigMocks() });

        const section = await openBrowserSettings(page, suite.server.baseUrl);
        await expect
          .poll(() =>
            section
              .getByRole("switch", {
                name: "Open links in Control UI browser",
                exact: true,
              })
              .count(),
          )
          .toBe(0);
        await captureBrowserSettingProof(page, section, "browser-before");
      },
    );
  });

  for (const host of ["browser", "app"] as const) {
    it(`routes links to the Control UI browser in a ${host}-hosted UI`, async () => {
      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
      }
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          recordVideo: captureUiProofEnabled
            ? { dir: uiProofArtifactDir, size: { height: 900, width: 1180 } }
            : undefined,
          serviceWorkers: "block",
          viewport: { height: 1000, width: 1180 },
        },
        async ({ page }) => {
          const pageErrors = collectPageErrors(page);
          if (host === "app") {
            await page.context().addInitScript(() => {
              const messages: unknown[] = [];
              const appWindow = window as Window & {
                openclawNativeLinkMessages?: unknown[];
                webkit?: unknown;
              };
              appWindow.openclawNativeLinkMessages = messages;
              appWindow.webkit = {
                messageHandlers: {
                  openclawLink: { postMessage: (message: unknown) => messages.push(message) },
                },
              };
            });
          }
          const gateway = await installMockGateway(page, {
            featureMethods: [
              "browser.request",
              "chat.metadata",
              "chat.startup",
              "config.apply",
              "config.patch",
              "config.schema",
              "config.set",
            ],
            methodResponses: {
              ...browserConfigMocks(),
              "browser.request": {
                cases: [
                  {
                    match: { method: "POST", path: "/tabs/open" },
                    response: {
                      tabId: "tab-1",
                      targetId: "target-1",
                      title: "Example",
                      url: "https://example.com/control-ui-proof",
                    },
                  },
                  {
                    match: { method: "GET", path: "/tabs" },
                    response: {
                      running: true,
                      tabs: [
                        {
                          tabId: "tab-1",
                          targetId: "target-1",
                          title: "Example",
                          url: "https://example.com/control-ui-proof",
                        },
                      ],
                    },
                  },
                  {
                    match: { method: "POST", path: "/screenshot" },
                    response: {
                      path: "/proof.png",
                      targetId: "target-1",
                      url: "https://example.com/control-ui-proof",
                    },
                  },
                  {
                    match: { method: "POST", path: "/act" },
                    response: {
                      result: {
                        cssHeight: 720,
                        cssWidth: 1280,
                        title: "Example",
                        url: "https://example.com/control-ui-proof",
                      },
                    },
                  },
                ],
              },
            },
          });
          await page.route("**/__openclaw__/assistant-media?**", async (route) => {
            await route.fulfill({
              body: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
              ),
              contentType: "image/png",
              status: 200,
            });
          });

          const section = await openBrowserSettings(page, suite.server.baseUrl);
          const preference = section.getByRole("switch", {
            name: "Open links in Control UI browser",
            exact: true,
          });
          const preferenceHost = section
            .locator(".settings-row", { hasText: "Open links in Control UI browser" })
            .locator("wa-switch");
          await preference.waitFor();
          expect(await preference.getAttribute("aria-checked")).toBe("false");
          await preferenceHost.click();
          await expect.poll(() => preference.getAttribute("aria-checked")).toBe("true");
          await page.reload();
          const persistedPreference = page.getByRole("switch", {
            name: "Open links in Control UI browser",
            exact: true,
          });
          await persistedPreference.waitFor();
          expect(await persistedPreference.getAttribute("aria-checked")).toBe("true");

          if (host === "browser") {
            await captureBrowserSettingProof(
              page,
              page.locator("#config-section-browser"),
              "browser-after",
            );
          }

          await page.goto(`${suite.server.baseUrl}chat`);
          await page.evaluate(() => {
            const link = document.createElement("a");
            link.href = "https://example.com/application-handled";
            link.textContent = "Application-handled link";
            link.dataset.controlUiBrowserHandled = "true";
            link.addEventListener("click", (event) => event.preventDefault());
            Object.assign(link.style, {
              background: "white",
              left: "16px",
              padding: "8px",
              position: "fixed",
              top: "16px",
              zIndex: "99999",
            });
            document.body.append(link);
          });
          await page.locator("[data-control-ui-browser-handled]").click();
          expect(await gateway.getRequests("browser.request")).toEqual([]);
          if (host === "app") {
            expect(
              await page.evaluate(
                () =>
                  (window as Window & { openclawNativeLinkMessages?: unknown[] })
                    .openclawNativeLinkMessages,
              ),
            ).toEqual([]);
          }
          await page.locator("[data-control-ui-browser-handled]").evaluate((link) => link.remove());
          await page.evaluate(() => {
            const link = document.createElement("a");
            link.href = "https://example.com/control-ui-proof";
            link.textContent = "Open proof link";
            link.dataset.controlUiBrowserProof = "true";
            Object.assign(link.style, {
              background: "white",
              left: "16px",
              padding: "8px",
              position: "fixed",
              top: "16px",
              zIndex: "99999",
            });
            document.body.append(link);
          });
          await page.locator("[data-control-ui-browser-proof]").click();
          await expect.poll(() => gateway.getRequests("browser.request")).not.toHaveLength(0);
          expect(
            (await gateway.getRequests("browser.request")).map((request) => request.params),
          ).toContainEqual({
            body: { url: "https://example.com/control-ui-proof" },
            method: "POST",
            path: "/tabs/open",
          });
          const browserPanel = page.locator("openclaw-browser-panel[embedded]");
          await browserPanel.waitFor();
          expect(
            await browserPanel.evaluate(
              (panel) => (panel as HTMLElement & { available?: boolean }).available,
            ),
          ).toBe(true);
          await browserPanel.getByText("Example", { exact: true }).first().waitFor();
          await expect
            .poll(
              async () => (await browserPanel.textContent())?.includes("Loading page...") ?? true,
            )
            .toBe(false);
          expect(await browserPanel.textContent()).not.toContain("Browser request failed");

          if (host === "app") {
            expect(
              await page.evaluate(
                () =>
                  (window as Window & { openclawNativeLinkMessages?: unknown[] })
                    .openclawNativeLinkMessages,
              ),
            ).toEqual([]);
          }
          expect(pageErrors).toEqual([]);
        },
      );
    });
  }
});
