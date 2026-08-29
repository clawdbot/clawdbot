import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { activateChatHeaderPanelAction } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat tabbed side panel",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:rail-tabs";
const proofDir = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
const videoDir = process.env.OPENCLAW_UI_RAIL_VIDEO_DIR?.trim();

const historyMessages = Array.from({ length: 10 }, (_, index) => ({
  id: `rail-tabs-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: [
    {
      type: "text",
      text:
        index % 2 === 0
          ? `Review checkpoint ${index + 1}: keep the conversation visible while working with session tools.`
          : `Checkpoint ${index + 1} is ready. The side panel can switch tools without changing the chat context.`,
    },
  ],
  timestamp: Date.now() - (10 - index) * 60_000,
}));

function scenario(): ControlUiMockGatewayScenario {
  return {
    featureMethods: [
      "browser.request",
      "desktop.observe",
      "environments.list",
      "sessions.diff",
      "tasks.list",
      "terminal.open",
    ],
    historyMessages,
    methodResponses: {
      "artifacts.list": { artifacts: [] },
      "browser.request": {
        cases: [{ match: { method: "GET", path: "/tabs" }, response: { running: true, tabs: [] } }],
      },
      "desktop.observe": {
        transport: "rfb",
        wsPath: "/desktop/observe?token=rail-tabs",
        expiresAtMs: 60_000,
        control: false,
        auth: "vnc-password",
      },
      "environments.list": {
        environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
      },
      "sessions.diff": {
        sessionKey,
        root: "/workspace/openclaw",
        branch: "feature/tabbed-side-panel",
        baseRef: "main",
        files: [
          {
            path: "ui/src/pages/chat/chat-pane-render.ts",
            status: "modified",
            additions: 4,
            deletions: 2,
            patch: [
              "diff --git a/ui/src/pages/chat/chat-pane-render.ts b/ui/src/pages/chat/chat-pane-render.ts",
              "--- a/ui/src/pages/chat/chat-pane-render.ts",
              "+++ b/ui/src/pages/chat/chat-pane-render.ts",
              "@@ -1,2 +1,4 @@",
              " existing line",
              "+single side panel",
              "+tab navigation",
              "",
            ].join("\n"),
          },
        ],
        additions: 4,
        deletions: 2,
      },
      "sessions.companion.ask": {
        answer: "The mobile side chat stayed inside its panel.",
        ts: Date.UTC(2026, 7, 16, 12, 0),
      },
      "sessions.companion.state": { exchanges: [] },
      "sessions.files.list": {
        browser: {
          path: "ui/src/pages/chat",
          entries: [
            {
              kind: "file",
              name: "chat-pane-render.ts",
              path: "ui/src/pages/chat/chat-pane-render.ts",
            },
            { kind: "file", name: "sidebar.css", path: "ui/src/styles/chat/sidebar.css" },
          ],
        },
        files: [
          {
            kind: "modified",
            missing: false,
            name: "chat-pane-render.ts",
            path: "/workspace/openclaw/ui/src/pages/chat/chat-pane-render.ts",
            size: 18_432,
          },
          {
            kind: "read",
            missing: false,
            name: "sidebar.css",
            path: "/workspace/openclaw/ui/src/styles/chat/sidebar.css",
            size: 24_820,
          },
        ],
        root: "/workspace/openclaw",
        sessionKey,
      },
      "tasks.list": {
        tasks: [
          {
            agentId: "main",
            createdAt: Date.now() - 240_000,
            id: "task-navigation",
            kind: "subagent",
            ownerKey: sessionKey,
            sessionKey,
            progressSummary: "Checking panel navigation and persisted state",
            runtime: "subagent",
            startedAt: Date.now() - 210_000,
            status: "running",
            taskId: "task-navigation",
            title: "Verify tab navigation",
            updatedAt: Date.now(),
          },
        ],
      },
      "terminal.list": { sessions: [] },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/workspace/openclaw",
        sessionId: "rail-tabs-terminal",
        shell: "/bin/zsh",
      },
    },
    sessionKey,
    terminalEnabled: true,
    workspace: "/workspace/openclaw",
    workspaceGit: true,
  };
}

async function seedSettings(page: Page, themeMode: "light" | "dark") {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, sessionKey: seededSessionKey, themeMode: seededThemeMode }) => {
      if (localStorage.getItem(key) !== null) {
        return;
      }
      localStorage.setItem(
        key,
        JSON.stringify({
          theme: "claw",
          themeMode: seededThemeMode,
          sidebarSessionLayouts: {
            [seededSessionKey]: { columns: [], open: false, expanded: false },
          },
        }),
      );
    },
    { key: settingsKey, sessionKey, themeMode },
  );
}

async function seedDockReservationRegression(page: Page, dock: "bottom" | "right") {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ dock: seededDock, key, sessionKey: seededSessionKey }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          theme: "claw",
          themeMode: "light",
          sidebarSessionLayouts: {
            [seededSessionKey]: { columns: [], dock: seededDock, open: false, expanded: false },
          },
        }),
      );
      localStorage.setItem(
        "openclaw.browser.panel.v1",
        JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
      );
    },
    { dock, key: settingsKey, sessionKey },
  );
}

function sidePanel(page: Page): Locator {
  return page.locator(".sidebar-region__right-runtime .side-panel");
}

// Scope tab queries to the panel's own header: Terminal and Browser render the
// same strip inside the panel body, so an unscoped descendant match would also
// collect their inner rails. Match descendants of that header rather than a
// direct child, so header layout wrappers can change without silently emptying
// every tab assertion.
const sidePanelTabLabelSelector = ":scope > .side-panel__header .tabstrip-tab__label";

async function openFromEmpty(page: Page, label: string) {
  const button = sidePanel(page).locator(".side-panel-empty__type").filter({ hasText: label });
  await button.click();
}

async function openFromPlus(page: Page, label: string) {
  const panel = sidePanel(page);
  const dropdown = panel.locator("wa-dropdown.side-panel-type-menu");
  await dropdown.getByRole("button", { name: "Add side panel tab" }).click();
  const item = dropdown.locator("wa-dropdown-item").filter({ hasText: label });
  const afterHide = dropdown.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener("wa-after-hide", () => resolve(), { once: true });
      }),
  );
  await item.click();
  await afterHide;
  await expect.poll(() => dropdown.evaluate((element) => Reflect.get(element, "open"))).toBe(false);
}

async function selectTab(page: Page, label: string) {
  await sidePanel(page).locator("wa-tab").filter({ hasText: label }).click();
}

async function tabLabels(page: Page): Promise<string[]> {
  return sidePanel(page)
    .locator(sidePanelTabLabelSelector)
    .evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ""));
}

async function narrowestRailTabLabel(page: Page): Promise<number> {
  return sidePanel(page)
    .locator(sidePanelTabLabelSelector)
    .evaluateAll((labels) =>
      Math.min(...labels.map((label) => (label as HTMLElement).getBoundingClientRect().width)),
    );
}

async function expectExpandedSidePanelFillsRegion(page: Page): Promise<void> {
  const geometry = await sidePanel(page).evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const region = element.closest(".sidebar-region")?.getBoundingClientRect();
    if (!region) {
      throw new Error("Expanded side panel has no sidebar region");
    }
    return {
      bottom: Math.abs(panel.bottom - region.bottom),
      left: Math.abs(panel.left - region.left),
      right: Math.abs(panel.right - region.right),
      top: Math.abs(panel.top - region.top),
    };
  });
  for (const delta of Object.values(geometry)) {
    expect(delta).toBeLessThanOrEqual(1);
  }
}

async function captureRichPanel(page: Page, name: string) {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  const clip = await page.evaluate(() => {
    const elements = [
      document.querySelector<HTMLElement>(".chat-pane__header"),
      document.querySelector<HTMLElement>(".agent-chat__scroll"),
      document.querySelector<HTMLElement>(".side-panel"),
    ].filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) {
      throw new Error("No chat panel geometry found for evidence clip");
    }
    const rects = elements.map((element) => element.getBoundingClientRect());
    const x = Math.max(0, Math.min(...rects.map((rect) => rect.left)));
    const y = Math.max(0, Math.min(...rects.map((rect) => rect.top)));
    const right = Math.min(innerWidth, Math.max(...rects.map((rect) => rect.right)));
    const bottom = Math.min(innerHeight, Math.max(...rects.map((rect) => rect.bottom)));
    return { x, y, width: right - x, height: bottom - y };
  });
  await page.screenshot({ path: path.join(proofDir, `${name}.png`), clip });
}

suite.define(() => {
  it.each(["right", "bottom"] as const)(
    "opens topbar surfaces without reserving a stale right dock while the rail is %s-docked",
    async (dock) => {
      await suite.withPage(
        {
          colorScheme: "light",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1600 },
        },
        async ({ page }) => {
          await seedDockReservationRegression(page, dock);
          await installMockGateway(page, scenario());
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(".chat-group").first().waitFor();

          await page.locator(".chat-browser-panel-toggle").click();
          await sidePanel(page).locator('[data-panel-slot="browser"]:not([hidden])').waitFor();
          await expect
            .poll(() =>
              page.evaluate(() => ({
                marginRight: getComputedStyle(
                  document.querySelector<HTMLElement>(".content--chat")!,
                ).marginRight,
                reservation: document.documentElement.style.getPropertyValue(
                  "--oc-browser-reserve-right",
                ),
              })),
            )
            .toEqual({ marginRight: "0px", reservation: "0px" });
          await expect
            .poll(() =>
              sidePanel(page).evaluate((panel) => panel.classList.contains("side-panel--bottom")),
            )
            .toBe(dock === "bottom");

          await page.locator(".chat-tasks-toggle").click();
          await sidePanel(page).locator('[data-panel-slot="tasks"]:not([hidden])').waitFor();
          await expect
            .poll(() =>
              page.evaluate(() => {
                const content = document.querySelector<HTMLElement>(".content--chat")!;
                const panel = document.querySelector<HTMLElement>(".side-panel")!;
                const region = document.querySelector<HTMLElement>(".sidebar-region")!;
                return {
                  marginRight: getComputedStyle(content).marginRight,
                  reservation: document.documentElement.style.getPropertyValue(
                    "--oc-browser-reserve-right",
                  ),
                  spansRegion:
                    Math.abs(
                      panel.getBoundingClientRect().width - region.getBoundingClientRect().width,
                    ) < 1,
                };
              }),
            )
            .toEqual({
              marginRight: "0px",
              reservation: "0px",
              spansRegion: dock === "bottom",
            });
        },
      );
    },
  );

  it.each(["light", "dark"] as const)(
    "navigates and persists one tabbed side panel in %s theme",
    async (themeMode) => {
      await suite.withPage(
        {
          colorScheme: themeMode,
          locale: "en-US",
          ...(videoDir && themeMode === "light"
            ? { recordVideo: { dir: videoDir, size: { height: 900, width: 1600 } } }
            : {}),
          serviceWorkers: "block",
          viewport: { height: 900, width: 1600 },
        },
        async ({ page }) => {
          await seedSettings(page, themeMode);
          const gateway = await installMockGateway(page, scenario());
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(".chat-group").first().waitFor();

          const topbarButtons = page.locator(".chat-pane__actions .chat-icon-btn");
          await expect.poll(() => topbarButtons.count()).toBe(5);
          await expect
            .poll(async () => {
              const buttons = (await topbarButtons.all()).map(async (button) => ({
                button: await button.boundingBox(),
                glyph: await button.locator(":scope > svg").boundingBox(),
              }));
              const geometry = await Promise.all(buttons);
              const buttonCenters = geometry.map(
                ({ button }) => (button?.y ?? 0) + (button?.height ?? 0) / 2,
              );
              const glyphCenters = geometry.map(
                ({ glyph }) => (glyph?.y ?? 0) + (glyph?.height ?? 0) / 2,
              );
              const taskBadge = await page.locator(".chat-tasks-toggle__badge").boundingBox();
              const taskButton = geometry[1]!.button;
              const taskGlyph = geometry[1]!.glyph;
              const gaps = geometry.slice(1).map(({ button }, index) => {
                const previous = geometry[index]!.button;
                return (button?.x ?? 0) - ((previous?.x ?? 0) + (previous?.width ?? 0));
              });
              const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
              return {
                buttonCenterSpread: spread(buttonCenters),
                buttonHeights: geometry.map(({ button }) => button?.height),
                gapSpread: spread(gaps),
                glyphCenterSpread: spread(glyphCenters),
                glyphSizes: geometry.map(({ glyph }) => [glyph?.width, glyph?.height]),
                taskBadgeCenterDelta: Math.abs(
                  (taskBadge?.y ?? 0) +
                    (taskBadge?.height ?? 0) / 2 -
                    ((taskGlyph?.y ?? 0) + (taskGlyph?.height ?? 0) / 2),
                ),
                taskBadgeContained:
                  (taskBadge?.x ?? 0) >= (taskButton?.x ?? 0) &&
                  (taskBadge?.x ?? 0) + (taskBadge?.width ?? 0) <=
                    (taskButton?.x ?? 0) + (taskButton?.width ?? 0),
              };
            })
            .toEqual({
              buttonCenterSpread: 0,
              buttonHeights: [28, 28, 28, 28, 28],
              gapSpread: 0,
              glyphCenterSpread: 0,
              glyphSizes: [
                [16, 16],
                [16, 16],
                [16, 16],
                [16, 16],
                [16, 16],
              ],
              taskBadgeCenterDelta: 6,
              taskBadgeContained: false,
            });

          await page.locator(".chat-side-panel-toggle").click();
          await sidePanel(page).locator(".side-panel-empty--selector").waitFor();
          expect(await sidePanel(page).locator("wa-tab").count()).toBe(0);
          await captureRichPanel(page, `rails-tabs-empty-${themeMode}`);

          await openFromEmpty(page, "Files");
          await sidePanel(page).locator('[data-panel-slot="workspace"]:not([hidden])').waitFor();
          await expect.poll(() => sidePanel(page).textContent()).toContain("chat-pane-render.ts");
          await activateChatHeaderPanelAction(page, "Show session changes");
          await gateway.waitForRequest("sessions.diff");
          await sidePanel(page).locator('[data-panel-slot="detail"]:not([hidden])').waitFor();
          await expect.poll(() => sidePanel(page).textContent()).toContain("single side panel");
          await captureRichPanel(page, `rails-tabs-review-${themeMode}`);

          await openFromPlus(page, "Terminal");
          const terminalOpen = await gateway.waitForRequest("terminal.open");
          expect(terminalOpen.params).toMatchObject({ agentId: "main", sessionKey });
          await sidePanel(page).locator('[data-panel-slot="terminal"]:not([hidden])').waitFor();
          await openFromPlus(page, "Tasks");
          await expect.poll(() => sidePanel(page).textContent()).toContain("Verify tab navigation");
          await openFromPlus(page, "Browser");
          await sidePanel(page).locator('[data-panel-slot="browser"]:not([hidden])').waitFor();
          await captureRichPanel(page, `rails-tabs-browser-${themeMode}`);
          await openFromPlus(page, "Side chat");
          await sidePanel(page).locator('[data-panel-slot="companion"]:not([hidden])').waitFor();
          await openFromPlus(page, "Desktop");
          await sidePanel(page).locator('[data-panel-slot="desktop"]:not([hidden])').waitFor();
          const desktopObserve = await gateway.waitForRequest("desktop.observe");
          expect(desktopObserve.params).toEqual({ source: { kind: "host" }, control: false });
          await sidePanel(page).getByLabel("VNC password", { exact: true }).waitFor();
          await captureRichPanel(page, `rails-tabs-desktop-${themeMode}`);
          expect(await tabLabels(page)).toEqual([
            "Files",
            "Review",
            "Terminal",
            "Tasks",
            "Browser",
            "Side chat",
            "Desktop",
          ]);
          await expect.poll(() => narrowestRailTabLabel(page)).toBeGreaterThanOrEqual(24);
          await expect
            .poll(() =>
              sidePanel(page)
                .locator(":scope > .side-panel__header .tabstrip-tab__icon")
                .evaluateAll((icons) => {
                  const geometry = icons.map((icon) => {
                    const iconRect = icon.getBoundingClientRect();
                    const glyphRect = icon.querySelector("svg")?.getBoundingClientRect();
                    const tab = icon.closest("wa-tab");
                    const baseRect = tab?.shadowRoot
                      ?.querySelector<HTMLElement>('[part~="base"]')
                      ?.getBoundingClientRect();
                    return {
                      baseDelta: Math.abs(
                        iconRect.y +
                          iconRect.height / 2 -
                          ((baseRect?.y ?? 0) + (baseRect?.height ?? 0) / 2),
                      ),
                      box: [iconRect.width, iconRect.height],
                      center: iconRect.y + iconRect.height / 2,
                      glyph: [glyphRect?.width, glyphRect?.height],
                    };
                  });
                  const centers = geometry.map(({ center }) => center);
                  return {
                    baseDeltas: geometry.map(({ baseDelta }) => baseDelta),
                    boxes: geometry.map(({ box }) => box),
                    centerSpread: Math.max(...centers) - Math.min(...centers),
                    glyphs: geometry.map(({ glyph }) => glyph),
                  };
                }),
            )
            .toEqual({
              baseDeltas: [0, 0, 0, 0, 0, 0, 0],
              boxes: Array.from({ length: 7 }, () => [16, 16]),
              centerSpread: 0,
              glyphs: Array.from({ length: 7 }, () => [15, 15]),
            });
          const filesTab = sidePanel(page).locator("wa-tab").filter({ hasText: "Files" });
          const filesClose = sidePanel(page).getByRole("button", {
            name: "Close Files",
            exact: true,
          });
          const desktopClose = sidePanel(page).getByRole("button", {
            name: "Close Desktop",
            exact: true,
          });
          await expect
            .poll(() => filesClose.evaluate((button) => getComputedStyle(button).opacity))
            .toBe("0");
          await expect
            .poll(() => desktopClose.evaluate((button) => getComputedStyle(button).opacity))
            .toBe("1");
          const filesGeometry = await filesTab.evaluate((tab) => {
            const close = tab.nextElementSibling as HTMLElement;
            return { closeWidth: close.offsetWidth, tabWidth: (tab as HTMLElement).offsetWidth };
          });
          await filesTab.hover();
          await expect
            .poll(() => filesClose.evaluate((button) => getComputedStyle(button).opacity))
            .toBe("1");
          await expect
            .poll(() =>
              filesTab.evaluate((tab) => {
                const base = tab.shadowRoot?.querySelector<HTMLElement>('[part~="base"]');
                const close = tab.nextElementSibling as HTMLElement | null;
                return base && close
                  ? getComputedStyle(base).backgroundColor ===
                      getComputedStyle(close).backgroundColor
                  : false;
              }),
            )
            .toBe(true);
          await filesClose.hover();
          await expect
            .poll(() =>
              filesTab.evaluate((tab) => {
                const base = tab.shadowRoot?.querySelector<HTMLElement>('[part~="base"]');
                const close = tab.nextElementSibling as HTMLElement | null;
                return base && close
                  ? getComputedStyle(base).backgroundColor ===
                      getComputedStyle(close).backgroundColor
                  : false;
              }),
            )
            .toBe(true);
          expect(
            await filesTab.evaluate((tab) => {
              const close = tab.nextElementSibling as HTMLElement;
              return { closeWidth: close.offsetWidth, tabWidth: (tab as HTMLElement).offsetWidth };
            }),
          ).toEqual(filesGeometry);
          await expect
            .poll(() =>
              sidePanel(page)
                .locator(sidePanelTabLabelSelector)
                .evaluateAll((labels) =>
                  labels.some((label) => {
                    const element = label as HTMLElement;
                    return element.hasAttribute("data-tooltip-overflow");
                  }),
                ),
            )
            .toBe(true);
          const railLabels = sidePanel(page).locator(sidePanelTabLabelSelector);
          const overflowingLabelIndex = await railLabels.evaluateAll((labels) =>
            labels.findIndex((label) => label.hasAttribute("data-tooltip-overflow")),
          );
          expect(overflowingLabelIndex).toBeGreaterThanOrEqual(0);
          const overflowingLabel = railLabels.nth(overflowingLabelIndex);
          const fullLabel = (await overflowingLabel.textContent())?.trim();
          const tooltipTrigger = overflowingLabel.locator("..");
          const labelTooltip = tooltipTrigger.locator("..");
          expect(await labelTooltip.evaluate((element) => element.localName)).toBe(
            "openclaw-tooltip",
          );
          expect(
            await overflowingLabel.locator("xpath=ancestor::wa-tab").getAttribute("title"),
          ).toBeNull();
          await tooltipTrigger.hover();
          await expect
            .poll(() =>
              labelTooltip
                .locator("wa-tooltip")
                .evaluate((tooltip) => Reflect.get(tooltip, "open")),
            )
            .toBe(true);
          expect(await labelTooltip.locator("wa-tooltip .tooltip-content").textContent()).toContain(
            fullLabel,
          );
          await expect
            .poll(() =>
              sidePanel(page)
                .locator(":scope > .side-panel__header wa-tab-group.tabstrip")
                .evaluate((group) => {
                  const tabsPart = group.shadowRoot?.querySelector<HTMLElement>('[part~="tabs"]');
                  if (!tabsPart) {
                    return null;
                  }
                  const tabsRect = tabsPart.getBoundingClientRect();
                  const rightmostItem = Math.max(
                    ...[
                      ...group.querySelectorAll<HTMLElement>(
                        "wa-tab, .tabstrip-tab__close, .tabstrip-separator",
                      ),
                    ].map((item) => Math.min(item.getBoundingClientRect().right, tabsRect.right)),
                  );
                  const clipped = [
                    ...group.querySelectorAll<HTMLElement>(".tabstrip-tab__label"),
                  ].some((label) => label.hasAttribute("data-tooltip-overflow"));
                  return { clipped, unused: Math.max(0, tabsRect.right - rightmostItem) };
                }),
            )
            .toEqual({ clipped: true, unused: 0 });

          await selectTab(page, "Files");
          await captureRichPanel(page, `rails-tabs-rich-${themeMode}`);

          const panelWidth = await sidePanel(page).evaluate(
            (element) => element.getBoundingClientRect().width,
          );
          const divider = page.locator(".sidebar-column__divider");
          const dividerBox = await divider.boundingBox();
          expect(dividerBox).not.toBeNull();
          await page.mouse.move(dividerBox!.x + 1, dividerBox!.y + dividerBox!.height / 2);
          await page.mouse.down();
          await page.mouse.move(dividerBox!.x - 90, dividerBox!.y + dividerBox!.height / 2);
          await page.mouse.up();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeGreaterThan(panelWidth + 70);
          const resizedWidth = await sidePanel(page).evaluate(
            (element) => element.getBoundingClientRect().width,
          );

          await sidePanel(page).getByRole("button", { name: "Dock to bottom" }).click();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) =>
                element.classList.contains("side-panel--bottom"),
              ),
            )
            .toBe(true);
          await expect
            .poll(() =>
              page.evaluate(() => {
                const panel = document.querySelector<HTMLElement>(".side-panel");
                const region = document.querySelector<HTMLElement>(".sidebar-region");
                return Math.abs(
                  (panel?.getBoundingClientRect().width ?? 0) -
                    (region?.getBoundingClientRect().width ?? 0),
                );
              }),
            )
            .toBeLessThan(1);
          await expect
            .poll(() =>
              divider.evaluate((element) => (element as { orientation?: string }).orientation),
            )
            .toBe("horizontal");
          await expect.poll(() => narrowestRailTabLabel(page)).toBeGreaterThanOrEqual(24);
          const bottomHeight = await sidePanel(page).evaluate(
            (element) => element.getBoundingClientRect().height,
          );
          const bottomDividerBox = await divider.boundingBox();
          expect(bottomDividerBox).not.toBeNull();
          await page.mouse.move(
            bottomDividerBox!.x + bottomDividerBox!.width / 2,
            bottomDividerBox!.y + 1,
          );
          await page.mouse.down();
          await page.mouse.move(
            bottomDividerBox!.x + bottomDividerBox!.width / 2,
            bottomDividerBox!.y - 70,
          );
          await page.mouse.up();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().height),
            )
            .toBeGreaterThan(bottomHeight + 50);
          const resizedHeight = await sidePanel(page).evaluate(
            (element) => element.getBoundingClientRect().height,
          );
          await page.mouse.move(80, 80);
          await page.mouse.click(300, 100);
          // Pointer drags leave the divider focused; blur it so the evidence
          // frame shows the resting divider, not its focus highlight.
          await divider.evaluate((element) => element.blur());
          await captureRichPanel(page, `rails-tabs-bottom-${themeMode}`);

          await sidePanel(page).getByRole("button", { name: "Close", exact: true }).click();
          await page.locator(".chat-side-panel-toggle").click();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) =>
                element.classList.contains("side-panel--bottom"),
              ),
            )
            .toBe(true);
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().height),
            )
            .toBeCloseTo(resizedHeight, 0);

          await page.reload();
          await page.locator(".chat-group").first().waitFor();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) =>
                element.classList.contains("side-panel--bottom"),
              ),
            )
            .toBe(true);
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().height),
            )
            .toBeCloseTo(resizedHeight, 0);

          await sidePanel(page).getByRole("button", { name: "Dock to right" }).click();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) =>
                element.classList.contains("side-panel--bottom"),
              ),
            )
            .toBe(false);
          await expect
            .poll(() =>
              divider.evaluate((element) => (element as { orientation?: string }).orientation),
            )
            .toBe("vertical");
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeCloseTo(resizedWidth, 0);

          await sidePanel(page).getByRole("button", { name: "Expand side panel" }).click();
          await expect
            .poll(() =>
              page
                .locator(".sidebar-region__primary")
                .evaluate((element) => getComputedStyle(element).display),
            )
            .toBe("none");
          await expectExpandedSidePanelFillsRegion(page);
          await captureRichPanel(page, `rails-tabs-expanded-${themeMode}`);
          await sidePanel(page).getByRole("button", { name: "Restore side panel" }).click();

          await sidePanel(page).getByRole("button", { name: "Close", exact: true }).click();
          await expect.poll(() => sidePanel(page).count()).toBe(0);
          await page.locator(".chat-side-panel-toggle").click();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeCloseTo(resizedWidth, 0);

          await page.reload();
          await page.locator(".chat-group").first().waitFor();
          await sidePanel(page).waitFor();
          expect(await tabLabels(page)).toEqual([
            "Files",
            "Review",
            "Terminal",
            "Tasks",
            "Browser",
            "Side chat",
            "Desktop",
          ]);
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeCloseTo(resizedWidth, 0);
          expect(
            await sidePanel(page)
              .locator(":scope > .side-panel__header wa-tab[active] .tabstrip-tab__label")
              .textContent(),
          ).toContain("Files");

          await page.keyboard.press("Meta+Shift+B");
          await expect.poll(async () => (await tabLabels(page)).includes("Files")).toBe(false);
          await page.keyboard.press("Meta+Shift+B");
          await expect.poll(async () => (await tabLabels(page)).at(-1)).toBe("Files");
          await page.keyboard.press("Control+Backquote");
          await expect
            .poll(() =>
              sidePanel(page)
                .locator(":scope > .side-panel__header wa-tab[active] .tabstrip-tab__label")
                .textContent(),
            )
            .toContain("Terminal");
          await page.keyboard.press("Control+Backquote");
          await expect.poll(async () => (await tabLabels(page)).includes("Terminal")).toBe(false);

          for (const label of ["Review", "Tasks", "Browser", "Side chat", "Desktop", "Files"]) {
            await sidePanel(page)
              .locator(":scope > .side-panel__header")
              .getByRole("button", { name: `Close ${label}`, exact: true })
              .click();
          }
          await expect.poll(() => sidePanel(page).count()).toBe(0);
          await page.reload();
          await page.locator(".chat-group").first().waitFor();
          await expect.poll(() => sidePanel(page).count()).toBe(0);
          await page.locator(".chat-side-panel-toggle").click();
          await sidePanel(page).locator(".side-panel-empty--selector").waitFor();
          expect(await sidePanel(page).locator("wa-tab").count()).toBe(0);
          const emptyDividerBox = await divider.boundingBox();
          expect(emptyDividerBox).not.toBeNull();
          await page.mouse.move(
            emptyDividerBox!.x + 1,
            emptyDividerBox!.y + emptyDividerBox!.height / 2,
          );
          await page.mouse.down();
          await page.mouse.move(
            emptyDividerBox!.x - 70,
            emptyDividerBox!.y + emptyDividerBox!.height / 2,
          );
          await page.mouse.up();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeGreaterThan(resizedWidth + 50);
          const emptyResizedWidth = await sidePanel(page).evaluate(
            (element) => element.getBoundingClientRect().width,
          );
          await divider.evaluate((element) => element.blur());
          await captureRichPanel(page, `rails-tabs-empty-resized-${themeMode}`);

          await page.reload();
          await page.locator(".chat-group").first().waitFor();
          await sidePanel(page).locator(".side-panel-empty--selector").waitFor();
          expect(await divider.boundingBox()).not.toBeNull();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeCloseTo(emptyResizedWidth, 0);
          await openFromEmpty(page, "Terminal");
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeCloseTo(emptyResizedWidth, 0);
          const terminalLabel = sidePanel(page)
            .locator(sidePanelTabLabelSelector)
            .filter({ hasText: "Terminal" });
          await expect
            .poll(() =>
              terminalLabel.evaluate((label) => {
                const element = label as HTMLElement;
                return {
                  fits: element.scrollWidth <= element.clientWidth + 1,
                  mask: getComputedStyle(element.parentElement!).maskImage,
                };
              }),
            )
            .toEqual({ fits: true, mask: "none" });
          const terminalTabGeometry = await terminalLabel.evaluate((label) => {
            const tab = label.closest<HTMLElement>("wa-tab");
            const group = tab?.closest("wa-tab-group");
            const tabs = group?.shadowRoot?.querySelector<HTMLElement>('[part~="tabs"]');
            return {
              availableWidth: tabs?.getBoundingClientRect().width ?? 0,
              tabWidth: tab?.getBoundingClientRect().width ?? 0,
            };
          });
          expect(terminalTabGeometry.tabWidth).toBeLessThan(
            terminalTabGeometry.availableWidth - 12,
          );
          await captureRichPanel(page, `rails-tabs-single-${themeMode}`);
          const terminalTooltip = terminalLabel.locator("../..");
          await terminalLabel.locator("..").hover();
          await page.waitForTimeout(200);
          expect(
            await terminalTooltip
              .locator("wa-tooltip")
              .evaluate((tooltip) => Reflect.get(tooltip, "open")),
          ).toBe(false);
          await openFromPlus(page, "Review");
          await openFromPlus(page, "Tasks");
          await sidePanel(page)
            .getByRole("button", { name: "Close Terminal", exact: true })
            .click();
          await expect.poll(() => tabLabels(page)).toEqual(["Review", "Tasks"]);
          // Closing back down to a strip that fits must release the shrink state:
          // the in-pill fade is a symptom of overflow, so labels that fit again
          // report their natural width and carry no mask.
          await expect
            .poll(() =>
              sidePanel(page)
                .locator(sidePanelTabLabelSelector)
                .evaluateAll((labels) =>
                  labels.every((label) => {
                    const element = label as HTMLElement;
                    const trigger = element.parentElement;
                    const mask = trigger ? getComputedStyle(trigger).maskImage : "none";
                    return (
                      element.scrollWidth <= element.clientWidth + 1 &&
                      !element.classList.contains("is-overflowing") &&
                      trigger?.classList.contains("has-label-overflow") === false &&
                      mask === "none"
                    );
                  }),
                ),
            )
            .toBe(true);
          await captureRichPanel(page, `rails-tabs-reflow-${themeMode}`);
        },
      );
    },
  );

  it("keeps navigation usable on a mobile viewport", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
      async ({ page }) => {
        await seedSettings(page, "light");
        const gateway = await installMockGateway(page, scenario());
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".chat-group").first().waitFor();
        await activateChatHeaderPanelAction(page, "Show session files");
        await openFromPlus(page, "Terminal");
        await openFromPlus(page, "Side chat");
        await selectTab(page, "Side chat");
        await expect.poll(async () => tabLabels(page)).toEqual(["Files", "Terminal", "Side chat"]);
        await expect.poll(() => narrowestRailTabLabel(page)).toBeGreaterThanOrEqual(24);

        const geometry = await sidePanel(page).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.width).toBeGreaterThan(300);

        const companion = sidePanel(page).locator("openclaw-chat-session-rail");
        const companionGeometry = await companion.locator(".chat-session-rail").evaluate((rail) => {
          const body = rail.closest(".side-panel__body");
          const bodyRect = body?.getBoundingClientRect();
          const railRect = rail.getBoundingClientRect();
          return {
            bodyBottom: bodyRect?.bottom ?? 0,
            bodyTop: bodyRect?.top ?? 0,
            railBottom: railRect.bottom,
            railTop: railRect.top,
          };
        });
        expect(companionGeometry.railTop).toBeGreaterThanOrEqual(companionGeometry.bodyTop - 1);
        expect(companionGeometry.railBottom).toBeLessThanOrEqual(companionGeometry.bodyBottom + 1);

        const mainComposer = page.getByRole("textbox", { name: "Message OpenClaw", exact: true });
        await mainComposer.click();
        expect(await mainComposer.evaluate((element) => element === document.activeElement)).toBe(
          true,
        );
        const input = companion.getByRole("textbox", { name: "Ask the session companion" });
        await input.fill("Can I use side chat here?");
        await companion.getByRole("button", { name: "Ask", exact: true }).click();
        const request = await gateway.waitForRequest("sessions.companion.ask");
        expect(request.params).toEqual({
          agentId: "main",
          question: "Can I use side chat here?",
          sessionKey,
        });
        await companion
          .getByText("The mobile side chat stayed inside its panel.", { exact: true })
          .waitFor();
        const companionActions = sidePanel(page).getByRole("button", {
          name: "More companion actions",
        });
        await companionActions.click();
        await sidePanel(page)
          .locator('wa-dropdown-item[value="clear"]')
          .waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await captureRichPanel(page, "rails-side-chat-mobile-light");

        await sidePanel(page).getByRole("button", { name: "Expand side panel" }).click();
        await expect
          .poll(() =>
            page
              .locator(".sidebar-region__primary")
              .evaluate((element) => getComputedStyle(element).display),
          )
          .toBe("none");
        await expectExpandedSidePanelFillsRegion(page);
        await captureRichPanel(page, "rails-tabs-mobile-light");
      },
    );
  });
});
