import { Buffer } from "node:buffer";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installDesktopClientFake } from "./desktop-rfb-test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat sidebar cold-open invariant",
  startServerBeforeBrowser: true,
});

const HIDDEN_BOARD_SESSION_KEY = "agent:main:hidden-board-slot";
const RETAINED_DESKTOP_SESSION_KEY = "agent:main:retained-desktop-slot";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPcAAAAASUVORK5CYII=",
  "base64",
);

type ColdOpenOutcome = {
  outcome: "content" | "generic-empty";
  emptyStateOffersAction: boolean;
};

const offeredSlotLabels = [
  "Review",
  "Terminal",
  "Browser",
  "Files",
  "Side chat",
  "Tasks",
  "Desktop",
  "Discussion",
] as const;

type OfferedSlotLabel = (typeof offeredSlotLabels)[number];

const actionlessEmptyStateAllowlist = new Set<OfferedSlotLabel>([
  // Review: no git checkout, nothing to diff.
  "Review",
  // Tasks: no background tasks, nothing to inspect.
  "Tasks",
  // Discussion: no external URL, nothing to open.
  "Discussion",
]);

function coldOpenScenario(): ControlUiMockGatewayScenario {
  return {
    featureMethods: [
      "browser.request",
      "chat.metadata",
      "chat.startup",
      "desktop.observe",
      "environments.list",
      "session.discussion.info",
      "session.discussion.open",
      "sessions.companion.state",
      "sessions.diff",
      "sessions.files.list",
      "tasks.list",
      "terminal.open",
    ],
    methodResponses: {
      "browser.request": {
        cases: [
          { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
        ],
      },
      "environments.list": { environments: [] },
      "session.discussion.info": {
        state: "open",
      },
      "sessions.files.list": {
        browser: { entries: [], path: "" },
        files: [],
        gitCheckout: false,
        root: "/tmp/plain-workspace",
        sessionKey: "main",
      },
      "tasks.list": { tasks: [] },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/tmp/plain-workspace",
        sessionId: "cold-open-terminal",
        shell: "/bin/zsh",
      },
    },
    terminalEnabled: true,
    workspace: "/tmp/plain-workspace",
    workspaceGit: false,
  };
}

function populatedColdOpenScenario(): ControlUiMockGatewayScenario {
  const sparse = coldOpenScenario();
  return {
    ...sparse,
    methodResponses: {
      ...sparse.methodResponses,
      "browser.request": {
        cases: [
          {
            match: { method: "GET", path: "/tabs" },
            response: {
              running: true,
              tabs: [
                {
                  targetId: "target-1",
                  tabId: "tab-1",
                  title: "OpenClaw",
                  url: "https://example.test/",
                },
              ],
            },
          },
          {
            match: { method: "POST", path: "/screenshot" },
            response: {
              path: "/proof/browser.png",
              targetId: "target-1",
              url: "https://example.test/",
            },
          },
        ],
      },
      "environments.list": {
        environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
      },
      "session.discussion.info": {
        embedUrl: "https://discussion.example/embed/thread/session",
        openUrl: "https://discussion.example/session",
        state: "open",
      },
      "sessions.companion.state": {
        exchanges: [
          {
            question: "What changed?",
            answer: "Every offered panel now opens with useful content.",
            ts: Date.now() - 1_000,
          },
        ],
      },
      "sessions.diff": {
        additions: 1,
        baseRef: "main",
        branch: "feature/sidebar-invariant",
        deletions: 0,
        files: [
          {
            additions: 1,
            deletions: 0,
            patch: [
              "diff --git a/README.md b/README.md",
              "--- a/README.md",
              "+++ b/README.md",
              "@@ -1 +1,2 @@",
              " OpenClaw",
              "+Cold-open invariant",
              "",
            ].join("\n"),
            path: "README.md",
            status: "modified",
          },
        ],
        root: "/tmp/checkout",
        sessionKey: "main",
      },
      "sessions.files.list": {
        browser: {
          entries: [{ kind: "file", name: "README.md", path: "README.md" }],
          path: "",
        },
        files: [
          {
            kind: "modified",
            missing: false,
            name: "README.md",
            path: "/tmp/checkout/README.md",
            size: 128,
          },
        ],
        gitCheckout: true,
        root: "/tmp/checkout",
        sessionKey: "main",
      },
      "tasks.list": {
        tasks: [
          {
            agentId: "main",
            createdAt: Date.now() - 2_000,
            id: "task-sidebar-invariant",
            kind: "subagent",
            ownerKey: "main",
            progressSummary: "Checking every offered panel",
            runtime: "subagent",
            startedAt: Date.now() - 1_000,
            status: "running",
            taskId: "task-sidebar-invariant",
            title: "Verify cold-open behavior",
            updatedAt: Date.now(),
          },
        ],
      },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/tmp/checkout",
        sessionId: "cold-open-terminal",
        shell: "/bin/zsh",
      },
    },
    workspace: "/tmp/checkout",
    workspaceGit: true,
  };
}

async function openColdSidebar(page: Page, scenario = coldOpenScenario()) {
  await page.route("**/__openclaw__/assistant-media?*", (route) =>
    route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png" }),
  );
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiGatewayReady(page);
  await gateway.waitForRequest("session.discussion.info");
  await gateway.waitForRequest("sessions.companion.state");
  await gateway.waitForRequest("sessions.files.list");
  await page.getByRole("button", { name: "Side panel", exact: true }).first().click();
  const choices = page.locator(".side-panel-empty__type");
  await choices.first().waitFor();
  return choices;
}

async function seedHiddenBoardSlot(page: Page) {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, sessionKey }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          sessionKey,
          sidebarSessionLayouts: {
            [sessionKey]: {
              columns: [
                {
                  id: "side-panel-column",
                  side: "right",
                  panels: [{ id: "chat", slot: "chat" }],
                  activePanelId: "chat",
                  height: 360,
                  width: 480,
                },
              ],
              dock: "right",
              open: true,
              expanded: false,
            },
          },
        }),
      );
    },
    { key: settingsKey, sessionKey: HIDDEN_BOARD_SESSION_KEY },
  );
}

async function seedRetainedDesktopSlot(page: Page) {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, sessionKey }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          sessionKey,
          sidebarSessionLayouts: {
            [sessionKey]: {
              columns: [
                {
                  id: "side-panel-column",
                  side: "right",
                  panels: [
                    { id: "workspace", slot: "workspace" },
                    { id: "desktop", slot: "desktop" },
                  ],
                  activePanelId: "workspace",
                  height: 360,
                  width: 480,
                },
              ],
              dock: "right",
              open: true,
              expanded: false,
            },
          },
        }),
      );
      localStorage.setItem(
        "openclaw.desktopPanel",
        JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
      );
    },
    { key: settingsKey, sessionKey: RETAINED_DESKTOP_SESSION_KEY },
  );
}

function retainedDesktopScenario(): ControlUiMockGatewayScenario {
  return {
    ...coldOpenScenario(),
    sessionKey: RETAINED_DESKTOP_SESSION_KEY,
    methodResponses: {
      ...coldOpenScenario().methodResponses,
      "environments.list": {
        environments: [
          {
            id: "worker-desktop-1",
            type: "worker",
            status: "available",
            desktop: true,
            worker: {
              providerId: "crabbox",
              state: "attached",
              ageMs: 1_000,
              attachedSessionIds: [RETAINED_DESKTOP_SESSION_KEY],
              tunnelStatus: "connected",
              desktopApps: [],
            },
          },
        ],
      },
      "desktop.observe": {
        transport: "rfb",
        wsPath: "/desktop/observe?token=retained",
        expiresAtMs: 60_000,
        control: false,
      },
    },
  };
}

async function clickSidebarTab(page: Page, label: string): Promise<void> {
  await page.locator(".side-panel__header .tabstrip-tab").filter({ hasText: label }).click();
}

async function readColdOpenOutcome(page: Page): Promise<ColdOpenOutcome> {
  const activePanel = page.locator(".side-panel__panel:not([hidden])");
  await activePanel.waitFor();
  await activePanel.locator(":scope > *").first().waitFor();
  const emptyState = activePanel.locator("openclaw-panel-empty-state").first();
  const genericEmptyState = (await emptyState.count()) > 0;
  return {
    outcome: genericEmptyState ? "generic-empty" : "content",
    emptyStateOffersAction:
      genericEmptyState &&
      (await activePanel.locator('[slot="action"], a[href], button:not([disabled])').count()) > 0,
  };
}

async function offeredLabels(page: Page, scenario: ControlUiMockGatewayScenario) {
  const choices = await openColdSidebar(page, scenario);
  return choices.locator(".side-panel-type-option__label").allTextContents();
}

async function readSlotColdOpenOutcome(
  label: OfferedSlotLabel,
  scenario: ControlUiMockGatewayScenario,
  expectedOutcome?: ColdOpenOutcome["outcome"],
): Promise<ColdOpenOutcome> {
  const context = await suite.newBrowserContext({ serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    const choices = await openColdSidebar(page, scenario);
    await choices.filter({ hasText: label }).click();
    if (expectedOutcome) {
      await expect
        .poll(() => readColdOpenOutcome(page), { message: `${label} cold-open outcome` })
        .toMatchObject({ outcome: expectedOutcome });
    } else {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
    }
    return await readColdOpenOutcome(page);
  } finally {
    await suite.closeBrowserContext(context);
  }
}

suite.define(() => {
  it("closes a projected-empty side panel when a hidden board tab remains persisted", async () => {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      await seedHiddenBoardSlot(page);
      await installMockGateway(page, {
        ...coldOpenScenario(),
        sessionKey: HIDDEN_BOARD_SESSION_KEY,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);

      const panel = page.locator(".sidebar-region__right-runtime .side-panel");
      await panel.locator(".side-panel-empty--selector").waitFor();
      expect(await panel.locator("wa-tab").count()).toBe(0);

      await panel.getByRole("button", { name: "Close", exact: true }).click();
      await expect.poll(() => panel.count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("refreshes retained Browser state when its sidebar tab becomes active", async () => {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      await page.route("**/__openclaw__/assistant-media?*", (route) =>
        route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png" }),
      );
      const gateway = await installMockGateway(page, {
        featureMethods: ["browser.request", "chat.metadata", "chat.startup"],
        methodResponses: {
          "browser.request": {
            cases: [
              {
                match: { method: "GET", path: "/tabs" },
                response: { running: true, tabs: [] },
              },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);
      await openChatSidePanelType(page, "Browser");
      const browser = page.locator("openclaw-browser-panel");
      await browser.locator("openclaw-panel-empty-state").waitFor();

      const initialRequests = await gateway.getRequests("browser.request");
      expect(initialRequests.map((request) => request.params)).toEqual([
        { method: "GET", path: "/tabs" },
      ]);

      await openChatSidePanelType(page, "Files");
      expect(await browser.evaluate((element) => element.isConnected)).toBe(true);
      const hiddenRequestCount = (await gateway.getRequests("browser.request")).length;
      await gateway.setMethodResponse("browser.request", {
        cases: [
          {
            match: { method: "GET", path: "/tabs" },
            response: {
              running: true,
              tabs: [
                {
                  targetId: "blacksmith-target",
                  tabId: "blacksmith-tab",
                  title: "Blacksmith",
                  url: "https://blacksmith.sh/",
                },
              ],
            },
          },
          {
            match: { method: "POST", path: "/screenshot" },
            response: {
              path: "/proof/blacksmith.png",
              targetId: "blacksmith-target",
              url: "https://blacksmith.sh/",
            },
          },
        ],
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect((await gateway.getRequests("browser.request")).length).toBe(hiddenRequestCount);

      await page
        .locator(".side-panel__header .tabstrip-tab")
        .filter({ hasText: "Browser" })
        .click();
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("browser.request");
          return requests.filter((request) => {
            const params = request.params as { method?: string; path?: string };
            return params.method === "GET" && params.path === "/tabs";
          }).length;
        })
        .toBe(2);
      await expect
        .poll(async () =>
          (await gateway.getRequests("browser.request")).map((request) => request.params),
        )
        .toContainEqual({
          body: { targetId: "blacksmith-tab", type: "png" },
          method: "POST",
          path: "/screenshot",
        });

      await browser.locator(".bp-shot").waitFor();
      expect(await browser.locator(".bp-shot").getAttribute("src")).toMatch(
        /^data:image\/png;base64,/,
      );
      expect(await browser.locator(".bp-url").inputValue()).toBe("https://blacksmith.sh/");
      expect(await browser.locator(".bp-loading").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps a retained Desktop dormant until its sidebar tab is active", async () => {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      await seedRetainedDesktopSlot(page);
      const gateway = await installMockGateway(page, retainedDesktopScenario());
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);

      const desktop = page.locator("openclaw-desktop-panel");
      await desktop.waitFor({ state: "attached" });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(await desktop.evaluate((element) => element.isConnected)).toBe(true);
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);

      await clickSidebarTab(page, "Desktop");
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBe(1);
      await clickSidebarTab(page, "Files");
      expect(await desktop.evaluate((element) => element.isConnected)).toBe(true);
      expect(await gateway.getRequests("environments.list")).toHaveLength(1);

      await clickSidebarTab(page, "Desktop");
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBe(2);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("tears down retained Desktop work on presentation loss", async () => {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const gateway = await installMockGateway(page, retainedDesktopScenario());
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);
      await openChatSidePanelType(page, "Desktop");

      const desktop = page.locator("openclaw-desktop-panel");
      await desktop.getByText("worker-desktop-1", { exact: true }).waitFor();
      await installDesktopClientFake(desktop);
      await gateway.deferNext("desktop.observe");
      const observeCount = (await gateway.getRequests("desktop.observe")).length;
      await desktop.getByRole("button", { name: "Connect", exact: true }).click();
      await gateway.waitForRequest("desktop.observe", { after: observeCount });

      await openChatSidePanelType(page, "Files");
      await gateway.resolveDeferred("desktop.observe", {
        transport: "rfb",
        wsPath: "/desktop/observe?token=stale",
        expiresAtMs: 60_000,
        control: false,
      });
      await page.evaluate(() => Promise.resolve());

      expect(await desktop.getAttribute("data-connect-count")).toBeNull();
      expect(await desktop.evaluate((element) => element.isConnected)).toBe(true);

      const inventoryBeforeReactivation = (await gateway.getRequests("environments.list")).length;
      await clickSidebarTab(page, "Desktop");
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBe(inventoryBeforeReactivation + 1);
      await desktop.getByText("Desktop sources", { exact: true }).waitFor();

      await desktop.getByRole("button", { name: "Connect", exact: true }).click();
      await expect.poll(() => desktop.getAttribute("data-connect-count")).toBe("1");
      await clickSidebarTab(page, "Files");

      expect(await desktop.evaluate((element) => element.isConnected)).toBe(true);
      expect(await desktop.getAttribute("data-disconnect-count")).toBe("1");

      const inventoryBeforeSecondReactivation = (await gateway.getRequests("environments.list"))
        .length;
      const observeBeforeSecondReactivation = (await gateway.getRequests("desktop.observe")).length;
      await clickSidebarTab(page, "Desktop");
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBe(inventoryBeforeSecondReactivation + 1);
      await desktop.getByText("Desktop sources", { exact: true }).waitFor();

      expect(await gateway.getRequests("desktop.observe")).toHaveLength(
        observeBeforeSecondReactivation,
      );
      expect(await desktop.getAttribute("data-connect-count")).toBe("1");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("preserves the production header-action shapes for Side chat and Discussion", async () => {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const choices = await openColdSidebar(page, populatedColdOpenScenario());

    await choices.filter({ hasText: "Side chat" }).click();
    const contentActions = page.locator(".side-panel__action-group--content");
    const companionMenu = contentActions.locator("wa-dropdown.chat-session-rail__menu");
    await companionMenu.waitFor();
    expect(await companionMenu.count()).toBe(1);
    expect(await contentActions.locator(":scope > button").count()).toBe(0);

    const tab = page.locator(".side-panel__header .tabstrip-tab[active]");
    for (const direction of ["ltr", "rtl"] as const) {
      const tabPadding = await tab.evaluate((node, dir) => {
        const panel = node.closest(".side-panel");
        if (!(panel instanceof HTMLElement)) {
          throw new Error("Active side-panel tab must render inside the side panel");
        }
        panel.dir = dir;
        const tabBase = node.shadowRoot?.querySelector<HTMLElement>("[part~='base']");
        const leadingGlyph = node.querySelector<HTMLElement>(".tabstrip-tab__icon svg");
        const label = node.querySelector<HTMLElement>(".tabstrip-tab__label");
        const labelClipper = node.querySelector<HTMLElement>(".tabstrip-tab__tooltip-trigger");
        const close = node.nextElementSibling;
        const trailingGlyph = close?.querySelector<HTMLElement>("svg");
        if (
          !(close instanceof HTMLElement) ||
          !tabBase ||
          !leadingGlyph ||
          !label ||
          !labelClipper ||
          !trailingGlyph
        ) {
          throw new Error("Active side-panel tab must render its label and both edge glyphs");
        }
        const tabBounds = tabBase.getBoundingClientRect();
        const closeBounds = close.getBoundingClientRect();
        const leadingBounds = leadingGlyph.getBoundingClientRect();
        const labelBounds = label.getBoundingClientRect();
        const labelClipperBounds = labelClipper.getBoundingClientRect();
        const trailingBounds = trailingGlyph.getBoundingClientRect();
        const rtl = dir === "rtl";
        const tabStyle = getComputedStyle(tabBase);
        const closeStyle = getComputedStyle(close);
        return {
          leading: rtl
            ? tabBounds.right - leadingBounds.right
            : leadingBounds.left - tabBounds.left,
          trailing: rtl
            ? trailingBounds.left - closeBounds.left
            : closeBounds.right - trailingBounds.right,
          labelBlockStartInset: labelBounds.top - labelClipperBounds.top,
          labelBlockEndInset: labelClipperBounds.bottom - labelBounds.bottom,
          tabOuterRadius: Number.parseFloat(
            rtl ? tabStyle.borderTopRightRadius : tabStyle.borderTopLeftRadius,
          ),
          tabJoinRadius: Number.parseFloat(
            rtl ? tabStyle.borderTopLeftRadius : tabStyle.borderTopRightRadius,
          ),
          closeJoinRadius: Number.parseFloat(
            rtl ? closeStyle.borderTopRightRadius : closeStyle.borderTopLeftRadius,
          ),
          closeOuterRadius: Number.parseFloat(
            rtl ? closeStyle.borderTopLeftRadius : closeStyle.borderTopRightRadius,
          ),
        };
      }, direction);
      expect(tabPadding.trailing, `${direction} glyph insets`).toBeCloseTo(tabPadding.leading, 0);
      expect(
        tabPadding.labelBlockStartInset,
        `${direction} label block-start containment`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        tabPadding.labelBlockEndInset,
        `${direction} label block-end containment`,
      ).toBeGreaterThanOrEqual(0);
      expect(tabPadding.tabJoinRadius, `${direction} tab join`).toBe(0);
      expect(tabPadding.closeJoinRadius, `${direction} close join`).toBe(0);
      expect(tabPadding.tabOuterRadius, `${direction} tab outer`).toBeGreaterThan(0);
      expect(tabPadding.closeOuterRadius, `${direction} close outer`).toBeGreaterThan(0);
    }
    await tab.evaluate((node) => {
      const panel = node.closest(".side-panel");
      if (panel instanceof HTMLElement) {
        panel.removeAttribute("dir");
      }
    });

    await page.locator(".side-panel-type-menu__trigger").click();
    await page.locator(".side-panel-type-menu__item").filter({ hasText: "Discussion" }).click();
    const discussionAction = contentActions.locator(
      ':scope > a.rail-header__action[target="_blank"]',
    );
    await discussionAction.waitFor();
    expect(await discussionAction.getAttribute("href")).toBe("https://discussion.example/session");

    await suite.closeBrowserContext(context);
  });

  it("renders content for every offered slot with backing data", async () => {
    const probeContext = await suite.newBrowserContext({ serviceWorkers: "block" });
    try {
      const offered = await offeredLabels(
        await probeContext.newPage(),
        populatedColdOpenScenario(),
      );
      expect(offered).toEqual(offeredSlotLabels);
    } finally {
      await suite.closeBrowserContext(probeContext);
    }

    for (const label of offeredSlotLabels) {
      expect(
        await readSlotColdOpenOutcome(label, populatedColdOpenScenario(), "content"),
        `${label} must render content when its backing capability has data`,
      ).toEqual({ outcome: "content", emptyStateOffersAction: false });
    }
  });

  it("keeps generic empty states actionable or explicitly allowlisted", async () => {
    const probeContext = await suite.newBrowserContext({ serviceWorkers: "block" });
    try {
      const offered = await offeredLabels(await probeContext.newPage(), coldOpenScenario());
      expect(offered).toEqual(offeredSlotLabels);
    } finally {
      await suite.closeBrowserContext(probeContext);
    }

    const observedActionlessEmptyStates: OfferedSlotLabel[] = [];
    for (const label of offeredSlotLabels) {
      const outcome = await readSlotColdOpenOutcome(label, coldOpenScenario());
      if (outcome.outcome !== "generic-empty" || outcome.emptyStateOffersAction) {
        continue;
      }
      expect(
        actionlessEmptyStateAllowlist.has(label),
        `${label} renders the generic empty state without an action`,
      ).toBe(true);
      observedActionlessEmptyStates.push(label);
    }

    expect(observedActionlessEmptyStates).toEqual([...actionlessEmptyStateAllowlist]);
  });
});
