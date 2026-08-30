import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
// Frozen proposal base 2d5228d4, built with startBundledControlUiE2eServer.
const BASELINE_BUNDLE_SHA256 = "7970b72aaa5f99d8cf123fa61c96adec16359c8c473c33015f7a986e81ffa530";

function createToolTitleFixture(count: number) {
  const items = Array.from({ length: count }, (_, index) => {
    const args = {
      task: `Inspect tool-title queue entry ${String(index + 1).padStart(3, "0")}`,
      payload: `${"x".repeat(140)}-${index}`,
    };
    const input = JSON.stringify(args);
    const source = `demo__show\u0000${input}`;
    return {
      args,
      callId: `tool-title-${index}`,
      requestId: `t${fnv1aUtf16(source).toString(36)}${source.length.toString(36)}`,
      title: `Generated purpose ${String(index + 1).padStart(3, "0")}`,
    };
  });
  return {
    historyMessages: [
      {
        role: "assistant",
        content: items.map((item) => ({
          type: "toolCall",
          id: item.callId,
          name: "demo__show",
          arguments: item.args,
        })),
        timestamp: Date.UTC(2026, 7, 29, 12, 0),
      },
      ...items.map((item, index) => ({
        role: "toolResult",
        toolCallId: item.callId,
        toolName: "demo__show",
        content: [{ type: "text", text: `Completed fixture ${index + 1}` }],
        timestamp: Date.UTC(2026, 7, 29, 12, 0, 1) + index,
      })),
      {
        role: "assistant",
        content: [{ type: "text", text: "Tool-title stress fixture complete." }],
        timestamp: Date.UTC(2026, 7, 29, 12, 1),
      },
    ],
    items,
    titles: Object.fromEntries(items.map((item) => [item.requestId, item.title])),
  };
}

function removeToolTitleFixtureItem(
  fixture: ReturnType<typeof createToolTitleFixture>,
  itemIndex: number,
): unknown[] {
  const removed = fixture.items[itemIndex];
  if (!removed) {
    throw new Error(`Missing tool-title fixture item ${itemIndex}`);
  }
  return fixture.historyMessages.flatMap((message): unknown[] => {
    const record = message as Record<string, unknown>;
    if (record.role === "toolResult" && record.toolCallId === removed.callId) {
      return [];
    }
    if (record.role !== "assistant" || !Array.isArray(record.content)) {
      return [message];
    }
    const content = record.content.filter((part) => {
      const partRecord = part as Record<string, unknown>;
      return partRecord.id !== removed.callId;
    });
    return content.length > 0 ? [{ ...record, content }] : [];
  });
}

async function setToolTitleProofCue(page: Page, text: string): Promise<void> {
  await page.evaluate((cueText) => {
    const id = "tool-title-proof-cue";
    let cue = document.getElementById(id);
    if (!cue) {
      cue = document.createElement("div");
      cue.id = id;
      Object.assign(cue.style, {
        background: "#111827",
        border: "1px solid #f9fafb",
        color: "#f9fafb",
        font: "600 14px/1.4 system-ui, sans-serif",
        left: "16px",
        maxWidth: "420px",
        padding: "8px 10px",
        position: "fixed",
        top: "16px",
        zIndex: "2147483647",
      });
      document.body.append(cue);
    }
    cue.textContent = cueText;
  }, text);
}

suite.define(() => {
  it("bounds a 240-row title burst and preserves overflow fallbacks", async () => {
    const artifactDir =
      process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim() ||
      path.join(process.cwd(), ".artifacts", "ui-visual-proof", "tool-title-bounds", "executable");
    await mkdir(artifactDir, { recursive: true });
    const context = await suite.newBrowserContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1440 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    try {
      const page = await context.newPage();
      const fixture = createToolTitleFixture(240);
      const gateway = await installMockGateway(page, {
        historyMessages: fixture.historyMessages,
        methodResponses: { "chat.toolTitles": { titles: fixture.titles } },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const summary = page.locator(".chat-activity-group__summary").first();
      await summary.waitFor();
      await summary.click();
      const rows = page.locator(".chat-tool-row");
      await expect.poll(() => rows.count()).toBe(240);
      await page.screenshot({ path: path.join(artifactDir, "expanded-initial.png") });
      await waitForRequests(gateway, "chat.toolTitles", 2);
      await expectRequestCountStable(gateway, "chat.toolTitles", 2, 750);

      const requests = await gateway.getRequests("chat.toolTitles");
      const requestedItems = requests.reduce((count, request) => {
        const params = requireRecord(request.params);
        return count + (Array.isArray(params.items) ? params.items.length : 0);
      }, 0);
      expect(requestedItems).toBe(48);
      await expect.poll(() => rows.locator(".chat-tool-row__title").count()).toBe(48);
      expect(await rows.locator(".chat-tool-msg-summary__label").count()).toBe(192);
      const assetSrc = await page
        .locator('script[type="module"][src*="assets/index-"]')
        .first()
        .getAttribute("src");
      expect(assetSrc).toMatch(/assets\/index-.*\.js/u);
      const assetBytes = Buffer.from(
        await (
          await fetch(new URL(requireString(assetSrc, "Control UI asset source"), page.url()))
        ).arrayBuffer(),
      );
      const assetSha256 = createHash("sha256").update(assetBytes).digest("hex");
      expect(assetSha256).not.toBe(BASELINE_BUNDLE_SHA256);
      await page.screenshot({ path: path.join(artifactDir, "settled-boundary.png") });
      await writeFile(
        path.join(artifactDir, "metrics.json"),
        `${JSON.stringify(
          {
            assetSha256,
            assetSrc,
            baselineAssetSha256: BASELINE_BUNDLE_SHA256,
            exactHead: process.env.OPENCLAW_TOOL_TITLES_EXACT_HEAD?.trim() ?? null,
            fallbackCount: 192,
            generatedCount: 48,
            requestCount: requests.length,
            requestedItems,
            rowCount: 240,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("resumes title generation after transcript pruning removes the cursor", async () => {
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1440 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const video = page.video();
    try {
      const initialTime = new Date("2026-08-30T12:00:00Z");
      await page.clock.setFixedTime(initialTime);
      const fixture = createToolTitleFixture(120);
      const retainedHistory = removeToolTitleFixtureItem(fixture, 47);
      const gateway = await installMockGateway(page, {
        historyMessages: fixture.historyMessages,
        methodResponses: { "chat.toolTitles": { titles: fixture.titles } },
        sessionKey: "main",
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const summary = page.locator(".chat-activity-group__summary").first();
      await summary.waitFor();
      await summary.click();
      const rows = page.locator(".chat-tool-row");
      await expect.poll(() => rows.count()).toBe(120);
      await waitForRequests(gateway, "chat.toolTitles", 2);
      await expectRequestCountStable(gateway, "chat.toolTitles", 2, 500);
      await expect.poll(() => rows.locator(".chat-tool-row__title").count()).toBe(48);
      await rows.nth(48).scrollIntoViewIfNeeded();
      await setToolTitleProofCue(page, "Initial bound: 48 generated, 72 deterministic fallbacks");
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "01-initial-bound.png") });
      }

      await page.clock.setFixedTime(new Date(initialTime.getTime() + 5 * 60_000 + 1));
      await gateway.setHistoryMessages(retainedHistory);
      const firstHistoryCount = (await gateway.getRequests("chat.history")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        key: "main",
        phase: "reset",
        reason: "reset",
        sessionId: "control-ui-e2e-session",
        updatedAt: initialTime.getTime() + 5 * 60_000 + 1,
      });
      await gateway.waitForRequest("chat.history", { after: firstHistoryCount });
      await expect.poll(() => rows.count()).toBe(119);
      await expectRequestCountStable(gateway, "chat.toolTitles", 2, 500);
      await expect.poll(() => rows.locator(".chat-tool-row__title").count()).toBe(47);
      await rows.nth(47).scrollIntoViewIfNeeded();
      await setToolTitleProofCue(
        page,
        "Cursor pruned: first complete retained render remains suppressed",
      );
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "02-pruned-first-render.png") });
      }

      const secondHistoryCount = (await gateway.getRequests("chat.history")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        key: "main",
        phase: "message",
        sessionId: "control-ui-e2e-session",
        updatedAt: initialTime.getTime() + 5 * 60_000 + 2,
      });
      await gateway.waitForRequest("chat.history", { after: secondHistoryCount });
      await waitForRequests(gateway, "chat.toolTitles", 4);
      await expectRequestCountStable(gateway, "chat.toolTitles", 4, 500);

      const requests = await gateway.getRequests("chat.toolTitles");
      const requestItems = requests.flatMap((request) => {
        const params = requireRecord(request.params);
        return Array.isArray(params.items) ? params.items.map((item) => requireRecord(item)) : [];
      });
      expect(
        requests.every((request) => {
          const params = requireRecord(request.params);
          return Array.isArray(params.items) && params.items.length <= 24;
        }),
      ).toBe(true);
      expect(
        new Set(requestItems.map((item) => requireString(item.id, "tool title id"))).size,
      ).toBe(96);
      await expect.poll(() => rows.locator(".chat-tool-row__title").count()).toBe(95);
      expect(await rows.locator(".chat-tool-msg-summary__label").count()).toBe(24);
      await rows.nth(47).scrollIntoViewIfNeeded();
      await setToolTitleProofCue(page, "Resumed: 96 unique requests, 95 visible generated titles");
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "03-pruned-resumed.png") });
        await writeFile(
          path.join(artifactDir, "metrics.json"),
          `${JSON.stringify(
            {
              exactHead: process.env.OPENCLAW_TOOL_TITLES_EXACT_HEAD?.trim() ?? null,
              finalFallbackCount: 24,
              finalGeneratedCount: 95,
              initialGeneratedCount: 48,
              removedCursorRequestId: fixture.items[47]?.requestId ?? null,
              requestBatchSizes: requests.map((request) => {
                const params = requireRecord(request.params);
                return Array.isArray(params.items) ? params.items.length : 0;
              }),
              uniqueRequestedIds: 96,
              visibleRowsAfterPruning: 119,
            },
            null,
            2,
          )}\n`,
        );
      }
    } finally {
      await context.close();
      if (artifactDir && video) {
        await video.saveAs(path.join(artifactDir, "cursor-pruning-transition.webm"));
      }
    }
  });

  it("repaints both split panes after one shared pending title settles", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    await context.addInitScript((settingsKey) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          chatSplitLayout: {
            activePaneId: "p1",
            columns: [
              {
                id: "c1",
                panes: [{ id: "p1", sessionKey: "agent:main:session-a" }],
                paneWeights: [1],
              },
              {
                id: "c2",
                panes: [{ id: "p2", sessionKey: "agent:main:session-a" }],
                paneWeights: [1],
              },
            ],
            columnWeights: [0.5, 0.5],
          },
        }),
      );
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));

    try {
      const page = await context.newPage();
      const fixture = createToolTitleFixture(1);
      const gateway = await installMockGateway(page, {
        heldMethods: ["chat.toolTitles"],
        historyMessages: fixture.historyMessages,
        methodResponses: { "sessions.list": chatSessionListResponse() },
        sessionKey: "agent:main:session-a",
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expect.poll(() => panes.count()).toBe(2);
      const rows = panes.locator(".chat-tool-row");
      await expect.poll(() => rows.count()).toBe(2);
      await expect.poll(() => rows.locator(".chat-tool-msg-summary__label").count()).toBe(2);
      const [request] = await waitForRequests(gateway, "chat.toolTitles", 1);
      await expectRequestCountStable(gateway, "chat.toolTitles", 1, 500);
      const params = requireRecord(request?.params);
      const requestItems = Array.isArray(params.items) ? params.items : [];
      const requestId = requireRecord(requestItems[0]).id;
      expect(typeof requestId).toBe("string");

      await gateway.resolveDeferred("chat.toolTitles", {
        titles: { [String(requestId)]: "Shared generated title" },
      });
      await expect
        .poll(() => rows.locator(".chat-tool-row__title").allTextContents())
        .toEqual(["Shared generated title", "Shared generated title"]);
      expect(await gateway.getRequests("chat.toolTitles")).toHaveLength(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("invalidates a rendered title when the gateway client is replaced", async () => {
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1440 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    try {
      const page = await context.newPage();
      const fixture = createToolTitleFixture(1);
      const requestId = fixture.items[0]?.requestId;
      expect(requestId).toBeDefined();
      const gateway = await installMockGateway(page, {
        historyMessages: fixture.historyMessages,
        methodResponses: {
          "chat.toolTitles": { titles: { [String(requestId)]: "First gateway title" } },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(".chat-tool-row").first();
      await row.locator(".chat-tool-row__title").getByText("First gateway title").waitFor();
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "replacement-before.png") });
      }

      const requestCount = (await gateway.getRequests("chat.toolTitles")).length;
      const socketCount = await gateway.getSocketCount();
      await gateway.setMethodResponse("chat.toolTitles", {
        titles: { [String(requestId)]: "Replacement gateway title" },
      });
      await gateway.setOnline(false);
      await gateway.closeLatest(1006, "tool-title replacement proof");
      await row.locator(".chat-tool-msg-summary__label").waitFor();
      expect(await row.locator(".chat-tool-row__title").count()).toBe(0);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "replacement-fallback.png") });
      }

      await gateway.setOnline(true);
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await expect
        .poll(async () => (await gateway.getRequests("chat.toolTitles")).length)
        .toBeGreaterThan(requestCount);
      await row.locator(".chat-tool-row__title").getByText("Replacement gateway title").waitFor();
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "replacement-after.png") });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
