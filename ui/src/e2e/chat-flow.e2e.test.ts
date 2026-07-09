// Control UI tests cover chat flow behavior.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

let server: ControlUiE2eServer;
const contextBrowsers = new WeakMap<BrowserContext, Browser>();
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
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`Timed out waiting for ${count} ${method} requests`);
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
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext(options);
    contextBrowsers.set(context, browser);
    openBrowserContexts.add(context);
    return context;
  } catch (error) {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeBrowserContext(context: BrowserContext): Promise<void> {
  const browser = contextBrowsers.get(context);
  openBrowserContexts.delete(context);
  contextBrowsers.delete(context);
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}

async function closeOpenBrowserContexts(): Promise<void> {
  await Promise.all([...openBrowserContexts].map((context) => closeBrowserContext(context)));
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
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await closeOpenBrowserContexts();
    await server?.close();
  });

  afterEach(async () => {
    await closeOpenBrowserContexts();
  });

  it("uses one global toolbar row for split view", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ type: "text", text: "Split toolbar proof." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Split toolbar proof.").waitFor({ timeout: 10_000 });

      const splitEntry = page.getByRole("button", { name: "Open split view" });
      await expect.poll(() => splitEntry.isVisible()).toBe(true);
      await page.setViewportSize({ height: 900, width: 1100 });
      await expect.poll(() => splitEntry.isVisible()).toBe(true);
      await page.setViewportSize({ height: 900, width: 1440 });
      await expect
        .poll(() =>
          splitEntry.evaluate((node) => node.closest(".agent-chat__composer-shell") == null),
        )
        .toBe(true);
      const topbar = page.locator(".topbar");
      // Desktop renders no topbar row until split view needs the toolbar row.
      await expect.poll(() => topbar.isVisible()).toBe(false);
      await splitEntry.click();

      const toolbar = page.locator(".chat-split-toolbar");
      const toolbarPanes = page.locator(".chat-split-toolbar__pane");
      await expect.poll(() => page.locator(".chat-split-view__pane").count()).toBe(2);
      await expect.poll(() => toolbarPanes.count()).toBe(2);
      await expect
        .poll(async () => {
          const visible = await Promise.all(
            (await toolbarPanes.all()).map((pane) => pane.isVisible()),
          );
          return visible.every(Boolean);
        })
        .toBe(true);
      // The empty topbar returns as the split toolbar's backdrop row.
      await expect.poll(() => topbar.isVisible()).toBe(true);
      await expect.poll(() => splitEntry.count()).toBe(0);

      const [topbarBox, toolbarBox] = await Promise.all([
        topbar.boundingBox(),
        toolbar.boundingBox(),
      ]);
      expect(topbarBox).not.toBeNull();
      expect(toolbarBox).not.toBeNull();
      if (!topbarBox || !toolbarBox) {
        throw new Error("expected the split toolbar and global topbar to have layout boxes");
      }
      expect(Math.abs(topbarBox.y - toolbarBox.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(topbarBox.height - toolbarBox.height)).toBeLessThanOrEqual(1);

      await toolbarPanes.first().getByRole("combobox").focus();
      await expect.poll(() => toolbarPanes.first().getAttribute("class")).toContain("--active");

      await page.evaluate(() => {
        document.documentElement.style.setProperty("--safe-area-top", "20px");
        document.documentElement.style.setProperty("--safe-area-left", "24px");
        document.documentElement.style.setProperty("--safe-area-right", "24px");
        document.body.style.paddingTop = "20px";
        document.body.style.paddingRight = "24px";
        document.body.style.paddingLeft = "24px";
      });
      const insetToolbarBox = await toolbar.boundingBox();
      expect(insetToolbarBox?.y).toBe(20);
      expect(insetToolbarBox?.x).toBeGreaterThan(topbarBox.x);

      await page.setViewportSize({ height: 900, width: 1100 });
      const navToggle = page.getByRole("button", { name: "Expand sidebar" });
      await expect.poll(() => navToggle.isVisible()).toBe(true);
      const [navToggleBox, narrowToolbarBox] = await Promise.all([
        navToggle.boundingBox(),
        toolbar.boundingBox(),
      ]);
      expect(navToggleBox).not.toBeNull();
      expect(narrowToolbarBox).not.toBeNull();
      if (!navToggleBox || !narrowToolbarBox) {
        throw new Error("expected the drawer toggle and split toolbar to have layout boxes");
      }
      expect(narrowToolbarBox.x).toBeGreaterThanOrEqual(navToggleBox.x + navToggleBox.width);

      const firstPane = page.locator(".chat-split-view__pane").first();
      await firstPane.click({ position: { x: 20, y: 80 } });
      await expect.poll(() => firstPane.getAttribute("class")).toContain("--active");
      await expect.poll(() => toolbarPanes.first().getAttribute("class")).toContain("--active");
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

      await page.getByText("Harness verified.").waitFor({ timeout: 10_000 });

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
      await page.getByText("Default shortcut received.").waitFor({ timeout: 10_000 });

      await page.getByRole("button", { name: "Chat settings" }).click();
      const shortcutSelect = page.getByLabel("Send shortcut");
      await shortcutSelect.selectOption("modifier-enter");
      expect(await shortcutSelect.inputValue()).toBe("modifier-enter");

      await page.reload();
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await page.getByRole("button", { name: "Chat settings" }).click();
      expect(await page.getByLabel("Send shortcut").inputValue()).toBe("modifier-enter");
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
            key: "main",
            kind: "direct",
            label: "Main",
            updatedAt: Date.now(),
          },
        ]),
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Active run is waiting for steering.").waitFor({ timeout: 10_000 });
      await gateway.waitForRequest("sessions.list");

      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("/steer use the smaller fix");
      await page.getByRole("button", { name: "Queue message" }).click();

      const steerRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(steerRequest.params);
      expect(params.sessionKey).toBe("main");
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
        "Session context usage: ~190k of 200k (~95%)",
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
        .getByText("Visible progress from the targetless message tool.")
        .waitFor({ timeout: 10_000 });

      await gateway.emitChatFinal({ runId, text: "Visible automatic final reply." });
      await page.getByText("Visible automatic final reply.").waitFor({ timeout: 10_000 });
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
      await page.getByRole("button", { name: "Expand session workspace" }).click();
      await page.getByText("AGENTS.md").waitFor({ timeout: 10_000 });

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
      await page.getByRole("button", { name: "Expand session workspace" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
      expect(await page.locator(".chat-workspace-rail__file").count()).toBe(0);
      expect(await page.locator(".chat-workspace-rail__collapsed-icon svg").count()).toBe(1);
      // The rail docks flush to the window edge in both states (no content gutter).
      const railEdgeGap = () =>
        page.locator(".chat-workspace-rail").evaluate((element) => {
          return window.innerWidth - element.getBoundingClientRect().right;
        });
      expect(await railEdgeGap()).toBe(0);

      await page.getByRole("button", { name: "Expand session workspace" }).click();
      await page.getByRole("button", { name: "Collapse session workspace" }).waitFor({
        timeout: 10_000,
      });
      await page.getByText("AGENTS.md").waitFor({ timeout: 10_000 });
      await page.getByText("preview.png").waitFor({ timeout: 10_000 });
      await page.getByText("Project files").waitFor({ timeout: 10_000 });
      await page.locator(".chat-workspace-rail__file-name", { hasText: "package.json" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);
      expect(await gateway.getRequests("artifacts.list")).toHaveLength(1);
      expect(await railEdgeGap()).toBe(0);

      await page.getByRole("button", { name: "Collapse session workspace" }).click();
      await page.getByRole("button", { name: "Expand session workspace" }).waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".chat-workspace-rail__file").count()).toBe(0);
      expect(await page.locator(".chat-workspace-rail__collapsed-icon svg").count()).toBe(1);

      await page.getByRole("button", { name: "Expand session workspace" }).click();
      await page.getByRole("button", { name: "Collapse session workspace" }).waitFor({
        timeout: 10_000,
      });
      await page.getByText("AGENTS.md").waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      await page.setViewportSize({ height: 900, width: 1000 });
      expect(await page.locator(".chat-workspace-rail").isHidden()).toBe(true);
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
      await page.getByRole("button", { name: "Expand session workspace" }).click();
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
      await page.locator(".markdown-plain-text-fallback").getByText("working **tail").waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".markdown-plain-text-fallback strong").count()).toBe(0);

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
      // flag, which would disable New Session for the whole request.
      expect(await page.getByRole("button", { name: "New session" }).first().isEnabled()).toBe(
        true,
      );

      await gateway.resolveDeferred("sessions.list");
      await page
        .locator(".sidebar-recent-session", { hasText: "Main" })
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("creates a worktree chat from the git-backed agent sidebar action", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.create": { key: "agent:main:dashboard:worktree", ok: true },
      },
      workspaceGit: true,
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const worktreeButton = page.getByRole("button", { name: "New chat in worktree" });
      await worktreeButton.waitFor({ state: "visible", timeout: 10_000 });
      await worktreeButton.click();

      const request = await gateway.waitForRequest("sessions.create");
      expect(requireRecord(request.params)).toMatchObject({ agentId: "main", worktree: true });
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
      await page.getByText("History race stayed visible.").waitFor({ timeout: 10_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill("/");
      expect(await gateway.getRequests("commands.list")).toHaveLength(0);
      expect(await gateway.getRequests("agents.list")).toHaveLength(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps streamed text visible when a chat error terminates the turn", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
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
      await page.getByText(partialText).waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("chat", {
        errorMessage: "gateway disconnected",
        runId,
        sessionKey: "main",
        state: "error",
      });

      await page.getByText(partialText).waitFor({ timeout: 10_000 });
      await page.getByText("Error: gateway disconnected").waitFor({ timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("replaces the pending reading indicator with the streamed response", async () => {
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
      await page.locator(".chat-reading-indicator").waitFor({ timeout: 10_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });

      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await page.locator(".chat-reading-indicator").waitFor({ timeout: 10_000 });

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

  it("retries an ACK-lost send after reconnect with the same idempotency key", async () => {
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

      const prompt = "retry with the same key";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const firstRequest = await gateway.waitForRequest("chat.send");
      const firstParams = requireRecord(firstRequest.params);
      const runId = requireString(firstParams.idempotencyKey, "first idempotency key");

      await gateway.closeLatest(1006, "lost ack");

      const sends = await waitForRequests(gateway, "chat.send", 2);
      const secondParams = requireRecord(sends[1]?.params);
      expect(secondParams.idempotencyKey).toBe(runId);
      expect(secondParams.message).toBe(prompt);
      await page.locator(".chat-queue").waitFor({ state: "detached", timeout: 10_000 });
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

      // The picker stays open after an immediate apply; the pinned default
      // option clears the override without a save step.
      await main.locator('[data-chat-model-option=""]').click();
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

      await page.getByRole("button", { name: "Sort sessions" }).click();
      await page.getByRole("menuitemradio", { name: "Last updated" }).click();
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(updatedOrder);

      await page.getByRole("button", { name: "Sort sessions" }).click();
      await page.getByRole("menuitemradio", { name: "Created" }).click();
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);

      await page.getByRole("button", { name: "Sort sessions" }).click();
      await page.getByRole("main").click();
      await expect.poll(() => page.getByRole("menuitemradio", { name: "Created" }).count()).toBe(0);
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
    const sessions = chatSessionListResponse();
    sessions.sessions[0].label = "Short";
    sessions.sessions[1].label =
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

      await recentRow.locator("a.sidebar-recent-session__link").dispatchEvent("click", {
        button: 0,
      });
      await page
        .locator(".sidebar-recent-session--active")
        .getByText(sessions.sessions[1].label)
        .waitFor({
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

      await page.locator(".chat-queue").getByText("Waiting for model").waitFor({
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

      await page.getByText("Recovered from refreshed history.").waitFor({ timeout: 15_000 });
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
