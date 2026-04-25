import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  bodyLocator,
  browserClose,
  contextClose,
  contextNewPage,
  goto,
  launch,
  locatorFill,
  locatorPress,
  locatorWaitFor,
  pageEvaluate,
  pageTitle,
  pageUrl,
  pageWaitForFunction,
  pageWaitForSelector,
} = vi.hoisted(() => ({
  bodyLocator: {
    waitFor: vi.fn(async () => undefined),
    textContent: vi.fn(async () => "hello from body"),
  },
  browserClose: vi.fn(async () => undefined),
  contextClose: vi.fn(async () => undefined),
  contextNewPage: vi.fn(),
  goto: vi.fn(async () => undefined),
  launch: vi.fn(),
  locatorFill: vi.fn(async () => undefined),
  locatorPress: vi.fn(async () => undefined),
  locatorWaitFor: vi.fn(async () => undefined),
  pageEvaluate: vi.fn(async () => "ok"),
  pageTitle: vi.fn(async () => "QA"),
  pageUrl: vi.fn(() => "http://127.0.0.1:3000/chat"),
  pageWaitForFunction: vi.fn(async () => undefined),
  pageWaitForSelector: vi.fn(async () => undefined),
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launch,
  },
}));

import {
  closeAllQaWebSessions,
  closeQaWebSessions,
  qaWebEvaluate,
  qaWebOpenPage,
  qaWebSnapshot,
  qaWebType,
  qaWebWait,
} from "./web-runtime.js";

beforeEach(async () => {
  const page = {
    on: vi.fn(),
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
});

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
    await closeAllQaWebSessions();

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "chrome", headless: true }),
    );
    expect(goto).toHaveBeenCalledWith("http://127.0.0.1:3000/chat", expect.any(Object));
    expect(pageWaitForSelector).toHaveBeenCalledWith("textarea", expect.any(Object));
    expect(pageWaitForFunction).toHaveBeenCalled();
    expect(locatorFill).toHaveBeenCalledWith("hello", expect.any(Object));
    expect(locatorPress).toHaveBeenCalledWith("Enter", expect.any(Object));
    expect(snapshot.text).toBe("hello");
    expect(evaluated).toBe("ok");
    expect(contextClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it("can close only selected page sessions", async () => {
    const first = await qaWebOpenPage({ url: "http://127.0.0.1:3000/one" });
    const second = await qaWebOpenPage({ url: "http://127.0.0.1:3000/two" });

    await closeQaWebSessions([first.pageId]);

    await expect(qaWebSnapshot({ pageId: first.pageId })).rejects.toThrow(
      `unknown web session: ${first.pageId}`,
    );
    await expect(qaWebSnapshot({ pageId: second.pageId })).resolves.toMatchObject({
      text: "hello from body",
    });
    await closeAllQaWebSessions();
  });
});
