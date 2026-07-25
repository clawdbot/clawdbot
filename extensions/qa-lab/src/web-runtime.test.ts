// Qa Lab tests cover web runtime plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  bodyLocator,
  browserClose,
  contextClose,
  contextNewPage,
  existsSync,
  goto,
  launch,
  locatorFill,
  locatorPress,
  locatorWaitFor,
  pageOn,
  pageEvaluate,
  pageTitle,
  pageUrl,
  pageWaitForFunction,
  pageWaitForSelector,
  spawnSync,
} = vi.hoisted(() => ({
  bodyLocator: {
    waitFor: vi.fn(async () => undefined),
    textContent: vi.fn(async () => "hello from body"),
  },
  browserClose: vi.fn(async () => undefined),
  contextClose: vi.fn(async () => undefined),
  contextNewPage: vi.fn(),
  existsSync: vi.fn((_candidate: unknown) => false),
  goto: vi.fn(async () => undefined),
  launch: vi.fn(),
  locatorFill: vi.fn(async () => undefined),
  locatorPress: vi.fn(async () => undefined),
  locatorWaitFor: vi.fn(async () => undefined),
  pageOn: vi.fn(),
  pageEvaluate: vi.fn(async () => "ok"),
  pageTitle: vi.fn(async () => "QA"),
  pageUrl: vi.fn(() => "http://127.0.0.1:3000/chat"),
  pageWaitForFunction: vi.fn(async () => undefined),
  pageWaitForSelector: vi.fn(async () => undefined),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => ({
  spawnSync,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync,
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launch,
  },
}));

import {
  closeQaWebSessions,
  qaWebEvaluate,
  qaWebOpenPage,
  qaWebSnapshot,
  qaWebType,
  qaWebWait,
} from "./web-runtime.js";

beforeEach(async () => {
  const page = {
    on: pageOn,
    goto,
    title: pageTitle,
    url: pageUrl,
    waitForSelector: pageWaitForSelector,
    waitForFunction: pageWaitForFunction,
    locator: vi.fn((selector: string) => {
      if (selector === "body") {
        return bodyLocator;
      }
      return {
        first: () => ({
          waitFor: locatorWaitFor,
          fill: locatorFill,
          press: locatorPress,
        }),
      };
    }),
    evaluate: pageEvaluate,
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: contextClose,
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: browserClose,
  };
  contextNewPage.mockResolvedValue(page);
  launch.mockResolvedValue(browser);
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
  spawnSync.mockReturnValue({ status: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function requireLaunchOptions() {
  const [call] = launch.mock.calls;
  if (!call) {
    throw new Error("expected browser launch call");
  }
  const [launchOptions] = call;
  if (!launchOptions || typeof launchOptions !== "object" || Array.isArray(launchOptions)) {
    throw new Error("expected browser launch options");
  }
  return launchOptions as Record<string, unknown>;
}

describe("qa web runtime", () => {
  it("opens, interacts with, snapshots, and closes a page", async () => {
    const opened = await qaWebOpenPage({ url: "http://127.0.0.1:3000/chat" });

    await qaWebWait({ pageId: opened.pageId, selector: "textarea" });
    await qaWebWait({ pageId: opened.pageId, text: "bridge armed" });
    await qaWebType({
      pageId: opened.pageId,
      selector: "textarea",
      text: "hello",
      submit: true,
    });
    const snapshot = await qaWebSnapshot({ pageId: opened.pageId, maxChars: 5 });
    const evaluated = await qaWebEvaluate({ pageId: opened.pageId, expression: "'ok'" });
    await closeQaWebSessions();

    const launchOptions = requireLaunchOptions();
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      ["scripts/ensure-playwright-chromium.mjs", "--skip-ffmpeg"],
      expect.objectContaining({ cwd: process.cwd(), stdio: "inherit" }),
    );
    expect(launchOptions?.channel).toBeUndefined();
    expect(launchOptions?.executablePath).toBeUndefined();
    expect(launchOptions?.headless).toBe(true);
    expect(goto).toHaveBeenCalledWith("http://127.0.0.1:3000/chat", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(pageWaitForSelector).toHaveBeenCalledWith("textarea", { timeout: 20_000 });
    expect(pageWaitForFunction).toHaveBeenCalled();
    expect(locatorFill).toHaveBeenCalledWith("hello", { timeout: 20_000 });
    expect(locatorPress).toHaveBeenCalledWith("Enter", { timeout: 20_000 });
    expect(snapshot.text).toBe("hello");
    expect(evaluated).toBe("ok");
    expect(contextClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it("keeps bounded web text on UTF-16 boundaries", async () => {
    bodyLocator.textContent.mockResolvedValueOnce(`${"a".repeat(1999)}😀tail`);
    const opened = await qaWebOpenPage({ url: "http://127.0.0.1:3000/chat" });
    const consoleHandler = pageOn.mock.calls.find(([event]) => event === "console")?.[1] as
      | ((message: { type: () => string; text: () => string }) => void)
      | undefined;
    if (!consoleHandler) {
      throw new Error("expected console handler");
    }
    consoleHandler({
      type: () => "log",
      text: () => `${"a".repeat(1993)}😀tail`,
    });

    const snapshot = await qaWebSnapshot({ pageId: opened.pageId, maxChars: 2000 });

    expect(snapshot.text).toBe("a".repeat(1999));
    expect(snapshot.diagnostics).toEqual([{ kind: "console", text: `[log] ${"a".repeat(1993)}` }]);
    await closeQaWebSessions();
  });

  it("launches an explicit Chromium executable override when configured", async () => {
    vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "/custom/chromium");
    existsSync.mockImplementation((candidate) => candidate === "/custom/chromium");

    await qaWebOpenPage({ url: "http://127.0.0.1:3000/chat" });

    const launchOptions = requireLaunchOptions();
    expect(spawnSync).toHaveBeenCalledWith("/custom/chromium", ["--version"], {
      stdio: "ignore",
    });
    expect(launchOptions?.channel).toBeUndefined();
    expect(launchOptions?.executablePath).toBe("/custom/chromium");
    await closeQaWebSessions();
  });

  it("launches detected system Chromium without requiring branded Chrome", async () => {
    existsSync.mockImplementation((candidate) => candidate === "/usr/bin/chromium");

    await qaWebOpenPage({ url: "http://127.0.0.1:3000/chat" });

    const launchOptions = requireLaunchOptions();
    expect(spawnSync).toHaveBeenCalledWith("/usr/bin/chromium", ["--version"], {
      stdio: "ignore",
    });
    expect(launchOptions?.channel).toBeUndefined();
    expect(launchOptions?.executablePath).toBe("/usr/bin/chromium");
    await closeQaWebSessions();
  });

  it("keeps an explicit browser channel request explicit", async () => {
    await qaWebOpenPage({ url: "http://127.0.0.1:3000/chat", channel: "chrome" });

    const launchOptions = requireLaunchOptions();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(launchOptions?.channel).toBe("chrome");
    expect(launchOptions?.executablePath).toBeUndefined();
    await closeQaWebSessions();
  });

  it("can close only selected page sessions", async () => {
    const first = await qaWebOpenPage({ url: "http://127.0.0.1:3000/one" });
    const second = await qaWebOpenPage({ url: "http://127.0.0.1:3000/two" });

    await closeQaWebSessions([first.pageId]);

    await expect(qaWebSnapshot({ pageId: first.pageId })).rejects.toThrow(
      `unknown web session: ${first.pageId}`,
    );
    const snapshot = await qaWebSnapshot({ pageId: second.pageId });
    expect(snapshot.text).toBe("hello from body");
    await closeQaWebSessions();
  });

  it("caps oversized web runtime timeouts", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const opened = await qaWebOpenPage({
        url: "http://127.0.0.1:3000/chat",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });

      await qaWebWait({
        pageId: opened.pageId,
        selector: "textarea",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });
      await qaWebEvaluate({
        pageId: opened.pageId,
        expression: "'ok'",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });
      await closeQaWebSessions();

      expect(goto).toHaveBeenCalledWith("http://127.0.0.1:3000/chat", {
        waitUntil: "domcontentloaded",
        timeout: MAX_TIMER_TIMEOUT_MS,
      });
      expect(pageWaitForSelector).toHaveBeenCalledWith("textarea", {
        timeout: MAX_TIMER_TIMEOUT_MS,
      });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });
});
