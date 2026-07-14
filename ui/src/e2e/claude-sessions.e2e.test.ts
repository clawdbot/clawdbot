import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const allowMissing = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const suite = available || !allowMissing ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

suite("Claude native session catalog", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("auto-loads older chat without moving the viewport and disables paired-node continuation", async () => {
    const page = await browser.newPage();
    await page.clock.install();
    const catalogResponse = (threadId: string, name: string, nextCursor?: string) => ({
      catalogs: [
        {
          id: "claude",
          label: "Claude Code",
          capabilities: { continueSession: true, archive: false },
          hosts: [
            {
              hostId: "node:devbox",
              label: "Dev Box",
              kind: "node",
              connected: true,
              nodeId: "devbox",
              sessions: [
                {
                  threadId,
                  name,
                  status: "stored",
                  source: "claude-cli",
                  archived: false,
                  canContinue: false,
                  canArchive: false,
                },
              ],
              ...(nextCursor ? { nextCursor } : {}),
            },
          ],
        },
      ],
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          cases: [
            {
              match: {
                agentId: "main",
                catalogId: "claude",
                cursors: { "node:devbox": "catalog-page-2" },
              },
              response: catalogResponse("older-remote-thread", "Older remote review"),
            },
            {
              match: {},
              response: catalogResponse(
                "remote-thread",
                "Remote architecture review",
                "catalog-page-2",
              ),
            },
          ],
        },
        "sessions.catalog.read": {
          cases: [
            {
              match: { cursor: "older" },
              response: {
                hostId: "node:devbox",
                threadId: "remote-thread",
                items: [{ id: "u1", type: "userMessage", text: "older question" }],
              },
            },
            {
              match: {},
              response: {
                hostId: "node:devbox",
                threadId: "remote-thread",
                items: Array.from({ length: 40 }, (_, index) => ({
                  id: `a${index + 1}`,
                  type: index % 2 === 0 ? "agentMessage" : "userMessage",
                  text:
                    index === 0
                      ? "newer answer"
                      : `recent transcript message ${index + 1} with enough text to fill the pane`,
                })),
                nextCursor: "older",
              },
            },
          ],
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);
    await page.getByRole("button", { name: "Load more sessions" }).click();
    await page.getByText("Older remote review", { exact: true }).waitFor();
    expect((await gateway.getRequests("sessions.catalog.list")).at(-1)?.params).toEqual({
      agentId: "main",
      catalogId: "claude",
      cursors: { "node:devbox": "catalog-page-2" },
    });
    const catalogRequestCount = (await gateway.getRequests("sessions.catalog.list")).length;
    await page.clock.runFor(30_000);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
      .toBeGreaterThanOrEqual(catalogRequestCount + 2);
    await page.getByText("Older remote review", { exact: true }).waitFor();
    await page.getByText("Remote architecture review", { exact: true }).click();
    await expect.poll(() => page.getByText("newer answer", { exact: true }).count()).toBe(1);
    const thread = page.locator(".chat-thread");
    await expect
      .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight + 100))
      .toBe(true);
    const initialReadCount = (await gateway.getRequests("sessions.catalog.read")).length;
    await gateway.deferNext("sessions.catalog.read");
    const before = await thread.evaluate((element) => {
      element.scrollTop = 0;
      return { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
    });
    await expect
      .poll(() => gateway.getRequests("sessions.catalog.read").then((requests) => requests.length))
      .toBe(initialReadCount + 1);
    await page.locator(".chat-history-loading").waitFor();
    expect(await page.getByRole("button", { name: "Load older" }).count()).toBe(0);
    await gateway.resolveDeferred("sessions.catalog.read");
    await expect.poll(() => page.getByText("older question", { exact: true }).count()).toBe(1);
    const after = await thread.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(after.scrollTop).toBeGreaterThan(0);
    expect(after.scrollTop).toBeCloseTo(
      before.scrollTop + (after.scrollHeight - before.scrollHeight),
      0,
    );
    expect(await page.locator(".agent-chat__composer-combobox > textarea").isDisabled()).toBe(true);
    await expect
      .poll(() => page.getByText("This session is on a paired node and is view-only.").count())
      .toBe(1);
    expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
      catalogId: "claude",
      cursor: "older",
    });
    const exhaustedReadCount = (await gateway.getRequests("sessions.catalog.read")).length;
    await thread.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.clock.runFor(500);
    expect(await page.locator(".chat-history-loading").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Load older" }).count()).toBe(0);
    expect(await gateway.getRequests("sessions.catalog.read")).toHaveLength(exhaustedReadCount);
    await page.close();
  });

  it("auto-loads older native history with a spinner and stable viewport", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.clock.install();
    const historyMessage = (seq: number, prefix: string) => ({
      __openclaw: { seq },
      content: [
        {
          type: "text",
          text: `${prefix} ${seq}\n${"transcript detail line\n".repeat(3)}`,
        },
      ],
      role: seq % 2 === 0 ? "assistant" : "user",
      timestamp: Date.now() + seq,
    });
    const recent = Array.from({ length: 100 }, (_, index) =>
      historyMessage(index + 41, "recent native message"),
    );
    const older = Array.from({ length: 40 }, (_, index) =>
      historyMessage(index + 1, "older native message"),
    );
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "chat.startup": {
          messages: recent,
          hasMore: true,
          nextOffset: 100,
          totalMessages: 140,
          sessionId: "native-scrollback",
          thinkingLevel: null,
        },
        "chat.history": {
          cases: [
            {
              match: { offset: 100 },
              response: {
                messages: older,
                hasMore: false,
                totalMessages: 140,
                sessionId: "native-scrollback",
                thinkingLevel: null,
              },
            },
          ],
        },
      },
    });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText(/^recent native message 140\n/).waitFor();
    const thread = page.locator(".chat-thread");
    await expect
      .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight + 100))
      .toBe(true);
    await page.locator(".chat-history-sentinel").waitFor();
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await gateway.deferNext("chat.history");
    const before = await thread.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
      return { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
    });
    await gateway.waitForRequest("chat.history");
    await page.locator(".chat-history-loading").waitFor();
    await gateway.resolveDeferred("chat.history");
    await expect
      .poll(() =>
        page
          .locator("openclaw-chat-pane")
          .evaluate(
            (element) =>
              (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                .length,
          ),
      )
      .toBe(140);
    await page.getByText(/^older native message 1\n/).waitFor();

    const after = await thread.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(after.scrollTop).toBeGreaterThan(0);
    expect(after.scrollTop).toBeCloseTo(
      before.scrollTop + (after.scrollHeight - before.scrollHeight),
      0,
    );
    expect((await gateway.getRequests("chat.history")).at(-1)?.params).toMatchObject({
      limit: 100,
      offset: 100,
    });
    const exhaustedRequestCount = (await gateway.getRequests("chat.history")).length;
    await thread.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.clock.runFor(300);
    expect(await page.locator(".chat-history-loading").count()).toBe(0);
    expect(await gateway.getRequests("chat.history")).toHaveLength(exhaustedRequestCount);
    await page.close();
  });
});
