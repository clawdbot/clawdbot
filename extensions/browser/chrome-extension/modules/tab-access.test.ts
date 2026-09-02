import { describe, expect, it, vi } from "vitest";
import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";
import { createTabAccessPolicy } from "./tab-access.js";
import { tabEligibility } from "./tab-eligibility.js";

function storageArea(seed: Record<string, unknown> = {}) {
  const values = { ...seed };
  return {
    values,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(
        keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]),
      ),
    ),
    set: vi.fn(async (next: Record<string, unknown>) => {
      Object.assign(values, next);
    }),
    remove: vi.fn(async (keys: string[]) => {
      for (const key of keys) {
        delete values[key];
      }
    }),
  };
}

function createHarness({
  tabs,
  denied = [],
}: {
  tabs: Array<{
    id: number;
    url?: string;
    pendingUrl?: string;
    groupId?: number;
    incognito?: boolean;
    [key: string]: unknown;
  }>;
  denied?: unknown[];
}) {
  const session = storageArea({ deniedTabIdsV1: denied });
  const current = new Map(tabs.map((tab) => [tab.id, tab]));
  const chromeApi = {
    storage: { session },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = current.get(tabId);
        if (!tab) {
          throw new Error(`No tab with id: ${tabId}`);
        }
        return tab;
      }),
      query: vi.fn(async () => [...current.values()]),
    },
  };
  const policy = createTabAccessPolicy({
    chromeApi,
    isSelectedTab: async (tab) => tab.groupId === 7,
  });
  return { chromeApi, current, policy, session };
}

describe("tab eligibility", () => {
  it.each([
    "http://example.com",
    "https://example.com/path",
    "data:text/html,<title>fixture</title>",
    "blob:https://example.com/1234",
    "file:///tmp/openclaw-fixture.html",
  ])("allows ordinary document URL %s", (url) => {
    expect(tabEligibility({ id: 1, url, incognito: false }).eligible).toBe(true);
  });

  it("rejects file documents when Chrome has not granted file URL access", () => {
    expect(
      tabEligibility({ id: 1, url: "file:///tmp/private.html" }, { fileAccessAllowed: false }),
    ).toEqual({
      eligible: false,
      reason: "restricted",
    });
  });

  it.each([
    "chrome://settings",
    "chrome-extension://abcdefghijklmnop/popup.html",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.com",
    "about:settings",
    "about:blank",
    "about:blank#ready",
    "blob:chrome-extension://abcdefghijklmnop/private",
    "blob:null/private",
  ])("rejects restricted URL %s", (url) => {
    expect(tabEligibility({ id: 1, url })).toEqual({ eligible: false, reason: "restricted" });
  });

  it("rejects missing ids, missing URLs, malformed URLs, and incognito tabs", () => {
    expect(tabEligibility({ url: "https://example.com" })).toEqual({
      eligible: false,
      reason: "missing",
    });
    expect(tabEligibility({ id: 1 })).toEqual({ eligible: false, reason: "missing" });
    expect(tabEligibility({ id: 1, url: "not a URL" })).toEqual({
      eligible: false,
      reason: "restricted",
    });
    expect(tabEligibility({ id: 1, url: "https://example.com", incognito: true })).toEqual({
      eligible: false,
      reason: "incognito",
    });
  });

  it("treats a pending destination as an additional eligibility restriction", () => {
    expect(
      tabEligibility({
        id: 1,
        url: "https://example.com/ordinary",
        pendingUrl: "chrome://settings",
      }),
    ).toEqual({ eligible: false, reason: "restricted" });
    expect(tabEligibility({ id: 1, pendingUrl: "https://example.com/pending" })).toEqual({
      eligible: true,
      reason: null,
    });
    expect(
      tabEligibility({
        id: 1,
        url: "chrome://settings",
        pendingUrl: "https://example.com/pending",
      }),
    ).toEqual({ eligible: false, reason: "restricted" });
    expect(
      tabEligibility({
        id: 1,
        url: "https://example.com/stale",
        pendingUrl: "not a URL",
      }),
    ).toEqual({ eligible: false, reason: "restricted" });
    expect(
      tabEligibility(
        {
          id: 1,
          url: "file:///tmp/private.html",
          pendingUrl: "https://example.com/pending",
        },
        { fileAccessAllowed: false },
      ),
    ).toEqual({ eligible: false, reason: "restricted" });
  });
});

describe("tab access policy", () => {
  it("allows ungrouped eligible tabs in all mode and only grouped tabs in selected mode", async () => {
    const harness = createHarness({
      tabs: [
        { id: 1, url: "https://one.example", groupId: -1 },
        { id: 2, url: "https://two.example", groupId: 7 },
      ],
    });
    await harness.policy.initialize("all", true);
    await expect(harness.policy.requireTab(1)).resolves.toMatchObject({ id: 1 });
    expect((await harness.policy.listAccessibleTabs()).map((tab) => tab.id)).toEqual([1, 2]);

    harness.policy.setMode("selected");
    await expect(harness.policy.requireTab(1)).rejects.toThrow("not in the OpenClaw tab group");
    await expect(harness.policy.requireTab(2)).resolves.toMatchObject({ id: 2 });
  });

  it("rejects restricted and incognito tabs in both modes", async () => {
    const harness = createHarness({
      tabs: [
        { id: 1, url: "chrome://settings", groupId: 7 },
        { id: 2, url: "https://secret.example", incognito: true, groupId: 7 },
      ],
    });
    await harness.policy.initialize("all", true);
    await expect(harness.policy.requireTab(1)).rejects.toThrow("restricted or unavailable");
    await expect(harness.policy.requireTab(2)).rejects.toThrow("incognito");
    harness.policy.setMode("selected");
    await expect(harness.policy.requireTab(1)).rejects.toThrow("restricted or unavailable");
    await expect(harness.policy.requireTab(2)).rejects.toThrow("incognito");
  });

  it("invalidates captured authority across mode and per-tab deny changes", async () => {
    const harness = createHarness({
      tabs: [{ id: 1, url: "https://one.example", groupId: -1 }],
    });
    await harness.policy.initialize("all", true);
    const beforeMode = harness.policy.capture(1);
    harness.policy.setMode("selected");
    await expect(harness.policy.requireTab(1, beforeMode)).rejects.toThrow("access was revoked");

    harness.policy.setMode("all");
    const beforePause = harness.policy.capture(1);
    await harness.policy.pause(1);
    await expect(harness.policy.requireTab(1, beforePause)).rejects.toThrow("access was revoked");
    await expect(harness.policy.requireTab(1)).rejects.toThrow("paused for OpenClaw");
  });

  it("blocks new authority before the asynchronous pause lookup completes", async () => {
    const harness = createHarness({
      tabs: [{ id: 1, url: "https://one.example", groupId: -1 }],
    });
    await harness.policy.initialize("all", true);
    let releaseLookup = () => {};
    harness.chromeApi.tabs.get.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          releaseLookup = () => resolve({ id: 1, url: "https://one.example", groupId: -1 });
        }),
    );

    const pausing = harness.policy.pause(1);
    expect(harness.policy.isDenied(1)).toBe(true);
    await expect(harness.policy.requireTab(1)).rejects.toThrow("paused for OpenClaw");
    releaseLookup();
    await expect(pausing).resolves.toBeUndefined();
  });

  it("blocks newly arriving authority throughout a mode transition", async () => {
    const harness = createHarness({
      tabs: [{ id: 1, url: "https://one.example", groupId: -1 }],
    });
    await harness.policy.initialize("all", true);
    harness.policy.beginTransition();
    await expect(harness.policy.requireTab(1)).rejects.toThrow("access was revoked");
    await expect(harness.policy.listAccessibleTabs()).resolves.toEqual([]);
    harness.policy.setMode("selected");
    harness.policy.endTransition();
    await expect(harness.policy.requireTab(1)).rejects.toThrow("not in the OpenClaw tab group");
  });

  it("scopes revocation barriers to one tab while keeping captured authority fail closed", async () => {
    const harness = createHarness({
      tabs: [
        { id: 1, url: "https://one.example", groupId: -1 },
        { id: 2, url: "https://two.example", groupId: -1 },
      ],
    });
    await harness.policy.initialize("all", true);
    const tabOneEpoch = harness.policy.capture(1);
    const tabTwoEpoch = harness.policy.capture(2);
    expect(harness.policy.epochIsCurrent(1, tabOneEpoch)).toBe(true);
    expect(harness.policy.epochIsCurrent(2, tabTwoEpoch)).toBe(true);

    harness.policy.setEnabled(false);
    expect(harness.policy.epochIsCurrent(1, harness.policy.capture(1))).toBe(false);

    harness.policy.setEnabled(true);
    harness.policy.beginTransition();
    expect(harness.policy.epochIsCurrent(1, harness.policy.capture(1))).toBe(false);
    harness.policy.endTransition();
    expect(harness.policy.epochIsCurrent(1, harness.policy.capture(1))).toBe(true);

    const tabTwoRevocationEpoch = harness.policy.capture(2);
    const revocation = harness.policy.beginRevocation(1);
    const duringRevocation = harness.policy.capture(1);
    expect(harness.policy.epochIsCurrent(1, duringRevocation)).toBe(false);
    expect(harness.policy.epochIsCurrent(2, tabTwoRevocationEpoch)).toBe(true);
    await expect(harness.policy.listAccessibleTabs()).resolves.toEqual([
      expect.objectContaining({ id: 2 }),
    ]);
    harness.policy.endRevocation(revocation);
    expect(harness.policy.epochIsCurrent(1, duringRevocation)).toBe(false);
    expect(harness.policy.epochIsCurrent(1, harness.policy.capture(1))).toBe(true);
    expect(harness.policy.epochIsCurrent(2, tabTwoRevocationEpoch)).toBe(true);
  });

  it("fails closed when selected-mode membership changes during an async policy check", async () => {
    const harness = createHarness({
      tabs: [{ id: 1, url: "https://one.example", groupId: 7 }],
    });
    await harness.policy.initialize("selected", true);
    harness.chromeApi.tabs.get
      .mockResolvedValueOnce({ id: 1, url: "https://one.example", groupId: 7 })
      .mockResolvedValueOnce({ id: 1, url: "https://one.example", groupId: -1 });
    await expect(harness.policy.requireTab(1)).rejects.toThrow("access was revoked");
  });

  it("revalidates selected group authority when the group title changes in place", async () => {
    const harness = createHarness({
      tabs: [{ id: 1, url: "https://one.example", groupId: 7 }],
    });
    const isSelectedTab = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const policy = createTabAccessPolicy({
      chromeApi: harness.chromeApi,
      isSelectedTab,
    });
    await policy.initialize("selected", true);

    await expect(policy.requireTab(1)).rejects.toThrow("access was revoked");
    expect(isSelectedTab).toHaveBeenCalledTimes(2);
  });

  it("restarts an in-flight discovery when an OpenClaw group becomes eligible", async () => {
    const harness = createHarness({
      tabs: [{ id: 1, url: "https://one.example", groupId: 7 }],
    });
    let releaseFirst = (_selected: boolean) => {};
    const firstSelection = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const isSelectedTab = vi
      .fn()
      .mockImplementationOnce(async () => await firstSelection)
      .mockResolvedValue(true);
    const policy = createTabAccessPolicy({ chromeApi: harness.chromeApi, isSelectedTab });
    await policy.initialize("selected", true);

    const listing = policy.listAccessibleTabs();
    await vi.waitFor(() => expect(isSelectedTab).toHaveBeenCalledOnce());
    policy.invalidateGroup({ id: 7, title: OPENCLAW_TAB_GROUP_TITLE });
    releaseFirst(false);

    await expect(listing).resolves.toEqual([{ id: 1, url: "https://one.example", groupId: 7 }]);
    expect(isSelectedTab).toHaveBeenCalledTimes(2);
  });

  it("rejects an epoch revoked during the final selected-group lookup", async () => {
    const harness = createHarness({
      tabs: [{ id: 1, url: "https://one.example", groupId: 7 }],
    });
    let releaseFinalLookup = () => {};
    const finalLookup = new Promise<boolean>((resolve) => {
      releaseFinalLookup = () => resolve(true);
    });
    const isSelectedTab = vi.fn().mockResolvedValueOnce(true).mockReturnValueOnce(finalLookup);
    const policy = createTabAccessPolicy({
      chromeApi: harness.chromeApi,
      isSelectedTab,
    });
    await policy.initialize("selected", true);

    const requiring = policy.requireTab(1);
    await vi.waitFor(() => expect(isSelectedTab).toHaveBeenCalledTimes(2));
    policy.invalidateTab(1);
    releaseFinalLookup();

    await expect(requiring).rejects.toThrow("access was revoked");
  });

  it("revokes selected authority when a pending navigation appears between reads", async () => {
    const harness = createHarness({
      tabs: [{ id: 1, url: "https://one.example", groupId: 7 }],
    });
    await harness.policy.initialize("selected", true);
    harness.chromeApi.tabs.get
      .mockResolvedValueOnce({ id: 1, url: "https://one.example", groupId: 7 })
      .mockResolvedValueOnce({
        id: 1,
        url: "https://one.example",
        pendingUrl: "https://two.example",
        groupId: 7,
      });

    await expect(harness.policy.requireTab(1)).rejects.toThrow("access was revoked");
  });

  it("restores existing-tab session denies across worker instances and prunes closed ids", async () => {
    const harness = createHarness({
      tabs: [
        { id: 1, url: "https://one.example" },
        { id: 2, url: "chrome://settings" },
      ],
      denied: [1, 1, 2, -1, 999, "1"],
    });
    await harness.policy.initialize("all", true);
    expect(harness.session.values.deniedTabIdsV1).toEqual([1, 2]);
    await expect(harness.policy.requireTab(1)).rejects.toThrow("paused for OpenClaw");
    harness.current.set(2, { id: 2, url: "https://two.example" });
    await expect(harness.policy.requireTab(2)).rejects.toThrow("paused for OpenClaw");

    const reloaded = createTabAccessPolicy({
      chromeApi: harness.chromeApi,
      isSelectedTab: async () => false,
    });
    await reloaded.initialize("all", true);
    await expect(reloaded.requireTab(1)).rejects.toThrow("paused for OpenClaw");
    await reloaded.allow(1);
    await expect(reloaded.requireTab(1)).resolves.toMatchObject({ id: 1 });
    expect(harness.session.values.deniedTabIdsV1).toEqual([2]);
    await reloaded.allow(2);
    expect(harness.session.values).not.toHaveProperty("deniedTabIdsV1");
  });

  it("prunes a denied id when its tab closes", async () => {
    const harness = createHarness({
      tabs: [{ id: 1, url: "https://one.example" }],
      denied: [1],
    });
    await harness.policy.initialize("all", true);
    harness.current.delete(1);
    await harness.policy.forgetTab(1);
    expect(harness.session.values).not.toHaveProperty("deniedTabIdsV1");
  });

  it("moves a pause to Chrome's replacement tab id", async () => {
    const harness = createHarness({
      tabs: [
        { id: 1, url: "https://one.example" },
        { id: 2, url: "https://two.example" },
      ],
      denied: [1],
    });
    await harness.policy.initialize("all", true);

    await expect(harness.policy.replaceTab(2, 1)).resolves.toBe(true);

    expect(harness.policy.isDenied(1)).toBe(false);
    expect(harness.policy.isDenied(2)).toBe(true);
    expect(harness.session.values.deniedTabIdsV1).toEqual([2]);
    await expect(harness.policy.requireTab(2)).rejects.toThrow("paused for OpenClaw");
  });
});
