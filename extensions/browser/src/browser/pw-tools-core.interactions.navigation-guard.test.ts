// Browser tests cover pw tools core.interactions.navigation guard plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.js");

function requireInvocationOrder(mock: { invocationCallOrder: number[] }, context: string): number {
  return expectDefined(mock.invocationCallOrder[0], context);
}

function createMutableFrame(initialUrl: string) {
  let currentUrl = initialUrl;
  return {
    frame: {
      url: vi.fn(() => currentUrl),
    },
    setUrl: (nextUrl: string) => {
      currentUrl = nextUrl;
    },
  };
}

describe("pw-tools-core interaction navigation guard", () => {
  it("waits for the grace window before completing a successful non-navigating click", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      const click = vi.fn(async () => {});
      const page = {
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const completion = vi.fn();
      const task = mod
        .clickViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          ref: "1",
          ssrfPolicy: { allowPrivateNetwork: false },
        })
        .then(completion);

      await vi.advanceTimersByTimeAsync(0);
      expect(completion).not.toHaveBeenCalled();
      expect(listeners.size).toBe(1);
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await task;
      expect(completion).toHaveBeenCalledTimes(1);
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the post-click navigation guard when navigation starts shortly after the click resolves", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:9222/json/list";
          for (const listener of listeners) {
            listener();
          }
        }, 10);
      });
      const page = {
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const completion = vi.fn();
      const task = mod
        .clickViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          ref: "1",
          ssrfPolicy: { allowPrivateNetwork: false },
        })
        .then(completion);

      await vi.advanceTimersByTimeAsync(0);
      expect(completion).not.toHaveBeenCalled();
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await task;
      expect(completion).toHaveBeenCalledTimes(1);

      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the post-select navigation guard when navigation starts shortly after the select resolves", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "https://example.com/form";
      const selectOption = vi.fn(async () => {
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:9222/private-target";
          for (const listener of listeners) {
            listener();
          }
        }, 10);
      });
      const page = {
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ selectOption });
      setPwToolsCoreCurrentPage(page);

      const task = mod.selectOptionViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        values: ["go"],
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(250);
      await task;

      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks subframe navigations before a later main-frame navigation", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "https://example.com/embed" };
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(subframe);
          }
        }, 10);
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:9222/json/list";
          for (const listener of listeners) {
            listener(mainFrame);
          }
        }, 20);
      });
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(listeners.size).toBe(1);
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();
      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(240);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "https://example.com/embed",
      });
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks subframe-only navigation to a private URL during the post-action grace window", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(subframe);
          }
        }, 10);
      });
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => "https://attacker.example.com/page"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const blocked = new Error("SSRF blocked: private network");
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("SSRF blocked: private network");

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
      await rejection;
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("snapshots delayed subframe URLs before later rewrites make them look safe", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = createMutableFrame("http://169.254.169.254/latest/meta-data/");
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(subframe.frame);
          }
        }, 10);
        setTimeout(() => {
          subframe.setUrl("https://example.com/embed");
        }, 20);
      });
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => "https://attacker.example.com/page"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(230);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "http://169.254.169.254/latest/meta-data/",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still quarantines the main frame when a delayed subframe block fires first", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      let currentUrl = "https://attacker.example.com/page";
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(subframe);
          }
        }, 10);
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:8080/internal";
          for (const listener of listeners) {
            listener(mainFrame);
          }
        }, 20);
      });
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const subframeBlocked = new Error("subframe blocked");
      const mainFrameBlocked = new Error("main frame blocked");
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        subframeBlocked,
      );
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        mainFrameBlocked,
      );

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("main frame blocked");

      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(230);
      await rejection;
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stop watching for a later main-frame navigation after a harmless subframe hop", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "about:blank" };
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(subframe);
          }
        }, 10);
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:9222/json/list";
          for (const listener of listeners) {
            listener(mainFrame);
          }
        }, 20);
      });
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(230);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).not.toHaveBeenCalled();
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks delayed subframe navigations in the action-error recovery path", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        evaluate: vi.fn(async () => {
          setTimeout(() => {
            for (const listener of listeners) {
              listener(subframe);
            }
          }, 10);
          throw new Error("evaluate failed");
        }),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => "https://attacker.example.com/page"),
      };
      setPwToolsCoreCurrentPage(page);

      const blocked = new Error("SSRF blocked: private network");
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        fn: "() => 1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("SSRF blocked: private network");

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
      await rejection;
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(1);
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
      expect(
        requireInvocationOrder(
          getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mock,
          "navigation request guard invocation",
        ),
      ).toBeLessThan(requireInvocationOrder(page.evaluate.mock, "page evaluation invocation"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("snapshots subframe URLs observed during the action before they change", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = createMutableFrame("http://169.254.169.254/latest/meta-data/");
      const click = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              for (const listener of listeners) {
                listener(subframe.frame);
              }
            }, 10);
            setTimeout(() => {
              subframe.setUrl("https://example.com/embed");
            }, 20);
            setTimeout(resolve, 30);
          }),
      );
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => "https://attacker.example.com/page"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(250);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "http://169.254.169.254/latest/meta-data/",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still quarantines the main frame when an in-flight subframe block fires first", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      let currentUrl = "https://attacker.example.com/page";
      const click = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              for (const listener of listeners) {
                listener(subframe);
              }
            }, 10);
            setTimeout(() => {
              currentUrl = "http://127.0.0.1:8080/internal";
              for (const listener of listeners) {
                listener(mainFrame);
              }
            }, 20);
            setTimeout(resolve, 30);
          }),
      );
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const subframeBlocked = new Error("subframe blocked");
      const mainFrameBlocked = new Error("main frame blocked");
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        subframeBlocked,
      );
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        mainFrameBlocked,
      );

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("main frame blocked");

      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates delayed navigation guards across repeated successful interactions", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {});
      const page = {
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const first = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.size).toBe(1);

      const second = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.size).toBe(1);

      currentUrl = "http://127.0.0.1:9222/json/list";
      for (const listener of Array.from(listeners)) {
        listener();
      }
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([first, second]);

      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(3);
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates blocked delayed navigation instead of reporting click success", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:9222/private-target";
          for (const listener of listeners) {
            listener();
          }
        }, 10);
      });
      const page = {
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const blocked = new Error("blocked delayed interaction navigation");
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("blocked delayed interaction navigation");

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the post-click navigation guard with the resolved SSRF policy", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: vi
        .fn()
        .mockReturnValueOnce("http://127.0.0.1:9222/json/version")
        .mockReturnValue("http://127.0.0.1:9222/json/list"),
    };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    const blocked = new Error("blocked interaction navigation");
    getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(blocked);

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    ).rejects.toThrow("blocked interaction navigation");

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("skips interaction navigation guards when no explicit SSRF policy is provided", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {
        currentUrl = "http://127.0.0.1:9222/json/list";
        for (const listener of listeners) {
          listener(mainFrame);
        }
      });
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      await mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      });
      await vi.runAllTimersAsync();

      expect(page.on).not.toHaveBeenCalled();
      expect(page.off).not.toHaveBeenCalled();
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the post-evaluate navigation guard after page evaluation", async () => {
    const page = {
      evaluate: vi.fn(async () => "ok"),
      url: vi
        .fn()
        .mockReturnValueOnce("http://127.0.0.1:9222/json/version")
        .mockReturnValue("http://127.0.0.1:9222/json/list"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      fn: "() => location.href = 'http://127.0.0.1:9222/json/version'",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(result).toBe("ok");
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("runs statement-body page evaluate sources", async () => {
    const page = {
      evaluate: vi.fn(async (evaluateFn: (args: unknown) => unknown, args: unknown) =>
        evaluateFn(args),
      ),
      url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      fn: "const value = 41; return value + 1;",
    });

    expect(result).toBe(42);
    expect(page.evaluate.mock.calls[0]?.[1]).toMatchObject({
      fnSource: "async () => {\nconst value = 41; return value + 1;\n}",
    });
  });

  it("runs statement-body ref evaluate sources", async () => {
    const page = {
      url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
    };
    const locator = {
      evaluate: vi.fn(async (evaluateFn: (el: Element, args: unknown) => unknown, args: unknown) =>
        evaluateFn({ textContent: "Ada" } as Element, args),
      ),
    };
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator(locator);

    const result = await mod.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      fn: "const text = el.textContent; return text;",
    });

    expect(result).toBe("Ada");
    expect(locator.evaluate.mock.calls[0]?.[1]).toMatchObject({
      fnSource: "async (el) => {\nconst text = el.textContent; return text;\n}",
    });
  });

  it("runs the post-keypress navigation guard when navigation starts shortly after the keypress resolves", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const page = {
        keyboard: {
          press: vi.fn(async () => {
            setTimeout(() => {
              currentUrl = "http://127.0.0.1:9222/private-target";
              for (const listener of listeners) {
                listener();
              }
            }, 10);
          }),
        },
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentPage(page);

      const task = mod.pressKeyViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        key: "Enter",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(250);
      await task;

      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults non-finite keypress delays before calling Playwright", async () => {
    vi.useFakeTimers();
    try {
      const press = vi.fn(async () => {});
      const page = {
        keyboard: { press },
        on: vi.fn(),
        off: vi.fn(),
        url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
      };
      setPwToolsCoreCurrentPage(page);

      const task = mod.pressKeyViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        key: "Enter",
        delayMs: Number.NaN,
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(250);
      await task;

      expect(press).toHaveBeenCalledWith("Enter", { delay: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates blocked delayed submit navigation instead of reporting type success", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "https://example.com/form";
      const locator = {
        fill: vi.fn(async () => {}),
        press: vi.fn(async () => {
          setTimeout(() => {
            currentUrl = "http://127.0.0.1:9222/private-target";
            for (const listener of listeners) {
              listener();
            }
          }, 10);
        }),
      };
      const page = {
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator(locator);
      setPwToolsCoreCurrentPage(page);

      const blocked = new Error("blocked delayed interaction navigation");
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.typeViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        text: "hello",
        submit: true,
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("blocked delayed interaction navigation");

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the final committed-URL check when a click leaves the URL unchanged", async () => {
    const click = vi.fn(async () => {});
    const page = { url: vi.fn(() => "http://127.0.0.1:9222/json/version") };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("runs the final committed-URL check after a same-document hash change", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: vi
        .fn()
        .mockReturnValueOnce("https://example.com/page")
        .mockReturnValue("https://example.com/page#section"),
    };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("runs the navigation guard when a same-URL reload fires framenavigated during a click", async () => {
    // A page reload (form submit, location.reload()) keeps the URL identical but
    // fires framenavigated. Prior to the isHashOnlyNavigation fix, didCrossDocumentUrlChange
    // would treat currentUrl === previousUrl as "no navigation" and skip the SSRF guard.
    const listeners = new Set<() => void>();
    const sameUrl = "http://192.168.1.1/admin";
    const click = vi.fn(async () => {
      // Simulate reload: URL stays the same but framenavigated fires during the click
      for (const listener of listeners) {
        listener();
      }
    });
    const page = {
      on: vi.fn((event: string, listener: () => void) => {
        if (event === "framenavigated") {
          listeners.add(listener);
        }
      }),
      off: vi.fn((event: string, listener: () => void) => {
        if (event === "framenavigated") {
          listeners.delete(listener);
        }
      }),
      url: vi.fn(() => sameUrl),
    };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("installs the request guard before evaluate and runs the final committed-URL check", async () => {
    const page = {
      evaluate: vi.fn(async () => "ok"),
      url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      fn: "() => 1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(result).toBe("ok");
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
    expect(
      requireInvocationOrder(
        getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mock,
        "navigation request guard invocation",
      ),
    ).toBeLessThan(requireInvocationOrder(page.evaluate.mock, "page evaluation invocation"));
  });

  it("propagates the SSRF policy through batch interaction actions", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: vi.fn().mockReturnValueOnce("about:blank").mockReturnValue("https://example.com/after"),
    };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    await mod.batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ssrfPolicy: { allowPrivateNetwork: false },
      actions: [{ kind: "click", ref: "1" }],
    });

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("runs the post-evaluate navigation guard when evaluate rejects after triggering navigation", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const page = {
        evaluate: vi.fn(async () => {
          setTimeout(() => {
            currentUrl = "http://127.0.0.1:9222/json/list";
            for (const listener of listeners) {
              listener();
            }
          }, 0);
          throw new Error("evaluate failed after scheduling navigation");
        }),
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentPage(page);

      const blocked = new Error("blocked interaction navigation");
      getPwToolsCoreSessionMocks()
        .assertPageNavigationCompletedSafely.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(blocked);

      const task = mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        fn: "() => location.href = 'http://127.0.0.1:9222/json/list'",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const expectation = expect(task).rejects.toThrow("blocked interaction navigation");

      await vi.runAllTimersAsync();
      await expectation;

      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns click downloads without adding a second policy grace", async () => {
    const page = { url: vi.fn(() => "https://example.com") };
    const click = vi.fn(async () => {});
    const drain = vi.fn(async () => [
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ]);
    const dispose = vi.fn();
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain,
      dispose,
    });
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator({ click });

    const result = await mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action: { kind: "click", ref: "1" },
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(result.downloads).toEqual([
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ]);
    expect(drain).toHaveBeenCalledWith({
      firstEventGraceMs: 0,
      maxWaitMs: 1_000,
      quietMs: 250,
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage).toHaveBeenCalledWith(
      page,
      { beforeSave: expect.any(Function) },
    );
  });

  it.each([
    {
      name: "hover",
      action: { kind: "hover", ref: "1" } as const,
      locator: { hover: vi.fn(async () => {}) },
    },
    {
      name: "scrollIntoView",
      action: { kind: "scrollIntoView", ref: "1" } as const,
      locator: { scrollIntoViewIfNeeded: vi.fn(async () => {}) },
    },
    {
      name: "drag",
      action: { kind: "drag", startRef: "1", endRef: "2" } as const,
      locator: { dragTo: vi.fn(async () => {}) },
    },
  ])("does not add a second download grace for guarded $name", async ({ action, locator }) => {
    const page = { url: vi.fn(() => "https://example.com") };
    const drain = vi.fn(async () => undefined);
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain,
      dispose: vi.fn(),
    });
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator(locator);

    await mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(drain).toHaveBeenCalledWith({
      firstEventGraceMs: 0,
      maxWaitMs: 1_000,
      quietMs: 250,
    });
  });

  it("does not quarantine a source page preserved after policy denial", async () => {
    const page = { url: vi.fn(() => "about:blank") };
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator({ hover: vi.fn(async () => {}) });
    getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockRejectedValueOnce(blocked);
    getPwToolsCoreSessionMocks()
      .wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockReturnValueOnce(true)
      .mockReturnValueOnce(true);

    await expect(
      mod.executeActViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        action: { kind: "hover", ref: "1" },
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    ).rejects.toBe(blocked);

    expect(getPwToolsCoreSessionMocks().quarantineBlockedNavigationTarget).not.toHaveBeenCalled();
  });

  it("retains the pre-existing download grace when a guarded hover aborts", async () => {
    const ctrl = new AbortController();
    let hoverStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      hoverStarted = resolve;
    });
    let releaseHover!: () => void;
    const pendingHover = new Promise<void>((resolve) => {
      releaseHover = resolve;
    });
    const page = { url: vi.fn(() => "https://example.com") };
    const drain = vi.fn(async () => undefined);
    const dispose = vi.fn();
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain,
      dispose,
    });
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator({
      hover: vi.fn(() => {
        hoverStarted();
        return pendingHover;
      }),
    });

    const task = mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action: { kind: "hover", ref: "1" },
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: ctrl.signal,
    });
    await started;
    ctrl.abort(new Error("aborted by test"));

    await expect(task).rejects.toThrow("aborted by test");
    expect(drain).toHaveBeenCalledWith({
      firstEventGraceMs: 250,
      maxWaitMs: 1_000,
      quietMs: 250,
    });
    expect(dispose).toHaveBeenCalledOnce();
    releaseHover();
  });

  it("retains the download grace when an executable wait aborts", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("aborted by test"));
    const page = {
      url: vi.fn(() => "https://example.com"),
      waitForFunction: vi.fn(async () => {}),
    };
    const drain = vi.fn(async () => undefined);
    const dispose = vi.fn();
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain,
      dispose,
    });
    setPwToolsCoreCurrentPage(page);

    const task = mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action: { kind: "wait", fn: "() => false" },
      evaluateEnabled: true,
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: ctrl.signal,
    });

    await expect(task).rejects.toThrow("aborted by test");
    expect(drain).toHaveBeenCalledWith({
      firstEventGraceMs: 250,
      maxWaitMs: 1_000,
      quietMs: 250,
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("does not add a second download grace after a settled guarded failure", async () => {
    vi.useFakeTimers();
    try {
      const page = { url: vi.fn(() => "https://example.com") };
      const drain = vi.fn(async () => undefined);
      getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
        drain,
        dispose: vi.fn(),
      });
      setPwToolsCoreCurrentPage(page);
      setPwToolsCoreCurrentRefLocator({
        hover: vi.fn(async () => {
          throw new Error("locator failed");
        }),
      });

      const task = mod.executeActViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        action: { kind: "hover", ref: "1" },
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const expectation = expect(task).rejects.toThrow("locator failed");
      await vi.runAllTimersAsync();
      await expectation;

      expect(drain).toHaveBeenCalledWith({
        firstEventGraceMs: 0,
        maxWaitMs: 1_000,
        quietMs: 250,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks a private final URL after an earlier safe navigation", async () => {
    vi.useFakeTimers();
    try {
      let currentUrl = "https://example.com";
      const blocked = new Error("final browser URL blocked by policy");
      blocked.name = "SsrFBlockedError";
      const page = { url: vi.fn(() => currentUrl) };
      setPwToolsCoreCurrentPage(page);
      setPwToolsCoreCurrentRefLocator({
        hover: vi.fn(async () => {
          currentUrl = "https://example.org/safe";
          setTimeout(() => {
            currentUrl = "http://127.0.0.1:18080/private-final";
          }, 200);
        }),
      });
      getPwToolsCoreSessionMocks()
        .assertPageNavigationCompletedSafely.mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => {
          await getPwToolsCoreSessionMocks().quarantineBlockedNavigationTarget({
            cdpUrl: "http://127.0.0.1:18792",
            page,
            targetId: "T1",
          });
          throw blocked;
        });

      const task = mod.executeActViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        action: { kind: "hover", ref: "1" },
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const expectation = expect(task).rejects.toBe(blocked);
      await vi.advanceTimersByTimeAsync(250);
      await expectation;

      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(2);
      expect(getPwToolsCoreSessionMocks().quarantineBlockedNavigationTarget).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        page,
        targetId: "T1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a permissive batch and quarantines when source preservation fails", async () => {
    const page = { url: vi.fn(() => "about:blank") };
    const hover = vi.fn(async () => {});
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator({ hover });
    getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockRejectedValueOnce(blocked);

    await expect(
      mod.executeActViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        action: {
          kind: "batch",
          stopOnError: false,
          actions: [
            { kind: "hover", ref: "1" },
            { kind: "hover", ref: "1" },
          ],
        },
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    ).rejects.toBe(blocked);

    expect(hover).not.toHaveBeenCalled();
    expect(getPwToolsCoreSessionMocks().withPageNavigationRequestGuard).toHaveBeenCalledTimes(1);
    expect(getPwToolsCoreSessionMocks().quarantineBlockedNavigationTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      targetId: "T1",
    });
  });

  it("quarantines the target without closing it when an action download fails policy", async () => {
    const page = { url: vi.fn(() => "https://example.com") };
    const click = vi.fn(async () => {});
    const blocked = new Error("blocked action download");
    blocked.name = "InvalidBrowserNavigationUrlError";
    const dispose = vi.fn();
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain: vi.fn(async () => {
        throw blocked;
      }),
      dispose,
    });
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator({ click });

    await expect(
      mod.executeActViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        action: { kind: "click", ref: "1" },
      }),
    ).rejects.toBe(blocked);

    expect(getPwToolsCoreSessionMocks().quarantineBlockedNavigationTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      targetId: "T1",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("captures key-triggered downloads with a bounded event grace", async () => {
    const page = {
      keyboard: { press: vi.fn(async () => {}) },
      url: vi.fn(() => "https://example.com"),
    };
    const drain = vi.fn(async () => [
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ]);
    const dispose = vi.fn();
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain,
      dispose,
    });
    setPwToolsCoreCurrentPage(page);

    const result = await mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action: { kind: "press", key: "Enter" },
    });

    expect(result.downloads).toEqual([
      expect.objectContaining({ suggestedFilename: "report.pdf" }),
    ]);
    expect(drain).toHaveBeenCalledWith({
      firstEventGraceMs: 250,
      maxWaitMs: 1_000,
      quietMs: 250,
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
