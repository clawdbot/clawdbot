/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { postNativeNavState } from "./native-nav-state.ts";

type TestWebKitWindow = Window & {
  webkit?: {
    messageHandlers: {
      openclawNav: {
        postMessage(message: unknown): void;
      };
    };
  };
};

afterEach(() => {
  Reflect.deleteProperty(window, "webkit");
});

describe("native nav state bridge", () => {
  it("posts the typed payload to WebKit", () => {
    const postMessage = vi.fn();
    (window as TestWebKitWindow).webkit = {
      messageHandlers: { openclawNav: { postMessage } },
    };

    postNativeNavState({ collapsed: false, width: 280 });

    expect(postMessage).toHaveBeenCalledWith({
      type: "nav-state",
      collapsed: false,
      width: 280,
    });
  });

  it("does nothing without WebKit and tolerates a disappearing handler", () => {
    expect(() => postNativeNavState({ collapsed: true, width: 280 })).not.toThrow();
    (window as TestWebKitWindow).webkit = {
      messageHandlers: {
        openclawNav: {
          postMessage: () => {
            throw new Error("handler removed");
          },
        },
      },
    };
    expect(() => postNativeNavState({ collapsed: true, width: 280 })).not.toThrow();
  });
});
