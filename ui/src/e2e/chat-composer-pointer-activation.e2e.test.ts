// Control UI E2E tests cover pointer activation near the mobile safe area.
import { chromium, type Locator, type Page } from "playwright";
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

type PointerTraceEntry = {
  activeTag: string;
  bottom: number;
  centerHitLabel: string | null;
  clientX: number;
  clientY: number;
  defaultPrevented: boolean;
  eventTargetLabel: string | null;
  top: number;
  type: string;
};

let server: ControlUiE2eServer;

async function installPointerTrace(page: Page, button: Locator): Promise<void> {
  await button.evaluate((element) => {
    const target = element as HTMLButtonElement;
    const trace: PointerTraceEntry[] = [];
    const traceWindow = window as Window & { openclawPointerTrace?: PointerTraceEntry[] };
    traceWindow.openclawPointerTrace = trace;
    const record = (event: Event) => {
      const pointerEvent = event as PointerEvent;
      const bounds = target.getBoundingClientRect();
      const hit = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
      trace.push({
        activeTag: document.activeElement?.tagName ?? "",
        bottom: bounds.bottom,
        clientX: pointerEvent.clientX,
        clientY: pointerEvent.clientY,
        centerHitLabel: hit?.closest("button")?.getAttribute("aria-label") ?? null,
        defaultPrevented: event.defaultPrevented,
        eventTargetLabel:
          event.target instanceof Element
            ? (event.target.closest("button")?.getAttribute("aria-label") ?? null)
            : null,
        top: bounds.top,
        type: event.type,
      });
    };
    for (const type of ["pointerdown", "pointerup", "click"]) {
      target.addEventListener(type, record);
    }
    // Android dismisses the software-keyboard focus as an action button is
    // activated. Model that transition explicitly because desktop Chromium
    // normally keeps a textarea focused for a synthetic touch tap.
    target.addEventListener(
      "pointerdown",
      (event) => {
        if ((event as PointerEvent).pointerType === "touch" && !event.defaultPrevented) {
          document.querySelector<HTMLTextAreaElement>(".agent-chat__input textarea")?.blur();
        }
      },
      { once: true },
    );
  });
}

async function readPointerTrace(page: Page): Promise<PointerTraceEntry[]> {
  return page.evaluate(
    () =>
      (window as Window & { openclawPointerTrace?: PointerTraceEntry[] }).openclawPointerTrace ??
      [],
  );
}

function expectStablePointerActivation(trace: PointerTraceEntry[]): void {
  const pointerDown = trace.find((entry) => entry.type === "pointerdown");
  const pointerUp = trace.find((entry) => entry.type === "pointerup");
  expect(trace, `pointer trace: ${JSON.stringify(trace)}`).toContainEqual(
    expect.objectContaining({ type: "click" }),
  );
  expect(pointerDown, `pointer trace: ${JSON.stringify(trace)}`).toBeDefined();
  expect(pointerUp, `pointer trace: ${JSON.stringify(trace)}`).toBeDefined();
  if (!pointerDown || !pointerUp) {
    return;
  }
  expect(
    Math.abs(pointerUp.top - pointerDown.top),
    `pointer trace: ${JSON.stringify(trace)}`,
  ).toBeLessThanOrEqual(1.5);
  expect(pointerUp.centerHitLabel).toBe(pointerDown.centerHitLabel);
  expect(pointerUp.eventTargetLabel).toBe(pointerDown.eventTargetLabel);
}

async function clickMouseAtCurrentCenter(page: Page, button: Locator): Promise<void> {
  const bounds = await button.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) {
    return;
  }
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

describeControlUiE2e("Control UI composer pointer controls", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("sends and stops without moving the action out from under an Android-like tap", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      serviceWorkers: "block",
      viewport: { width: 393, height: 852 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantName: "OpenClaw",
      deferredMethods: ["chat.send"],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page.addStyleTag({
        content: ":root { --safe-area-bottom: 34px !important; }",
      });

      const composerShell = page.locator(".agent-chat__composer-shell");
      const textarea = page.locator(".agent-chat__input textarea");
      await textarea.fill("Verify mobile safe-area touch controls");
      await textarea.focus();
      await expect
        .poll(() => composerShell.evaluate((node) => getComputedStyle(node).marginBottom))
        .toBe("0px");

      const send = page.getByRole("button", { name: "Send message" });
      await expect.poll(() => send.isVisible()).toBe(true);
      await installPointerTrace(page, send);
      await send.tap();
      expectStablePointerActivation(await readPointerTrace(page));
      await expect
        .poll(() => textarea.evaluate((node) => document.activeElement === node))
        .toBe(true);

      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId =
        typeof sendRequest.params === "object" &&
        sendRequest.params !== null &&
        "idempotencyKey" in sendRequest.params
          ? String(sendRequest.params.idempotencyKey)
          : "";
      expect(runId).not.toBe("");
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await gateway.emitGatewayEvent("chat", {
        deltaText: "Working on it.",
        message: {
          content: [{ text: "Working on it.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      const stop = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stop.isVisible()).toBe(true);
      await textarea.focus();
      await expect
        .poll(() => composerShell.evaluate((node) => getComputedStyle(node).marginBottom))
        .toBe("0px");
      await installPointerTrace(page, stop);
      await stop.tap();
      expectStablePointerActivation(await readPointerTrace(page));
      await expect
        .poll(() => textarea.evaluate((node) => document.activeElement === node))
        .toBe(true);

      const abortRequest = await gateway.waitForRequest("chat.abort");
      expect(abortRequest.params).toMatchObject({
        runId,
        sessionKey: "main",
      });
      await expect.poll(() => stop.count()).toBe(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("sends and stops in a narrow desktop viewport without moving under the mouse", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({
      hasTouch: false,
      isMobile: false,
      serviceWorkers: "block",
      viewport: { width: 393, height: 852 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantName: "OpenClaw",
      deferredMethods: ["chat.send"],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page.addStyleTag({
        content: ":root { --safe-area-bottom: 34px !important; }",
      });

      const composerShell = page.locator(".agent-chat__composer-shell");
      const textarea = page.locator(".agent-chat__input textarea");
      await textarea.fill("Verify narrow desktop pointer controls");
      await textarea.focus();
      await expect
        .poll(() => composerShell.evaluate((node) => getComputedStyle(node).marginBottom))
        .toBe("0px");

      const send = page.getByRole("button", { name: "Send message" });
      await expect.poll(() => send.isVisible()).toBe(true);
      await installPointerTrace(page, send);
      await clickMouseAtCurrentCenter(page, send);

      expectStablePointerActivation(await readPointerTrace(page));
      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await expect
        .poll(() => textarea.evaluate((node) => document.activeElement === node))
        .toBe(true);

      const runId =
        typeof sendRequest.params === "object" &&
        sendRequest.params !== null &&
        "idempotencyKey" in sendRequest.params
          ? String(sendRequest.params.idempotencyKey)
          : "";
      expect(runId).not.toBe("");
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await gateway.emitGatewayEvent("chat", {
        deltaText: "Working on it.",
        message: {
          content: [{ text: "Working on it.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      const stop = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stop.isVisible()).toBe(true);
      await textarea.focus();
      await installPointerTrace(page, stop);
      await clickMouseAtCurrentCenter(page, stop);
      expectStablePointerActivation(await readPointerTrace(page));
      const abortRequest = await gateway.waitForRequest("chat.abort");
      expect(abortRequest.params).toMatchObject({ runId, sessionKey: "main" });
      await expect
        .poll(() => textarea.evaluate((node) => document.activeElement === node))
        .toBe(true);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("keeps wide desktop mouse activation and keyboard activation working", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({
      hasTouch: false,
      isMobile: false,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantName: "OpenClaw",
      deferredMethods: ["chat.send"],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const textarea = page.locator(".agent-chat__input textarea");
      await textarea.fill("Verify wide desktop pointer controls");
      await textarea.focus();
      const send = page.getByRole("button", { name: "Send message" });
      await installPointerTrace(page, send);
      await clickMouseAtCurrentCenter(page, send);
      expectStablePointerActivation(await readPointerTrace(page));
      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      const runId =
        typeof sendRequest.params === "object" &&
        sendRequest.params !== null &&
        "idempotencyKey" in sendRequest.params
          ? String(sendRequest.params.idempotencyKey)
          : "";
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await gateway.emitGatewayEvent("chat", {
        deltaText: "Working on it.",
        message: {
          content: [{ text: "Working on it.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      const stop = page.getByRole("button", { name: "Stop generating" });
      await stop.focus();
      await expect.poll(() => stop.evaluate((node) => document.activeElement === node)).toBe(true);
      await stop.press("Space");
      const abortRequest = await gateway.waitForRequest("chat.abort");
      expect(abortRequest.params).toMatchObject({ runId, sessionKey: "main" });

      await textarea.fill("Verify keyboard Send");
      await textarea.focus();
      await textarea.press("Tab");
      const keyboardSend = page.getByRole("button", { name: "Send message" });
      await expect
        .poll(() => keyboardSend.evaluate((node) => document.activeElement === node))
        .toBe(true);
      await keyboardSend.press("Enter");
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("does not send when a mouse gesture leaves the button before release", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({
      hasTouch: false,
      isMobile: false,
      serviceWorkers: "block",
      viewport: { width: 393, height: 852 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { assistantName: "OpenClaw" });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page.addStyleTag({
        content: ":root { --safe-area-bottom: 34px !important; }",
      });
      const textarea = page.locator(".agent-chat__input textarea");
      await textarea.fill("Do not send this draft");
      await textarea.focus();
      const send = page.getByRole("button", { name: "Send message" });
      const bounds = await send.boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) {
        return;
      }
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x - 20, bounds.y - 20);
      await page.mouse.up();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await expect.poll(() => textarea.inputValue()).toBe("Do not send this draft");
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
