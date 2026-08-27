import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI settings layout mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const proofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "settings-layout-audit",
  "after",
);

const introRoutes = [
  "appearance",
  "approvals",
  "cloud-workers",
  "labs",
  "mcp",
  "secrets",
  "security",
  "talk",
  "updates",
] as const;

const learnMoreRoutes = [
  "appearance",
  "approvals",
  "cloud-workers",
  "labs",
  "mcp",
  "model-providers",
  "security",
  "talk",
] as const;

const sectionAlignmentRoutes = [
  "appearance",
  "cloud-workers",
  "labs",
  "mcp",
  "secrets",
  "security",
  "talk",
  "updates",
] as const;

const actionSectionCases = [
  { route: "mcp", heading: "Configured servers" },
  { route: "model-providers", heading: "Default models" },
] as const;

const responsiveViewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
] as const;

suite.define(() => {
  it("keeps settings introductions, section headings, and Learn more links on one layout system", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      if (proofEnabled) {
        await mkdir(proofDir, { recursive: true });
      }

      const routes = new Set([...introRoutes, ...learnMoreRoutes, ...sectionAlignmentRoutes]);
      for (const route of routes) {
        await page.goto(`${suite.server.baseUrl}settings/${route}`);
        await waitForControlUiRoute(page, {
          pathname: `/settings/${route}`,
          routeId: route,
        });
        if ((introRoutes as readonly string[]).includes(route)) {
          const title = page.locator(".page-title");
          const subtitle = page.locator(".page-subtitle");
          await title.waitFor();
          await subtitle.waitFor();
          await expect
            .poll(async () => {
              const [titleBox, subtitleBox] = await Promise.all([
                title.boundingBox(),
                subtitle.boundingBox(),
              ]);
              return titleBox && subtitleBox
                ? Math.round(subtitleBox.y - titleBox.y - titleBox.height)
                : null;
            })
            .toBe(2);
          expect(await page.locator(".settings-page__intro").count()).toBe(0);
          if (proofEnabled) {
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(proofDir, `${route}.png`),
            });
          }
        }

        if ((sectionAlignmentRoutes as readonly string[]).includes(route)) {
          const heading = page.locator(".settings-section__heading").first();
          const group = page.locator(".settings-section .settings-group").first();
          await heading.waitFor();
          await group.waitFor();
          await expect
            .poll(async () => {
              const [headingBox, groupBox] = await Promise.all([
                heading.boundingBox(),
                group.boundingBox(),
              ]);
              return headingBox && groupBox ? Math.round(headingBox.x - groupBox.x) : null;
            })
            .toBe(0);
        }

        if ((learnMoreRoutes as readonly string[]).includes(route)) {
          const link = page.getByRole("link", { name: "Learn more", exact: true }).first();
          await link.waitFor();
          expect(
            await link.evaluate((element) => getComputedStyle(element).textDecorationLine),
          ).toBe("none");
        }
      }

      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport);
        for (const sectionCase of actionSectionCases) {
          await page.goto(`${suite.server.baseUrl}settings/${sectionCase.route}`);
          await waitForControlUiRoute(page, {
            pathname: `/settings/${sectionCase.route}`,
            routeId: sectionCase.route,
          });
          const heading = page.getByRole("heading", {
            name: sectionCase.heading,
            exact: true,
          });
          const section = page.locator(".settings-section").filter({ has: heading });
          const description = section.locator(".settings-section__desc");
          const actions = section.locator(".settings-section__actions");
          const group = section.locator(":scope > .settings-group");
          await Promise.all([
            heading.waitFor(),
            description.waitFor(),
            actions.waitFor(),
            group.waitFor(),
          ]);
          await expect
            .poll(async () => {
              const [sectionBox, headingBox, descriptionBox, actionsBox, groupBox] =
                await Promise.all([
                  section.boundingBox(),
                  heading.boundingBox(),
                  description.boundingBox(),
                  actions.boundingBox(),
                  group.boundingBox(),
                ]);
              if (!sectionBox || !headingBox || !descriptionBox || !actionsBox || !groupBox) {
                return null;
              }
              return {
                actionPlacement:
                  viewport.width <= 640
                    ? Math.round(actionsBox.y - descriptionBox.y - descriptionBox.height)
                    : Math.round(actionsBox.y - headingBox.y),
                actionRightInset: Math.round(
                  sectionBox.x + sectionBox.width - actionsBox.x - actionsBox.width,
                ),
                copyGap: Math.round(descriptionBox.y - headingBox.y - headingBox.height),
                groupClearance: Math.round(
                  groupBox.y -
                    Math.max(
                      descriptionBox.y + descriptionBox.height,
                      actionsBox.y + actionsBox.height,
                    ),
                ),
                overlapsAction:
                  descriptionBox.x < actionsBox.x + actionsBox.width &&
                  descriptionBox.x + descriptionBox.width > actionsBox.x &&
                  descriptionBox.y < actionsBox.y + actionsBox.height &&
                  descriptionBox.y + descriptionBox.height > actionsBox.y,
              };
            })
            .toEqual({
              actionPlacement: viewport.width <= 640 ? 8 : 0,
              actionRightInset: 0,
              copyGap: 4,
              groupClearance: 12,
              overlapsAction: false,
            });

          if (proofEnabled && viewport.width === 1440) {
            await section.screenshot({
              animations: "disabled",
              path: path.join(proofDir, `action-${sectionCase.route}.png`),
            });
          }
        }
      }
    } finally {
      await context.close();
    }
  });
});
