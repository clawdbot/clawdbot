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
      "chat.metadata",
      "chat.startup",
      "board.get",
      "session.discussion.info",
      "session.discussion.open",
      "sessions.diff",
      "tasks.list",
      "terminal.open",
    ],
    historyMessages,
    methodResponses: {
      "artifacts.list": { artifacts: [] },
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

async function seedTheme(page: Page): Promise<void> {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, mode }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          theme: "claw",
          themeMode: mode,
          boardSessionViews: {
            "agent:main:rail-columns": { activeTabId: "main", face: "dashboard" },
          },
        }),
      );
    },
    { key: settingsKey, mode: theme },
  );
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
        if (proofPhase === "after") {
          await expectFullHeightRail(page, tasks);
          await expectFullHeightRail(page, workspace);
        }
        await capture(page, "01-workspace-tasks-default");

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

          await page.locator(".chat-workspace-rail__collapse-toggle").click();
          await page.getByRole("button", { name: "Show session files", exact: true }).click();
          await expect
            .poll(() => workspace.evaluate((element) => element.getBoundingClientRect().width))
            .toBeCloseTo(resizedWidth, 0);
          await capture(page, "03-workspace-tasks-reopened");
        }

        await page.locator(".chat-workspace-rail__collapse-toggle").click();
        await page.locator(".chat-tasks-rail__collapse-toggle").click();
        await page.locator(".chat-session-diff-toggle").click();
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

        await page.getByRole("button", { name: "Show session companion" }).click();
        const companion = page.locator("openclaw-chat-session-rail");
        await companion.locator(".chat-session-rail--expanded").waitFor();
        if (proofPhase === "after") {
          await expectFullHeightRail(page, companion);
        }
        await capture(page, "06-companion");

        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("openclaw:terminal-toggle", { detail: { open: true } }),
          ),
        );
        await gateway.waitForRequest("terminal.open");
        await page.locator("openclaw-terminal-panel .tp").waitFor();
        await capture(page, "07-terminal-reference");

        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("openclaw:terminal-toggle", { detail: { open: false } }),
          ),
        );
        await page.goto(`${suite.server.baseUrl}dashboard`);
        const boardChat = page.locator('.sidebar-column[data-column-id="chat-column"]');
        await boardChat.waitFor();
        if (proofPhase === "after") {
          await expectFullHeightRail(page, boardChat);
        }
        await capture(page, "08-board-chat");
      },
    );
  });
});
