import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
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
  "labs",
  "mcp",
  "model-providers",
  "security",
  "talk",
] as const;

const settingsGuidanceLinks: ReadonlyArray<{
  route: string;
  container: string;
  section?: string;
}> = [
  { route: "cloud-workers", container: ".page-subtitle" },
  { route: "mcp", section: "Configured servers", container: ".settings-section__desc" },
];

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

const settingsRowRoutes = [
  "profile",
  "appearance",
  "lobsterdex",
  "notifications",
  "connection",
  "channels",
  "communications",
  "talk",
  "devices",
  "cloud-workers",
  "agents",
  "ai-agents",
  "labs",
  "model-setup",
  "model-providers",
  "mcp",
  "memory",
  "automation",
  "security",
  "secrets",
  "approvals",
  "infrastructure",
  "updates",
  "advanced",
  "plugins",
  "about",
  "debug",
] as const satisfies readonly RouteId[];

const mobileSettingsRoutes = [...settingsRowRoutes, "logs"] as const satisfies readonly RouteId[];

const responsiveViewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
] as const;

suite.define(() => {
  it("aligns every mobile settings page with the topbar content", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    let page = await context.newPage();
    await installMockGateway(page);

    try {
      const readShellInsets = (route: RouteId) =>
        page.evaluate((activeRoute) => {
          const content = document.querySelector<HTMLElement>("main.content");
          const topbar = document.querySelector<HTMLElement>(".topbar");
          if (!content || !topbar) {
            throw new Error(`${activeRoute} settings shell did not render`);
          }
          return {
            contentPaddingInline: Math.round(
              Number.parseFloat(getComputedStyle(content).paddingLeft),
            ),
            topbarPaddingInline: Math.round(
              Number.parseFloat(getComputedStyle(topbar).paddingLeft),
            ),
          };
        }, route);

      const layouts = [];
      for (const route of mobileSettingsRoutes) {
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });
        await page.waitForTimeout(200);
        layouts.push({ route, ...(await readShellInsets(route)) });
      }
      for (const layout of layouts) {
        if (layout.contentPaddingInline !== 12 || layout.topbarPaddingInline !== 12) {
          throw new Error(`${layout.route} settings shell alignment: ${JSON.stringify(layout)}`);
        }
      }

      for (const route of ["appearance", "model-setup"] as const) {
        await page.close();
        page = await context.newPage();
        await installMockGateway(page);
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });
        const header = page.locator(".content-header").last();
        const workspace = page.locator(".settings-workspace").last();
        await Promise.all([header.waitFor(), workspace.waitFor()]);
        await expect
          .poll(async () => {
            const [headerBox, workspaceBox] = await Promise.all([
              header.boundingBox(),
              workspace.boundingBox(),
            ]);
            return headerBox && workspaceBox
              ? {
                  headerLeft: Math.round(headerBox.x),
                  headerTop: Math.round(headerBox.y),
                  workspaceLeft: Math.round(workspaceBox.x),
                  workspaceRight: Math.round(workspaceBox.x + workspaceBox.width),
                }
              : null;
          })
          .toEqual({ headerLeft: 12, headerTop: 70, workspaceLeft: 12, workspaceRight: 378 });
      }

      await page.setViewportSize({ height: 900, width: 1440 });
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/appearance",
        routeId: "appearance",
      });
      const desktopInsets = await page.evaluate(() => ({
        configPadding: Number.parseFloat(
          getComputedStyle(document.querySelector<HTMLElement>(".config-content")!).paddingLeft,
        ),
        headerPadding: Number.parseFloat(
          getComputedStyle(document.querySelector<HTMLElement>(".content-header")!).paddingLeft,
        ),
        pagePadding: Number.parseFloat(
          getComputedStyle(document.querySelector<HTMLElement>(".settings-page")!).paddingLeft,
        ),
      }));
      expect(desktopInsets).toEqual({ configPadding: 22, headerPadding: 16, pagePadding: 16 });
    } finally {
      await context.close();
    }
  });

  it("uses the shared tab system for Communications without duplicate section help", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const config = {
      messages: { queueLimit: 5, responsePrefix: "[OpenClaw]" },
      tts: { auto: "off" },
    };
    const schema = {
      type: "object",
      properties: {
        messages: {
          type: "object",
          title: "Messages",
          properties: {
            queueLimit: { type: "integer", title: "Queue limit", minimum: 0 },
            responsePrefix: { type: "string", title: "Response prefix" },
          },
        },
        tts: {
          type: "object",
          title: "Voice",
          properties: {
            auto: {
              type: "string",
              title: "Automatic speech",
              enum: ["off", "always", "inbound", "tagged"],
            },
          },
        },
      },
    };
    await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          path: "~/.openclaw/openclaw.json",
          exists: true,
          raw: `${JSON.stringify(config, null, 2)}\n`,
          hash: "communications-config-hash",
          appliedConfigHash: "communications-config-hash",
          valid: true,
          config,
          issues: [],
        },
        "config.schema": {
          schema,
          uiHints: {
            messages: {
              label: "Messages",
              docsUrl: "https://docs.openclaw.ai/concepts/messages",
            },
            "messages.queueLimit": { advanced: false },
            "messages.responsePrefix": { advanced: true },
            tts: { label: "Voice", docsUrl: "https://docs.openclaw.ai/tts" },
          },
          version: "communications-layout",
          generatedAt: new Date(0).toISOString(),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/communications`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/communications",
        routeId: "communications",
      });

      expect(await page.locator(".page-subtitle").textContent()).toBe(
        "Messages and text-to-speech settings.",
      );
      expect(await page.locator("wa-tab-group.config-sections-hub-tabs").count()).toBe(1);
      expect((await page.locator("wa-tab").allTextContents()).map((label) => label.trim())).toEqual(
        ["Messages", "Voice"],
      );
      expect(await page.locator(".settings-section__help-button").count()).toBe(0);
      const spacing = await page.evaluate(() => {
        const subtitle = document.querySelector<HTMLElement>(".page-subtitle");
        const tabs = document.querySelector<HTMLElement>("wa-tab-group.config-sections-hub-tabs");
        const section = document.querySelector<HTMLElement>(".settings-section");
        if (!subtitle || !tabs || !section) {
          throw new Error("Communications layout did not render");
        }
        return {
          aboveTabs: tabs.getBoundingClientRect().top - subtitle.getBoundingClientRect().bottom,
          belowTabs: section.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom,
        };
      });
      expect(spacing.aboveTabs).toBeGreaterThan(0);
      expect(Math.abs(spacing.belowTabs - spacing.aboveTabs)).toBeLessThanOrEqual(1);

      const advanced = page.locator("details.config-advanced-disclosure");
      // Scope to the disclosure's own summary; expanded advanced content can
      // add nested collapsible-object summaries a bare locator would match.
      const advancedSummary = advanced.locator(":scope > summary");
      await expect.poll(() => advanced.count()).toBe(1);
      await expect.poll(() => advanced.getAttribute("open")).toBeNull();
      await expect.poll(() => advancedSummary.textContent()).toContain("Advanced settings");
      if (proofEnabled) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "communications-messages.png"),
        });
      }

      await advancedSummary.click();
      await expect.poll(() => advanced.getAttribute("open")).not.toBeNull();
      await expect.poll(() => page.getByText("Response prefix", { exact: true }).count()).toBe(1);
      if (proofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "communications-advanced-expanded.png"),
        });
      }

      await page.locator("#config-sections-tab-tts").click();
      await page.waitForFunction(() =>
        document.querySelector("#config-sections-tab-tts")?.hasAttribute("active"),
      );
      expect(await page.locator("#config-sections-tab-tts").getAttribute("active")).not.toBeNull();
      expect(await page.locator(".settings-section__help-button").count()).toBe(0);
      if (proofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "communications-voice.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("keeps settings rows, introductions, section headings, and Learn more links on one layout system", async () => {
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

      let auditedPairCount = 0;
      for (const route of settingsRowRoutes) {
        const pathname = pathForRoute(route);
        // Reload each route so earlier lazy styles cannot hide missing or misordered CSS.
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, {
          pathname,
          routeId: route,
        });

        const titleDescriptionPairs = page.locator(
          ".settings-row__text > .settings-row__title + .settings-row__desc",
        );
        const gaps = await titleDescriptionPairs.evaluateAll((descriptions) =>
          descriptions.map((description) => {
            const title = description.previousElementSibling;
            if (!(title instanceof HTMLElement)) {
              throw new Error("settings row description is missing its title");
            }
            const titleBox = title.getBoundingClientRect();
            const descriptionBox = description.getBoundingClientRect();
            return Math.round(descriptionBox.y - titleBox.y - titleBox.height);
          }),
        );
        auditedPairCount += gaps.length;
        expect(gaps, `${route} title/subtitle gaps`).toEqual(gaps.map(() => 0));

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

      expect(auditedPairCount).toBeGreaterThan(0);

      for (const guidanceLink of settingsGuidanceLinks) {
        await page.goto(`${suite.server.baseUrl}settings/${guidanceLink.route}`);
        await waitForControlUiRoute(page, {
          pathname: `/settings/${guidanceLink.route}`,
          routeId: guidanceLink.route,
        });
        const root = guidanceLink.section
          ? page.locator(".settings-section").filter({
              has: page.getByRole("heading", { name: guidanceLink.section, exact: true }),
            })
          : page;
        const link = (guidanceLink.container ? root.locator(guidanceLink.container) : root)
          .getByRole("link", { name: "Learn more", exact: true })
          .first();
        await link.waitFor();
        expect(await link.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe(
          "none",
        );
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
                actionGap:
                  viewport.width <= 640
                    ? null
                    : Math.round(actionsBox.x - descriptionBox.x - descriptionBox.width),
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
              actionGap: viewport.width <= 640 ? null : 20,
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
