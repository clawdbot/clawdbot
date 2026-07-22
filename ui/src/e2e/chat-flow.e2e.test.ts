import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
// Control UI tests cover chat flow behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SESSION_DRAG_MIME } from "../lib/sessions/drag.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const sessionAccessibilityProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-accessibility",
);
const managedImageCacheProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "managed-image-cache",
);

let server: ControlUiE2eServer;
// Browser contexts preserve test isolation; keep one process warm for this file.
let browser: Browser;
const openBrowserContexts = new Set<BrowserContext>();

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return value;
}

async function waitForRequests(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  method: string,
  count: number,
): Promise<MockGatewayRequest[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests(method);
    if (requests.length >= count) {
      return requests;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${count} ${method} requests`);
}

async function expectRequestCountStable(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  method: string,
  count: number,
  durationMs = 500,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  do {
    expect(await gateway.getRequests(method)).toHaveLength(count);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } while (Date.now() < deadline);
}

async function installPlainHttpClipboardCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec = [];
    document.execCommand = ((command: string) => {
      if (command !== "copy") {
        return false;
      }
      // execCommand("copy") copies the active selection; the fallback selects
      // its off-screen scratch textarea, so the focused element holds the text.
      const active = document.activeElement as HTMLTextAreaElement | null;
      (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec.push(
        active?.value ?? "",
      );
      return true;
    }) as typeof document.execCommand;
  });
}

async function copiedViaExec(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec);
}

async function chatThreadDistanceFromBottom(page: Page): Promise<number> {
  return page.locator(".chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    return Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight);
  });
}

async function waitForChatScrollIdle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.locator(".chat-thread").evaluate(async (element) => {
          const thread = element as HTMLElement;
          const readGeometry = () => ({
            clientHeight: thread.clientHeight,
            scrollHeight: thread.scrollHeight,
            scrollTop: Math.round(thread.scrollTop),
          });
          const before = readGeometry();
          // The chat scroll owner may do one bounded 120/150ms late-size retry.
          await new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, 180);
          });
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          });
          const after = readGeometry();
          return (
            before.clientHeight === after.clientHeight &&
            before.scrollHeight === after.scrollHeight &&
            before.scrollTop === after.scrollTop
          );
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function scrollChatThreadToTop(page: Page): Promise<void> {
  await page.locator(".chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    thread.scrollTop = 0;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

async function newBrowserContext(options: Parameters<Browser["newContext"]>[0]) {
  const context = await browser.newContext(options);
  openBrowserContexts.add(context);
  return context;
}

async function closeBrowserContext(context: BrowserContext): Promise<void> {
  openBrowserContexts.delete(context);
  await context.close().catch(() => {});
}

async function closeOpenBrowserContexts(): Promise<void> {
  await Promise.all([...openBrowserContexts].map((context) => closeBrowserContext(context)));
}

async function captureSessionAccessibilityProof(page: Page, name: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(sessionAccessibilityProofDir, { recursive: true });
  const sidebar = page.locator("openclaw-app-sidebar");
  await page.screenshot({
    fullPage: true,
    path: path.join(sessionAccessibilityProofDir, `${name}.png`),
  });
  await writeFile(
    path.join(sessionAccessibilityProofDir, `${name}.yml`),
    await sidebar.ariaSnapshot(),
    "utf8",
  );
}

async function visibleChatBubbleTexts(page: Page): Promise<string[]> {
  return page.locator(".chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    const viewport = thread.getBoundingClientRect();
    return Array.from(thread.querySelectorAll(".chat-bubble"))
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.width > 0 &&
          rect.bottom > viewport.top &&
          rect.top < viewport.bottom
        );
      })
      .map((candidate) => candidate.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}
function chatSessionListResponse(
  sessions: Array<
    Record<string, unknown> & {
      key: string;
      kind: string;
      label: string;
      updatedAt: number;
    }
  > = [
    {
      key: "agent:main:session-a",
      kind: "direct",
      label: "Session A",
      updatedAt: 2,
    },
    {
      key: "agent:main:session-b",
      kind: "direct",
      label: "Session B",
      updatedAt: 1,
    },
  ],
) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    path: "",
    sessions,
    ts: Date.now(),
  };
}

async function sidebarSessionOrder(page: Page): Promise<string[]> {
  return page
    .locator(".sidebar-recent-session")
    .evaluateAll((rows) =>
      rows
        .map((row) => row.getAttribute("data-session-key") ?? "")
        .filter((key) => key.startsWith("agent:main:session-")),
    );
}

describeControlUiE2e("Control UI mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterAll(async () => {
    await closeOpenBrowserContexts();
    await browser?.close();
    await server?.close();
  });

  afterEach(async () => {
    await closeOpenBrowserContexts();
  });

  it("renders always-on pane headers without desktop topbar chrome", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ type: "text", text: "Split toolbar proof." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      methodResponses: { "sessions.list": chatSessionListResponse() },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Split toolbar proof.").waitFor({ timeout: 10_000 });

      // Desktop renders no topbar row: the sidebar owns navigation.
      await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);

      const splitEntry = page.getByRole("button", { name: "Open split view" });
      await expect.poll(() => splitEntry.isVisible()).toBe(true);
      await expect.poll(() => page.locator(".chat-pane__header").count()).toBe(1);
      await page.evaluate(() => {
        document.documentElement.classList.add("openclaw-native-macos");
        document.querySelector(".shell")?.classList.add("shell--nav-collapsed");
      });
      await expect
        .poll(() =>
          page
            .locator(".chat-pane__header")
            .evaluate((header) => getComputedStyle(header).paddingLeft),
        )
        .toBe("90px");
      await page.evaluate(() => {
        document.documentElement.classList.remove("openclaw-native-macos");
        document.querySelector(".shell")?.classList.remove("shell--nav-collapsed");
      });
      await page.setViewportSize({ height: 900, width: 1100 });
      await expect.poll(() => splitEntry.isVisible()).toBe(true);
      await page.setViewportSize({ height: 900, width: 1440 });
      await expect
        .poll(() =>
          splitEntry.evaluate((node) => node.closest(".agent-chat__composer-shell") == null),
        )
        .toBe(true);
      await page.locator("openclaw-chat-pane").evaluate((pane) => {
        (
          globalThis as typeof globalThis & {
            classicChatPane?: Element;
          }
        ).classicChatPane = pane;
      });
      const startupRequestsBeforeSplit = (await gateway.getRequests("chat.startup")).length;
      await gateway.deferNext("chat.startup");
      await splitEntry.click();
      await expect
        .poll(async () => (await gateway.getRequests("chat.startup")).length)
        .toBeGreaterThan(startupRequestsBeforeSplit);

      // Each pane owns the same in-flow header in classic and split layouts.
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      const headers = page.locator(".chat-pane__header");
      await expect.poll(() => panes.count()).toBe(2);
      await panes.last().getByText("Split toolbar proof.").waitFor();
      await expect.poll(() => panes.last().locator(".chat-loading-skeleton").count()).toBe(0);
      await gateway.resolveDeferred("chat.startup");
      await expect
        .poll(() =>
          panes.first().evaluate(
            (pane) =>
              (
                globalThis as typeof globalThis & {
                  classicChatPane?: Element;
                }
              ).classicChatPane === pane,
          ),
        )
        .toBe(true);
      await expect.poll(() => headers.count()).toBe(2);
      await expect
        .poll(async () => {
          const visible = await Promise.all((await headers.all()).map((pane) => pane.isVisible()));
          return visible.every(Boolean);
        })
        .toBe(true);
      await expect.poll(() => splitEntry.count()).toBe(0);
      // The pane header hosts the session workspace toggle (the old collapsed
      // rail strip is gone).
      await expect.poll(() => headers.first().locator(".chat-workspace-toggle").count()).toBe(1);
      await expect.poll(() => page.locator(".chat-workspace-rail").count()).toBe(0);

      // Keyboard focus on a header action marks the pane active.
      await headers.first().getByRole("button", { name: "Split down" }).focus();
      const cells = page.locator(".chat-split-view__cell");
      await expect.poll(() => cells.first().getAttribute("class")).toContain("--active");

      const lastPane = page.locator(".chat-split-view__pane").last();
      await lastPane.click({ position: { x: 20, y: 80 } });
      await expect.poll(() => cells.last().getAttribute("class")).toContain("--active");
      const targetHeader = headers.first();
      await expect
        .poll(() =>
          targetHeader.evaluate((header) => {
            const owner = header.closest("openclaw-chat-pane");
            return (
              owner === header.parentElement && owner?.classList.contains("chat-split-view__pane")
            );
          }),
        )
        .toBe(true);

      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await dataTransfer.evaluate(
        (transfer, data) => {
          transfer.setData(data.mime, data.sessionKey);
        },
        { mime: SESSION_DRAG_MIME, sessionKey: "agent:main:session-b" },
      );
      const unrelatedTarget = page.locator(".chat-split-view");
      const unrelatedDrag = {
        bubbles: true,
        clientX: 0,
        clientY: 0,
        dataTransfer,
      };
      await unrelatedTarget.dispatchEvent("dragenter", unrelatedDrag);
      await unrelatedTarget.dispatchEvent("dragover", unrelatedDrag);
      await expect.poll(() => page.locator(".chat-split-view__drop-indicator").count()).toBe(0);
      await unrelatedTarget.dispatchEvent("drop", unrelatedDrag);
      await expect.poll(() => panes.count()).toBe(2);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("session"))
        .toBe("agent:main:session-a");

      // Start with no retained pane preview and target the visible header.
      const targetBox = await targetHeader.boundingBox();
      if (!targetBox) {
        throw new Error("expected the pane header to have a layout box");
      }
      const directHeaderDrag = {
        bubbles: true,
        clientX: targetBox.x + targetBox.width / 2,
        clientY: targetBox.y + targetBox.height / 2,
        dataTransfer,
      };
      await targetHeader.dispatchEvent("dragenter", directHeaderDrag);
      await targetHeader.dispatchEvent("dragover", directHeaderDrag);
      await expect.poll(() => page.locator(".chat-split-view__drop-indicator").count()).toBe(1);
      await targetHeader.dispatchEvent("drop", directHeaderDrag);
      await dataTransfer.dispose();

      await expect.poll(() => panes.count()).toBe(3);
      await expect
        .poll(async () =>
          (await page.locator(".chat-pane__session-title").allTextContents()).map((title) =>
            title.trim(),
          ),
        )
        .toContain("Session B");
      await expect
        .poll(() => new URL(page.url()).searchParams.get("session"))
        .toBe("agent:main:session-b");
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("sends a chat turn through the GUI and renders the final Gateway event", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Ready for an end-to-end GUI check.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Ready for an end-to-end GUI check.").waitFor({ timeout: 10_000 });

      const prompt = "verify the control UI e2e harness";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      expect(params.sessionKey).toBe("main");
      expect(params.message).toBe(prompt);
      expect(params.deliver).toBe(false);

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await gateway.emitChatFinal({ runId, text: "Harness verified." });

      await page
        .locator(".chat-thread-inner")
        .getByText("Harness verified.")
        .waitFor({ timeout: 10_000 });

      const spacedPairCommand = "/ pair qr";
      await page.locator(".agent-chat__composer-combobox textarea").fill(spacedPairCommand);
      await page.getByRole("button", { name: "Send message" }).click();

      const commandRequests = await waitForRequests(gateway, "chat.send", 2);
      const commandParams = requireRecord(commandRequests[1]?.params);
      expect(commandParams.message).toBe(spacedPairCommand);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("reconciles authoritative history before a trailing final by run identity", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { historyMessages: [] });
    try {
      await page.goto(`${server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("reconcile the terminal event ordering");
      await page.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(send.params).idempotencyKey,
        "chat send idempotency key",
      );
      const finalText = "One authoritative final response.";
      const messageId = "assistant-authoritative-final";
      const authoritative = {
        __openclaw: { id: messageId, seq: 2 },
        content: [{ text: finalText, type: "text" }],
        role: "assistant",
        timestamp: Date.now(),
      };
      await gateway.emitGatewayEvent("chat", {
        deltaText: finalText,
        message: {
          content: [{ text: finalText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      await page.locator(".chat-bubble.streaming", { hasText: finalText }).waitFor();
      await gateway.setHistoryMessages([
        {
          __openclaw: { id: "user-reconcile", seq: 1 },
          content: [{ text: "reconcile the terminal event ordering", type: "text" }],
          role: "user",
          timestamp: Date.now() - 1,
        },
        authoritative,
      ]);
      const historyRequestsBefore = (await gateway.getRequests("chat.history")).length;
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        clientRunId: runId,
        hasActiveRun: false,
        message: authoritative,
        messageId,
        messageSeq: 2,
        session: {
          activeRunIds: [],
          hasActiveRun: false,
          key: "main",
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).length)
        .toBeGreaterThan(historyRequestsBefore);
      await page.locator(".chat-thread-inner").getByText(finalText, { exact: true }).waitFor();
      await expect
        .poll(() =>
          page.locator(".chat-group.assistant .chat-text", { hasText: finalText }).count(),
        )
        .toBe(1);

      await gateway.emitChatFinal({ runId, text: finalText });
      await expect
        .poll(() => page.locator(".chat-group.assistant .chat-duplicate-count").count())
        .toBe(0);
      await expect
        .poll(() =>
          page.locator(".chat-group.assistant .chat-text", { hasText: finalText }).count(),
        )
        .toBe(1);

      await gateway.emitChatFinal({ runId: "a-different-legitimate-run", text: finalText });
      await expect
        .poll(() =>
          page.locator(".chat-group.assistant .chat-text", { hasText: finalText }).count(),
        )
        .toBe(2);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("restores the selected session transcript after a hard reload", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const historyText = "Transcript survives a hard reload.";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: historyText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat?session=main`);
      await page.getByText(historyText).waitFor({ timeout: 10_000 });
      await gateway.waitForRequest("chat.startup");

      await page.reload();

      await page.getByText(historyText).waitFor({ timeout: 10_000 });
      await expect.poll(async () => (await gateway.getRequests("chat.startup")).length).toBe(1);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("sends idle stop aliases as ordinary chat messages", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await composer.fill("wait");
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(sendRequest.params).message).toBe("wait");
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("persists the chat send shortcut and keeps multiline and IME input safe", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });

      await composer.fill("default enter send");
      await composer.press("Enter");
      const defaultRequest = await gateway.waitForRequest("chat.send");
      const defaultParams = requireRecord(defaultRequest.params);
      expect(defaultParams.message).toBe("default enter send");
      await gateway.emitChatFinal({
        runId: requireString(defaultParams.idempotencyKey, "default send idempotency key"),
        text: "Default shortcut received.",
      });
      await page
        .locator(".chat-thread-inner")
        .getByText("Default shortcut received.")
        .waitFor({ timeout: 10_000 });

      // The send shortcut moved to the Settings appearance page; picking it
      // there must apply to the chat composer after navigating back.
      await page.goto(`${server.baseUrl}settings/appearance`);
      const shortcutSelect = page.locator("[data-settings-send-shortcut]");
      await shortcutSelect.selectOption("modifier-enter");
      expect(await shortcutSelect.inputValue()).toBe("modifier-enter");

      await page.goto(`${server.baseUrl}chat`);
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      expect(await composer.getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");

      await composer.fill("plain enter stays in the draft");
      await composer.press("Enter");
      expect(await composer.inputValue()).toContain("\n");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await composer.fill("composition must not send");
      await composer.dispatchEvent("compositionstart");
      await composer.press("Control+Enter");
      await composer.dispatchEvent("compositionend");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await composer.fill("modifier send");
      await composer.press("Meta+Enter");
      const modifierRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(modifierRequest.params).message).toBe("modifier send");
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("steers an active run when the session row only reports hasActiveRun", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "main";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Active run is waiting for steering.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            hasActiveRun: true,
            key: "agent:main:main",
            kind: "direct",
            label: "Main",
            updatedAt: Date.now(),
          },
        ]),
      },
      sessionKey,
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Active run is waiting for steering.").waitFor({ timeout: 10_000 });
      await gateway.waitForRequest("sessions.list");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("/steer use the smaller fix");
      await page.getByRole("button", { name: "Send message" }).click();

      const steerRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(steerRequest.params);
      expect(params.sessionKey).toBe(sessionKey);
      expect(params.message).toBe("use the smaller fix");
      expect(params.deliver).toBe(false);

      await page.getByText("Steered.", { exact: true }).waitFor({ timeout: 10_000 });
      expect(await page.getByText("No active run").count()).toBe(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("downloads an assistant document with the server-provided Unicode filename", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const source = "/tmp/openclaw/测试 report.pdf";
    const mediaUrl = `/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&mediaTicket=ticket-download`;
    const requestedUrls: URL[] = [];
    // The document opens in a new tab, so intercept at the context boundary.
    await context.route("**/__openclaw__/assistant-media?**", async (route) => {
      const url = new URL(route.request().url());
      requestedUrls.push(url);
      await route.fulfill({
        body: "%PDF-1.4\n",
        contentType: "application/pdf",
        headers: {
          "Content-Disposition": `attachment; filename="__ report.pdf"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20report.pdf`,
        },
      });
    });
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Your report is ready." },
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "测试 report.pdf",
                mimeType: "application/pdf",
                url: mediaUrl,
              },
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const link = page.getByRole("link", { name: "测试 report.pdf" });
      await link.waitFor({ state: "visible", timeout: 10_000 });
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);

      expect(download.suggestedFilename()).toBe("测试 report.pdf");
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]?.searchParams.get("source")).toBe(source);
      expect(requestedUrls[0]?.searchParams.get("mediaTicket")).toBe("ticket-download");
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("renders a direct tool-result image from Gateway history", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const imageData =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X3q8AAAAAElFTkSuQmCC";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [
            { alt: "Tool result preview", data: imageData, mimeType: "image/png", type: "image" },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const image = page.getByAltText("Tool result preview");
      await image.waitFor({ state: "visible", timeout: 10_000 });
      expect(await image.getAttribute("src")).toBe(`data:image/png;base64,${imageData}`);
      await gateway.waitForRequest("chat.startup");
      await expect
        .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
        .toBe(1);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("renders a canonical inbound image through the ticketed media route", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const requestedMediaUrls: URL[] = [];
    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requestedMediaUrls.push(url);
      expect(url.searchParams.get("source")).toBe("media://inbound/telegram-photo.png");
      if (url.searchParams.get("meta") === "1") {
        expect(request.headers().authorization).toBe("Bearer e2e-device-token");
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            mediaTicket: "ticket-inbound",
            mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          }),
        });
        return;
      }
      expect(url.searchParams.get("mediaTicket")).toBe("ticket-inbound");
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    });
    await installMockGateway(page, {
      historyMessages: [
        {
          id: "user-inbound-media-ref",
          role: "user",
          content: [{ type: "text", text: "🖼️ Attached image" }],
          MediaPath: "media://inbound/telegram-photo.png",
          MediaType: "image/png",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await expect.poll(() => requestedMediaUrls.length, { timeout: 10_000 }).toBe(2);
      const image = page.getByAltText("Attached image");
      await image.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() =>
          image.evaluate((element) =>
            element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
          ),
        )
        .toBe(1);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("evicts and refetches managed image Blob URLs after the cache reaches capacity", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const originalCreateObjectURL = URL.createObjectURL.bind(URL);
      const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
      const proof = { created: [] as string[], revoked: [] as string[] };
      Object.defineProperty(globalThis, "managedImageCacheProof", {
        configurable: true,
        value: proof,
      });
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: (blob: Blob) => {
          const blobUrl = originalCreateObjectURL(blob);
          proof.created.push(blobUrl);
          return blobUrl;
        },
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: (blobUrl: string) => {
          proof.revoked.push(blobUrl);
          originalRevokeObjectURL(blobUrl);
        },
      });
    });

    const imageUrls = Array.from({ length: 65 }, (_, index) => {
      const id = String(index + 1).padStart(12, "0");
      return `/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-${id}/full`;
    });
    const fetchedMedia: Array<{
      authorization: string | undefined;
      pathname: string;
      requesterSessionKey: string | undefined;
    }> = [];
    await page.route("**/api/chat/media/outgoing/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      fetchedMedia.push({
        authorization: request.headers().authorization,
        pathname: url.pathname,
        requesterSessionKey: request.headers()["x-openclaw-requester-session-key"],
      });
      await route.fulfill({
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" rx="12" fill="#0f766e"/><text x="80" y="50" text-anchor="middle" fill="white" font-family="sans-serif" font-size="14">managed preview</text></svg>',
        contentType: "image/svg+xml",
      });
    });

    const historyFor = (indexes: number[], labelPrefix: string) => [
      {
        content: indexes.map((index) => ({
          alt: `${labelPrefix} ${index + 1}`,
          type: "image",
          url: imageUrls[index],
        })),
        role: "assistant",
        timestamp: Date.now(),
      },
    ];
    const gateway = await installMockGateway(page, {
      historyMessages: historyFor(
        Array.from({ length: 64 }, (_, index) => index),
        "Initial managed image",
      ),
    });
    const readBlobProof = () =>
      page.evaluate(() => {
        const proof = (
          globalThis as typeof globalThis & {
            managedImageCacheProof: { created: string[]; revoked: string[] };
          }
        ).managedImageCacheProof;
        return { created: [...proof.created], revoked: [...proof.revoked] };
      });
    let proofMessageSequence = 100;
    const replaceHistory = async (messages: unknown[], visibleAlt: string) => {
      const historyRequestsBefore = (await gateway.getRequests("chat.history")).length;
      await gateway.setHistoryMessages(messages);
      proofMessageSequence += 1;
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        hasActiveRun: false,
        message: messages[0],
        messageId: `managed-image-cache-proof-${proofMessageSequence}`,
        messageSeq: proofMessageSequence,
        session: {
          activeRunIds: [],
          hasActiveRun: false,
          key: "main",
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(historyRequestsBefore);
      await page.getByAltText(visibleAlt).waitFor({ state: "visible", timeout: 10_000 });
    };

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await expect.poll(async () => (await readBlobProof()).created.length).toBe(64);
      await expect
        .poll(() =>
          page
            .locator("img.chat-message-image")
            .evaluateAll(
              (images) =>
                images.filter(
                  (image) =>
                    image instanceof HTMLImageElement &&
                    image.complete &&
                    image.naturalWidth === 160,
                ).length,
            ),
        )
        .toBe(64);

      await replaceHistory(
        historyFor([0], "Recently viewed managed image"),
        "Recently viewed managed image 1",
      );
      expect((await readBlobProof()).created).toHaveLength(64);

      await replaceHistory(historyFor([64], "Overflow managed image"), "Overflow managed image 65");
      await expect.poll(async () => (await readBlobProof()).created.length).toBe(65);
      const overflowProof = await readBlobProof();
      const retainedRecentBlobUrl = expectDefined(
        overflowProof.created[0],
        "recent managed image Blob URL",
      );
      const evictedBlobUrl = expectDefined(
        overflowProof.created[1],
        "evicted managed image Blob URL",
      );
      expect(overflowProof.revoked).toContain(evictedBlobUrl);
      expect(overflowProof.revoked).not.toContain(retainedRecentBlobUrl);

      const evictedPath = new URL(
        expectDefined(imageUrls[1], "evicted managed image URL"),
        server.baseUrl,
      ).pathname;
      const fetchesBeforeRevisit = fetchedMedia.filter(
        (request) => request.pathname === evictedPath,
      ).length;
      await replaceHistory(historyFor([1], "Refetched managed image"), "Refetched managed image 2");
      const revisitedImage = page.getByAltText("Refetched managed image 2");
      await expect
        .poll(() =>
          revisitedImage.evaluate((image) =>
            image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
          ),
        )
        .toBe(160);
      await expect.poll(async () => (await readBlobProof()).created.length).toBe(66);
      const finalProof = await readBlobProof();
      const evictedImageFetches = fetchedMedia.filter(
        (request) => request.pathname === evictedPath,
      ).length;
      expect(evictedImageFetches).toBe(fetchesBeforeRevisit + 1);
      expect(fetchedMedia).not.toHaveLength(0);
      expect(
        fetchedMedia.every((request) => request.authorization === "Bearer e2e-device-token"),
      ).toBe(true);
      expect(
        fetchedMedia.every((request) => request.requesterSessionKey === "agent:main:main"),
      ).toBe(true);

      const proofSummary = {
        cacheCapacity: 64,
        createdBlobUrls: finalProof.created.length,
        evictedBlobIndex: 1,
        evictedImageFetches,
        refetchedImageNaturalWidth: await revisitedImage.evaluate(
          (image) => (image as HTMLImageElement).naturalWidth,
        ),
        retainedRecentBlobRevoked: finalProof.revoked.includes(retainedRecentBlobUrl),
        revokedBlobUrls: finalProof.revoked.length,
      };
      if (captureUiProofEnabled) {
        await mkdir(managedImageCacheProofDir, { recursive: true });
        await page.evaluate((summary) => {
          const panel = document.createElement("pre");
          panel.setAttribute("data-managed-image-cache-proof", "true");
          panel.style.cssText =
            "position:fixed;right:16px;bottom:16px;z-index:99999;max-width:460px;padding:16px;border:2px solid #5eead4;border-radius:10px;background:#0f172a;color:#ccfbf1;font:14px/1.45 monospace;white-space:pre-wrap";
          panel.textContent = `Managed image cache browser proof\n${JSON.stringify(summary, null, 2)}`;
          document.body.append(panel);
        }, proofSummary);
        await page.screenshot({
          fullPage: true,
          path: path.join(managedImageCacheProofDir, "after-refetch.png"),
        });
        await writeFile(
          path.join(managedImageCacheProofDir, "after-refetch.json"),
          `${JSON.stringify(proofSummary, null, 2)}\n`,
          "utf8",
        );
      }
      if (process.env.OPENCLAW_BEHAVIOR_PROOF === "1") {
        process.stdout.write(
          `${JSON.stringify({ proof: "managed-image-cache", ...proofSummary })}\n`,
        );
      }
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("opens current context and latest-run usage from the composer ring", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        { role: "user", content: "Show current usage", timestamp: Date.now() - 1_000 },
        {
          role: "assistant",
          content: "Usage ready.",
          cost: {
            input: 0.003456,
            output: 0.018,
            cacheRead: 0.0015,
            cacheWrite: 0.0005,
            total: 0.023456,
          },
          model: "gpt-5.5",
          provider: "openai",
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: 200_000,
            model: "gpt-5.5",
            modelProvider: "openai",
          },
          path: "",
          sessions: [
            {
              contextTokens: 200_000,
              estimatedCostUsd: 0.023456,
              inputTokens: 757_300,
              key: "main",
              kind: "direct",
              model: "gpt-5.5",
              modelProvider: "openai",
              outputTokens: 42_300,
              totalTokens: 46_000,
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const trigger = page.locator("summary.context-ring");
      await trigger.waitFor({ timeout: 10_000 });
      await trigger.click();

      const popover = page.locator(".context-usage__popover");
      await expect.poll(() => popover.isVisible()).toBe(true);
      await expect.poll(() => popover.textContent()).toContain("46k / 200k · 23%");
      await expect.poll(() => popover.textContent()).toContain("757.3k");
      await expect.poll(() => popover.textContent()).toContain("42.3k");
      await expect.poll(() => popover.textContent()).toContain("Est. cost");
      await expect.poll(() => popover.textContent()).toContain("$0.023");
      await expect.poll(() => popover.textContent()).toContain("Cost by Type");
      await expect.poll(() => popover.textContent()).toContain("$0.0035");
      await expect.poll(() => popover.textContent()).toContain("$0.018");
      await expect.poll(() => popover.textContent()).toContain("$0.0015");
      await expect.poll(() => popover.textContent()).toContain("$0.0005");
      await expect.poll(() => popover.textContent()).toContain("openai");
      await expect.poll(() => popover.textContent()).toContain("gpt-5.5");

      await page.keyboard.press("Escape");
      await expect.poll(() => popover.isHidden()).toBe(true);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("routes page typing to the active composer without stealing text input focus", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Type whenever you are ready.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Type whenever you are ready.").click();

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect
        .poll(() => composer.evaluate((element) => element === document.activeElement))
        .toBe(false);

      await page.keyboard.type("first character preserved");
      expect(await composer.inputValue()).toBe("first character preserved");
      await expect
        .poll(() => composer.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.getByRole("button", { name: "Open command palette" }).click();
      const paletteInput = page.locator(".cmd-palette__input");
      await paletteInput.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => paletteInput.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.type("session search");

      expect(await paletteInput.inputValue()).toBe("session search");
      expect(await composer.inputValue()).toBe("first character preserved");
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps stale context visible as approximate without warning or compaction", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: 200_000, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              contextTokens: 200_000,
              key: "main",
              kind: "direct",
              totalTokens: 190_000,
              totalTokensFresh: false,
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const trigger = page.locator("summary.context-ring");
      await trigger.waitFor({ timeout: 10_000 });
      expect((await trigger.textContent())?.trim()).toBe("~95%");
      expect(await trigger.getAttribute("aria-label")).toBe(
        "Thread context usage: ~190k of 200k (~95%)",
      );
      expect(
        await trigger.evaluate((element) => element.classList.contains("context-ring--warning")),
      ).toBe(false);

      await trigger.click();
      await expect
        .poll(() => page.locator(".context-usage__popover").textContent())
        .toContain("~190k / 200k · ~95%");
      expect(await page.locator(".context-ring__action").count()).toBe(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps a targetless message-tool source reply beside the automatic final reply", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);

      const prompt = "send progress through the message tool and then finish";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      expect(params).toMatchObject({ sessionKey: "main", message: prompt, deliver: false });
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await gateway.emitChatFinal({
        runId,
        text: "Visible progress from the targetless message tool.",
      });
      await page
        .locator(".chat-thread-inner")
        .getByText("Visible progress from the targetless message tool.")
        .waitFor({ timeout: 10_000 });

      await gateway.emitChatFinal({ runId, text: "Visible automatic final reply." });
      await page
        .locator(".chat-thread-inner")
        .getByText("Visible automatic final reply.")
        .waitFor({ timeout: 10_000 });
      const bubbleTexts = await page.locator(".chat-thread .chat-bubble").allTextContents();
      for (const expectedText of [
        prompt,
        "Visible progress from the targetless message tool.",
        "Visible automatic final reply.",
      ]) {
        expect(bubbleTexts.some((text) => text.includes(expectedText))).toBe(true);
      }
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps the composer clear when a stale native input replay arrives after send", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Ready for stale replay check.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Ready for stale replay check.").waitFor({ timeout: 10_000 });

      const prompt = "submitted message";
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      expect(await composer.inputValue()).toBe("");

      const afterReplay = await composer.evaluate((element, submitted) => {
        const textarea = element as HTMLTextAreaElement;
        textarea.value = submitted;
        textarea.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: submitted,
            inputType: "insertText",
          }),
        );
        return textarea.value;
      }, prompt);

      expect(afterReplay).toBe("");
      expect(await composer.inputValue()).toBe("");

      await composer.pressSequentially(prompt);
      expect(await composer.inputValue()).toBe(prompt);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("copies a code block over a non-secure context via the execCommand fallback", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    // Simulate a plain-HTTP deployment where navigator.clipboard is unavailable.
    await installPlainHttpClipboardCapture(page);
    const code = "const hello = 1;";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [
            {
              text: `${"long response line\n\n".repeat(80)}\`\`\`js\n${code}\n\`\`\``,
              type: "text",
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const copyButton = page.locator(".code-block-copy").first();
      await copyButton.waitFor({ timeout: 10_000 });
      await waitForChatScrollIdle(page);
      await copyButton.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const thread = page.locator(".chat-thread");
      const scrollTopBefore = await thread.evaluate((element) =>
        Math.round((element as HTMLElement).scrollTop),
      );
      await copyButton.click();

      await expect
        .poll(() => copyButton.evaluate((el) => el.classList.contains("copied")), {
          timeout: 10_000,
        })
        .toBe(true);
      expect(await copiedViaExec(page)).toContain(code);
      await expect
        .poll(() => thread.evaluate((element) => Math.round((element as HTMLElement).scrollTop)))
        .toBe(scrollTopBefore);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("copies a workspace file path over a non-secure context via the execCommand fallback", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installPlainHttpClipboardCapture(page);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "artifacts.list": { artifacts: [] },
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
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.locator(".chat-workspace-toggle").click();
      await page.locator(".chat-workspace-rail__file-name", { hasText: "AGENTS.md" }).waitFor({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: "Copy path" }).click();

      expect(await copiedViaExec(page)).toContain("/workspace/AGENTS.md");
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("starts the workspace files panel collapsed and toggles it open", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "artifacts.list": {
          artifacts: [
            {
              download: { mode: "bytes" },
              id: "artifact-1",
              mimeType: "image/png",
              sizeBytes: 128,
              title: "preview.png",
              type: "image",
            },
          ],
        },
        "sessions.files.list": {
          browser: {
            entries: [
              {
                kind: "directory",
                name: "src",
                path: "src",
                sessionKind: "modified",
              },
              {
                kind: "file",
                name: "package.json",
                path: "package.json",
                size: 4096,
              },
            ],
            path: "",
          },
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
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      // Collapsed rails render nothing; the title-bar toggle carries the
      // changed-file badge.
      const opener = page.locator(".chat-workspace-toggle");
      await opener.waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
      expect(await page.locator(".chat-workspace-rail").count()).toBe(0);

      await opener.click();
      await page.locator(".chat-workspace-rail__collapse-toggle").waitFor({ timeout: 10_000 });
      await expect.poll(() => opener.getAttribute("aria-expanded")).toBe("true");
      await page.locator(".chat-workspace-rail__file-name", { hasText: "AGENTS.md" }).waitFor({
        timeout: 10_000,
      });
      await page
        .locator(".chat-workspace-rail__file-name", { hasText: "preview.png" })
        .waitFor({ timeout: 10_000 });
      await page.getByText("Project files").waitFor({ timeout: 10_000 });
      await page.locator(".chat-workspace-rail__file-name", { hasText: "package.json" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);
      expect(await gateway.getRequests("artifacts.list")).toHaveLength(1);
      // The rail docks flush to the window edge (no content gutter).
      expect(
        await page.locator(".chat-workspace-rail").evaluate((element) => {
          return window.innerWidth - element.getBoundingClientRect().right;
        }),
      ).toBe(0);

      await page.locator(".chat-workspace-rail__collapse-toggle").click();
      await opener.waitFor({ timeout: 10_000 });
      expect(await page.locator(".chat-workspace-rail").count()).toBe(0);

      await opener.click();
      await page.locator(".chat-workspace-rail__collapse-toggle").waitFor({ timeout: 10_000 });
      await page.locator(".chat-workspace-rail__file-name", { hasText: "AGENTS.md" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      await page.setViewportSize({ height: 900, width: 760 });
      const workbench = page.locator(".chat-workbench");
      await expect
        .poll(() => workbench.getAttribute("class"))
        .toContain("chat-workbench--dock-bottom");
      const workspaceRail = page.locator(".chat-workspace-rail");
      await expect
        .poll(async () => {
          const box = await workspaceRail.boundingBox();
          return Boolean(box && box.width > 0 && box.height > 0);
        })
        .toBe(true);
      expect(await page.locator(".chat-workspace-rail__dock").count()).toBe(0);
      expect(await page.locator(".chat-workspace-rail__grip").count()).toBe(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps long workspace file sections scrollable inside the rail", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const browserEntries = Array.from({ length: 60 }, (_, index) => ({
      kind: "file" as const,
      name: `file-${String(index + 1).padStart(2, "0")}.ts`,
      path: `src/file-${String(index + 1).padStart(2, "0")}.ts`,
      size: 2048 + index,
    }));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.files.list": {
          browser: {
            entries: browserEntries,
            path: "",
          },
          files: [],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.locator(".chat-workspace-toggle").click();
      await page.locator(".chat-workspace-rail__file-name", { hasText: "file-60.ts" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      const browserSection = page.locator(".chat-workspace-rail__section", {
        hasText: "Project files",
      });
      await expect
        .poll(
          () =>
            browserSection.evaluate((section) => {
              const element = section as HTMLElement;
              const scroll = element.closest(".chat-workspace-rail__scroll") as HTMLElement | null;
              if (!scroll) {
                throw new Error("Expected workspace rail scroll container");
              }
              const sectionRect = element.getBoundingClientRect();
              const scrollRect = scroll.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                bottomWithinRail: Math.ceil(sectionRect.bottom) <= Math.ceil(scrollRect.bottom),
                clientHeight: element.clientHeight,
                overflowY: style.overflowY,
                scrollHeight: element.scrollHeight,
              };
            }),
          { timeout: 10_000 },
        )
        .toMatchObject({
          bottomWithinRail: true,
          overflowY: "auto",
        });
      const sectionMetrics = await browserSection.evaluate((section) => {
        const element = section as HTMLElement;
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        };
      });
      expect(sectionMetrics.scrollHeight).toBeGreaterThan(sectionMetrics.clientHeight);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("renders stable markdown during a streaming chat turn and finalizes the tail", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);

      const prompt = "stream markdown through the GUI";
      await gateway.deferNext("chat.send");
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const streamingText = "## Streaming heading\n\nworking **tail";
      await gateway.emitGatewayEvent("chat", {
        deltaText: streamingText,
        message: {
          content: [{ text: streamingText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.locator(".chat-thread h2").getByText("Streaming heading").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-bubble.streaming strong").getByText("tail").waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await page.locator(".chat-thread h2").getByText("Streaming heading").waitFor({
        timeout: 10_000,
      });

      await gateway.emitChatFinal({
        runId,
        text: "## Streaming heading\n\nworking **tail**",
      });

      await page.locator(".chat-thread strong").getByText("tail").waitFor({ timeout: 10_000 });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("normalizes Unicode line separators in streaming and final chat DOM", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);

      await gateway.deferNext("chat.send");
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("render Unicode separators");
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const streamingText = "## Unicode stream\u2028\u2028working **tail";
      await gateway.emitGatewayEvent("chat", {
        deltaText: streamingText,
        message: {
          content: [{ text: streamingText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.locator(".chat-thread h2").getByText("Unicode stream").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-bubble.streaming strong").getByText("tail").waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await gateway.emitChatFinal({
        runId,
        text: "## Unicode final\u2028\u2028- first\u2029- second",
      });

      await page.locator(".chat-thread h2").getByText("Unicode final").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(() => page.locator(".chat-thread li").allTextContents(), { timeout: 10_000 })
        .toEqual(["first", "second"]);
      const finalChatText = await page.locator(".chat-thread .chat-text").last().textContent();
      expect(finalChatText).not.toContain("\u2028");
      expect(finalChatText).not.toContain("\u2029");
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps chat usable while sessions are still loading", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.list"],
      historyMessages: [
        {
          content: [{ text: "History renders before sessions finish.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      await page.getByText("History renders before sessions finish.").waitFor({ timeout: 10_000 });
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });

      // The chat boot hydrates the sidebar session list; that request stays
      // deferred here while the composer must remain fully usable.
      await gateway.waitForRequest("sessions.list");

      await composer.fill("draft while sessions load");
      expect(await composer.inputValue()).toBe("draft while sessions load");
      await composer.fill("");

      // The background hydrate must not take the shared sessions loading
      // flag, which would disable New thread for the whole request.
      const newThread = page.getByRole("button", { name: "New thread" }).first();
      expect(await newThread.isEnabled()).toBe(true);

      await gateway.resolveDeferred("sessions.list");
      await expect.poll(() => newThread.isEnabled()).toBe(true);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("opens a git-backed agent draft from the sidebar new-session action", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { workspaceGit: true });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const newSessionButton = page.locator("openclaw-app-sidebar .sidebar-brand__new-thread");
      await newSessionButton.waitFor({ state: "visible", timeout: 10_000 });
      await newSessionButton.click();

      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await expect.poll(() => new URL(page.url()).searchParams.get("agent")).toBe("main");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("starts a model-suggested follow-up in a fresh worktree session", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const suggestion = {
      id: "task_123",
      title: "Remove stale adapter",
      prompt: "Delete the stale adapter in src/example.ts and update tests.",
      tldr: "The adapter is unreachable and adds maintenance cost.",
      cwd: "/projects/example",
      sessionKey: "main",
      agentId: "main",
      createdAt: Date.now(),
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["taskSuggestions.list"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "taskSuggestions.list",
        "taskSuggestions.accept",
      ],
      methodResponses: {
        "taskSuggestions.list": { suggestions: [suggestion] },
        "taskSuggestions.accept": {
          taskId: "task_123",
          key: "agent:main:dashboard:suggested",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("taskSuggestions.list");
      await gateway.emitGatewayEvent("task.suggestion", {
        action: "created",
        suggestion,
      });
      await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });

      const startButton = page.getByRole("button", { name: "Start in worktree" });
      await startButton.waitFor({ state: "visible", timeout: 10_000 });
      await page
        .getByText("/projects/example", { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      await page
        .getByText("Delete the stale adapter in src/example.ts and update tests.", {
          exact: true,
        })
        .waitFor({ state: "visible", timeout: 10_000 });
      await startButton.click();

      const acceptRequest = await gateway.waitForRequest("taskSuggestions.accept");
      expect(acceptRequest.params).toEqual({ taskId: "task_123" });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("clears model-suggested follow-ups while switching sessions", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "taskSuggestions.list"],
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
        "taskSuggestions.list": {
          suggestions: [
            {
              id: "task_session_a",
              title: "Follow up from session A",
              prompt: "Complete the follow-up discovered in session A.",
              tldr: "This suggestion belongs only to session A.",
              cwd: "/projects/example",
              sessionKey: "agent:main:session-a",
              agentId: "main",
              createdAt: Date.now(),
            },
          ],
        },
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const startButton = page.getByRole("button", { name: "Start in worktree" });
      await startButton.waitFor({ state: "visible", timeout: 10_000 });
      await gateway.deferNext("taskSuggestions.list");
      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      await waitForRequests(gateway, "taskSuggestions.list", 2);

      await expect.poll(() => startButton.count()).toBe(0);
      await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps the composer visible when follow-up suggestions overflow", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "taskSuggestions.list"],
      methodResponses: {
        "taskSuggestions.list": {
          suggestions: Array.from({ length: 12 }, (_, index) => ({
            id: `task_overflow_${index}`,
            title: `Follow-up ${index}`,
            prompt: "Inspect the related implementation and tests. ".repeat(12),
            tldr: "This follow-up remains useful but must not hide the composer.",
            cwd: "/projects/example",
            sessionKey: "main",
            agentId: "main",
            createdAt: Date.now() + index,
          })),
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const tray = page.locator(".task-suggestions");
      await tray.waitFor({ state: "visible", timeout: 10_000 });
      expect(await tray.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );

      const composer = page.locator(".agent-chat__composer-shell");
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      const box = await composer.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.y ?? 720) + (box?.height ?? 0)).toBeLessThanOrEqual(720);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("sends the first chat turn while agents startup loading is still pending", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "ops",
      deferredMethods: ["chat.startup"],
      historyMessages: [],
      sessionKey: "global",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("agents.list")).toHaveLength(0);
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      expect(await gateway.getRequests("commands.list")).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const prompt = "send before agents list completes";
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").inputValue(), {
          timeout: 10_000,
        })
        .toBe("");
      const params = requireRecord(sendRequest.params);
      expect(params.message).toBe(prompt);
      expect(params.sessionKey).toBe("global");
      expect(params.agentId).toBe("ops");

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await gateway.emitGatewayEvent("chat", {
        deltaText: "First token visible.",
        message: {
          content: [{ text: "First token visible.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        agentId: "ops",
        sessionKey: "global",
        state: "delta",
      });
      await page.getByText("First token visible.").waitFor({ timeout: 10_000 });
      await gateway.resolveDeferred("chat.startup", {
        agentsList: {
          agents: [{ id: "ops", name: "OpenClaw" }],
          defaultId: "ops",
          mainKey: "main",
          scope: "agent",
        },
        messages: [],
        metadata: {
          models: [],
        },
        sessionId: "control-ui-e2e-session",
        thinkingLevel: null,
      });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await page.getByText("First token visible.").waitFor({ timeout: 10_000 });
      await gateway.waitForRequest("chat.metadata");
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(1);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
      expect(await gateway.getRequests("commands.list")).toHaveLength(0);
      await gateway.emitChatFinal({ runId, text: "History race stayed visible." });
      await page
        .locator(".chat-thread-inner")
        .getByText("History race stayed visible.")
        .waitFor({ timeout: 10_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill("/");
      expect(await gateway.getRequests("commands.list")).toHaveLength(0);
      expect(await gateway.getRequests("agents.list")).toHaveLength(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it.each([
    { label: "desktop", viewport: { height: 900, width: 1280 } },
    { label: "mobile", viewport: { height: 844, width: 390 } },
  ])(
    "keeps streamed text visible when a chat error terminates the turn on $label",
    async ({ viewport }) => {
      const context = await newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page);

      try {
        await page.goto(`${server.baseUrl}chat`);

        const prompt = "stream before terminal error";
        await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();

        const sendRequest = await gateway.waitForRequest("chat.send");
        const params = requireRecord(sendRequest.params);
        const runId = requireString(params.idempotencyKey, "chat send idempotency key");
        const partialText = "Partial answer before gateway error.";
        await gateway.emitGatewayEvent("chat", {
          deltaText: partialText,
          message: {
            content: [{ text: partialText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "delta",
        });
        await page
          .locator(".chat-thread-inner")
          .getByText(partialText)
          .waitFor({ timeout: 10_000 });

        const gatewayErrorText =
          "⚠️ Model login expired on the gateway for openai. Send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth with `openclaw models auth login --provider openai` in a terminal, then try again.";
        const errorText = gatewayErrorText.replace(/^⚠️\s*/u, "");
        await gateway.emitGatewayEvent("chat", {
          errorMessage: gatewayErrorText,
          message: {
            content: [{ text: gatewayErrorText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "error",
        });

        await page
          .locator(".chat-thread-inner")
          .getByText(partialText)
          .waitFor({ timeout: 10_000 });
        const alert = page.locator(".chat-run-error");
        await alert.getByText(errorText).waitFor({ timeout: 10_000 });
        expect(await alert.locator("button").count()).toBe(0);
        expect(await page.locator(".chat-thread-inner").getByText(errorText).count()).toBe(0);
        expect(
          await alert.evaluate((element) =>
            element.nextElementSibling?.classList.contains("agent-chat__composer-shell"),
          ),
        ).toBe(true);
        const [alertBox, composerBox] = await Promise.all([
          alert.boundingBox(),
          page.locator(".agent-chat__composer-shell").boundingBox(),
        ]);
        expect(alertBox).not.toBeNull();
        expect(composerBox).not.toBeNull();
        expect(Math.abs((alertBox?.x ?? 0) - (composerBox?.x ?? 0))).toBeLessThan(1);
        expect(Math.abs((alertBox?.width ?? 0) - (composerBox?.width ?? 0))).toBeLessThan(1);

        await page.locator(".agent-chat__composer-combobox textarea").fill("retry after error");
        await page.getByRole("button", { name: "Send message" }).click();
        await waitForRequests(gateway, "chat.send", 2);
        await alert.waitFor({ state: "detached", timeout: 10_000 });
      } finally {
        await closeBrowserContext(context);
      }
    },
  );

  it("keeps the pending working row stable through acknowledgement and streaming", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "hold this until the ack arrives";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").inputValue(), {
          timeout: 10_000,
        })
        .toBe("");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      const indicator = page.locator(".chat-reading-indicator");
      await indicator.waitFor({ timeout: 10_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
      await page.locator(".chat-working-indicator").evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const pendingRow = await indicator
        .locator(
          "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' chat-virtual-row ')][1]",
        )
        .elementHandle();
      if (!pendingRow) {
        throw new Error("expected pending working indicator virtual row");
      }
      const pendingLayout = await pendingRow.evaluate((row) => {
        const rect = row.getBoundingClientRect();
        Reflect.set(window, "__openclawPendingWorkingRow", row);
        return {
          height: rect.height,
          key: row.getAttribute("data-virtual-row-key"),
          top: rect.top,
        };
      });
      expect(pendingLayout.key).not.toBeNull();
      await page.evaluate(() => {
        const samples: Array<{
          height: number | null;
          key: string | null;
          sameRow: boolean;
          top: number | null;
        }> = [];
        Reflect.set(window, "__openclawWorkingRowSamples", samples);
        let remaining = 20;
        const sample = () => {
          const originalRow = Reflect.get(window, "__openclawPendingWorkingRow");
          const currentRow = document
            .querySelector(".chat-reading-indicator")
            ?.closest<HTMLElement>(".chat-virtual-row");
          const rect = currentRow?.getBoundingClientRect();
          samples.push({
            height: rect?.height ?? null,
            key: currentRow?.getAttribute("data-virtual-row-key") ?? null,
            sameRow: currentRow === originalRow,
            top: rect?.top ?? null,
          });
          remaining -= 1;
          if (remaining > 0) {
            requestAnimationFrame(sample);
          }
        };
        sample();
      });

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });

      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await indicator.waitFor({ timeout: 10_000 });
      const samples = await page.evaluate(
        () =>
          new Promise<
            Array<{
              height: number | null;
              key: string | null;
              sameRow: boolean;
              top: number | null;
            }>
          >((resolve) => {
            const read = () => {
              const current = Reflect.get(window, "__openclawWorkingRowSamples");
              if (Array.isArray(current) && current.length >= 20) {
                resolve(current);
                return;
              }
              requestAnimationFrame(read);
            };
            read();
          }),
      );
      const layouts = samples.filter(
        (sample): sample is { height: number; key: string; sameRow: true; top: number } =>
          sample.sameRow &&
          typeof sample.height === "number" &&
          typeof sample.key === "string" &&
          typeof sample.top === "number",
      );
      expect(layouts).toHaveLength(20);
      expect(new Set(layouts.map((sample) => sample.key))).toEqual(new Set([pendingLayout.key]));
      const tops = layouts.map((sample) => sample.top);
      const heights = layouts.map((sample) => sample.height);
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);

      const response = "The streamed response is now visible.";
      await gateway.emitGatewayEvent("chat", {
        deltaText: response,
        message: {
          content: [{ text: response, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.getByText(response).waitFor({ timeout: 10_000 });
      await page.locator(".chat-reading-indicator").waitFor({ state: "detached", timeout: 10_000 });
      const streamingLayout = await pendingRow.evaluate(
        (row, visibleResponse) => ({
          connected: row.isConnected,
          hasResponse: row.textContent?.includes(visibleResponse) ?? false,
          key: row.getAttribute("data-virtual-row-key"),
        }),
        response,
      );
      expect(streamingLayout).toEqual({
        connected: true,
        hasResponse: true,
        key: pendingLayout.key,
      });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("steers ordinary follow-ups when the server default is steer", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "steer" }, mode: "followup" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: runtimeConfig,
          hash: "queue-steer-config",
          issues: [],
          raw: JSON.stringify(runtimeConfig),
          runtimeConfig,
          valid: true,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      await page.locator(".agent-chat__composer-combobox textarea").fill("keep this run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const followUp = "tighten the active plan";
      await page.locator(".agent-chat__composer-combobox textarea").fill(followUp);
      await page.getByRole("button", { name: "Steer into the active run" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      expect(requireRecord(sends[1]?.params)).toMatchObject({
        deliver: false,
        message: followUp,
        sessionKey: "main",
      });
      const queue = page.locator(".chat-queue");
      await queue.getByText("Steered").waitFor({ timeout: 10_000 });
      await queue.getByText(followUp).waitFor({ timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/steer-default.png`,
          fullPage: true,
        });
      }
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("preserves a non-steer server default for active-run follow-ups", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "followup" }, mode: "steer" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: runtimeConfig,
          hash: "queue-followup-config",
          issues: [],
          raw: JSON.stringify(runtimeConfig),
          runtimeConfig,
          valid: true,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/appearance`);
      const followUpSelect = page.locator("[data-settings-follow-up-mode]");
      await followUpSelect.waitFor({ state: "visible", timeout: 10_000 });
      expect(await followUpSelect.inputValue()).toBe("server");
      await page.getByText("Using server default (followup)").waitFor({ timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/server-followup-setting.png`,
          fullPage: true,
        });
      }
      await followUpSelect.selectOption("steer");
      await page.getByText("Overriding server default (followup)").waitFor({ timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/server-followup-override.png`,
          fullPage: true,
        });
      }
      await page.getByRole("button", { name: "Reset to server default" }).click();
      expect(await followUpSelect.inputValue()).toBe("server");

      await page.goto(`${server.baseUrl}chat`);

      const activePrompt = "keep this run active";
      await page.locator(".agent-chat__composer-combobox textarea").fill(activePrompt);
      await page.getByRole("button", { name: "Send message" }).click();

      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const queuedPrompt = "queue this on the server";
      await page.locator(".agent-chat__composer-combobox textarea").fill(queuedPrompt);
      await page.getByRole("button", { name: "Queue message" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      expect(requireRecord(sends[1]?.params)).toMatchObject({
        message: queuedPrompt,
        queueMode: "followup",
        sessionKey: "main",
      });
      await page.locator(".chat-queue").waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("honors a session interrupt override ahead of the webchat config default", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "main";
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "steer" }, mode: "steer" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: runtimeConfig,
          hash: "queue-session-override-config",
          issues: [],
          raw: JSON.stringify(runtimeConfig),
          runtimeConfig,
          valid: true,
        },
        "sessions.list": chatSessionListResponse([
          {
            effectiveQueueMode: "interrupt",
            key: "agent:main:main",
            kind: "direct",
            label: "Main",
            queueMode: "interrupt",
            updatedAt: Date.now(),
          },
        ]),
      },
      sessionInfo: {
        effectiveQueueMode: "interrupt",
        hasActiveRun: false,
        key: "agent:main:main",
        queueMode: "interrupt",
        status: "done",
      },
      sessionKey,
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      await page.locator(".agent-chat__composer-combobox textarea").fill("keep this run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const followUp = "interrupt for this session override";
      await page.locator(".agent-chat__composer-combobox textarea").fill(followUp);
      await page.getByRole("button", { name: "Send message" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      expect(requireRecord(sends[1]?.params)).toMatchObject({
        message: followUp,
        queueMode: "interrupt",
        sessionKey,
      });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("steers a restored queued message when only the session row reports the active run", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.goto(`${server.baseUrl}chat`);

      await page.locator(".agent-chat__composer-combobox textarea").fill("keep this run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const queuedPrompt = "steer this after restoring the queue";
      await page.locator(".agent-chat__composer-combobox textarea").fill(queuedPrompt);
      await page.getByRole("button", { name: "Queue message" }).click();
      await page.locator(".chat-queue").getByText(queuedPrompt).waitFor({ timeout: 10_000 });

      await gateway.setMethodResponse(
        "sessions.list",
        chatSessionListResponse([
          {
            hasActiveRun: true,
            key: "main",
            kind: "direct",
            label: "Main",
            updatedAt: Date.now(),
          },
        ]),
      );
      await page.reload();

      const queue = page.locator(".chat-queue");
      await queue.getByText(queuedPrompt).waitFor({ timeout: 10_000 });
      await queue.getByRole("button", { name: "Steer" }).click();

      const steerRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(steerRequest.params)).toMatchObject({
        deliver: false,
        message: queuedPrompt,
        sessionKey: "main",
      });
      await queue.getByText(queuedPrompt).waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("scrolls a delayed pending send into view before the ACK resolves", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `History message ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("History message 49").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(4);

      await waitForChatScrollIdle(page);
      await expect
        .poll(
          async () => {
            await scrollChatThreadToTop(page);
            return chatThreadDistanceFromBottom(page);
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(200);

      await gateway.deferNext("chat.send");

      const prompt = `pending send should scroll before ack\n${"visible now\n".repeat(6)}`;
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await page.locator(".chat-thread").getByText("pending send should scroll").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(4);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("overlays the scroll-to-bottom affordance without shrinking the transcript", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `Scrollable history ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Scrollable history 49").waitFor({ timeout: 10_000 });
      await waitForChatScrollIdle(page);

      const readLayout = () =>
        page.locator(".chat-main").evaluate((container) => {
          const thread = container.querySelector<HTMLElement>(".chat-thread");
          const composer = container.querySelector<HTMLElement>(".agent-chat__composer-shell");
          const button = container.querySelector<HTMLElement>(".chat-scroll-to-bottom");
          if (!thread || !composer) {
            throw new Error("expected chat thread and composer");
          }
          const threadRect = thread.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();
          const buttonRect = button?.getBoundingClientRect();
          return {
            buttonBottom: buttonRect ? Math.round(buttonRect.bottom) : null,
            composerTop: Math.round(composerRect.top),
            threadBottom: Math.round(threadRect.bottom),
          };
        });

      const before = await readLayout();
      expect(before.buttonBottom).toBeNull();

      await scrollChatThreadToTop(page);
      await page.getByRole("button", { name: "Scroll to latest" }).waitFor({ timeout: 10_000 });
      const after = await readLayout();

      expect(after.threadBottom).toBe(before.threadBottom);
      expect(after.composerTop).toBe(before.composerTop);
      expect(after.buttonBottom).not.toBeNull();
      expect(after.buttonBottom!).toBeLessThan(after.composerTop);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("shows persisted user messages after opening History and scrolling mixed history", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const currentSessionMessages = [
      {
        content: [{ text: "Current session placeholder", type: "text" }],
        role: "assistant",
        timestamp: baseTs - 1,
      },
    ];
    const historyMessages = Array.from({ length: 70 }, (_, index) => ({
      content: [
        {
          text: `${index % 2 === 0 ? "User history question" : "Assistant history answer"} ${index}\n${"history detail line\n".repeat(4)}`,
          type: index % 2 === 0 ? "input_text" : "output_text",
        },
      ],
      role: index % 2 === 0 ? "user" : "assistant",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, {
      historyMessages: currentSessionMessages,
      methodResponses: {
        "chat.history": {
          cases: [
            {
              match: { sessionKey: "agent:main:session-b" },
              response: {
                messages: historyMessages,
                sessionId: "control-ui-e2e-history-session-b",
                thinkingLevel: null,
              },
            },
            {
              match: { sessionKey: "agent:main:session-a" },
              response: {
                messages: currentSessionMessages,
                sessionId: "control-ui-e2e-history-session-a",
                thinkingLevel: null,
              },
            },
          ],
        },
        "sessions.list": chatSessionListResponse(),
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Current session placeholder").waitFor({ timeout: 10_000 });

      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      const historyRequest = await gateway.waitForRequest("chat.history");
      expect(requireRecord(historyRequest.params)).toMatchObject({
        sessionKey: "agent:main:session-b",
      });
      await page.locator(".chat-thread").getByText("User history question 68").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-thread").getByText("Assistant history answer 69").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(
          async () => {
            const texts = await visibleChatBubbleTexts(page);
            return (
              texts.some((text) => text.includes("User history question 68")) &&
              texts.some((text) => text.includes("Assistant history answer 69"))
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);

      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      await page.locator(".chat-thread").getByText("User history question 10").waitFor({
        timeout: 10_000,
      });
      await scrollChatThreadToTop(page);
      await page.locator(".chat-thread").getByText("User history question 0").waitFor({
        timeout: 10_000,
      });
      await scrollChatThreadToTop(page);
      await expect
        .poll(
          async () => {
            const texts = await visibleChatBubbleTexts(page);
            return (
              texts.some((text) => text.includes("User history question 0")) &&
              texts.some((text) => text.includes("Assistant history answer 1"))
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps retained paginated history stable when returning to a session", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const historyMessage = (seq: number, label: string) => ({
      __openclaw: { id: `history-${seq}`, seq },
      content: [
        {
          text: `${label} ${seq}\n${"retained transcript detail\n".repeat(3)}`,
          type: seq % 2 === 0 ? "output_text" : "input_text",
        },
      ],
      role: seq % 2 === 0 ? "assistant" : "user",
      timestamp: 1_800_000_000_000 + seq,
    });
    const shortMessages = [historyMessage(1, "short session"), historyMessage(2, "short session")];
    const recentMessages = Array.from({ length: 100 }, (_, index) =>
      historyMessage(index + 41, "recent retained message"),
    );
    const olderMessages = Array.from({ length: 40 }, (_, index) =>
      historyMessage(index + 1, "older retained message"),
    );
    const gateway = await installMockGateway(page, {
      historyMessages: shortMessages,
      methodResponses: {
        "chat.history": {
          cases: [
            {
              match: { offset: 100, sessionKey: "agent:main:session-b" },
              response: {
                hasMore: false,
                messages: olderMessages,
                sessionId: "retained-history-session",
                thinkingLevel: null,
                totalMessages: 140,
              },
            },
            {
              match: { sessionKey: "agent:main:session-b" },
              response: {
                hasMore: true,
                messages: recentMessages,
                nextOffset: 100,
                sessionId: "retained-history-session",
                thinkingLevel: null,
                totalMessages: 140,
              },
            },
            {
              match: { sessionKey: "agent:main:session-a" },
              response: {
                hasMore: false,
                messages: shortMessages,
                sessionId: "short-history-session",
                thinkingLevel: null,
                totalMessages: 2,
              },
            },
          ],
        },
        "sessions.list": chatSessionListResponse(),
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText(/^short session 2\n/).waitFor({ timeout: 10_000 });

      const sessionB = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
      );
      const sessionA = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-a"] a.sidebar-recent-session__link',
      );
      await sessionB.click();
      await page.getByText(/^recent retained message 140\n/).waitFor({ timeout: 10_000 });
      const thread = page.locator(".chat-thread");
      await thread.hover();
      await page.mouse.wheel(0, -1_000_000);
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
      // Prepending preserves the visible anchor. A renewed upward gesture
      // reaches the newly loaded start instead of teleporting the reader.
      await page.mouse.wheel(0, -1_000_000);
      await page.getByText(/^older retained message 1\n/).waitFor({ timeout: 10_000 });

      await sessionA.click();
      await page.getByText(/^short session 2\n/).waitFor({ timeout: 10_000 });
      const historyRequestsBeforeReturn = (await gateway.getRequests("chat.history")).length;
      await page.evaluate(() => {
        type FrameSample = {
          hiddenNotice: boolean;
          loading: boolean;
          messageCount: number;
          minOpacity: number;
          sessionKey: string;
        };
        const samples: FrameSample[] = [];
        (
          globalThis as typeof globalThis & {
            chatSessionReturnSamples: FrameSample[];
          }
        ).chatSessionReturnSamples = samples;
        const deadline = performance.now() + 750;
        const sample = () => {
          const pane = document.querySelector("openclaw-chat-pane") as
            | (HTMLElement & {
                state?: { chatMessages?: unknown[]; sessionKey?: string };
              })
            | null;
          const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-row-key]"));
          samples.push({
            hiddenNotice: document.body.textContent?.includes("Showing last") ?? false,
            loading: document.querySelector(".chat-history-loading") !== null,
            messageCount: pane?.state?.chatMessages?.length ?? 0,
            minOpacity: rows.reduce(
              (minimum, row) => Math.min(minimum, Number.parseFloat(getComputedStyle(row).opacity)),
              1,
            ),
            sessionKey: pane?.state?.sessionKey ?? "",
          });
          if (performance.now() < deadline) {
            requestAnimationFrame(sample);
          }
        };
        requestAnimationFrame(sample);
      });

      await sessionB.click();
      await page.getByText(/^recent retained message 140\n/).waitFor({ timeout: 10_000 });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 800);
      });
      const samples = await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              chatSessionReturnSamples: Array<{
                hiddenNotice: boolean;
                loading: boolean;
                messageCount: number;
                minOpacity: number;
                sessionKey: string;
              }>;
            }
          ).chatSessionReturnSamples,
      );
      const returnedSamples = samples.filter(
        (sample) => sample.sessionKey === "agent:main:session-b",
      );
      const restoredIndex = returnedSamples.findIndex((sample) => sample.messageCount === 140);
      expect(restoredIndex).toBeGreaterThanOrEqual(0);
      expect(
        returnedSamples.slice(restoredIndex).every((sample) => sample.messageCount === 140),
      ).toBe(true);
      expect(returnedSamples.every((sample) => sample.minOpacity === 1)).toBe(true);
      expect(returnedSamples.every((sample) => !sample.hiddenNotice)).toBe(true);
      expect(returnedSamples.every((sample) => !sample.loading)).toBe(true);
      expect(await page.getByRole("button", { name: "Load older" }).count()).toBe(0);
      await expectRequestCountStable(gateway, "chat.history", historyRequestsBeforeReturn + 1);
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/retained-history-return.png`,
          fullPage: true,
        });
      }
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps rejected pre-ACK sends visible and restores the draft", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "policy should not eat this";
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");

      await gateway.rejectDeferred("chat.send", {
        code: "INVALID_REQUEST",
        message: "send blocked by session policy",
      });

      await page.locator(".chat-queue").getByText("Failed").waitFor({ timeout: 10_000 });
      await page.locator(".chat-queue").getByText(prompt).waitFor({ timeout: 10_000 });
      expect(await composer.inputValue()).toBe(prompt);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("parks an ACK-lost send for review before a same-key manual retry", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "control-ui-e2e-session",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "retry with the same key";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const firstRequest = await gateway.waitForRequest("chat.send");
      const firstParams = requireRecord(firstRequest.params);
      const runId = requireString(firstParams.idempotencyKey, "first idempotency key");

      await gateway.closeLatest(1006, "lost ack");

      const queue = page.locator(".chat-queue");
      await queue.getByText("Needs review").waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await queue.locator(".chat-queue__retry").click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      const secondParams = requireRecord(sends[1]?.params);
      expect(secondParams.idempotencyKey).toBe(runId);
      expect(secondParams.message).toBe(prompt);
      await queue.waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("stores new input while offline and sends it after reconnect", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "control-ui-e2e-session",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });

      await gateway.setOnline(false);
      await page.locator(".agent-chat__offline-hint").waitFor({ timeout: 10_000 });

      const prompt = "send this when the Gateway returns";
      const attachmentName = "offline-proof.txt";
      const attachmentMimeType = "text/plain";
      const attachmentText = "offline attachment proof";
      const attachmentBase64 = Buffer.from(attachmentText).toString("base64");
      const attachmentDataUrl = `data:${attachmentMimeType};base64,${attachmentBase64}`;
      const composerEnabled = await composer.isEnabled();
      expect(composerEnabled).toBe(true);
      await composer.fill(prompt);
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: attachmentName,
        mimeType: attachmentMimeType,
        buffer: Buffer.from(attachmentText),
      });
      await page.locator(".chat-attachment-file__name", { hasText: attachmentName }).waitFor({
        timeout: 10_000,
      });
      const send = page.getByRole("button", { name: "Send message" });
      const sendEnabled = await send.isEnabled();
      expect(sendEnabled).toBe(true);
      await send.click();

      const queue = page.locator(".chat-queue");
      await queue.getByText("Waiting for reconnect").waitFor({ timeout: 10_000 });
      await queue.getByText(prompt).waitFor({ timeout: 10_000 });
      const requestsBeforeReconnect = await gateway.getRequests("chat.send");
      expect(requestsBeforeReconnect).toHaveLength(0);
      const readStoredProof = () =>
        page.evaluate(
          ({ expectedAttachmentName, expectedAttachmentDataUrl, expectedPrompt }) => {
            const storedValues = Object.entries(sessionStorage)
              .filter(([key]) => key.startsWith("openclaw.control.chatComposer.v2:"))
              .map(([, value]) => value);
            const stored = storedValues.join("\n");
            let runId: string | null = null;
            for (const value of storedValues) {
              try {
                const parsed = JSON.parse(value) as {
                  sessions?: Record<
                    string,
                    {
                      queue?: Array<{
                        attachments?: Array<{ dataUrl?: unknown; fileName?: unknown }>;
                        sendRunId?: unknown;
                        text?: unknown;
                      }>;
                    }
                  >;
                };
                const item = Object.values(parsed.sessions ?? {})
                  .flatMap((session) => session.queue ?? [])
                  .find((entry) => entry.text === expectedPrompt);
                if (typeof item?.sendRunId === "string") {
                  runId = item.sendRunId;
                  const attachment = item.attachments?.find(
                    (entry) => entry.fileName === expectedAttachmentName,
                  );
                  return {
                    attachment: attachment?.dataUrl === expectedAttachmentDataUrl,
                    prompt: true,
                    runId,
                    waitingReconnect: value.includes('"sendState":"waiting-reconnect"'),
                  };
                }
              } catch {
                // Ignore unrelated malformed session storage in this focused proof.
              }
            }
            return {
              attachment: false,
              prompt: stored.includes(expectedPrompt),
              runId,
              waitingReconnect: stored.includes('"sendState":"waiting-reconnect"'),
            };
          },
          {
            expectedAttachmentDataUrl: attachmentDataUrl,
            expectedAttachmentName: attachmentName,
            expectedPrompt: prompt,
          },
        );
      await expect.poll(readStoredProof).toEqual({
        attachment: true,
        prompt: true,
        runId: expect.any(String),
        waitingReconnect: true,
      });
      const storedProof = await readStoredProof();
      const storedRunId = requireString(storedProof.runId, "stored offline send idempotency key");
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/01-offline-queued.png`, fullPage: true });
      }

      await page.reload();
      await expect.poll(readStoredProof).toEqual({
        attachment: true,
        prompt: true,
        runId: storedRunId,
        waitingReconnect: true,
      });
      // A cold reload waits for initial Gateway bootstrap before rebuilding the
      // UI. Storage survival here plus replay below is the reload contract.
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.setOnline(true);
      await page.locator("openclaw-chat-pane").waitFor({ state: "attached", timeout: 10_000 });

      const request = await gateway.waitForRequest("chat.send");
      const params = requireRecord(request.params);
      const runId = requireString(params.idempotencyKey, "offline send idempotency key");
      expect(params.message).toBe(prompt);
      expect(runId).toBe(storedRunId);
      expect(params.attachments).toEqual([
        {
          content: attachmentBase64,
          fileName: attachmentName,
          mimeType: attachmentMimeType,
          type: "file",
        },
      ]);
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/02-reconnected-active.png`, fullPage: true });
      }
      await expectRequestCountStable(gateway, "chat.send", 1);
      const requestsAfterReconnect = await gateway.getRequests("chat.send");
      await gateway.setHistoryMessages([
        {
          role: "user",
          __openclaw: { idempotencyKey: `${runId}:user` },
        },
      ]);
      await gateway.emitChatFinal({ runId, text: "Delivered after reconnect." });
      await queue.waitFor({ state: "detached", timeout: 10_000 });
      await expect
        .poll(async () => {
          const proof = await readStoredProof();
          return proof.attachment || proof.prompt || proof.runId === runId;
        })
        .toBe(false);
      await page.locator(".agent-chat__offline-hint").waitFor({ state: "detached" });
      await expectRequestCountStable(gateway, "chat.send", 1);
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/03-online-delivered.png`, fullPage: true });
      }
      if (process.env.OPENCLAW_BEHAVIOR_PROOF === "1") {
        process.stdout.write(
          `${JSON.stringify({
            proof: "offline-chat-reconnect",
            composerEnabled,
            sendEnabled,
            waitingStateVisible: true,
            storedPrompt: storedProof.prompt,
            storedWaitingState: storedProof.waitingReconnect,
            requestsBeforeReconnect: requestsBeforeReconnect.length,
            requestsAfterReconnect: requestsAfterReconnect.length,
            idempotencyKeyPresent: runId.length > 0,
            queueClearedAfterDelivery: true,
          })}\n`,
        );
      }
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("routes runtime-aware model commands through the server directive path", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const command = "/model openai/gpt-5.6-luna --runtime codex continue with the selected model";
      await page.locator(".agent-chat__composer-combobox textarea").fill(command);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(sendRequest.params)).toMatchObject({
        message: command,
        sessionKey: "agent:main:main",
      });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps a session model override selected after switching away and back", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const main = page.getByRole("main");
      const openModelSelect = async () => {
        const trigger = main.locator('[data-chat-model-select="true"]').first();
        await trigger.waitFor({ state: "visible", timeout: 10_000 });
        return trigger;
      };
      const selectModel = async (value: string) => {
        await main.locator('[data-chat-model-select="true"]').click();
        const provider = value.split("/", 1)[0];
        await main.locator(`[data-chat-model-provider="${provider}"]`).click();
        const option = main.locator(`[data-chat-model-option="${value}"]`);
        await option.waitFor({ state: "visible", timeout: 10_000 });
        await option.click();
        await page.keyboard.press("Escape");
      };

      let modelSelect = await openModelSelect();
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");

      await selectModel("bedrock/claude-opus-4.5");
      const patchRequest = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(patchRequest.params)).toMatchObject({
        key: "agent:main:session-a",
        model: "bedrock/claude-opus-4.5",
      });
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(
        "bedrock/claude-opus-4.5",
      );

      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Session B").waitFor({
        timeout: 10_000,
      });
      modelSelect = await openModelSelect();
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");

      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-a"] a.sidebar-recent-session__link',
        )
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Session A").waitFor({
        timeout: 10_000,
      });

      modelSelect = await openModelSelect();
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(
        "bedrock/claude-opus-4.5",
      );
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("restores the selected agent model after clearing a session override", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const agentsList = {
      agents: [
        {
          id: "ops",
          model: { primary: "anthropic/claude-opus-4-5" },
          name: "Operations",
        },
      ],
      defaultId: "ops",
      mainKey: "main",
      scope: "agent",
    };
    const sessionsList = {
      count: 1,
      defaults: {
        contextTokens: null,
        model: "gpt-5.5",
        modelProvider: "openai",
      },
      path: "",
      sessions: [
        {
          key: "agent:ops:session-a",
          kind: "direct",
          label: "Operations",
          updatedAt: Date.now(),
        },
      ],
      ts: Date.now(),
    };
    const gateway = await installMockGateway(page, {
      assistantAgentId: "ops",
      defaultAgentId: "ops",
      methodResponses: {
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: {
            models: [
              { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
              {
                id: "claude-opus-4-5",
                name: "Claude Opus 4.5",
                provider: "anthropic",
              },
            ],
          },
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
        },
        "sessions.list": sessionsList,
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
      ],
      sessionKey: "agent:ops:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const main = page.getByRole("main");
      const modelSelect = main.locator('[data-chat-model-select="true"]').first();
      await modelSelect.waitFor({ state: "visible", timeout: 10_000 });
      expect(await modelSelect.textContent()).toContain("Claude Opus 4.5");
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");

      await modelSelect.click();
      await main.locator('[data-chat-model-provider="openai"]').click();
      await main.locator('[data-chat-model-option="openai/gpt-5.5"]').click();
      const firstPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(firstPatch.params)).toMatchObject({
        key: "agent:ops:session-a",
        model: "openai/gpt-5.5",
      });
      expect(await modelSelect.textContent()).toContain("GPT-5.5");

      // The picker stays open after an immediate apply. Return to the default
      // model's provider and select its real catalog row to clear the override.
      await main.locator('[data-chat-model-provider="anthropic"]').click();
      const defaultModel = main.locator(
        '[data-chat-model-option="anthropic/claude-opus-4-5"][data-chat-model-default="true"]',
      );
      await defaultModel.waitFor({ state: "visible", timeout: 10_000 });
      expect(await defaultModel.textContent()).toContain("Default");
      expect(await main.locator('[data-chat-model-option=""]').count()).toBe(0);
      await defaultModel.click();
      const patches = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patches[1]?.params)).toMatchObject({
        key: "agent:ops:session-a",
        model: null,
      });
      expect(await modelSelect.textContent()).toContain("Claude Opus 4.5");
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps every sidebar session stable while selecting sessions and supports sort modes", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const createdSessionKeys = Array.from(
      { length: 11 },
      (_, index) => `agent:main:session-${String.fromCharCode(97 + index)}`,
    );
    const pinnedSessionKey = "agent:main:session-pinned";
    const createdOrder = [pinnedSessionKey, ...createdSessionKeys];
    const updatedOrder = [pinnedSessionKey, ...createdSessionKeys.toReversed()];
    const sessions = {
      count: createdSessionKeys.length + 1,
      defaults: {
        contextTokens: null,
        model: "gpt-5.5",
        modelProvider: "openai",
      },
      path: "",
      sessions: [
        {
          key: pinnedSessionKey,
          kind: "direct",
          label: "Pinned Session",
          pinned: true,
          pinnedAt: 1,
          updatedAt: 50,
        },
        ...createdSessionKeys.map((key, index) => ({
          key,
          kind: "direct",
          label: `Session ${key.slice(-1).toUpperCase()}`,
          updatedAt: (index + 1) * 100,
        })),
      ],
      ts: Date.now(),
    };
    await installMockGateway(page, {
      methodResponses: { "sessions.list": sessions },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page
        .locator('.sidebar-recent-session[data-session-key="agent:main:session-a"]')
        .waitFor({
          timeout: 10_000,
        });
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder.slice(0, 11));
      await page.getByRole("button", { name: "Load more" }).click();
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);

      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Session B").waitFor({
        timeout: 10_000,
      });
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);

      const activeWeight = await page
        .locator('.sidebar-recent-session[data-session-key="agent:main:session-b"]')
        .locator(".sidebar-recent-session__name")
        .evaluate((label) => getComputedStyle(label).fontWeight);
      const inactiveWeight = await page
        .locator('.sidebar-recent-session[data-session-key="agent:main:session-a"]')
        .locator(".sidebar-recent-session__name")
        .evaluate((label) => getComputedStyle(label).fontWeight);
      expect(activeWeight).toBe(inactiveWeight);

      const sortThreads = page.getByRole("button", { name: "Sort threads" });
      await sortThreads.locator("..").hover();
      await sortThreads.click();
      await page.getByRole("menuitemradio", { name: "Last updated" }).click();
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(updatedOrder);

      await sortThreads.locator("..").hover();
      await sortThreads.click();
      await page.getByRole("menuitemradio", { name: "Created" }).click();
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);

      await sortThreads.locator("..").hover();
      await sortThreads.click();
      await page.getByRole("main").click();
      await expect.poll(() => page.getByRole("menuitemradio", { name: "Created" }).count()).toBe(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps derived sidebar titles and accessible state after session patch refreshes", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const initialKey = "agent:main:session-a";
    const key = "agent:main:session-b";
    const readableTitle = "Readable planning title";
    const baseTime = Date.now();
    const sessionsWithDerivedTitle = chatSessionListResponse([
      {
        key: initialKey,
        kind: "direct",
        label: initialKey,
        displayName: initialKey,
        derivedTitle: "Initial readable title",
        updatedAt: baseTime,
      },
      {
        key,
        kind: "direct",
        label: key,
        displayName: key,
        derivedTitle: readableTitle,
        updatedAt: baseTime - 60_000,
      },
    ]);
    const sessionsWithoutDerivedTitle = chatSessionListResponse([
      {
        key: initialKey,
        kind: "direct",
        label: initialKey,
        displayName: initialKey,
        updatedAt: baseTime,
      },
      {
        key,
        kind: "direct",
        label: key,
        displayName: key,
        updatedAt: baseTime - 60_000,
      },
    ]);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { includeDerivedTitles: true }, response: sessionsWithDerivedTitle },
            { match: {}, response: sessionsWithoutDerivedTitle },
          ],
        },
      },
      sessionKey: initialKey,
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.locator("a.sidebar-recent-session__link").click();
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("sessions.list");
          return requests.map((request) => request.params);
        })
        .toContainEqual(expect.objectContaining({ includeDerivedTitles: true }));
      const label = row.locator(".sidebar-recent-session__name");
      const link = row.locator("a.sidebar-recent-session__link");
      await expect.poll(() => label.textContent()).toBe(readableTitle);
      expect(await row.getAttribute("role")).toBe("listitem");
      expect(await row.getAttribute("aria-label")).toBeNull();
      expect(await link.getAttribute("aria-label")).toBeNull();
      expect(await link.getAttribute("aria-current")).toBe("page");
      expect(await link.getAttribute("aria-describedby")).toBeNull();
      expect(await link.ariaSnapshot()).toContain(`link "${readableTitle}"`);
      await captureSessionAccessibilityProof(page, "after-derived-title");

      const listCountBeforePatch = (await gateway.getRequests("sessions.list")).length;
      await row.hover();
      await row.getByRole("button", { name: "Pin thread" }).click();

      const patchRequest = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(patchRequest.params)).toMatchObject({
        key,
        pinned: true,
      });
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("sessions.list");
          return requests.slice(listCountBeforePatch).map((request) => request.params);
        })
        .toContainEqual(expect.objectContaining({ includeDerivedTitles: true }));
      await expect.poll(() => label.textContent()).toBe(readableTitle);
      expect(await link.getAttribute("aria-current")).toBe("page");
      expect(await link.ariaSnapshot()).toContain(`link "${readableTitle}"`);
      await captureSessionAccessibilityProof(page, "after-patch-refresh");
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps long sidebar labels clipped after a session switch", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.clock.install();
    const sessions = chatSessionListResponse();
    const firstSession = expectDefined(sessions.sessions[0], "first chat session fixture");
    const secondSession = expectDefined(sessions.sessions[1], "second chat session fixture");
    firstSession.label = "Short";
    secondSession.label =
      "Review and repair the intentionally overlong sidebar session title before navigation ".repeat(
        4,
      );
    await installMockGateway(page, {
      methodResponses: { "sessions.list": sessions },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const recentRow = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-b"]',
      );
      const recentLabel = recentRow.locator(".sidebar-recent-session__name");
      await recentLabel.waitFor({ state: "visible", timeout: 10_000 });
      const layout = await recentLabel.evaluate((label) => ({
        clientWidth: label.clientWidth,
        linkWidth: label.parentElement?.clientWidth ?? 0,
        rowWidth: label.closest<HTMLElement>(".sidebar-recent-session")?.clientWidth ?? 0,
        scrollWidth: label.scrollWidth,
        text: label.textContent,
      }));
      expect(layout.scrollWidth, JSON.stringify(layout)).toBeGreaterThan(layout.clientWidth);

      await recentRow.dispatchEvent("mouseenter");
      await page.clock.runFor(250);
      expect(await recentLabel.evaluate((label) => label.classList.value)).not.toContain(
        "hover-marquee--scrolling",
      );
      await recentRow.dispatchEvent("mouseleave");
      await page.clock.runFor(300);
      expect(await recentLabel.evaluate((label) => label.classList.value)).not.toContain(
        "hover-marquee--scrolling",
      );
      await recentRow.dispatchEvent("mouseenter");
      await expect
        .poll(() => recentLabel.evaluate((label) => label.classList.value), { timeout: 1_500 })
        .toContain("hover-marquee--scrolling");
      await recentRow.dispatchEvent("mouseleave");
      await expect
        .poll(
          () =>
            recentLabel.evaluate((label) => ({
              textIndent: getComputedStyle(label).textIndent,
              textOverflow: getComputedStyle(label).textOverflow,
            })),
          { timeout: 1_500 },
        )
        .toEqual({ textIndent: "0px", textOverflow: "ellipsis" });

      await recentRow.locator("a.sidebar-recent-session__link").dispatchEvent("click", {
        button: 0,
      });
      await page.locator(".sidebar-recent-session--active").getByText(secondSession.label).waitFor({
        timeout: 10_000,
      });

      const activeRow = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-b"]',
      );
      expect(
        await activeRow.locator(".sidebar-recent-session__name").evaluate((label) => ({
          textIndent: getComputedStyle(label).textIndent,
          textOverflow: getComputedStyle(label).textOverflow,
        })),
      ).toEqual({ textIndent: "0px", textOverflow: "ellipsis" });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("renders the visible authenticated assistant avatar after switching sessions", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const avatarBody = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPcAAAAASUVORK5CYII=",
      "base64",
    );
    let avatarRequestCount = 0;
    await page.route(/\/avatar\/main\?meta=1$/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ avatarUrl: "/avatar/main", avatarStatus: "local" }),
      }),
    );
    await page.route(/\/avatar\/main$/, (route) => {
      avatarRequestCount += 1;
      return route.fulfill({ contentType: "image/png", body: avatarBody });
    });
    await installMockGateway(page, {
      methodResponses: { "sessions.list": chatSessionListResponse() },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const documentMarker = await page.evaluate(() => {
        const marker = crypto.randomUUID();
        (window as Window & { __openclawAvatarTestDocument?: string })[
          "__openclawAvatarTestDocument"
        ] = marker;
        return marker;
      });
      const avatar = page.locator("img.agent-chat__welcome-avatar");
      await avatar.waitFor({ state: "visible" });
      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);
      const initialAvatarSrc = await avatar.getAttribute("src");
      const initialRequestCount = avatarRequestCount;

      const sessionRow = (sessionKey: string) =>
        page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      const sessionB = sessionRow("agent:main:session-b");
      await sessionB.locator("a.sidebar-recent-session__link").click();
      await expect
        .poll(() => sessionB.getAttribute("class"))
        .toContain("sidebar-recent-session--active");
      await expect.poll(() => avatarRequestCount).toBeGreaterThan(initialRequestCount);
      await expect.poll(() => avatar.getAttribute("src")).not.toBe(initialAvatarSrc);
      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);
      await expect.poll(() => avatar.isVisible()).toBe(true);
      const sessionBAvatarSrc = await avatar.getAttribute("src");
      const sessionBRequestCount = avatarRequestCount;

      const sessionA = sessionRow("agent:main:session-a");
      await sessionA.locator("a.sidebar-recent-session__link").click();
      await expect
        .poll(() => sessionA.getAttribute("class"))
        .toContain("sidebar-recent-session--active");

      await expect.poll(() => avatarRequestCount).toBeGreaterThan(sessionBRequestCount);
      await expect.poll(() => avatar.getAttribute("src")).not.toBe(sessionBAvatarSrc);
      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);
      await expect.poll(() => avatar.isVisible()).toBe(true);
      expect(
        await page.evaluate(
          () =>
            (window as Window & { __openclawAvatarTestDocument?: string })[
              "__openclawAvatarTestDocument"
            ],
        ),
      ).toBe(documentMarker);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("shows a pending send while a model override update is still pending", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const main = page.getByRole("main");
      await main.locator('[data-chat-model-select="true"]').click();
      await main.locator('[data-chat-model-provider="bedrock"]').click();
      await main.locator('[data-chat-model-option="bedrock/claude-opus-4.5"]').click();
      await page.keyboard.press("Escape");
      await gateway.waitForRequest("sessions.patch");

      const prompt = "send while the model save is pending";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      await page.locator(".chat-queue").getByText("Applying chat settings").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-queue").getByText(prompt).waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.patch", {});
      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      expect(params.message).toBe(prompt);
      expect(params.sessionKey).toBe("agent:main:session-a");
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("applies provider-specific reasoning after the selected model is saved", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:session-a";
    const fableSession = {
      key: sessionKey,
      kind: "direct",
      label: "Session A",
      model: "claude-fable-5",
      modelProvider: "anthropic",
      thinkingDefault: "high",
      thinkingLevel: "high",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "adaptive", label: "adaptive" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "max" },
      ],
      updatedAt: 2,
    };
    const solSession = {
      ...fableSession,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "ultra", label: "ultra" },
      ],
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse([fableSession]),
      },
      models: [
        { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
      ],
      sessionKey,
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const main = page.getByRole("main");
      await main.locator('[data-chat-model-select="true"]').click();
      await main.locator('[data-chat-model-provider="openai"]').click();
      await main.locator('[data-chat-model-option="openai/gpt-5.6-sol"]').click();

      const modelPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(modelPatch.params)).toMatchObject({
        key: sessionKey,
        model: "openai/gpt-5.6-sol",
      });
      const thinkingSlider = main.locator('[data-chat-thinking-slider="true"]');
      await expect.poll(() => thinkingSlider.isDisabled()).toBe(true);
      await thinkingSlider.evaluate((input) => {
        const slider = input as HTMLInputElement;
        slider.value = slider.max;
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expectRequestCountStable(gateway, "sessions.patch", 1);

      await gateway.setMethodResponse("sessions.list", chatSessionListResponse([solSession]));
      await gateway.resolveDeferred("sessions.patch");
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toContain("ultra");
      await expect.poll(() => thinkingSlider.isEnabled()).toBe(true);

      await thinkingSlider.evaluate((input) => {
        const slider = input as HTMLInputElement;
        const values = (slider.dataset.chatThinkingValues ?? "").split(",");
        slider.value = String(values.indexOf("ultra"));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const patches = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patches[1]?.params)).toMatchObject({
        key: sessionKey,
        thinkingLevel: "ultra",
      });
      await expect.poll(() => page.getByText(/not supported for/u).count()).toBe(0);

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/model-thinking-sync.png`,
          fullPage: true,
        });
      }
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps send pending until reasoning and speed patches finish", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          ...chatSessionListResponse([
            {
              effectiveFastMode: false,
              fastMode: false,
              key: "agent:main:session-a",
              kind: "direct",
              label: "Session A",
              model: "gpt-5.5",
              modelProvider: "openai",
              thinkingLevel: "high",
              updatedAt: 2,
            },
          ]),
          defaults: {
            contextTokens: null,
            model: "gpt-5.5",
            modelProvider: "openai",
            thinkingDefault: "high",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
          },
        },
      },
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const main = page.getByRole("main");
      await main.locator('[data-chat-model-select="true"]').click();
      await gateway.deferNext("sessions.patch");
      await main.locator('[data-chat-thinking-slider="true"]').press("ArrowLeft");
      const firstPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(firstPatch.params).thinkingLevel).toBe("medium");

      await gateway.deferNext("sessions.patch");
      await main.locator('[data-chat-speed-toggle="on"]').click();
      await expectRequestCountStable(gateway, "sessions.patch", 1);
      await page.keyboard.press("Escape");

      const prompt = "send with the new reasoning and speed";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await page.locator(".chat-queue").getByText("Applying chat settings").waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      const sessionListCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.resolveDeferred("sessions.patch", {});
      const patches = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patches[1]?.params).fastMode).toBe(true);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(sessionListCount);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.patch", {});
      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(sendRequest.params)).toMatchObject({
        message: prompt,
        sessionKey: "agent:main:session-a",
      });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("refreshes history after a tool-call window disconnects and reconnects", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);

      const prompt = "use a tool then reconnect";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("agent", {
        data: {
          args: { query: "status" },
          name: "status",
          phase: "start",
          toolCallId: "tool-1",
        },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now(),
      });
      await gateway.setHistoryMessages([
        {
          __openclaw: { idempotencyKey: `${runId}:user` },
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        {
          content: [{ text: "Recovered from refreshed history.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ]);

      await gateway.closeLatest(1006, "lost during tool call");

      await page
        .locator(".chat-thread-inner")
        .getByText("Recovered from refreshed history.")
        .waitFor({ timeout: 15_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps live assistant stream text before the matching tool card", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);

      const prompt = "stream before tool";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await gateway.emitGatewayEvent("chat", {
        deltaText: "I will inspect the file.",
        message: {
          content: [{ text: "I will inspect the file.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      await page.getByText("I will inspect the file.").waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("agent", {
        data: {
          name: "read",
          phase: "result",
          result: "file contents",
          toolCallId: "call-read",
        },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now() - 10_000,
      });
      const toolBubble = page.locator('[data-message-id^="tool:assistant:call-read"]');
      await toolBubble.waitFor({ timeout: 10_000 });

      const visibleOrder = await page.locator(".chat-thread").evaluate((thread: Element) => {
        return Array.from(thread.querySelectorAll(".chat-group")).flatMap((group: Element) => {
          const text = group.textContent ?? "";
          if (text.includes("I will inspect the file.")) {
            return ["assistant stream"];
          }
          if (group.querySelector('[data-message-id^="tool:assistant:call-read"]')) {
            return ["tool card"];
          }
          return [];
        });
      });

      expect(visibleOrder).toEqual(["assistant stream", "tool card"]);
    } finally {
      await closeBrowserContext(context);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
