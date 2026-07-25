/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { isNativeWebChromeHost, readNativeHistoryState } from "./native-web-chrome.ts";

type TestNativeWindow = Window & {
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_HISTORY__?: { canGoBack: boolean; canGoForward: boolean };
};

afterEach(() => {
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_HISTORY__");
});

describe("native web chrome capability", () => {
  it("requires the document-start capability flag", () => {
    expect(isNativeWebChromeHost()).toBe(false);
    (window as TestNativeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
    expect(isNativeWebChromeHost()).toBe(true);
  });

  it("reads native history state and defaults safely", () => {
    expect(readNativeHistoryState()).toEqual({ canGoBack: false, canGoForward: false });
    (window as TestNativeWindow)["__OPENCLAW_NATIVE_HISTORY__"] = {
      canGoBack: true,
      canGoForward: false,
    };
    expect(readNativeHistoryState()).toEqual({ canGoBack: true, canGoForward: false });
  });
});
