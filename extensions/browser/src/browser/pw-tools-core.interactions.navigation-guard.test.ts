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
const mod = await import("./pw-tools-core.interactions.js");

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

async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  return await run().finally(() => vi.useRealTimers());
}

async function runWithVirtualNavigationGrace<T>(run: () => Promise<T>): Promise<T> {
  return await withFakeTimers(async () => {
    // Observe rejection before advancing the production grace timer to avoid a transient
    // unhandled rejection; timing-specific cases below still advance exact durations.
    const settled = run().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  });
}

const strictNavigationOptions = () =>
  ({
    cdpUrl: "http://127.0.0.1:18792",
    targetId: "T1",
    ssrfPolicy: { allowPrivateNetwork: false },
  }) as const;

const completedNavigationExpectation = (page: Record<string, unknown>) =>
  ({
    ...strictNavigationOptions(),
    page,
    response: null,
  }) as const;

type TestFrame = object;
type TestPageExtras = Record<string, unknown>;

function createNavigationPage<T extends TestPageExtras>(
  initialUrl: string,
  options: { extras?: T; mainFrame?: TestFrame } = {},
) {
  let currentUrl = initialUrl;
  const listeners = new Set<(frame?: TestFrame) => void>();
  const page = {
    ...(options.extras ?? ({} as T)),
    ...(options.mainFrame ? { mainFrame: vi.fn(() => options.mainFrame) } : {}),
    on: vi.fn((event: string, listener: (frame?: TestFrame) => void) => {
      if (event === "framenavigated") {
        listeners.add(listener);
      }
    }),
    off: vi.fn((event: string, listener: (frame?: TestFrame) => void) => {
      if (event === "framenavigated") {
        listeners.delete(listener);
      }
    }),
    url: vi.fn(() => currentUrl),
  };
  return {
    emitFrame(frame?: TestFrame) {
      for (const listener of listeners) {
        listener(frame);
      }
    },
    listeners,
    page,
    setUrl(nextUrl: string) {
      currentUrl = nextUrl;
    },
  };
}

function installInteractionPage(page: Record<string, unknown>, locator?: Record<string, unknown>) {
  if (locator) {
    setPwToolsCoreCurrentRefLocator(locator);
  }
  setPwToolsCoreCurrentPage(page);
}

function strictClick() {
  return mod.clickViaPlaywright({
    ...strictNavigationOptions(),
    ref: "1",
  });
}

const NO_EXTRA_DOWNLOAD_GRACE = {
  firstEventGraceMs: 0,
  maxWaitMs: 1_000,
  quietMs: 250,
};
const DOWNLOAD_GRACE = { ...NO_EXTRA_DOWNLOAD_GRACE, firstEventGraceMs: 250 };

type SessionMocks = ReturnType<typeof getPwToolsCoreSessionMocks>;
type DownloadCapture = ReturnType<SessionMocks["beginActionDownloadCaptureOnPage"]>;

function mockDownloadCapture(drain: DownloadCapture["drain"], dispose = vi.fn()) {
  getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
    drain,
    dispose,
  });
  return dispose;
}

describe("pw-tools-core interaction navigation guard", () => {
  it("waits for the grace window before completing a successful non-navigating click", async () => {
    await withFakeTimers(async () => {
      const { listeners, page } = createNavigationPage("http://127.0.0.1:9222/json/version");
      const click = vi.fn(async () => {});
      installInteractionPage(page, { click });

      const completion = vi.fn();
      const task = strictClick().then(completion);

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
    });
  });

  it.each([
    {
      kind: "click",
      sourceUrl: "http://127.0.0.1:9222/json/version",
      destinationUrl: "http://127.0.0.1:9222/json/list",
    },
    {
      kind: "select",
      sourceUrl: "https://example.com/form",
      destinationUrl: "http://127.0.0.1:9222/private-target",
    },
    {
      kind: "keypress",
      sourceUrl: "http://127.0.0.1:9222/json/version",
      destinationUrl: "http://127.0.0.1:9222/private-target",
    },
  ])(
    "runs the post-$kind navigation guard when navigation starts shortly after the $kind resolves",
    async ({ kind, sourceUrl, destinationUrl }) => {
      await withFakeTimers(async () => {
        const navigation = createNavigationPage(sourceUrl);
        const interaction = vi.fn(async () => {
          setTimeout(() => {
            navigation.setUrl(destinationUrl);
            navigation.emitFrame();
          }, 10);
        });
        const { page } = navigation;
        const locator =
          kind === "click"
            ? { click: interaction }
            : kind === "select"
              ? { selectOption: interaction }
              : undefined;
        if (kind === "keypress") {
          Object.assign(page, { keyboard: { press: interaction } });
        }
        installInteractionPage(page, locator);

        const completion = vi.fn();
        const task = (
          kind === "click"
            ? strictClick()
            : kind === "select"
              ? mod.selectOptionViaPlaywright({
                  ...strictNavigationOptions(),
                  ref: "1",
                  values: ["go"],
                })
              : mod.pressKeyViaPlaywright({ ...strictNavigationOptions(), key: "Enter" })
        ).then(completion);

        await vi.advanceTimersByTimeAsync(0);
        expect(completion).not.toHaveBeenCalled();
        expect(
          getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
        ).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(250);
        await task;
        expect(completion).toHaveBeenCalledTimes(1);
        expect(
          getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
        ).toHaveBeenCalledWith(completedNavigationExpectation(page));
      });
    },
  );

  it("checks subframe navigations before a later main-frame navigation", async () => {
    await withFakeTimers(async () => {
      const mainFrame = {};
      const subframe = { url: () => "https://example.com/embed" };
      const navigation = createNavigationPage("http://127.0.0.1:9222/json/version", {
        mainFrame,
      });
      const click = vi.fn(async () => {
        setTimeout(() => {
          navigation.emitFrame(subframe);
        }, 10);
        setTimeout(() => {
          navigation.setUrl("http://127.0.0.1:9222/json/list");
          navigation.emitFrame(mainFrame);
        }, 20);
      });
      const { listeners, page } = navigation;
      installInteractionPage(page, { click });

      const task = strictClick();

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
        completedNavigationExpectation(page),
      );
    });
  });

  it("blocks subframe-only navigation to a private URL during the post-action grace window", async () => {
    await withFakeTimers(async () => {
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      const navigation = createNavigationPage("https://attacker.example.com/page", { mainFrame });
      const click = vi.fn(async () => {
        setTimeout(() => {
          navigation.emitFrame(subframe);
        }, 10);
      });
      const { page } = navigation;
      installInteractionPage(page, { click });

      const blocked = new Error("SSRF blocked: private network");
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        blocked,
      );

      const task = strictClick();
      const rejection = expect(task).rejects.toThrow("SSRF blocked: private network");

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
      await rejection;
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        completedNavigationExpectation(page),
      );
    });
  });

  it.each([
    {
      name: "snapshots delayed subframe URLs before later rewrites make them look safe",
      actionDurationMs: 0,
      advanceMs: 20,
      graceMs: 230,
    },
    {
      name: "snapshots subframe URLs observed during the action before they change",
      actionDurationMs: 30,
      advanceMs: 30,
      graceMs: 250,
    },
  ])("$name", async ({ actionDurationMs, advanceMs, graceMs }) => {
    await withFakeTimers(async () => {
      const mainFrame = {};
      const subframe = createMutableFrame("http://169.254.169.254/latest/meta-data/");
      const navigation = createNavigationPage("https://attacker.example.com/page", { mainFrame });
      const click = vi.fn(async () => {
        setTimeout(() => {
          navigation.emitFrame(subframe.frame);
        }, 10);
        setTimeout(() => {
          subframe.setUrl("https://example.com/embed");
        }, 20);
        if (actionDurationMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, actionDurationMs);
          });
        }
      });
      const { page } = navigation;
      installInteractionPage(page, { click });

      const task = strictClick();

      await vi.advanceTimersByTimeAsync(advanceMs);
      await vi.advanceTimersByTimeAsync(graceMs);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "http://169.254.169.254/latest/meta-data/",
      });
    });
  });

  it.each([
    { phase: "a delayed", actionDurationMs: 0, advanceMs: 20, graceMs: 230 },
    { phase: "an in-flight", actionDurationMs: 30, advanceMs: 30, graceMs: 250 },
  ])(
    "still quarantines the main frame when $phase subframe block fires first",
    async ({ actionDurationMs, advanceMs, graceMs }) => {
      await withFakeTimers(async () => {
        const mainFrame = {};
        const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
        const navigation = createNavigationPage("https://attacker.example.com/page", { mainFrame });
        const click = vi.fn(async () => {
          setTimeout(() => {
            navigation.emitFrame(subframe);
          }, 10);
          setTimeout(() => {
            navigation.setUrl("http://127.0.0.1:8080/internal");
            navigation.emitFrame(mainFrame);
          }, 20);
          if (actionDurationMs > 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, actionDurationMs);
            });
          }
        });
        const { page } = navigation;
        installInteractionPage(page, { click });

        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
          new Error("subframe blocked"),
        );
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
          new Error("main frame blocked"),
        );

        const task = strictClick();
        const rejection = expect(task).rejects.toThrow("main frame blocked");

        await vi.advanceTimersByTimeAsync(advanceMs);
        await vi.advanceTimersByTimeAsync(graceMs);
        await rejection;
        expect(
          getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
        ).toHaveBeenCalledWith(completedNavigationExpectation(page));
      });
    },
  );

  it("does not stop watching for a later main-frame navigation after a harmless subframe hop", async () => {
    await withFakeTimers(async () => {
      const mainFrame = {};
      const subframe = { url: () => "about:blank" };
      const navigation = createNavigationPage("http://127.0.0.1:9222/json/version", {
        mainFrame,
      });
      const click = vi.fn(async () => {
        setTimeout(() => {
          navigation.emitFrame(subframe);
        }, 10);
        setTimeout(() => {
          navigation.setUrl("http://127.0.0.1:9222/json/list");
          navigation.emitFrame(mainFrame);
        }, 20);
      });
      const { page } = navigation;
      installInteractionPage(page, { click });

      const task = strictClick();

      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(230);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).not.toHaveBeenCalled();
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        completedNavigationExpectation(page),
      );
    });
  });

  it("checks delayed subframe navigations in the action-error recovery path", async () => {
    await withFakeTimers(async () => {
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      const navigation = createNavigationPage("https://attacker.example.com/page", { mainFrame });
      const page = Object.assign(navigation.page, {
        evaluate: vi.fn(async () => {
          setTimeout(() => navigation.emitFrame(subframe), 10);
          throw new Error("evaluate failed");
        }),
      });
      installInteractionPage(page);

      const blocked = new Error("SSRF blocked: private network");
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.evaluateViaPlaywright({
        ...strictNavigationOptions(),
        fn: "() => 1",
      });
      const rejection = expect(task).rejects.toThrow("SSRF blocked: private network");

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
      await rejection;
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(1);
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        completedNavigationExpectation(page),
      );
      expect(
        requireInvocationOrder(
          getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mock,
          "navigation request guard invocation",
        ),
      ).toBeLessThan(requireInvocationOrder(page.evaluate.mock, "page evaluation invocation"));
    });
  });

  it("deduplicates delayed navigation guards across repeated successful interactions", async () => {
    await withFakeTimers(async () => {
      const navigation = createNavigationPage("http://127.0.0.1:9222/json/version");
      const click = vi.fn(async () => {});
      const { listeners, page } = navigation;
      installInteractionPage(page, { click });

      const first = strictClick();
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.size).toBe(1);

      const second = strictClick();
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.size).toBe(1);

      navigation.setUrl("http://127.0.0.1:9222/json/list");
      navigation.emitFrame();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([first, second]);

      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(3);
      expect(listeners.size).toBe(0);
    });
  });

  it("propagates blocked delayed navigation instead of reporting click success", async () => {
    await withFakeTimers(async () => {
      const navigation = createNavigationPage("http://127.0.0.1:9222/json/version");
      const click = vi.fn(async () => {
        setTimeout(() => {
          navigation.setUrl("http://127.0.0.1:9222/private-target");
          navigation.emitFrame();
        }, 10);
      });
      const { listeners, page } = navigation;
      installInteractionPage(page, { click });

      const blocked = new Error("blocked delayed interaction navigation");
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );

      const task = strictClick();
      const rejection = expect(task).rejects.toThrow("blocked delayed interaction navigation");

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(listeners.size).toBe(0);
    });
  });

  it("runs the post-click navigation guard with the resolved SSRF policy", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: vi
        .fn()
        .mockReturnValueOnce("http://127.0.0.1:9222/json/version")
        .mockReturnValue("http://127.0.0.1:9222/json/list"),
    };
    installInteractionPage(page, { click });

    const blocked = new Error("blocked interaction navigation");
    getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(blocked);

    await expect(runWithVirtualNavigationGrace(() => strictClick())).rejects.toThrow(
      "blocked interaction navigation",
    );

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(page),
    );
  });

  it("skips interaction navigation guards when no explicit SSRF policy is provided", async () => {
    await withFakeTimers(async () => {
      const mainFrame = {};
      const navigation = createNavigationPage("http://127.0.0.1:9222/json/version", {
        mainFrame,
      });
      const click = vi.fn(async () => {
        navigation.setUrl("http://127.0.0.1:9222/json/list");
        navigation.emitFrame(mainFrame);
      });
      const { page } = navigation;
      installInteractionPage(page, { click });

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
    });
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

    const result = await runWithVirtualNavigationGrace(() =>
      mod.evaluateViaPlaywright({
        ...strictNavigationOptions(),
        fn: "() => location.href = 'http://127.0.0.1:9222/json/version'",
      }),
    );

    expect(result).toBe("ok");
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(page),
    );
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
    installInteractionPage(page, locator);

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

  it("defaults non-finite keypress delays before calling Playwright", async () => {
    await withFakeTimers(async () => {
      const press = vi.fn(async () => {});
      const page = {
        keyboard: { press },
        on: vi.fn(),
        off: vi.fn(),
        url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
      };
      setPwToolsCoreCurrentPage(page);

      const task = mod.pressKeyViaPlaywright({
        ...strictNavigationOptions(),
        key: "Enter",
        delayMs: Number.NaN,
      });

      await vi.advanceTimersByTimeAsync(250);
      await task;

      expect(press).toHaveBeenCalledWith("Enter", { delay: 0 });
    });
  });

  it("propagates blocked delayed submit navigation instead of reporting type success", async () => {
    await withFakeTimers(async () => {
      const navigation = createNavigationPage("https://example.com/form");
      const locator = {
        fill: vi.fn(async () => {}),
        press: vi.fn(async () => {
          setTimeout(() => {
            navigation.setUrl("http://127.0.0.1:9222/private-target");
            navigation.emitFrame();
          }, 10);
        }),
      };
      const { listeners, page } = navigation;
      installInteractionPage(page, locator);

      const blocked = new Error("blocked delayed interaction navigation");
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.typeViaPlaywright({
        ...strictNavigationOptions(),
        ref: "1",
        text: "hello",
        submit: true,
      });
      const rejection = expect(task).rejects.toThrow("blocked delayed interaction navigation");

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(listeners.size).toBe(0);
    });
  });

  it("runs the final committed-URL check when a click leaves the URL unchanged", async () => {
    const click = vi.fn(async () => {});
    const page = { url: vi.fn(() => "http://127.0.0.1:9222/json/version") };
    installInteractionPage(page, { click });

    await runWithVirtualNavigationGrace(() => strictClick());

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(page),
    );
  });

  it("runs the final committed-URL check after a same-document hash change", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: vi
        .fn()
        .mockReturnValueOnce("https://example.com/page")
        .mockReturnValue("https://example.com/page#section"),
    };
    installInteractionPage(page, { click });

    await runWithVirtualNavigationGrace(() => strictClick());

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(page),
    );
  });

  it("runs the navigation guard when a same-URL reload fires framenavigated during a click", async () => {
    // A page reload (form submit, location.reload()) keeps the URL identical but
    // fires framenavigated. Prior to the isHashOnlyNavigation fix, didCrossDocumentUrlChange
    // would treat currentUrl === previousUrl as "no navigation" and skip the SSRF guard.
    const sameUrl = "http://192.168.1.1/admin";
    const navigation = createNavigationPage(sameUrl);
    const click = vi.fn(async () => {
      // Simulate reload: URL stays the same but framenavigated fires during the click
      navigation.emitFrame();
    });
    const { page } = navigation;
    installInteractionPage(page, { click });

    await runWithVirtualNavigationGrace(() => strictClick());

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(page),
    );
  });

  it("installs the request guard before evaluate and runs the final committed-URL check", async () => {
    const page = {
      evaluate: vi.fn(async () => "ok"),
      url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await runWithVirtualNavigationGrace(() =>
      mod.evaluateViaPlaywright({
        ...strictNavigationOptions(),
        fn: "() => 1",
      }),
    );

    expect(result).toBe("ok");
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(page),
    );
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
    installInteractionPage(page, { click });

    await runWithVirtualNavigationGrace(() =>
      mod.batchViaPlaywright({
        ...strictNavigationOptions(),
        actions: [{ kind: "click", ref: "1" }],
      }),
    );

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(page),
    );
  });

  it("runs the post-evaluate navigation guard when evaluate rejects after triggering navigation", async () => {
    await withFakeTimers(async () => {
      const navigation = createNavigationPage("http://127.0.0.1:9222/json/version", {
        extras: {
          evaluate: vi.fn(async () => {
            setTimeout(() => {
              navigation.setUrl("http://127.0.0.1:9222/json/list");
              navigation.emitFrame();
            }, 0);
            throw new Error("evaluate failed after scheduling navigation");
          }),
        },
      });
      const { page } = navigation;
      installInteractionPage(page);

      const blocked = new Error("blocked interaction navigation");
      getPwToolsCoreSessionMocks()
        .assertPageNavigationCompletedSafely.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(blocked);

      const task = mod.evaluateViaPlaywright({
        ...strictNavigationOptions(),
        fn: "() => location.href = 'http://127.0.0.1:9222/json/list'",
      });
      const expectation = expect(task).rejects.toThrow("blocked interaction navigation");

      await vi.runAllTimersAsync();
      await expectation;

      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        completedNavigationExpectation(page),
      );
    });
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
    const dispose = mockDownloadCapture(drain);
    installInteractionPage(page, { click });

    const result = await runWithVirtualNavigationGrace(() =>
      mod.executeActViaPlaywright({
        ...strictNavigationOptions(),
        action: { kind: "click", ref: "1" },
      }),
    );

    expect(result.downloads).toEqual([
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ]);
    expect(drain).toHaveBeenCalledWith(NO_EXTRA_DOWNLOAD_GRACE);
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
    mockDownloadCapture(drain);
    installInteractionPage(page, locator);

    await runWithVirtualNavigationGrace(() =>
      mod.executeActViaPlaywright({
        ...strictNavigationOptions(),
        action,
      }),
    );

    expect(drain).toHaveBeenCalledWith(NO_EXTRA_DOWNLOAD_GRACE);
  });

  it("does not quarantine a source page preserved after policy denial", async () => {
    const page = { url: vi.fn(() => "about:blank") };
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    installInteractionPage(page, { hover: vi.fn(async () => {}) });
    getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockRejectedValueOnce(blocked);
    getPwToolsCoreSessionMocks()
      .wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockReturnValueOnce(true)
      .mockReturnValueOnce(true);

    await expect(
      mod.executeActViaPlaywright({
        ...strictNavigationOptions(),
        action: { kind: "hover", ref: "1" },
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
    const dispose = mockDownloadCapture(drain);
    installInteractionPage(page, {
      hover: vi.fn(() => {
        hoverStarted();
        return pendingHover;
      }),
    });

    const task = mod.executeActViaPlaywright({
      ...strictNavigationOptions(),
      action: { kind: "hover", ref: "1" },
      signal: ctrl.signal,
    });
    await started;
    ctrl.abort(new Error("aborted by test"));
    expect(drain).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    releaseHover();
    await expect(task).rejects.toThrow("aborted by test");
    expect(drain).toHaveBeenCalledWith(DOWNLOAD_GRACE);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("retains the download grace when an executable wait aborts", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("aborted by test"));
    const page = {
      url: vi.fn(() => "https://example.com"),
      waitForFunction: vi.fn(async () => {}),
    };
    const drain = vi.fn(async () => undefined);
    const dispose = mockDownloadCapture(drain);
    setPwToolsCoreCurrentPage(page);

    const task = mod.executeActViaPlaywright({
      ...strictNavigationOptions(),
      action: { kind: "wait", fn: "() => false" },
      evaluateEnabled: true,
      signal: ctrl.signal,
    });

    await expect(task).rejects.toThrow("aborted by test");
    expect(drain).toHaveBeenCalledWith(DOWNLOAD_GRACE);
    expect(dispose).toHaveBeenCalledOnce();
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("does not add a second download grace after a settled guarded failure", async () => {
    await withFakeTimers(async () => {
      const page = { url: vi.fn(() => "https://example.com") };
      const drain = vi.fn(async () => undefined);
      mockDownloadCapture(drain);
      installInteractionPage(page, {
        hover: vi.fn(async () => {
          throw new Error("locator failed");
        }),
      });

      const task = mod.executeActViaPlaywright({
        ...strictNavigationOptions(),
        action: { kind: "hover", ref: "1" },
      });
      const expectation = expect(task).rejects.toThrow("locator failed");
      await vi.runAllTimersAsync();
      await expectation;

      expect(drain).toHaveBeenCalledWith(NO_EXTRA_DOWNLOAD_GRACE);
    });
  });

  it("blocks a private final URL after an earlier safe navigation", async () => {
    await withFakeTimers(async () => {
      let currentUrl = "https://example.com";
      const blocked = new Error("final browser URL blocked by policy");
      blocked.name = "SsrFBlockedError";
      const page = { url: vi.fn(() => currentUrl) };
      installInteractionPage(page, {
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
        ...strictNavigationOptions(),
        action: { kind: "hover", ref: "1" },
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
    });
  });

  it("stops a permissive batch and quarantines when source preservation fails", async () => {
    const page = { url: vi.fn(() => "about:blank") };
    const hover = vi.fn(async () => {});
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    installInteractionPage(page, { hover });
    getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockRejectedValueOnce(blocked);

    await expect(
      mod.executeActViaPlaywright({
        ...strictNavigationOptions(),
        action: {
          kind: "batch",
          stopOnError: false,
          actions: [
            { kind: "hover", ref: "1" },
            { kind: "hover", ref: "1" },
          ],
        },
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
    const dispose = mockDownloadCapture(
      vi.fn(async () => {
        throw blocked;
      }),
    );
    installInteractionPage(page, { click });

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
    const dispose = mockDownloadCapture(drain);
    setPwToolsCoreCurrentPage(page);

    const result = await mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action: { kind: "press", key: "Enter" },
    });

    expect(result.downloads).toEqual([
      expect.objectContaining({ suggestedFilename: "report.pdf" }),
    ]);
    expect(drain).toHaveBeenCalledWith(DOWNLOAD_GRACE);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
