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

      await vi.advanceTimersByTimeAsync(10);
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

      await vi.advanceTimersByTimeAsync(10);
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
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();
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
      ).not.toHaveBeenCalled();
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
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([first, second]);

      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(1);
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

      await vi.advanceTimersByTimeAsync(10);
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

      await vi.advanceTimersByTimeAsync(10);
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

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run the post-click navigation guard when the url is unchanged", async () => {
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

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
  });

  it("does not run the navigation guard when only the URL hash changes (same-document navigation)", async () => {
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

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
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

  it("does not run the post-evaluate navigation guard when the url is unchanged", async () => {
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
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
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
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );

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
});
