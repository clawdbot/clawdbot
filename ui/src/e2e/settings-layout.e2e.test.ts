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

const actionSectionCases = [{ route: "mcp", heading: "Configured servers" }] as const;

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

const mobileStandaloneSettingsPageRoutes = [
  "sessions",
  "worktrees",
  "usage",
  "cron",
  "tasks",
  "memory-import",
] as const satisfies readonly RouteId[];

const mobileGeometryCases = [
  { route: "appearance", contentSelector: ".settings-page" },
  { route: "memory", contentSelector: ".memory-page__panel .settings-page" },
  { route: "plugins", contentSelector: ".settings-page" },
] as const satisfies ReadonlyArray<{ route: RouteId; contentSelector: string }>;

const responsiveViewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
] as const;

const standaloneHeaderCases = [
  { route: "cron", subtitle: "Scheduled tasks and recurring agent runs." },
  { route: "tasks", subtitle: "Background tasks: subagents, automation runs, CLI." },
  { route: "usage", subtitle: "API usage and costs." },
  {
    route: "memory-import",
    subtitle: "Bring Codex and Claude Code memory into an agent workspace.",
  },
] as const satisfies ReadonlyArray<{ route: RouteId; subtitle: string }>;

function createCronLayoutMethodResponses() {
  const jobs = [
    {
      id: "healthy",
      configRevision: "healthy-revision",
      name: "Healthy automation",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "healthy" },
      state: { lastRunStatus: "ok" },
    },
    {
      id: "failing",
      configRevision: "failing-revision",
      name: "Failing automation",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "failing" },
      state: { lastRunStatus: "error" },
    },
  ];
  return {
    "agents.list": {
      agents: [
        { id: "main", identity: { name: "Molty" }, name: "Molty" },
        { id: "writer", identity: { name: "Writer" }, name: "Writer" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    },
    "cron.list": {
      jobs,
      snapshotRevision: "settings-layout",
      total: jobs.length,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    },
    "cron.runs": {
      entries: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    },
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  };
}

suite.define(() => {
  it("aligns settings-style workspace headers with their content columns", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: createCronLayoutMethodResponses(),
    });

    try {
      for (const { route, subtitle } of standaloneHeaderCases) {
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });

        const header = page.locator(".content-header--settings").last();
        const content = page.locator(".settings-page").last();
        await Promise.all([header.waitFor(), content.waitFor()]);
        await expect.poll(() => header.locator(".page-subtitle").textContent()).toContain(subtitle);
        await expect
          .poll(async () => {
            const [headerBox, contentBox] = await Promise.all([
              header.boundingBox(),
              content.boundingBox(),
            ]);
            return headerBox && contentBox
              ? {
                  left: Math.round(headerBox.x - contentBox.x),
                  width: Math.round(headerBox.width - contentBox.width),
                }
              : null;
          })
          .toEqual({ left: 0, width: 0 });
      }
    } finally {
      await context.close();
    }
  });

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

      for (const route of mobileSettingsRoutes) {
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });
        await expect
          .poll(() => readShellInsets(route), { message: `${route} settings shell alignment` })
          .toEqual({ contentPaddingInline: 12, topbarPaddingInline: 12 });
      }

      for (const route of mobileStandaloneSettingsPageRoutes) {
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });
        const settingsPage = page.locator(".settings-page").last();
        await settingsPage.waitFor({ state: "attached" });
        expect(
          await settingsPage.evaluate((element) =>
            Math.round(Number.parseFloat(getComputedStyle(element).paddingLeft)),
          ),
          `${route} mobile page-owned inset`,
        ).toBe(12);
      }

      for (const { route, contentSelector } of mobileGeometryCases) {
        await page.close();
        page = await context.newPage();
        await installMockGateway(page);
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });
        const header = page.locator(".content-header").last();
        const title = header.locator(".page-title");
        const workspace = page.locator(".settings-workspace").last();
        const contentSurface = workspace.locator(contentSelector);
        await Promise.all([
          header.waitFor(),
          title.waitFor(),
          workspace.waitFor(),
          contentSurface.waitFor(),
        ]);
        await expect
          .poll(() =>
            page.evaluate((selector) => {
              const scrollport = document.querySelector<HTMLElement>("main.content");
              const headers = document.querySelectorAll<HTMLElement>(".content-header");
              const workspaces = document.querySelectorAll<HTMLElement>(".settings-workspace");
              const headerElement = headers.item(headers.length - 1);
              const workspaceElement = workspaces.item(workspaces.length - 1);
              const titleElement = headerElement?.querySelector<HTMLElement>(".page-title");
              const surfaceElement = workspaceElement?.querySelector<HTMLElement>(selector);
              if (
                !scrollport ||
                !headerElement ||
                !titleElement ||
                !workspaceElement ||
                !surfaceElement
              ) {
                return null;
              }
              const scrollportBox = scrollport.getBoundingClientRect();
              const headerBox = headerElement.getBoundingClientRect();
              const titleBox = titleElement.getBoundingClientRect();
              const workspaceBox = workspaceElement.getBoundingClientRect();
              const contentSurfaceBox = surfaceElement.getBoundingClientRect();
              // clientWidth excludes a non-overlay scrollbar and its stable gutter.
              const scrollportRight = scrollportBox.left + scrollport.clientWidth;
              return {
                headerLeft: Math.round(headerBox.left),
                headerTop: Math.round(headerBox.top),
                titleLeft: Math.round(titleBox.left),
                workspaceLeft: Math.round(workspaceBox.left),
                workspaceRightInset: Math.round(scrollportRight - workspaceBox.right),
                contentLeft: Math.round(contentSurfaceBox.left),
                contentRightInset: Math.round(scrollportRight - contentSurfaceBox.right),
              };
            }, contentSelector),
          )
          .toEqual({
            contentLeft: 12,
            contentRightInset: 12,
            headerLeft: 12,
            headerTop: 70,
            titleLeft: 12,
            workspaceLeft: 12,
            workspaceRightInset: 12,
          });
      }

      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/appearance",
        routeId: "appearance",
      });
      await page.locator(".topbar-nav-toggle").click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
      const settingsSidebar = page.locator(".settings-sidebar");
      await settingsSidebar.getByRole("link", { name: "Ask OpenClaw" }).click();
      await waitForControlUiRoute(page, { pathname: "/custodian", routeId: "custodian" });
      const custodianInsets = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>("main.content");
        const column = document.querySelector<HTMLElement>(".custodian__column");
        const topbar = document.querySelector<HTMLElement>(".topbar");
        if (!content || !column || !topbar) {
          throw new Error("Custodian settings route did not render");
        }
        const columnBox = column.getBoundingClientRect();
        return {
          columnLeft: Math.round(columnBox.left),
          columnRightInset: Math.round(document.documentElement.clientWidth - columnBox.right),
          contentPaddingInline: Math.round(
            Number.parseFloat(getComputedStyle(content).paddingLeft),
          ),
          topbarPaddingInline: Math.round(Number.parseFloat(getComputedStyle(topbar).paddingLeft)),
        };
      });
      expect(custodianInsets).toEqual({
        columnLeft: 12,
        columnRightInset: 12,
        contentPaddingInline: 0,
        topbarPaddingInline: 12,
      });

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

  it("keeps Automations search above one tab-and-action row", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: createCronLayoutMethodResponses(),
    });

    try {
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport);
        await page.goto(`${suite.server.baseUrl}automations`);
        await waitForControlUiRoute(page, { pathname: "/automations", routeId: "cron" });

        await expect
          .poll(() =>
            page.evaluate(() => {
              const primary = document.querySelector<HTMLElement>(".cron-toolbar__primary");
              const filters = document.querySelector<HTMLElement>(".cron-toolbar__filters");
              const actions = document.querySelector<HTMLElement>(".cron-toolbar__actions");
              const table = document.querySelector<HTMLElement>(".cron-table");
              const tabGroup = document.querySelector<HTMLElement>(".cron-list-hub-tabs");
              if (!primary || !filters || !actions || !table || !tabGroup) {
                return null;
              }
              const primaryBox = primary.getBoundingClientRect();
              const filtersBox = filters.getBoundingClientRect();
              const actionsBox = actions.getBoundingClientRect();
              const tableBox = table.getBoundingClientRect();
              const tabBox = tabGroup.getBoundingClientRect();
              return {
                actionsAboveTable: actionsBox.bottom <= tableBox.top,
                actionsRightAligned: Math.abs(tableBox.right - actionsBox.right) <= 1,
                actionsInlineWithTabs:
                  Math.abs(
                    actionsBox.top + actionsBox.height / 2 - (tabBox.top + tabBox.height / 2),
                  ) <= 1,
                filtersAbovePrimary: filtersBox.bottom <= primaryBox.top,
                primaryContainsActions: primary.contains(actions),
              };
            }),
          )
          .toEqual({
            actionsAboveTable: true,
            actionsInlineWithTabs: true,
            actionsRightAligned: true,
            filtersAbovePrimary: true,
            primaryContainsActions: true,
          });

        expect(
          (await page.locator(".cron-list-hub-tabs wa-tab").allTextContents()).map((label) =>
            label.trim(),
          ),
        ).toEqual(["All", "Active", "Paused", "Run history"]);
        expect(await page.locator(".cron-toolbar__filters wa-radio-group").count()).toBe(0);
        expect(await page.locator(".cron-stats").count()).toBe(0);
        expect(await page.locator(".agent-scope-control__label").count()).toBe(0);
        expect(await page.locator(".cron-table__name-text").allTextContents()).toEqual([
          "Failing automation",
          "Healthy automation",
        ]);

        if (proofEnabled) {
          const proofDir = path.join(suite.artifactDir, "settings-layout-audit");
          await mkdir(proofDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, `automations-toolbar-${viewport.width}.png`),
          });
        }
        await page.locator(".agent-select__trigger").click();
        const pickerTitle = page.locator(".agent-select__menu-title");
        await pickerTitle.waitFor();
        expect(await pickerTitle.textContent()).toBe("Agent");
        expect(
          await page
            .locator('.agent-select [part="menu"]')
            .evaluate((menu) => getComputedStyle(menu).opacity),
        ).toBe("1");
        if (proofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              suite.artifactDir,
              "settings-layout-audit",
              `automations-agent-picker-${viewport.width}.png`,
            ),
          });
        }
        await page.keyboard.press("Escape");
      }
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
        await mkdir(path.join(suite.artifactDir, "settings-layout-audit"), { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(
            path.join(suite.artifactDir, "settings-layout-audit"),
            "communications-messages.png",
          ),
        });
      }

      await advancedSummary.click();
      await expect.poll(() => advanced.getAttribute("open")).not.toBeNull();
      await expect.poll(() => page.getByText("Response prefix", { exact: true }).count()).toBe(1);
      if (proofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(
            path.join(suite.artifactDir, "settings-layout-audit"),
            "communications-advanced-expanded.png",
          ),
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
          path: path.join(
            path.join(suite.artifactDir, "settings-layout-audit"),
            "communications-voice.png",
          ),
        });
      }

      await page.setViewportSize({ height: 844, width: 390 });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const content = document.querySelector<HTMLElement>("main.content");
            const lead = document.querySelector<HTMLElement>(".config-lead");
            const tabs = document.querySelector<HTMLElement>(
              "wa-tab-group.config-sections-hub-tabs",
            );
            if (!content || !lead || !tabs) {
              return null;
            }
            const contentBox = content.getBoundingClientRect();
            const leadBox = lead.getBoundingClientRect();
            const tabsBox = tabs.getBoundingClientRect();
            return {
              leadLeft: Math.round(leadBox.left),
              leadRightInset: Math.round(contentBox.left + content.clientWidth - leadBox.right),
              tabsLeft: Math.round(tabsBox.left),
            };
          }),
        )
        .toEqual({ leadLeft: 12, leadRightInset: 12, tabsLeft: 12 });
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
        await mkdir(path.join(suite.artifactDir, "settings-layout-audit"), { recursive: true });
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
        if (route === "model-providers") {
          await page.getByRole("heading", { name: "Defaults", exact: true }).waitFor();
        }

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
              path: path.join(
                path.join(suite.artifactDir, "settings-layout-audit"),
                `${route}.png`,
              ),
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
              path: path.join(
                path.join(suite.artifactDir, "settings-layout-audit"),
                `action-${sectionCase.route}.png`,
              ),
            });
          }
        }
      }
    } finally {
      await context.close();
    }
  });
});
