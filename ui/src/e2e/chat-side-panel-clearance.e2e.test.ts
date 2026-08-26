import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import {
  activateChatHeaderPanelAction,
  failNextDeviceIdentityMint,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat side-panel shell clearance",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:side-panel-clearance";
const proofDir = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
const limitedScopes = ["operator.read", "operator.write"];
const historyMessages = [
  {
    id: "side-panel-clearance-user",
    role: "user",
    content: [{ type: "text", text: "Keep the panel header controls reachable." }],
    timestamp: Date.now() - 60_000,
  },
  {
    id: "side-panel-clearance-assistant",
    role: "assistant",
    content: [{ type: "text", text: "The panel header now clears every shell control." }],
    timestamp: Date.now(),
  },
];

function scenario(
  options: {
    custodian?: boolean;
    operatorScopes?: string[];
    updateAvailable?: ControlUiMockGatewayScenario["updateAvailable"];
  } = {},
): ControlUiMockGatewayScenario {
  return {
    featureMethods: [
      "device.scopes.requestUpgrade",
      "device.scopes.waitUpgrade",
      ...(options.custodian ? ["openclaw.chat"] : []),
    ],
    historyMessages,
    methodResponses: {
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
    },
    ...(options.operatorScopes ? { operatorScopes: options.operatorScopes } : {}),
    ...(options.updateAvailable ? { updateAvailable: options.updateAvailable } : {}),
    sessionKey,
    workspace: "/workspace/openclaw",
    workspaceGit: true,
  };
}

async function seedSettings(page: Page, themeMode: "light" | "dark") {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, seededSessionKey, seededThemeMode }) => {
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
    { key: settingsKey, seededSessionKey: sessionKey, seededThemeMode: themeMode },
  );
}

function sidePanel(page: Page): Locator {
  return page.locator(".sidebar-region__right-runtime .side-panel");
}

async function openExpandedFilesPanel(page: Page, beforeExpandProof?: string): Promise<void> {
  await page.goto(`${suite.server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
  await page.locator(".chat-group").first().waitFor();
  await activateChatHeaderPanelAction(page, "Show session files");
  if (beforeExpandProof) {
    await capturePanel(page, beforeExpandProof);
  }
  await sidePanel(page).getByRole("button", { name: "Expand side panel" }).click();
  await sidePanel(page).getByRole("button", { name: "Restore side panel" }).waitFor();
}

async function waitForShellLayout(page: Page): Promise<void> {
  await page.locator(".shell").evaluate(async (shell) => {
    const finiteAnimations = shell
      .getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(finiteAnimations.map((animation) => animation.finished));
  });
}

async function expectPanelHeaderControlsClearShellChrome(page: Page): Promise<void> {
  const panelControls = sidePanel(page).locator(
    ":scope > .side-panel__header :is(button, wa-tab):visible",
  );
  const panelCount = await panelControls.count();
  expect(panelCount).toBeGreaterThan(0);

  const geometry = await page.evaluate(() => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { bottom: box.bottom, left: box.left, right: box.right, top: box.top };
    };
    const header = document.querySelector(
      ".sidebar-region__right-runtime .side-panel > .side-panel__header",
    );
    if (!header) {
      throw new Error("Expanded side panel has no header");
    }
    const headerRect = rect(header);
    const headerStyle = getComputedStyle(header);
    const panels = [
      ...document.querySelectorAll(
        ".sidebar-region__right-runtime .side-panel > .side-panel__header :is(button, wa-tab):not([hidden])",
      ),
    ].map(rect);
    const shells = [
      ...document.querySelectorAll(
        ":is(.shell-chrome-controls, .macos-titlebar-controls, .sidebar-attention--floating) button:not([hidden])",
      ),
    ]
      .map(rect)
      .filter((shell) => shell.bottom > headerRect.top && shell.top < headerRect.bottom);
    return {
      contentLeft: headerRect.left + Number.parseFloat(headerStyle.paddingLeft),
      contentRight: headerRect.right - Number.parseFloat(headerStyle.paddingRight),
      direction: headerStyle.direction,
      panels,
      shells,
    };
  });

  expect(geometry.shells.length).toBeGreaterThan(0);
  const shellRight = Math.max(...geometry.shells.map((box) => box.right));
  const panelLeft = Math.min(...geometry.panels.map((box) => box.left));
  expect(geometry.contentLeft - shellRight).toBeGreaterThanOrEqual(4);
  expect(geometry.contentLeft - shellRight).toBeLessThanOrEqual(16);
  expect(panelLeft - shellRight).toBeGreaterThanOrEqual(8);
  if (geometry.direction !== "rtl") {
    expect(panelLeft - shellRight).toBeLessThanOrEqual(16);
  }
  expect(
    geometry.panels.every(
      (box) => box.left >= geometry.contentLeft - 0.5 && box.right <= geometry.contentRight + 0.5,
    ),
  ).toBe(true);
  for (let index = 0; index < panelCount; index += 1) {
    await panelControls.nth(index).click({ trial: true });
  }
}

async function capturePanel(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(proofDir, `${name}.png`) });
}

suite.define(() => {
  it.each([
    {
      beforeExpandProof: "right-docked",
      custodian: false,
      deviceLess: false,
      direction: "ltr",
      expectedControl: ".shell-chrome-controls__search",
      expectedUpdate: false,
      name: "expanded navigation",
      navCollapsed: false,
      operatorScopes: undefined,
      proof: "expanded-nav",
      themeMode: "dark" as const,
      updateAvailable: undefined,
    },
    {
      beforeExpandProof: undefined,
      custodian: false,
      deviceLess: false,
      direction: "ltr",
      expectedControl: ".shell-chrome-controls__search",
      expectedUpdate: false,
      name: "collapsed navigation",
      navCollapsed: true,
      operatorScopes: undefined,
      proof: "collapsed-nav",
      themeMode: "dark" as const,
      updateAvailable: undefined,
    },
    {
      beforeExpandProof: undefined,
      custodian: true,
      deviceLess: false,
      direction: "ltr",
      expectedControl: ".shell-chrome-controls__custodian",
      expectedUpdate: true,
      name: "collapsed navigation with custodian and attention",
      navCollapsed: true,
      operatorScopes: undefined,
      proof: "collapsed-nav-custodian-attention",
      themeMode: "dark" as const,
      updateAvailable: {
        channel: "stable",
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.2",
      },
    },
    {
      beforeExpandProof: undefined,
      custodian: false,
      deviceLess: true,
      direction: "rtl",
      expectedControl: ".sidebar-attention--floating .sidebar-issues-button",
      expectedUpdate: false,
      name: "collapsed RTL limited-access status and attention",
      navCollapsed: true,
      operatorScopes: limitedScopes,
      proof: "collapsed-rtl-limited-attention",
      themeMode: "dark" as const,
      updateAvailable: undefined,
    },
  ])("keeps expanded panel controls in a compact safe gap for $name", async (testCase) => {
    await suite.withPage(
      {
        colorScheme: testCase.themeMode,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1600 },
      },
      async ({ page }) => {
        if (testCase.deviceLess) {
          await failNextDeviceIdentityMint(page);
        }
        await seedSettings(page, testCase.themeMode);
        await installMockGateway(
          page,
          scenario({
            custodian: testCase.custodian,
            operatorScopes: testCase.operatorScopes,
            updateAvailable: testCase.updateAvailable,
          }),
        );
        await openExpandedFilesPanel(page, testCase.beforeExpandProof);
        await page.evaluate((direction) => {
          document.documentElement.dir = direction;
        }, testCase.direction);
        if (testCase.navCollapsed) {
          await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
          await expect
            .poll(() => page.locator(".shell").getAttribute("class"))
            .toContain("shell--nav-collapsed");
          await page.locator(".sidebar-attention--floating .sidebar-issues-button").waitFor();
        }
        await page.locator(testCase.expectedControl).waitFor();
        if (testCase.expectedUpdate) {
          const updateSlot = page.locator(
            ".sidebar-attention--floating .sidebar-footer-update-slot",
          );
          await updateSlot.waitFor();
          await updateSlot.hover();
          await waitForShellLayout(page);
          await expectPanelHeaderControlsClearShellChrome(page);
          await page.mouse.move(800, 700);
          await updateSlot.locator(".sidebar-footer-update").focus();
          await waitForShellLayout(page);
          await expectPanelHeaderControlsClearShellChrome(page);
        }
        await waitForShellLayout(page);
        await expectPanelHeaderControlsClearShellChrome(page);
        await capturePanel(page, testCase.proof);
      },
    );
  });
});
