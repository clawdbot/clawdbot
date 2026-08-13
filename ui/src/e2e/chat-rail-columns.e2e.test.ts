import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat rail columns",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:rail-columns";
const proofDir = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
const theme = process.env.OPENCLAW_UI_RAIL_PROOF_THEME === "dark" ? "dark" : "light";
const proofPhase = process.env.OPENCLAW_UI_RAIL_PROOF_PHASE === "before" ? "before" : "after";

const historyMessages = Array.from({ length: 8 }, (_, index) => ({
  id: `rail-proof-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: [
    {
      type: "text",
      text:
        index % 2 === 0
          ? `Review rail layout checkpoint ${index + 1}. Keep the transcript readable while supporting the work beside it.`
          : `Checkpoint ${index + 1} is ready. The column should start above this message and keep its own chrome, width, and scroll surface.`,
    },
  ],
  timestamp: Date.now() - (8 - index) * 60_000,
}));

function railScenario(): ControlUiMockGatewayScenario {
  return {
    featureMethods: [
      "browser.request",
      "chat.metadata",
      "chat.startup",
      "board.get",
      "desktop.observe",
      "environments.list",
      "openclaw.chat",
      "session.discussion.info",
      "session.discussion.open",
      "sessions.diff",
      "tasks.list",
      "terminal.open",
    ],
    historyMessages,
    methodResponses: {
      "artifacts.list": { artifacts: [] },
      "browser.request": {
        cases: [
          {
            match: { method: "GET", path: "/tabs" },
            response: { running: true, tabs: [] },
          },
        ],
      },
      "board.get": {
        sessionKey,
        revision: 1,
        tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
        widgets: [
          {
            name: "release-status",
            tabId: "main",
            title: "Release status",
            contentKind: "html",
            sizeW: 6,
            sizeH: 4,
            position: 0,
            grantState: "pending",
            revision: 1,
            frameUrl: "about:blank#release-status",
          },
        ],
      },
      "environments.list": {
        environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
      },
      "openclaw.chat": {
        sessionId: "rail-proof-custodian",
        reply: "The shared rail header contract is ready for review.",
        action: "none",
      },
      "session.discussion.info": {
        embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
        openUrl: "https://discussion.example/session",
        state: "open",
      },
      "session.discussion.open": {
        embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
        openUrl: "https://discussion.example/session",
        state: "open",
      },
      "sessions.diff": {
        sessionKey,
        root: "/workspace/openclaw",
        branch: "feature/full-height-rails",
        baseRef: "main",
        files: [
          {
            path: "ui/src/pages/chat/chat-view.ts",
            status: "modified",
            additions: 3,
            deletions: 1,
            patch: [
              "diff --git a/ui/src/pages/chat/chat-view.ts b/ui/src/pages/chat/chat-view.ts",
              "--- a/ui/src/pages/chat/chat-view.ts",
              "+++ b/ui/src/pages/chat/chat-view.ts",
              "@@ -1,2 +1,4 @@",
              " existing line",
              "+full-height rail",
              "+persisted width",
              "+shared resize handle",
              "",
            ].join("\n"),
          },
        ],
        additions: 3,
        deletions: 1,
      },
      "sessions.files.list": {
        browser: {
          path: "ui/src/pages/chat",
          entries: [
            { kind: "file", name: "chat-view.ts", path: "ui/src/pages/chat/chat-view.ts" },
            {
              kind: "file",
              name: "chat-pane-render.ts",
              path: "ui/src/pages/chat/chat-pane-render.ts",
            },
          ],
        },
        files: [
          {
            kind: "modified",
            missing: false,
            name: "chat-view.ts",
            path: "/workspace/openclaw/ui/src/pages/chat/chat-view.ts",
            size: 15_432,
          },
          {
            kind: "read",
            missing: false,
            name: "sidebar.css",
            path: "/workspace/openclaw/ui/src/styles/chat/sidebar.css",
            size: 22_840,
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
            id: "task-layout",
            kind: "subagent",
            ownerKey: sessionKey,
            sessionKey,
            progressSummary: "Comparing column geometry in both themes",
            runtime: "subagent",
            startedAt: Date.now() - 210_000,
            status: "running",
            taskId: "task-layout",
            title: "Verify rail layout",
            updatedAt: Date.now(),
          },
          {
            agentId: "main",
            createdAt: Date.now() - 420_000,
            id: "task-history",
            kind: "subagent",
            ownerKey: sessionKey,
            sessionKey,
            progressSummary: "Mapped the terminal and rail layout history",
            runtime: "subagent",
            startedAt: Date.now() - 410_000,
            status: "completed",
            taskId: "task-history",
            title: "Inspect layout history",
            updatedAt: Date.now() - 120_000,
          },
        ],
      },
      "terminal.list": { sessions: [] },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/workspace/openclaw",
        sessionId: "rail-proof-terminal",
        shell: "/bin/zsh",
      },
    },
    sessionKey,
    terminalEnabled: true,
    workspace: "/workspace/openclaw",
    workspaceGit: true,
  };
}

async function seedTheme(
  page: Page,
  options: { workspaceDock?: "bottom"; workspaceWidth?: number } = {},
): Promise<void> {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, mode, workspaceDock }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          theme: "claw",
          themeMode: mode,
          ...(workspaceDock ? { chatWorkspaceDock: workspaceDock } : {}),
          boardSessionViews: {
            "agent:main:rail-columns": { activeTabId: "main", face: "dashboard" },
          },
        }),
      );
    },
    { key: settingsKey, mode: theme, workspaceDock: options.workspaceDock },
  );
  if (options.workspaceWidth) {
    await page.addInitScript((width) => {
      localStorage.setItem(
        "openclaw.control.chat-workspace-rail.v1",
        JSON.stringify({ dock: "right", height: 320, open: false, width }),
      );
    }, options.workspaceWidth);
  }
}

async function expectFullHeightRail(page: Page, rail: Locator): Promise<void> {
  const geometry = await page.locator(".chat-split-view__cell").evaluate(
    (cell, railElement) => {
      if (!(railElement instanceof HTMLElement)) {
        throw new Error("Rail element is missing");
      }
      const cellRect = cell.getBoundingClientRect();
      const railRect = railElement.getBoundingClientRect();
      const headerRect = cell
        .querySelector<HTMLElement>(".chat-pane__header")
        ?.getBoundingClientRect();
      return {
        cellTop: cellRect.top,
        headerBottom: headerRect?.bottom ?? 0,
        railTop: railRect.top,
      };
    },
    await rail.elementHandle(),
  );
  expect(
    Math.abs(geometry.railTop - geometry.cellTop),
    JSON.stringify(geometry),
  ).toBeLessThanOrEqual(1);
  expect(geometry.railTop, JSON.stringify(geometry)).toBeLessThan(geometry.headerBottom - 10);
}

async function expectSharedRailHeaders(page: Page, headers: Locator[]): Promise<void> {
  await Promise.all(headers.map((header) => header.waitFor({ state: "visible" })));
  const metrics = await Promise.all(
    headers.map((header) =>
      header.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          alignItems: style.alignItems,
          borderBottomColor: style.borderBottomColor,
          borderBottomWidth: style.borderBottomWidth,
          height: element.getBoundingClientRect().height,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
        };
      }),
    ),
  );
  expect(
    metrics.every((metric) => Math.abs(metric.height - 48) <= 1),
    JSON.stringify(metrics),
  ).toBe(true);
  expect(new Set(metrics.map((metric) => metric.borderBottomColor)).size).toBe(1);
  for (const metric of metrics) {
    expect(metric).toMatchObject({
      alignItems: "center",
      borderBottomWidth: "1px",
      paddingLeft: "12px",
      paddingRight: "8px",
    });
  }
}

async function expectSingleRailSeparator(page: Page, selector: string): Promise<void> {
  const separators = page.locator(selector);
  await separators.first().waitFor();
  const metrics = await separators.evaluateAll((elements) =>
    elements.map((element) => {
      const line = getComputedStyle(element, "::after");
      const probe = document.createElement("div");
      probe.style.background = "var(--rail-divider-color)";
      document.body.append(probe);
      const railDivider = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { background: line.backgroundColor, railDivider, width: line.width };
    }),
  );
  expect(metrics.length).toBeGreaterThan(0);
  for (const metric of metrics) {
    expect(metric.width).toBe("1px");
    expect(metric.background).toBe(metric.railDivider);
  }
}

async function expectSharedRailActions(page: Page, actions: Locator[]): Promise<void> {
  const metrics = [];
  for (const [index, action] of actions.entries()) {
    await action.waitFor();
    const rest = await action.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const glyph = element.querySelector("svg")?.getBoundingClientRect();
      return {
        background: style.backgroundColor,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        borderRightWidth: style.borderRightWidth,
        borderTopWidth: style.borderTopWidth,
        color: style.color,
        height: rect.height,
        opacity: style.opacity,
        glyphHeight: glyph?.height ?? 0,
        glyphWidth: glyph?.width ?? 0,
        width: rect.width,
      };
    });
    await action.hover();
    const hover = await action.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
    const sentinelId = `rail-focus-sentinel-${index}`;
    await action.evaluate((element, id) => {
      const sentinel = document.createElement("button");
      sentinel.id = id;
      sentinel.type = "button";
      sentinel.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
      element.before(sentinel);
      sentinel.focus();
    }, sentinelId);
    await page.keyboard.press("Tab");
    const focus = await action.evaluate((element) => {
      const style = getComputedStyle(element);
      const root = element.getRootNode();
      const activeElement =
        root instanceof ShadowRoot ? root.activeElement : document.activeElement;
      return {
        active: activeElement === element,
        background: style.backgroundColor,
        color: style.color,
        focusVisible: element.matches(":focus-visible"),
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    await page.locator(`#${sentinelId}`).evaluate((element) => element.remove());
    await action.evaluate((element) => (element as HTMLElement).blur());
    metrics.push({ focus, hover, rest });
  }
  expect(
    metrics.every(
      ({ rest }) =>
        Math.abs(rest.width - 28) <= 1 &&
        Math.abs(rest.height - 28) <= 1 &&
        Math.abs(rest.glyphWidth - 16) <= 1 &&
        Math.abs(rest.glyphHeight - 16) <= 1,
    ),
    JSON.stringify(metrics),
  ).toBe(true);
  for (const metric of metrics) {
    expect(metric.rest).toMatchObject({
      background: "rgba(0, 0, 0, 0)",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
      borderRightWidth: "0px",
      borderTopWidth: "0px",
      opacity: "1",
    });
    expect(metric.hover.background).toBe("rgba(0, 0, 0, 0)");
    expect(metric.focus).toMatchObject({
      active: true,
      background: "rgba(0, 0, 0, 0)",
      focusVisible: true,
      outlineStyle: "solid",
    });
  }
  expect(new Set(metrics.map(({ rest }) => rest.color)).size).toBe(1);
  expect(new Set(metrics.map(({ hover }) => hover.color)).size).toBe(1);
  expect(new Set(metrics.map(({ focus }) => focus.color)).size).toBe(1);
  expect(new Set(metrics.map(({ focus }) => focus.outlineColor)).size).toBe(1);
  expect(new Set(metrics.map(({ focus }) => focus.outlineWidth)).size).toBe(1);
  expect(Number.parseFloat(metrics[0]?.focus.outlineWidth ?? "0")).toBeGreaterThanOrEqual(2);
}

async function expectSharedActiveRailActions(
  activeActions: Locator[],
  inactiveActions: Locator[],
): Promise<void> {
  const read = (action: Locator) =>
    action.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        color: style.color,
        opacity: style.opacity,
      };
    });
  const active = await Promise.all(activeActions.map(read));
  const inactive = await Promise.all(inactiveActions.map(read));
  for (const metric of [...active, ...inactive]) {
    expect(metric.background).toBe("rgba(0, 0, 0, 0)");
    expect(metric.opacity).toBe("1");
  }
  expect(new Set(active.map((metric) => metric.color)).size).toBe(1);
  expect(new Set(inactive.map((metric) => metric.color)).size).toBe(1);
  expect(active[0]?.color).not.toBe(inactive[0]?.color);
}

async function navigateWithinApp(page: Page, routeId: string): Promise<void> {
  await page.evaluate((targetRouteId) => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: { context: { navigate: (route: string) => void } };
    };
    if (!app.runtime) {
      throw new Error("OpenClaw application runtime is unavailable");
    }
    app.runtime.context.navigate(targetRouteId);
  }, routeId);
}

async function capture(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  const baseName = `${proofPhase}-${name}-${theme}`;
  await page.screenshot({ path: path.join(proofDir, `${baseName}-context.png`), fullPage: true });
  await page
    .locator(".chat-split-view__cell")
    .screenshot({ path: path.join(proofDir, `${baseName}-crop.png`) });
}

suite.define(() => {
  it("keeps every chat rail full-height and restores resized inline widths", async () => {
    await suite.withPage(
      {
        colorScheme: theme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1600 },
      },
      async ({ page }) => {
        await seedTheme(page);
        await page.route("https://discussion.example/embed/channel/**", (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `<!doctype html><html><body style="margin:0;padding:20px;font:14px system-ui">
              <h2>Session discussion</h2><p>Reviewing the rail layout with the team.</p>
            </body></html>`,
          }),
        );
        const gateway = await installMockGateway(page, railScenario());
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".chat-group").first().waitFor();

        await page.getByRole("button", { name: "Show background tasks" }).click();
        await page.getByRole("button", { name: "Show session files", exact: true }).click();
        const tasks = page.locator(".chat-tasks-rail");
        const workspace = page.locator(".chat-workspace-rail");
        await tasks.waitFor();
        await workspace.waitFor();
        await expect.poll(() => tasks.textContent()).toContain("Verify rail layout");
        await page.getByRole("button", { name: "Show session companion" }).click();
        const companion = page.locator("openclaw-chat-session-rail");
        await companion.locator(".chat-session-rail--expanded").waitFor();
        await companion.getByRole("button", { name: "Close session companion" }).waitFor();
        await capture(page, "00-rail-header-contract");
        if (proofPhase === "after") {
          await expectFullHeightRail(page, tasks);
          await expectFullHeightRail(page, workspace);
          await expectFullHeightRail(page, companion);
          await expectSharedRailHeaders(page, [
            workspace.locator(".chat-workspace-rail__header"),
            tasks.locator(".chat-tasks-rail__header"),
            companion.locator(".chat-session-rail__header"),
          ]);
          await expectSingleRailSeparator(page, ".chat-workspace-rail-resizer");
          await expectSingleRailSeparator(page, ".chat-tasks-rail-resizer");
          await expect
            .poll(() =>
              page
                .locator(".chat-main")
                .evaluate((element) => element.classList.contains("chat-main--rail-docked")),
            )
            .toBe(false);
          await expect
            .poll(() =>
              companion
                .locator(".chat-session-rail--expanded")
                .evaluate((element) => getComputedStyle(element).borderLeftWidth),
            )
            .toBe("1px");
          await expectSharedRailActions(page, [
            workspace.getByRole("button", { name: "Collapse session workspace" }),
            tasks.getByRole("button", { name: "Collapse background tasks" }),
            companion.getByRole("button", { name: "Close session companion" }),
          ]);
        }
        await capture(page, "01-three-rails-default");

        if (proofPhase === "after") {
          const workspaceWidth = await workspace.evaluate(
            (element) => element.getBoundingClientRect().width,
          );
          const workspaceHandle = page.locator(".chat-workspace-rail-resizer");
          const handleBox = await workspaceHandle.boundingBox();
          expect(handleBox).not.toBeNull();
          await page.mouse.move(handleBox!.x + 2, handleBox!.y + handleBox!.height / 2);
          await page.mouse.down();
          await page.mouse.move(handleBox!.x - 84, handleBox!.y + handleBox!.height / 2);
          await page.mouse.up();
          await expect
            .poll(() => workspace.evaluate((element) => element.getBoundingClientRect().width))
            .toBeGreaterThan(workspaceWidth + 70);
          const resizedWidth = await workspace.evaluate(
            (element) => element.getBoundingClientRect().width,
          );
          await capture(page, "02-workspace-tasks-resized");

          await workspace.getByRole("button", { name: "Collapse session workspace" }).click();
          await page.getByRole("button", { name: "Show session files", exact: true }).click();
          await expect
            .poll(() => workspace.evaluate((element) => element.getBoundingClientRect().width))
            .toBeCloseTo(resizedWidth, 0);
          await capture(page, "03-workspace-tasks-reopened");
        }

        await workspace.getByRole("button", { name: "Show session changes" }).click();
        await workspace.getByRole("button", { name: "Collapse session workspace" }).click();
        await tasks.getByRole("button", { name: "Collapse background tasks" }).click();
        if (proofPhase === "after") {
          await expect
            .poll(() =>
              page
                .locator(".chat-main")
                .evaluate((element) => element.classList.contains("chat-main--rail-docked")),
            )
            .toBe(true);
          await expectSingleRailSeparator(page, ".chat-companion-rail-resizer");
          await expect
            .poll(() =>
              companion
                .locator(".chat-session-rail--expanded")
                .evaluate((element) => getComputedStyle(element).borderLeftWidth),
            )
            .toBe("0px");
        }
        const changes = page.locator('.sidebar-column[data-column-id="detail-column"]');
        await changes.waitFor();
        if (proofPhase === "after") {
          await expectFullHeightRail(page, changes);
        }
        await capture(page, "04-changes");

        await page.getByRole("button", { name: "Show discussion" }).click();
        const discussion = page.locator('.sidebar-column[data-column-id="discussion-column"]');
        await discussion.waitFor();
        await expect.poll(() => page.locator("iframe.session-discussion__frame").count()).toBe(1);
        if (proofPhase === "after") {
          await expectFullHeightRail(page, discussion);
        }
        await capture(page, "05-discussion-clickclack");

        if (proofPhase === "after") {
          await expectFullHeightRail(page, companion);
        }
        await capture(page, "06-companion");

        await page.getByRole("button", { name: "Hide discussion" }).press("Enter");
        await expect.poll(() => discussion.count()).toBe(0);

        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("openclaw:browser-toggle", { detail: { open: true } }),
          ),
        );
        const browser = page.locator("openclaw-browser-panel");
        await browser.locator(".bp-header").waitFor();
        await browser.getByRole("button", { name: "Close browser panel" }).waitFor();
        if (proofPhase === "after") {
          await expectSharedRailHeaders(page, [
            changes.locator(".sidebar-column__header"),
            companion.locator(".chat-session-rail__header"),
            browser.locator(".bp-header"),
          ]);
          await expectSingleRailSeparator(page, '.sidebar-column__divider[role="separator"]');
          await expectSingleRailSeparator(page, "openclaw-browser-panel .bp-resizer--right");
          await expectSharedRailActions(page, [
            changes.locator(".sidebar-column__actions button").last(),
            companion.getByRole("button", { name: "Close session companion" }),
            browser.getByRole("button", { name: "Close browser panel" }),
          ]);
          await expectSharedActiveRailActions(
            [browser.getByRole("button", { name: "Dock to right" })],
            [browser.getByRole("button", { name: "Dock to bottom" })],
          );
        }
        await capture(page, "07-companion-details-browser");

        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("openclaw:browser-toggle", { detail: { open: false } }),
          ),
        );

        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("openclaw:terminal-toggle", { detail: { open: true } }),
          ),
        );
        await gateway.waitForRequest("terminal.open");
        const terminal = page.locator("openclaw-terminal-panel");
        await terminal.locator(".tp").waitFor();
        if (proofPhase === "after") {
          await expectSharedRailHeaders(page, [terminal.locator(".tp-header")]);
          await expectSharedRailActions(page, [
            terminal.getByRole("button", { name: "Hide terminal" }),
          ]);
          await expectSharedActiveRailActions(
            [terminal.getByRole("button", { name: "Dock to bottom" })],
            [terminal.getByRole("button", { name: "Dock to right" })],
          );
        }
        await capture(page, "08-terminal-reference");

        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("openclaw:terminal-toggle", { detail: { open: false } }),
          ),
        );
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("openclaw:desktop-toggle", { detail: { open: true } }),
          ),
        );
        const desktop = page.locator("openclaw-desktop-panel");
        await desktop.locator(".bp-header").waitFor();
        await gateway.waitForRequest("environments.list");
        if (proofPhase === "after") {
          await expectSharedRailHeaders(page, [
            changes.locator(".sidebar-column__header"),
            companion.locator(".chat-session-rail__header"),
            desktop.locator(".bp-header"),
          ]);
          await expectSingleRailSeparator(page, "openclaw-desktop-panel .bp-resizer--right");
          // Desktop is a fixed overlay, so covered rail controls cannot receive a
          // real pointer hover. Their interactive states were exercised above.
          await expectSharedRailActions(page, [
            desktop.getByRole("button", { name: "Hide desktop panel" }),
          ]);
          await expectSharedActiveRailActions(
            [desktop.getByRole("button", { name: "Dock to right" })],
            [desktop.getByRole("button", { name: "Dock to bottom" })],
          );
        }
        await capture(page, "09-companion-details-desktop");

        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("openclaw:desktop-toggle", { detail: { open: false } }),
          ),
        );
        await navigateWithinApp(page, "custodian");
        const custodianComposer = page.getByLabel("Message OpenClaw…");
        await custodianComposer.waitFor();
        await custodianComposer.fill("Audit the shared rail header chrome.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect
          .poll(async () =>
            (await gateway.getRequests("openclaw.chat")).some(
              (request) =>
                (request.params as { message?: unknown } | undefined)?.message ===
                "Audit the shared rail header chrome.",
            ),
          )
          .toBe(true);
        await expect
          .poll(() =>
            page
              .getByText("The shared rail header contract is ready for review.", { exact: true })
              .count(),
          )
          .toBeGreaterThanOrEqual(2);
        await navigateWithinApp(page, "chat");
        await page.locator(".chat-group").first().waitFor();
        const custodian = page.locator("openclaw-custodian-panel");
        await custodian.locator(".cp-header").waitFor();
        const reopenedWorkspace = page.locator(".chat-workspace-rail");
        if (!(await reopenedWorkspace.isVisible())) {
          await page
            .getByRole("button", { name: "Show session files", exact: true })
            .press("Enter");
          await reopenedWorkspace.waitFor();
        }
        if (!(await changes.isVisible())) {
          await reopenedWorkspace
            .getByRole("button", { name: "Show session changes" })
            .press("Enter");
        }
        if (!(await companion.locator(".chat-session-rail__header").isVisible())) {
          await page.getByRole("button", { name: "Show session companion" }).press("Enter");
        }
        await reopenedWorkspace
          .getByRole("button", { name: "Collapse session workspace" })
          .press("Enter");
        await custodian.locator(".cp-header").waitFor();
        if (proofPhase === "after") {
          await changes.waitFor();
          await companion.locator(".chat-session-rail__header").waitFor();
          await expectSharedRailHeaders(page, [
            changes.locator(".sidebar-column__header"),
            companion.locator(".chat-session-rail__header"),
            custodian.locator(".cp-header"),
          ]);
          await expectSingleRailSeparator(page, "openclaw-custodian-panel .cp-resizer--right");
          // Custodian is also a fixed overlay; covered controls were exercised
          // before navigation, while its own action remains interactive here.
          await expectSharedRailActions(page, [
            custodian.getByRole("button", { name: "Close Ask OpenClaw" }),
          ]);
        }
        await capture(page, "10-custodian");
        await custodian.getByRole("button", { name: "Close Ask OpenClaw" }).click();

        await page.goto(`${suite.server.baseUrl}dashboard`);
        const boardChat = page.locator('.sidebar-column[data-column-id="chat-column"]');
        await boardChat.waitFor();
        if (proofPhase === "after") {
          await expectFullHeightRail(page, boardChat);
        }
        const dashboardHeader = page.locator(".chat-pane-primary-column > .chat-pane__header");
        await expect
          .poll(() =>
            dashboardHeader.evaluate((element) =>
              Number.parseFloat(getComputedStyle(element).paddingLeft),
            ),
          )
          .toBeGreaterThanOrEqual(88);
        await capture(page, "11-board-chat-web");

        await page.evaluate(() => {
          document.documentElement.classList.add("openclaw-native-macos", "openclaw-native-nav");
          document.querySelector(".shell")?.classList.add("shell--nav-collapsed");
        });
        await expect
          .poll(() => dashboardHeader.evaluate((element) => getComputedStyle(element).paddingLeft))
          .toBe("204px");
        await capture(page, "12-board-chat-native");
      },
    );
  });

  it("preserves a bottom workspace beside Tasks without applying the side-sibling cap", async () => {
    await suite.withPage(
      {
        colorScheme: theme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1600 },
      },
      async ({ page }) => {
        await seedTheme(page, { workspaceDock: "bottom", workspaceWidth: 820 });
        await installMockGateway(page, railScenario());
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".chat-group").first().waitFor();

        await page.getByRole("button", { name: "Show session files", exact: true }).click();
        const workbench = page.locator(".chat-workbench");
        await expect
          .poll(() => workbench.getAttribute("class"))
          .toContain("chat-workbench--dock-bottom");
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await expect
          .poll(() =>
            workbench.evaluate((element) =>
              Number.parseFloat(
                getComputedStyle(element).getPropertyValue("--chat-workspace-rail-width"),
              ),
            ),
          )
          .toBeGreaterThan(0);
        const widthBeforeTasks = await workbench.evaluate((element) =>
          Number.parseFloat(
            getComputedStyle(element).getPropertyValue("--chat-workspace-rail-width"),
          ),
        );
        await page.getByRole("button", { name: "Show background tasks" }).click();
        await expect
          .poll(() => workbench.getAttribute("class"))
          .toContain("chat-workbench--tasks-open");
        await expect
          .poll(() => workbench.getAttribute("class"))
          .not.toContain("chat-workbench--workspace-open");
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await expect
          .poll(() =>
            workbench.evaluate((element) =>
              Number.parseFloat(
                getComputedStyle(element).getPropertyValue("--chat-workspace-rail-width"),
              ),
            ),
          )
          .toBeGreaterThan(0);
        const widthWithTasks = await workbench.evaluate((element) =>
          Number.parseFloat(
            getComputedStyle(element).getPropertyValue("--chat-workspace-rail-width"),
          ),
        );
        expect(widthWithTasks).toBeCloseTo(widthBeforeTasks, 0);
        await capture(page, "10-bottom-workspace-tasks");

        await page
          .locator(".chat-workspace-rail")
          .getByRole("button", { name: "Collapse session workspace" })
          .click();
        await page.getByRole("button", { name: "Show session files", exact: true }).click();
        await expect
          .poll(() => workbench.getAttribute("class"))
          .toContain("chat-workbench--dock-bottom");
        await capture(page, "12-bottom-workspace-reopened");
      },
    );
  });
});
