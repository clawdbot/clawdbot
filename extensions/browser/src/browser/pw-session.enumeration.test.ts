import { EventEmitter, getEventListeners } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  type BrowserMockBundle,
  setupPwSessionConnectionTest,
} from "./pw-session.connection.test-support.js";

const { connectOverCdpSpy, getChromeWebSocketUrlSpy, markPageRefBlocked, markTargetBlocked, pwAi } =
  setupPwSessionConnectionTest();

const {
  closePageByTargetIdViaPlaywright,
  focusPageByTargetIdViaPlaywright,
  listPagesViaPlaywright,
} = pwAi;

function makePageEnumerationBrowser(
  specs: Array<{
    targetId: string;
    title: string;
    url: string;
    readTitle?: () => Promise<string>;
    readTargetInfo?: () => Promise<{ targetInfo: { targetId: string; title: string } }>;
    detach?: () => Promise<void>;
  }>,
): BrowserMockBundle & {
  pages: import("playwright-core").Page[];
  newCDPSession: ReturnType<typeof vi.fn>;
  contextEvents: EventEmitter;
  browserEvents: EventEmitter;
} {
  const browserClose = vi.fn(async () => {});
  const specByPage = new WeakMap<import("playwright-core").Page, (typeof specs)[number]>();
  const pages = specs.map((spec) => {
    const page = {
      on: vi.fn(),
      context: () => context,
      title: vi.fn(spec.readTitle ?? (async () => spec.title)),
      url: vi.fn(() => spec.url),
    } as unknown as import("playwright-core").Page;
    specByPage.set(page, spec);
    return page;
  });
  const newCDPSession = vi.fn(async (page: import("playwright-core").Page) => {
    const spec = specByPage.get(page);
    if (!spec) {
      throw new Error("unexpected page");
    }
    return {
      send: vi.fn(async (method: string) => {
        if (method !== "Target.getTargetInfo") {
          return {};
        }
        return await (spec.readTargetInfo?.() ??
          Promise.resolve({ targetInfo: { targetId: spec.targetId, title: spec.title } }));
      }),
      detach: vi.fn(spec.detach ?? (async () => {})),
    };
  });
  const contextEvents = new EventEmitter();
  const browserEvents = new EventEmitter();
  const context = {
    pages: () => pages,
    on: contextEvents.on.bind(contextEvents),
    off: contextEvents.off.bind(contextEvents),
    newCDPSession,
  } as unknown as import("playwright-core").BrowserContext;
  const browser = {
    contexts: () => [context],
    on: browserEvents.on.bind(browserEvents),
    off: browserEvents.off.bind(browserEvents),
    close: browserClose,
    newBrowserCDPSession: vi.fn(async () => ({
      send: vi.fn(async () => ({
        targetInfos: specs.map((spec) => ({ targetId: spec.targetId, type: "page" })),
      })),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose, pages, newCDPSession, contextEvents, browserEvents };
}

describe("pw-session page enumeration", () => {
  it("lists healthy pages without awaiting a wedged page title", async () => {
    vi.useFakeTimers();
    const fixture = makePageEnumerationBrowser([
      {
        targetId: "WEDGED",
        title: "Wedged",
        url: "https://wedged.example",
        readTitle: () => new Promise<string>(() => {}),
      },
      {
        targetId: "HEALTHY",
        title: "Healthy title",
        url: "https://healthy.example",
      },
    ]);
    connectOverCdpSpy.mockResolvedValue(fixture.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    let listed: Awaited<ReturnType<typeof listPagesViaPlaywright>> | undefined;
    void listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" }).then((pages) => {
      listed = pages;
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(listed).toEqual([
      {
        targetId: "WEDGED",
        title: "Wedged",
        url: "https://wedged.example",
        type: "page",
      },
      {
        targetId: "HEALTHY",
        title: "Healthy title",
        url: "https://healthy.example",
        type: "page",
      },
    ]);
  });

  it("times out stuck target-info reads in one window and shares them across enumerations", async () => {
    vi.useFakeTimers();
    const fixture = makePageEnumerationBrowser([
      {
        targetId: "STUCK_A",
        title: "Stuck A",
        url: "https://stuck-a.example",
        readTargetInfo: () => new Promise(() => {}),
        detach: () => new Promise(() => {}),
      },
      {
        targetId: "STUCK_B",
        title: "Stuck B",
        url: "https://stuck-b.example",
        readTargetInfo: () => new Promise(() => {}),
        detach: () => new Promise(() => {}),
      },
      {
        targetId: "HEALTHY",
        title: "Healthy title",
        url: "https://healthy.example",
      },
    ]);
    connectOverCdpSpy.mockResolvedValue(fixture.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    let listed: Array<Awaited<ReturnType<typeof listPagesViaPlaywright>>> | undefined;
    void Promise.all([
      listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" }),
      listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" }),
    ]).then((pages) => {
      listed = pages;
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(listed).toEqual([
      [
        {
          targetId: "HEALTHY",
          title: "Healthy title",
          url: "https://healthy.example",
          type: "page",
        },
      ],
      [
        {
          targetId: "HEALTHY",
          title: "Healthy title",
          url: "https://healthy.example",
          type: "page",
        },
      ],
    ]);
    expect(
      fixture.pages
        .slice(0, 2)
        .map(
          (page) =>
            fixture.newCDPSession.mock.calls.filter(([candidate]) => candidate === page).length,
        ),
    ).toEqual([1, 1]);
  });

  it("reports unavailable when every accessible page identity is unresolved", async () => {
    vi.useFakeTimers();
    const fixture = makePageEnumerationBrowser([
      {
        targetId: "STUCK_A",
        title: "Stuck A",
        url: "https://stuck-a.example",
        readTargetInfo: () => new Promise(() => {}),
      },
      {
        targetId: "STUCK_B",
        title: "Stuck B",
        url: "https://stuck-b.example",
        readTargetInfo: () => new Promise(() => {}),
      },
    ]);
    connectOverCdpSpy.mockResolvedValue(fixture.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const listing = listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    const unavailable = expect(listing).rejects.toThrow(/target identities.*unavailable/i);
    await vi.advanceTimersByTimeAsync(2_000);

    await unavailable;
  });

  it.each(["during discovery", "after discovery", "during metadata"] as const)(
    "observes pages published %s without repeating the complete target inventory",
    async (timing) => {
      const cdpUrl = "http://127.0.0.1:9222";
      const metadataRead = createDeferred<void>();
      const releaseMetadata = createDeferred<void>();
      const fixture = makePageEnumerationBrowser([
        {
          targetId: "EXISTING",
          title: "Existing",
          url: "https://existing.example",
          readTargetInfo: async () => {
            metadataRead.resolve();
            if (timing === "during metadata") {
              await releaseMetadata.promise;
            }
            return { targetInfo: { targetId: "EXISTING", title: "Existing" } };
          },
        },
        {
          targetId: "RECOVERED",
          title: "Recovered",
          url: "https://recovered.example",
        },
      ]);
      let published = false;
      const context = fixture.browser.contexts()[0]!;
      vi.spyOn(context, "pages").mockImplementation(() =>
        published ? fixture.pages : fixture.pages.slice(0, 1),
      );
      const publish = () => {
        published = true;
        fixture.contextEvents.emit("page", fixture.pages[1]);
      };
      const inventoryRead = vi.fn(async () => {
        if (timing === "during discovery") {
          publish();
        }
        return {
          targetInfos: [
            { targetId: "EXISTING", type: "page" },
            { targetId: "RECOVERED", type: "page", title: "native title" },
          ],
        };
      });
      Object.assign(fixture.browser, {
        newBrowserCDPSession: vi.fn(async () => ({
          send: inventoryRead,
          detach: vi.fn(async () => {}),
        })),
      });
      connectOverCdpSpy.mockResolvedValue(fixture.browser);
      getChromeWebSocketUrlSpy.mockResolvedValue(null);

      const listing = listPagesViaPlaywright({ cdpUrl, requireCompleteTargetList: true });
      const listed = expect(listing).resolves.toEqual([
        {
          targetId: "EXISTING",
          title: "Existing",
          url: "https://existing.example",
          type: "page",
        },
        {
          targetId: "RECOVERED",
          title: "Recovered",
          url: "https://recovered.example",
          type: "page",
        },
      ]);
      void listed.catch(() => {});
      await metadataRead.promise;
      if (timing === "after discovery") {
        // Let the first page read finish before the recovered Page exists.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      if (timing !== "during discovery") {
        publish();
        releaseMetadata.resolve();
      }
      await listed;
      expect(inventoryRead).toHaveBeenCalledOnce();
      expect(connectOverCdpSpy).toHaveBeenCalledOnce();
      expect(fixture.browserClose).not.toHaveBeenCalled();
      expect(fixture.contextEvents.listenerCount("page")).toBe(1);
      expect(fixture.browserEvents.listenerCount("disconnected")).toBe(1);
    },
  );

  it("rejects an unavailable complete target enumeration even with zero cached pages", async () => {
    const fixture = makePageEnumerationBrowser([]);
    const detach = vi.fn(async () => {});
    const browser = Object.assign(fixture.browser, {
      newBrowserCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => {
          throw new Error("Target identities are unavailable");
        }),
        detach,
      })),
    });
    connectOverCdpSpy.mockResolvedValue(browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await expect(
      listPagesViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        requireCompleteTargetList: true,
      }),
    ).rejects.toThrow(/target identities.*unavailable/i);
    expect(detach).toHaveBeenCalledOnce();
  });

  it.each<{
    name: string;
    nativeIds: string[];
    pageIds: string[];
    unresolvedId?: string;
    rejectedId?: string;
    blockedId?: string;
    blockedPageId?: string;
    complete?: boolean;
    waitsForPublication?: boolean;
    expected: string[] | null;
  }>([
    {
      name: "native page not yet published",
      nativeIds: ["A", "B"],
      pageIds: ["A"],
      waitsForPublication: true,
      expected: null,
    },
    {
      name: "no published pages yet",
      nativeIds: ["A"],
      pageIds: [],
      waitsForPublication: true,
      expected: null,
    },
    {
      name: "unresolved page metadata",
      nativeIds: ["A", "B"],
      pageIds: ["A", "B"],
      unresolvedId: "B",
      expected: null,
    },
    {
      name: "rejected page metadata",
      nativeIds: ["A", "B"],
      pageIds: ["A", "B"],
      rejectedId: "B",
      expected: null,
    },
    {
      name: "unresolved extra page",
      nativeIds: ["A"],
      pageIds: ["A", "B"],
      unresolvedId: "B",
      expected: null,
    },
    {
      name: "equal counts with different identities",
      nativeIds: ["A", "B"],
      pageIds: ["A", "STALE"],
      waitsForPublication: true,
      expected: null,
    },
    {
      name: "native removal before page removal",
      nativeIds: ["A"],
      pageIds: ["A", "STALE"],
      expected: ["A"],
    },
    { name: "last native page removed", nativeIds: [], pageIds: ["STALE"], expected: [] },
    {
      name: "all pages projected in page order",
      nativeIds: ["B", "A"],
      pageIds: ["A", "B"],
      expected: ["A", "B"],
    },
    {
      name: "known blocked target without a page",
      nativeIds: ["A", "B"],
      pageIds: ["A"],
      blockedId: "B",
      expected: ["A"],
    },
    {
      name: "known blocked target with a page",
      nativeIds: ["A", "B"],
      pageIds: ["A", "B"],
      blockedId: "B",
      expected: ["A"],
    },
    {
      name: "known blocked page and target",
      nativeIds: ["A", "B"],
      pageIds: ["A", "B"],
      blockedId: "B",
      blockedPageId: "B",
      expected: ["A"],
    },
    {
      name: "blocked page cannot identify missing native target",
      nativeIds: ["A", "B"],
      pageIds: ["A", "B"],
      blockedPageId: "B",
      unresolvedId: "B",
      waitsForPublication: true,
      expected: null,
    },
    {
      name: "blocked page after native removal",
      nativeIds: ["A"],
      pageIds: ["A", "B"],
      blockedPageId: "B",
      expected: ["A"],
    },
    {
      name: "general read keeps a healthy subset",
      nativeIds: ["A", "B"],
      pageIds: ["A", "B"],
      unresolvedId: "B",
      complete: false,
      expected: ["A"],
    },
    {
      name: "general read ignores native inventory",
      nativeIds: [],
      pageIds: ["A"],
      complete: false,
      expected: ["A"],
    },
  ])("enforces enumeration completeness: $name", async (testCase) => {
    vi.useFakeTimers();
    const cdpUrl = "http://127.0.0.1:9222";
    const fixture = makePageEnumerationBrowser(
      testCase.pageIds.map((targetId) => ({
        targetId,
        title: `projected:${targetId}`,
        url: "https://same.example/",
        readTargetInfo: async () => {
          if (targetId === testCase.rejectedId) {
            throw new Error("Target metadata unavailable");
          }
          return {
            targetInfo: {
              targetId: targetId === testCase.unresolvedId ? "" : targetId,
              title: `projected:${targetId}`,
            },
          };
        },
      })),
    );
    const inventoryRead = vi.fn(async () => ({
      targetInfos: [
        ...testCase.nativeIds.map((targetId) => ({
          targetId,
          type: "page",
          title: "native title",
          url: "https://native.example/",
        })),
        { targetId: "WORKER", type: "service_worker" },
      ],
    }));
    const detach = vi.fn(async () => {});
    Object.assign(fixture.browser, {
      newBrowserCDPSession: vi.fn(async () => ({ send: inventoryRead, detach })),
    });
    connectOverCdpSpy.mockResolvedValue(fixture.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    if (testCase.blockedId) {
      markTargetBlocked(cdpUrl, testCase.blockedId);
    }
    const blockedPage = fixture.pages.find(
      (_, index) => testCase.pageIds[index] === testCase.blockedPageId,
    );
    if (blockedPage) {
      markPageRefBlocked(cdpUrl, blockedPage);
    }

    const requireCompleteTargetList = testCase.complete ?? true;
    const listing = listPagesViaPlaywright({ cdpUrl, requireCompleteTargetList, timeoutMs: 100 });
    if (testCase.expected === null) {
      const rejected = expect(listing).rejects.toThrow(
        testCase.waitsForPublication
          ? "Playwright page enumeration timed out after 100ms"
          : /target identities.*unavailable/i,
      );
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } else {
      await expect(listing).resolves.toEqual(
        testCase.expected.map((targetId) => ({
          targetId,
          title: `projected:${targetId}`,
          url: "https://same.example/",
          type: "page",
        })),
      );
    }
    expect(inventoryRead).toHaveBeenCalledTimes(requireCompleteTargetList ? 1 : 0);
    expect(detach).toHaveBeenCalledTimes(requireCompleteTargetList ? 1 : 0);
    expect(connectOverCdpSpy).toHaveBeenCalledOnce();
    expect(fixture.browserClose).toHaveBeenCalledTimes(testCase.waitsForPublication ? 1 : 0);
    expect(fixture.contextEvents.listenerCount("page")).toBe(1);
    expect(fixture.browserEvents.listenerCount("disconnected")).toBe(
      testCase.waitsForPublication ? 0 : 1,
    );
    if (blockedPage) {
      expect(fixture.newCDPSession).not.toHaveBeenCalledWith(blockedPage);
    }
  });

  it.each(["abort", "disconnect"] as const)("releases a publication wait on %s", async (stop) => {
    const specs = [{ targetId: "A", title: "A", url: "https://a.example/" }];
    const fixture = makePageEnumerationBrowser(specs);
    const context = fixture.browser.contexts()[0]!;
    vi.spyOn(context, "pages").mockReturnValue([]);
    const inventoryRead = createDeferred<void>();
    Object.assign(fixture.browser, {
      newBrowserCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => {
          inventoryRead.resolve();
          return { targetInfos: [{ targetId: "A", type: "page" }] };
        }),
        detach: vi.fn(async () => {}),
      })),
    });
    const successor = makePageEnumerationBrowser(specs);
    connectOverCdpSpy.mockResolvedValueOnce(fixture.browser).mockResolvedValue(successor.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    const controller = new AbortController();
    const listing = listPagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      requireCompleteTargetList: true,
      signal: controller.signal,
    });
    const result =
      stop === "abort"
        ? expect(listing).rejects.toThrow("cancelled publication")
        : expect(listing).resolves.toEqual([{ ...specs[0], type: "page" }]);
    void result.catch(() => {});
    await inventoryRead.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    if (stop === "abort") {
      controller.abort(new Error("cancelled publication"));
    } else {
      fixture.browserEvents.emit("disconnected");
    }
    await result;
    fixture.contextEvents.emit("page", fixture.pages[0]);
    expect(fixture.newCDPSession).not.toHaveBeenCalled();
    expect(fixture.contextEvents.listenerCount("page")).toBe(1);
    expect(fixture.browserEvents.listenerCount("disconnected")).toBe(stop === "abort" ? 0 : 1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(stop === "abort" ? 1 : 2);
    expect(successor.browserClose).not.toHaveBeenCalled();
  });

  it("aborts enumeration without a timeout and retires its connection", async () => {
    const fixture = makePageEnumerationBrowser([
      {
        targetId: "T1",
        title: "Tab 1",
        url: "https://example.com",
        readTargetInfo: () => new Promise(() => {}),
      },
    ]);
    connectOverCdpSpy.mockResolvedValue(fixture.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const controller = new AbortController();
    const listing = listPagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled enumeration"));

    await expect(listing).rejects.toThrow("cancelled enumeration");
    await vi.waitFor(() => expect(fixture.browserClose).toHaveBeenCalledOnce());
  });

  it.each([
    ["focus", focusPageByTargetIdViaPlaywright, "bringToFront"],
    ["close", closePageByTargetIdViaPlaywright, "close"],
  ] as const)(
    "does not %s after cancellation during target resolution",
    async (_name, run, method) => {
      let releaseTargetInfo: (() => void) | undefined;
      let markTargetInfoStarted: (() => void) | undefined;
      const targetInfoStarted = new Promise<void>((resolve) => {
        markTargetInfoStarted = resolve;
      });
      const targetInfoReleased = new Promise<void>((resolve) => {
        releaseTargetInfo = resolve;
      });
      const fixture = makePageEnumerationBrowser([
        {
          targetId: "T1",
          title: "Tab 1",
          url: "https://example.com",
          readTargetInfo: async () => {
            markTargetInfoStarted?.();
            await targetInfoReleased;
            return { targetInfo: { targetId: "T1", title: "Tab 1" } };
          },
        },
      ]);
      const finalIo = vi.fn(async () => {});
      Object.assign(fixture.pages[0]!, { [method]: finalIo });
      connectOverCdpSpy.mockResolvedValue(fixture.browser);
      getChromeWebSocketUrlSpy.mockResolvedValue(null);

      const controller = new AbortController();
      const operation = run({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "T1",
        signal: controller.signal,
      });
      await targetInfoStarted;
      controller.abort(new Error("cancelled target resolution"));
      releaseTargetInfo?.();

      await expect(operation).rejects.toThrow("cancelled target resolution");
      expect(finalIo).not.toHaveBeenCalled();
    },
  );
});
