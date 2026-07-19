import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
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

type VisibleVirtualRow = {
  key: string;
  viewportTop: number;
};

async function firstVisibleVirtualRow(thread: Locator): Promise<VisibleVirtualRow> {
  return thread.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = Array.from(
      element.querySelectorAll<HTMLElement>(".chat-virtual-row[data-virtual-row-key]"),
    ).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return (
        candidate.dataset.virtualRowKey !== "history" &&
        rect.bottom > viewport.top &&
        rect.top < viewport.bottom
      );
    });
    if (!row) {
      throw new Error("expected a visible virtual transcript row");
    }
    return {
      key: row.dataset.virtualRowKey ?? "",
      viewportTop: Math.round(row.getBoundingClientRect().top - viewport.top),
    };
  });
}

type VirtualRowPrependSample = {
  phase: "before" | "mutation" | "frame";
  viewportTop: number | null;
};

async function startVirtualRowPrependProbe(thread: Locator, anchor: VisibleVirtualRow) {
  await thread.evaluate((element, expected) => {
    const target = globalThis as typeof globalThis & {
      chatPrependProbe?: {
        observer: MutationObserver;
        samples: VirtualRowPrependSample[];
      };
    };
    const samples: VirtualRowPrependSample[] = [];
    let framePending = false;
    const sample = (phase: VirtualRowPrependSample["phase"]) => {
      const row = Array.from(
        element.querySelectorAll<HTMLElement>(".chat-virtual-row[data-virtual-row-key]"),
      ).find((candidate) => candidate.dataset.virtualRowKey === expected.key);
      samples.push({
        phase,
        viewportTop: row
          ? Math.round(row.getBoundingClientRect().top - element.getBoundingClientRect().top)
          : null,
      });
    };
    sample("before");
    const observer = new MutationObserver(() => {
      sample("mutation");
      if (framePending) {
        return;
      }
      framePending = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          framePending = false;
          sample("frame");
        });
      });
    });
    observer.observe(element, {
      attributeFilter: ["style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    target.chatPrependProbe = { observer, samples };
  }, anchor);
}

async function finishVirtualRowPrependProbe(thread: Locator) {
  return thread.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      chatPrependProbe?: {
        observer: MutationObserver;
        samples: VirtualRowPrependSample[];
      };
    };
    const probe = target.chatPrependProbe;
    if (!probe) {
      throw new Error("expected an active virtual row prepend probe");
    }
    probe.observer.disconnect();
    delete target.chatPrependProbe;
    return probe.samples;
  });
}

function expectStableVirtualRowPrepend(
  anchor: VisibleVirtualRow,
  samples: VirtualRowPrependSample[],
) {
  expect(samples.some((sample) => sample.phase === "mutation")).toBe(true);
  expect(samples.some((sample) => sample.phase === "frame")).toBe(true);
  const paintedSamples = samples.filter((sample) => sample.phase !== "mutation");
  expect(
    paintedSamples.every((sample) => sample.viewportTop !== null),
    JSON.stringify({ anchor, samples }),
  ).toBe(true);
  expect(
    paintedSamples.every((sample) => Math.abs((sample.viewportTop ?? 0) - anchor.viewportTop) <= 1),
    JSON.stringify({ anchor, samples }),
  ).toBe(true);
}

function resumableClaudeCatalog() {
  return {
    catalogs: [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Mac",
            kind: "local",
            connected: true,
            sessions: [
              {
                threadId: "claude-terminal-session",
                name: "Native Claude terminal",
                status: "stored",
                source: "claude-cli",
                archived: false,
                canContinue: true,
                canArchive: false,
                canOpenTerminal: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

function hostGroupedNativeCatalogs() {
  const catalog = (id: "claude" | "codex", label: string) => ({
    id,
    label,
    capabilities: { continueSession: true, archive: false },
    hosts: [
      {
        hostId: "gateway:local",
        label: "Gateway Mac",
        kind: "gateway",
        connected: true,
        sessions: [
          {
            threadId: `${id}-local`,
            name: `${label} local plan`,
            status: "stored",
            canContinue: true,
            canArchive: false,
          },
        ],
      },
      {
        hostId: "node:build",
        label: "Build Node",
        kind: "node",
        connected: true,
        nodeId: "build",
        sessions: [
          {
            threadId: `${id}-remote`,
            name: `${label} remote review`,
            status: "stored",
            canContinue: false,
            canArchive: false,
          },
        ],
      },
    ],
  });
  return { catalogs: [catalog("claude", "Claude Code"), catalog("codex", "Codex")] };
}

async function expandCodingSection(page: Page) {
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  await toggle.waitFor({ state: "visible" });
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}

async function openClaudeCatalogTerminal(page: Page) {
  await page.goto(`${server.baseUrl}chat`);
  await expandCodingSection(page);
  const row = page.locator('[data-session-key^="catalog:"]').filter({
    hasText: "Native Claude terminal",
  });
  await row.click({ button: "right" });
  await page.locator('wa-dropdown-item[value="terminal"]').click();
}

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

  it("groups Claude and Codex sessions by Gateway and paired-node host", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: { "sessions.catalog.list": hostGroupedNativeCatalogs() },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await expandCodingSection(page);
      for (const catalogId of ["claude", "codex"]) {
        const section = page.locator(`[data-session-section="catalog:${catalogId}"]`);
        const gatewayHost = section.locator('[data-session-catalog-host="gateway:local"]');
        const buildHost = section.locator('[data-session-catalog-host="node:build"]');
        await gatewayHost.getByText("Gateway Mac", { exact: true }).waitFor();
        await buildHost.getByText("Build Node", { exact: true }).waitFor();
        expect(await gatewayHost.locator(".sidebar-recent-session").count()).toBe(1);
        expect(await buildHost.locator(".sidebar-recent-session").count()).toBe(1);
      }

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await fs.mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          path: path.join(artifactDir, "native-session-host-groups.png"),
          fullPage: true,
        });
      }
    } finally {
      await page.close();
    }
  });

  it("shows catalog connection progress until the first terminal output", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["terminal.open"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.catalog.list",
        "sessions.catalog.read",
        "terminal.open",
      ],
      methodResponses: {
        "sessions.catalog.list": resumableClaudeCatalog(),
        "sessions.catalog.read": {
          hostId: "gateway:local",
          threadId: "claude-terminal-session",
          items: [{ type: "userMessage", text: "Continue the native session" }],
        },
        "terminal.list": { sessions: [] },
      },
      terminalEnabled: true,
    });

    try {
      await openClaudeCatalogTerminal(page);
      const open = await gateway.waitForRequest("terminal.open");
      expect(open.params).toMatchObject({
        catalog: {
          catalogId: "claude",
          hostId: "gateway:local",
          threadId: "claude-terminal-session",
        },
      });
      const connecting = page.getByRole("status").filter({ hasText: "Connecting to session" });
      await connecting.waitFor();
      expect(await page.locator(".tabstrip-tab.is-connecting").count()).toBe(1);

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await fs.mkdir(artifactDir, { recursive: true });
        await page.screenshot({ path: path.join(artifactDir, "claude-terminal-connecting.png") });
      }

      await gateway.resolveDeferred("terminal.open", {
        agentId: "main",
        confined: false,
        cwd: "/workspace",
        sessionId: "claude-terminal-e2e",
        shell: "/bin/zsh",
        title: "claude --resume claude-termi…",
      });
      await expect.poll(() => connecting.count()).toBe(1);
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "claude-terminal-e2e",
        seq: 17,
        data: "Claude Code ready\r\n",
      });
      await expect.poll(() => connecting.count()).toBe(0);
      expect(await page.locator(".tabstrip-tab.is-live").count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("closes a catalog terminal that produces no output before the deadline", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.catalog.list",
        "sessions.catalog.read",
        "terminal.open",
      ],
      methodResponses: {
        "sessions.catalog.list": resumableClaudeCatalog(),
        "sessions.catalog.read": {
          hostId: "gateway:local",
          threadId: "claude-terminal-session",
          items: [],
        },
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "claude-terminal-timeout",
          shell: "/bin/zsh",
          title: "claude --resume claude-termi…",
        },
      },
      terminalEnabled: true,
    });

    try {
      await page.clock.install();
      await openClaudeCatalogTerminal(page);
      await gateway.waitForRequest("terminal.open");
      await page.getByRole("status").filter({ hasText: "Connecting to session" }).waitFor();
      await page.clock.runFor(30_001);

      await page.getByText("Session did not connect within 30 seconds.", { exact: true }).waitFor();
      const close = await gateway.waitForRequest("terminal.close");
      expect(close.params).toEqual({ sessionId: "claude-terminal-timeout" });
      expect(await page.locator(".tabstrip-tab").count()).toBe(0);
    } finally {
      await context.close();
    }
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
    await expandCodingSection(page);
    await page.getByRole("button", { name: "Load more threads" }).click();
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
    await thread.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.clock.runFor(100);
    await page.locator('.chat-virtual-row:not([data-virtual-row-key="history"])').first().waitFor();
    const anchor = await firstVisibleVirtualRow(thread);
    await expect
      .poll(() => gateway.getRequests("sessions.catalog.read").then((requests) => requests.length))
      .toBe(initialReadCount + 1);
    await page.locator(".chat-history-loading").waitFor();
    expect(await page.getByRole("button", { name: "Load older" }).count()).toBe(0);
    await startVirtualRowPrependProbe(thread, anchor);
    await gateway.resolveDeferred("sessions.catalog.read");
    await expect
      .poll(() =>
        page
          .locator("openclaw-chat-pane")
          .evaluate(
            (element) =>
              (element as HTMLElement & { catalogMessages: unknown[] }).catalogMessages.length,
          ),
      )
      .toBe(41);
    await page.clock.runFor(100);
    expectStableVirtualRowPrepend(anchor, await finishVirtualRowPrependProbe(thread));
    expect(await page.locator(".agent-chat__composer-combobox > textarea").isDisabled()).toBe(true);
    await expect
      .poll(() => page.getByText("This thread is on a paired node and is view-only.").count())
      .toBe(1);
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const expectCenteredLayout = async (screenshotName: string) => {
      const [workbenchBox, threadBox, composerBox] = await Promise.all([
        page.locator(".chat-workbench").boundingBox(),
        page.locator(".chat-thread-inner").boundingBox(),
        page.locator(".agent-chat__composer-shell").boundingBox(),
      ]);
      expect(workbenchBox).not.toBeNull();
      expect(threadBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      const workbenchCenter = workbenchBox!.x + workbenchBox!.width / 2;
      expect(Math.abs(threadBox!.x + threadBox!.width / 2 - workbenchCenter)).toBeLessThanOrEqual(
        1,
      );
      expect(
        Math.abs(composerBox!.x + composerBox!.width / 2 - workbenchCenter),
      ).toBeLessThanOrEqual(1);
      if (artifactDir) {
        await fs.mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          path: path.join(artifactDir, screenshotName),
          fullPage: true,
        });
      }
    };
    await expectCenteredLayout("claude-external-session-centered-1280.png");
    await page.setViewportSize({ width: 1600, height: 900 });
    await expectCenteredLayout("claude-external-session-centered-1600.png");
    expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
      catalogId: "claude",
      cursor: "older",
    });
    const exhaustedReadCount = (await gateway.getRequests("sessions.catalog.read")).length;
    await thread.hover();
    await page.mouse.wheel(0, -10_000);
    await page.clock.runFor(100);
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
    await expect.poll(() => page.getByText("older question", { exact: true }).count()).toBe(1);
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
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await gateway.deferNext("chat.history");
    await thread.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.locator('.chat-virtual-row:not([data-virtual-row-key="history"])').first().waitFor();
    const anchor = await firstVisibleVirtualRow(thread);
    await gateway.waitForRequest("chat.history");
    await page.locator(".chat-history-loading").waitFor();
    await startVirtualRowPrependProbe(thread, anchor);
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
    await page.clock.runFor(100);
    expectStableVirtualRowPrepend(anchor, await finishVirtualRowPrependProbe(thread));
    expect((await gateway.getRequests("chat.history")).at(-1)?.params).toMatchObject({
      limit: 100,
      offset: 100,
    });
    const exhaustedRequestCount = (await gateway.getRequests("chat.history")).length;
    await thread.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.clock.runFor(100);
    await page.getByText(/^older native message 1\n/).waitFor();
    await page.clock.runFor(300);
    expect(await page.locator(".chat-history-loading").count()).toBe(0);
    expect(await gateway.getRequests("chat.history")).toHaveLength(exhaustedRequestCount);
    await page.close();
  });

  it("keeps a focused message action mounted while its row scrolls out of view", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const messages = Array.from({ length: 200 }, (_, index) => ({
      __openclaw: { seq: index + 1 },
      content: [
        {
          type: "text",
          text: `focus retention message ${index + 1}\n${"transcript detail line\n".repeat(3)}`,
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: Date.now() + index,
    }));
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "chat.startup": {
          messages,
          hasMore: false,
          totalMessages: messages.length,
          sessionId: "focus-retention",
          thinkingLevel: null,
        },
      },
    });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText(/^focus retention message 200\n/).waitFor();
    const thread = page.locator(".chat-thread");
    const action = thread.locator("button.chat-group-delete").last();
    await action.focus();
    const focusedRowKey = await action.evaluate(
      (element) => element.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey ?? "",
    );
    expect(focusedRowKey).not.toBe("");

    await thread.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => thread.evaluate((element) => Math.round(element.scrollTop))).toBe(0);
    await page.getByText(/^focus retention message 1\n/).waitFor();
    await expect
      .poll(() =>
        thread.evaluate((element, key) => {
          const row = Array.from(
            element.querySelectorAll<HTMLElement>(".chat-virtual-row[data-virtual-row-key]"),
          ).find((candidate) => candidate.dataset.virtualRowKey === key);
          return Boolean(row?.contains(document.activeElement));
        }, focusedRowKey),
      )
      .toBe(true);
    expect(await thread.locator(".chat-virtual-row").count()).toBeLessThan(30);
    await page.close();
  });
});
