import { beforeEach, describe, expect, it, vi } from "vitest";

let currentPage: Record<string, unknown> | null = null;
let currentRefLocator: Record<string, unknown> | null = null;
let pageState: {
  console: unknown[];
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
};

const sessionMocks = vi.hoisted(() => ({
  getPageForTargetId: vi.fn(async () => {
    if (!currentPage) throw new Error("missing page");
    return currentPage;
  }),
  ensurePageState: vi.fn(() => pageState),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  refLocator: vi.fn(() => {
    if (!currentRefLocator) throw new Error("missing locator");
    return currentRefLocator;
  }),
  rememberRoleRefsForTarget: vi.fn(() => {}),
}));

vi.mock("./pw-session.js", () => sessionMocks);

async function importModule() {
  return await import("./pw-tools-core.js");
}

describe("pw-tools-core", () => {
  beforeEach(() => {
    currentPage = null;
    currentRefLocator = null;
    pageState = {
      console: [],
      armIdUpload: 0,
      armIdDialog: 0,
      armIdDownload: 0,
    };
    for (const fn of Object.values(sessionMocks)) fn.mockClear();
  });

  it("clamps timeoutMs for scrollIntoView", async () => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {});
    currentRefLocator = { scrollIntoViewIfNeeded };
    currentPage = {};

    const mod = await importModule();
    await mod.scrollIntoViewViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      timeoutMs: 50,
    });

    expect(scrollIntoViewIfNeeded).toHaveBeenCalledWith({ timeout: 500 });
  });
  it("rewrites strict mode violations for scrollIntoView", async () => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {
      throw new Error('Error: strict mode violation: locator("aria-ref=1") resolved to 2 elements');
    });
    currentRefLocator = { scrollIntoViewIfNeeded };
    currentPage = {};

    const mod = await importModule();
    await expect(
      mod.scrollIntoViewViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/Run a new snapshot/i);
  });
  it("rewrites not-visible timeouts for scrollIntoView", async () => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {
      throw new Error('Timeout 5000ms exceeded. waiting for locator("aria-ref=1") to be visible');
    });
    currentRefLocator = { scrollIntoViewIfNeeded };
    currentPage = {};

    const mod = await importModule();
    await expect(
      mod.scrollIntoViewViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/not found or not visible/i);
  });
  it("rewrites strict mode violations into snapshot hints", async () => {
    const click = vi.fn(async () => {
      throw new Error('Error: strict mode violation: locator("aria-ref=1") resolved to 2 elements');
    });
    currentRefLocator = { click };
    currentPage = {};

    const mod = await importModule();
    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/Run a new snapshot/i);
  });
  it("rewrites not-visible timeouts into snapshot hints", async () => {
    const click = vi.fn(async () => {
      throw new Error('Timeout 5000ms exceeded. waiting for locator("aria-ref=1") to be visible');
    });
    currentRefLocator = { click };
    currentPage = {};

    const mod = await importModule();
    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/not found or not visible/i);
  });
  it("rewrites covered/hidden errors into interactable hints", async () => {
    const click = vi.fn(async () => {
      throw new Error(
        "Element is not receiving pointer events because another element intercepts pointer events",
      );
    });
    currentRefLocator = { click };
    currentPage = {};

    const mod = await importModule();
    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/not interactable/i);
  });
});
