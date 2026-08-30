import { describe, expect, it, vi } from "vitest";
import {
  type BrowserMockBundle,
  makeEmptyBrowser,
  setupPwSessionConnectionTest,
} from "./pw-session.connection.test-support.js";

const { connectOverCdpSpy, getChromeWebSocketUrlSpy, markPageRefBlocked, markTargetBlocked, pwAi } =
  setupPwSessionConnectionTest();

const { listPagesViaPlaywright } = pwAi;

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
  const context = {
    pages: () => pages,
    on: vi.fn(),
    newCDPSession,
  } as unknown as import("playwright-core").BrowserContext;
  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose, pages, newCDPSession };
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

  it("rejects an unavailable complete target enumeration even with zero cached pages", async () => {
    const fixture = makeEmptyBrowser();
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
    expected: string[] | null;
  }>([
    {
      name: "native page not yet published",
      nativeIds: ["A", "B"],
      pageIds: ["A"],
      expected: null,
    },
    { name: "no published pages yet", nativeIds: ["A"], pageIds: [], expected: null },
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
    const listing = listPagesViaPlaywright({ cdpUrl, requireCompleteTargetList });
    if (testCase.expected === null) {
      await expect(listing).rejects.toThrow(/target identities.*unavailable/i);
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
    expect(fixture.browserClose).not.toHaveBeenCalled();
    if (blockedPage) {
      expect(fixture.newCDPSession).not.toHaveBeenCalledWith(blockedPage);
    }
  });
});
