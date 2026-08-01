import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-panel-reflow");
const chatSessionKey = "agent:main:main";

const longReply =
  "Additional runtime work may make an earlier benchmark misleading. " +
  "The current implementation must preserve the visible conversation while panels resize the transcript. ";

const historyMessageCount = 4;
const historyMessages = Array.from({ length: historyMessageCount }, (_, index) => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: [
    {
      type: "text",
      text: `${index + 1}. ${longReply.repeat(3)}\n\n${longReply.repeat(2)}`,
    },
  ],
  timestamp: Date.now() - (historyMessageCount - index) * 1_000,
}));

async function expectMessagesNotToOverlap(page: import("playwright").Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator(".chat-group").evaluateAll((groups) => {
        const visible = groups
          .map((group, index) => {
            const rect = group.getBoundingClientRect();
            return { bottom: rect.bottom, index, top: rect.top };
          })
          .filter((rect) => rect.bottom > 0 && rect.top < window.innerHeight)
          .toSorted((a, b) => a.top - b.top);
        return visible.slice(1).flatMap((current, index) => {
          const previous = visible[index];
          if (!previous || current.top >= previous.bottom - 1) {
            return [];
          }
          return [
            {
              current: current.index,
              overlap: previous.bottom - current.top,
              previous: previous.index,
            },
          ];
        });
      }),
    )
    .toEqual([]);
}

let server: ControlUiE2eServer;
let browser: Browser;

describeControlUiE2e("chat transcript panel reflow", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps transcript rows separate across background-task, file, and diff panel toggles", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    await mkdir(artifactDir, { recursive: true });
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        historyMessages,
        methodResponses: {
          "artifacts.list": { artifacts: [] },
          "sessions.diff": {
            additions: 1,
            baseRef: "main",
            branch: "feature/reflow",
            deletions: 0,
            files: [
              {
                additions: 1,
                deletions: 0,
                patch: [
                  "diff --git a/src/app.ts b/src/app.ts",
                  "--- a/src/app.ts",
                  "+++ b/src/app.ts",
                  "@@ -1 +1,2 @@",
                  " current line",
                  "+new line",
                  "",
                ].join("\n"),
                path: "src/app.ts",
                status: "modified",
              },
            ],
            root: "/workspace",
            sessionKey: "main",
          },
          "sessions.files.list": {
            browser: { entries: [], path: "" },
            files: [
              {
                kind: "modified",
                missing: false,
                name: "AGENTS.md",
                path: "/workspace/AGENTS.md",
                size: 2048,
              },
            ],
            root: "/workspace",
            sessionKey: "main",
          },
          "tasks.list": {
            tasks: [
              {
                agentId: "main",
                createdAt: Date.now() - 5_000,
                id: "task-reflow",
                kind: "subagent",
                ownerKey: chatSessionKey,
                progressSummary: "Checking transcript layout",
                runtime: "subagent",
                startedAt: Date.now() - 4_000,
                status: "running",
                taskId: "task-reflow",
                title: "Reflow proof",
                updatedAt: Date.now(),
              },
            ],
          },
        },
      });

      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.status()).toBe(200);
      await expect.poll(() => page.locator(".chat-group").count()).toBe(historyMessageCount);
      await page.locator(".chat-thread").evaluate((element) => {
        element.scrollTop = Math.max(0, element.scrollHeight / 2);
      });
      await expectMessagesNotToOverlap(page);
      await page.screenshot({ path: path.join(artifactDir, "00-closed.png") });

      await page.getByRole("button", { name: "Show background tasks" }).click();
      await page.locator(".chat-tasks-rail").waitFor({ state: "visible" });
      await expectMessagesNotToOverlap(page);
      await page.screenshot({ path: path.join(artifactDir, "01-background-tasks.png") });

      await page.getByRole("button", { name: "Show thread files", exact: true }).click();
      await page.locator(".chat-workspace-rail").waitFor({ state: "visible" });
      await expectMessagesNotToOverlap(page);
      await page.screenshot({ path: path.join(artifactDir, "02-thread-files.png") });

      await page.locator(".chat-session-diff-toggle").first().click();
      await page.locator(".session-diff").waitFor({ state: "visible" });
      await expectMessagesNotToOverlap(page);
      await page.screenshot({ path: path.join(artifactDir, "03-thread-changes.png") });
    } finally {
      await context.close();
    }
  });
});
