// Control UI E2E tests protect transcript disclosure geometry across animation frames.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatThreadDistanceFromBottom, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI transcript disclosure anchoring",
  startServerBeforeBrowser: true,
});

type DisclosureFrame = {
  expanded: boolean;
  mountedBodies: number;
  rowHeight: number;
  rowTop: number;
  scrollHeight: number;
  scrollTop: number;
};

async function toggleDisclosureWithFrameTrace(
  page: import("playwright").Page,
  summary: import("playwright").Locator,
  actionSelector?: string,
): Promise<DisclosureFrame[]> {
  return await summary.evaluate((button, selector) => {
    const row = button.closest<HTMLElement>(".chat-virtual-row");
    const thread = button.closest<HTMLElement>(".chat-thread");
    if (!row || !thread) {
      throw new Error("Expected disclosure inside a virtual transcript row");
    }
    const frames: DisclosureFrame[] = [];
    const sample = () => {
      frames.push({
        expanded: button.matches("summary")
          ? button.closest("details")?.hasAttribute("open") === true
          : button.getAttribute("aria-expanded") === "true" ||
            button.getAttribute("aria-pressed") === "true",
        mountedBodies: row.querySelectorAll(".chat-tool-msg-body, .chat-activity-group__body")
          .length,
        rowHeight: row.getBoundingClientRect().height,
        rowTop: row.getBoundingClientRect().top - thread.getBoundingClientRect().top,
        scrollHeight: thread.scrollHeight,
        scrollTop: thread.scrollTop,
      });
    };
    sample();
    const action = selector ? row.querySelector<HTMLElement>(selector) : (button as HTMLElement);
    if (!action) {
      throw new Error(`Expected disclosure action ${selector}`);
    }
    action.click();
    return new Promise<DisclosureFrame[]>((resolve) => {
      let remaining = 8;
      const next = () => {
        sample();
        remaining -= 1;
        if (remaining === 0) {
          resolve(frames);
        } else {
          requestAnimationFrame(next);
        }
      };
      requestAnimationFrame(next);
    });
  }, actionSelector);
}

function expectStableDisclosureFrames(frames: DisclosureFrame[], label = "disclosure") {
  const initial = frames[0];
  expect(initial).toBeDefined();
  expect(frames.at(-1)?.expanded, `${label} state`).toBe(!initial!.expanded);
  expect(
    frames.some(
      (frame) =>
        Math.abs(frame.rowHeight - initial!.rowHeight) > 0.5 ||
        frame.scrollHeight !== initial!.scrollHeight,
    ),
    `${label} resize`,
  ).toBe(true);
  expect(
    Math.max(...frames.map((frame) => Math.abs(frame.rowTop - initial!.rowTop))),
    `${label} geometry`,
  ).toBeLessThanOrEqual(2);
  expect(
    Math.max(...frames.map((frame) => Math.abs(frame.scrollTop - initial!.scrollTop))),
    `${label} scroll offset`,
  ).toBeLessThanOrEqual(2);
}

async function showSplitDashboard(page: import("playwright").Page, sessionKey: string) {
  const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, settingsKey }) => {
      const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Record<
        string,
        unknown
      >;
      settings.boardSessionViews = { [key]: { activeTabId: "main" } };
      localStorage.setItem(settingsKey, JSON.stringify(settings));
    },
    { key: sessionKey, settingsKey: storageKey },
  );
  await page.goto(`${suite.server.baseUrl}dashboard`);
  await page.locator('.side-panel [data-panel-slot="chat"] .chat-thread').waitFor();
}

suite.define(() => {
  it("keeps completed-work and tool disclosures anchored on every expand and collapse frame", async () => {
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.browser.newContext({
      reducedMotion: "reduce",
      viewport: { height: 800, width: 1400 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 800, width: 1400 } } }
        : {}),
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:dashboard:disclosure-geometry";
    const transcriptPrefix = Array.from({ length: 12 }, (_, index) => [
      {
        role: "user",
        content: `Earlier prompt ${index + 1}: keep enough transcript above the active row to make the pane scroll.`,
        timestamp: index * 2 + 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Earlier response ${index + 1}.` }],
        timestamp: index * 2 + 2,
      },
    ]).flat();
    await installMockGateway(page, {
      sessionKey,
      featureMethods: ["board.get", "chat.history", "chat.metadata", "chat.startup"],
      methodResponses: {
        "board.get": {
          sessionKey,
          revision: 1,
          tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
          widgets: [],
        },
      },
      historyMessages: [
        ...transcriptPrefix,
        {
          role: "user",
          content: "Inspect the transcript implementation and run its focused tests.",
          timestamp: 99,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-anchor",
              name: "bash",
              arguments: { command: "pnpm test ui/src/pages/chat" },
            },
            {
              type: "toolCall",
              id: "call-anchor-read",
              name: "read",
              arguments: { path: "ui/src/pages/chat/components/chat-tool-cards.ts" },
            },
          ],
          timestamp: 100,
        },
        {
          role: "toolResult",
          toolCallId: "call-anchor",
          toolName: "bash",
          content: [
            {
              type: "text",
              text: Array.from(
                { length: 24 },
                (_, index) => `Focused test ${index + 1}: passed with stable transcript geometry.`,
              ).join("\n"),
            },
          ],
          timestamp: 101,
        },
        {
          role: "toolResult",
          toolCallId: "call-anchor-read",
          toolName: "read",
          content: [{ type: "text", text: "export function renderToolCard() {}" }],
          timestamp: 102,
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The transcript implementation is sound and all focused tests pass.",
            },
          ],
          timestamp: 103,
        },
        ...Array.from({ length: 3 }, (_, index) => [
          {
            role: "user",
            content: `Follow-up ${index + 1}: record the next transcript observation.`,
            timestamp: 104 + index * 2,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: `Observation ${index + 1} recorded.` }],
            timestamp: 105 + index * 2,
          },
        ]).flat(),
        {
          role: "user",
          content: "Run one short sibling tool check.",
          timestamp: 110,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-sibling",
              name: "bash",
              arguments: {
                command: "pnpm test ui/src/pages/chat/components/chat-tool-cards.test.ts",
              },
            },
          ],
          timestamp: 111,
        },
        {
          role: "toolResult",
          toolCallId: "call-sibling",
          toolName: "bash",
          content: [{ type: "text", text: "Focused sibling passed." }],
          timestamp: 112,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "The sibling tool check passed." }],
          timestamp: 113,
        },
      ],
    });

    await showSplitDashboard(page, sessionKey);
    const workSummaries = page.locator(".chat-work-group > .chat-activity-group__summary");
    await expect.poll(() => workSummaries.count()).toBe(2);
    const middleWorkSummary = workSummaries.first();
    const endWorkSummary = workSummaries.last();
    await waitForChatScrollIdle(page);
    expect(Math.abs(await chatThreadDistanceFromBottom(page))).toBeLessThanOrEqual(2);
    const traces: Record<string, DisclosureFrame[]> = {};
    traces.workEndExpand = await toggleDisclosureWithFrameTrace(page, endWorkSummary);
    traces.workEndCollapse = await toggleDisclosureWithFrameTrace(page, endWorkSummary);

    await middleWorkSummary.evaluate((button) => {
      const row = button.closest<HTMLElement>(".chat-virtual-row");
      const thread = button.closest<HTMLElement>(".chat-thread");
      if (!row || !thread) {
        throw new Error("Expected disclosure inside a virtual transcript row");
      }
      const rowTop = row.getBoundingClientRect().top - thread.getBoundingClientRect().top;
      thread.scrollTop += Math.round(rowTop - thread.clientHeight / 2);
    });
    await waitForChatScrollIdle(page);
    traces.workMiddleExpand = await toggleDisclosureWithFrameTrace(page, middleWorkSummary);
    const activitySummary = page
      .locator(
        ".chat-group--activity > .chat-group-messages > .chat-activity-group > .chat-activity-group__summary",
      )
      .first();
    traces.activityMiddleExpand = await toggleDisclosureWithFrameTrace(page, activitySummary);
    const activityGroup = activitySummary.locator("..");
    const toolSummary = activityGroup
      .locator(".chat-tool-msg-summary")
      .filter({ hasText: "pnpm test ui/src/pages/chat" });
    traces.toolMiddleExpand = await toggleDisclosureWithFrameTrace(page, toolSummary);
    traces.toolMiddleCollapse = await toggleDisclosureWithFrameTrace(page, toolSummary);
    const fileToolToggle = activityGroup.locator(".chat-tool-row__toggle").first();
    traces.fileToolMiddleExpand = await toggleDisclosureWithFrameTrace(page, fileToolToggle);
    traces.fileToolMiddleCollapse = await toggleDisclosureWithFrameTrace(page, fileToolToggle);
    traces.activityMiddleCollapse = await toggleDisclosureWithFrameTrace(page, activitySummary);
    traces.workMiddleCollapse = await toggleDisclosureWithFrameTrace(page, middleWorkSummary);

    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(
        path.join(artifactDir, "disclosure-geometry.json"),
        `${JSON.stringify(traces, null, 2)}\n`,
      );
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "disclosure-geometry-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
        .toBe("dark");
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "disclosure-geometry-dark.png"),
      });
    }
    await context.close();
    for (const frames of Object.values(traces)) {
      expectStableDisclosureFrames(frames);
    }
  });

  it("keeps raw tool details anchored at the end and middle of a long transcript", async () => {
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.browser.newContext({
      reducedMotion: "reduce",
      viewport: { height: 600, width: 900 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 600, width: 900 } } }
        : {}),
    });
    const page = await context.newPage();
    const transcriptPrefix = Array.from({ length: 14 }, (_, index) => [
      {
        role: "user",
        content: `Earlier raw-details prompt ${index + 1}.`,
        timestamp: index * 2 + 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Earlier raw-details response ${index + 1}.` }],
        timestamp: index * 2 + 2,
      },
    ]).flat();
    await installMockGateway(page, {
      historyMessages: [
        ...transcriptPrefix,
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "raw-details-widget",
              name: "canvas_render",
              arguments: { title: "Disclosure geometry proof" },
            },
            {
              type: "tool_result",
              id: "raw-details-widget",
              name: "canvas_render",
              text: JSON.stringify(
                {
                  kind: "canvas",
                  proof: Array.from(
                    { length: 24 },
                    (_, index) => `Focused test ${index + 1}: passed with stable geometry.`,
                  ),
                  view: {
                    backend: "canvas",
                    id: "disclosure-geometry-proof",
                    url: "/__openclaw__/canvas/documents/disclosure-geometry-proof/index.html",
                    title: "Disclosure geometry proof",
                    preferred_height: 160,
                  },
                  presentation: { target: "assistant_message" },
                },
                null,
                2,
              ),
            },
          ],
          timestamp: 100,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Disclosure geometry proof rendered." }],
          timestamp: 101,
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const toolSummary = page.locator(".chat-tool-msg-summary");
    await toolSummary.waitFor();
    await waitForChatScrollIdle(page);
    expectStableDisclosureFrames(await toggleDisclosureWithFrameTrace(page, toolSummary));
    const widgetHost = page.locator(".chat-tool-card__widget-host");
    const rawDetailsToggle = widgetHost.locator(".chat-tool-card__raw-toggle");
    await rawDetailsToggle.waitFor({ state: "attached" });
    await page.locator(".chat-thread").evaluate((thread) => {
      thread.scrollTop = thread.scrollHeight;
    });
    await waitForChatScrollIdle(page);
    expect(Math.abs(await chatThreadDistanceFromBottom(page))).toBeLessThanOrEqual(2);
    const traces: Record<string, DisclosureFrame[]> = {};
    // Menu selection already proves it clicks this toggle; exclude the popup's
    // own close/reposition geometry from the transcript-anchor measurement.
    traces.rawDetailsEndExpand = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);
    traces.rawDetailsEndCollapse = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);

    await rawDetailsToggle.evaluate((button) => {
      const row = button.closest<HTMLElement>(".chat-virtual-row");
      const thread = button.closest<HTMLElement>(".chat-thread");
      if (!row || !thread) {
        throw new Error("Expected raw-details disclosure inside a virtual transcript row");
      }
      const rowTop = row.getBoundingClientRect().top - thread.getBoundingClientRect().top;
      thread.scrollTop += Math.round(rowTop - thread.clientHeight / 2);
    });
    await waitForChatScrollIdle(page);
    traces.rawDetailsMiddleExpand = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);

    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(
        path.join(artifactDir, "raw-details-geometry.json"),
        `${JSON.stringify(traces, null, 2)}\n`,
      );
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "raw-details-geometry-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
        .toBe("dark");
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "raw-details-geometry-dark.png"),
      });
    }
    traces.rawDetailsMiddleCollapse = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);
    const video = page.video();
    await context.close();
    if (artifactDir) {
      await video?.saveAs(path.join(artifactDir, "raw-details-geometry.webm"));
    }
    for (const [label, frames] of Object.entries(traces)) {
      expectStableDisclosureFrames(frames, label);
    }
  });

  it("keeps message and JSON disclosures anchored in a long transcript", async () => {
    const context = await suite.browser.newContext({
      reducedMotion: "reduce",
      viewport: { height: 600, width: 900 },
    });
    const page = await context.newPage();
    const transcriptPrefix = Array.from({ length: 12 }, (_, index) => [
      {
        role: "user",
        content: `Earlier sibling-disclosure prompt ${index + 1}.`,
        timestamp: index * 2 + 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Earlier sibling-disclosure response ${index + 1}.` }],
        timestamp: index * 2 + 2,
      },
    ]).flat();
    await installMockGateway(page, {
      historyMessages: [
        ...transcriptPrefix,
        {
          role: "user",
          content: `User disclosure anchor marker. ${"A wrapped prompt line that must remain visually anchored. ".repeat(24)}`,
          timestamp: 100,
        },
        {
          role: "assistant",
          content: JSON.stringify({
            marker: "json-disclosure-anchor-marker",
            rows: Array.from(
              { length: 30 },
              (_, index) => `JSON disclosure proof row ${index + 1}`,
            ),
          }),
          timestamp: 101,
        },
        {
          role: "assistant",
          content: `\`\`\`text\n${"A wide transcript code line that must wrap without moving its virtual row. ".repeat(24)}\n\`\`\``,
          timestamp: 102,
        },
        {
          role: "user",
          content: "Keep both sibling disclosures above this final exchange.",
          timestamp: 103,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Both sibling disclosures are ready." }],
          timestamp: 104,
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await waitForChatScrollIdle(page);
    const userToggle = page
      .locator(".chat-message-disclosure")
      .filter({ hasText: "User disclosure anchor marker" })
      .locator(".chat-message-disclosure__toggle");
    const jsonSummary = page
      .locator(".chat-json-collapse")
      .filter({ hasText: "json-disclosure-anchor-marker" })
      .locator("summary");
    await userToggle.waitFor();
    await jsonSummary.waitFor();
    const wrapToggle = page.locator(".code-block-wrap");
    await wrapToggle.waitFor({ state: "visible" });
    const traces: Record<string, DisclosureFrame[]> = {};
    traces.userMessageExpand = await toggleDisclosureWithFrameTrace(page, userToggle);
    traces.userMessageCollapse = await toggleDisclosureWithFrameTrace(page, userToggle);
    traces.jsonExpand = await toggleDisclosureWithFrameTrace(page, jsonSummary);
    traces.jsonCollapse = await toggleDisclosureWithFrameTrace(page, jsonSummary);
    traces.codeWrap = await toggleDisclosureWithFrameTrace(page, wrapToggle);
    traces.codeUnwrap = await toggleDisclosureWithFrameTrace(page, wrapToggle);
    await context.close();
    for (const [label, frames] of Object.entries(traces)) {
      expectStableDisclosureFrames(frames, label);
    }
  });
});
