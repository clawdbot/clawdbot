import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import {
  ensurePageState,
  refLocator,
  rememberRoleRefsForTarget,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import { BROWSER_REF_MARKER_ATTRIBUTE } from "./pw-session.page-cdp.js";

type MutableDownload = {
  suggestedFilename: () => string;
  saveAs: ReturnType<typeof vi.fn>;
  path?: () => Promise<string>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

function fakePage(): {
  page: Page;
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  mocks: {
    on: ReturnType<typeof vi.fn>;
    getByRole: ReturnType<typeof vi.fn>;
    frameLocator: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
  };
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
    return undefined as unknown;
  });
  const getByRole = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));
  const frameLocator = vi.fn(() => ({
    getByRole: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
    locator: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
  }));
  const locator = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));

  const page = {
    on,
    getByRole,
    frameLocator,
    locator,
  } as unknown as Page;

  return { page, handlers, mocks: { on, getByRole, frameLocator, locator } };
}

describe("pw-session refLocator", () => {
  it("uses frameLocator for role refs when snapshot was scoped to a frame", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { e1: { role: "button", name: "OK" } };
    state.roleRefsFrameSelector = "iframe#main";

    refLocator(page, "e1");

    expect(mocks.frameLocator).toHaveBeenCalledWith("iframe#main");
  });

  it("uses page getByRole for role refs by default", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { e1: { role: "button", name: "OK" } };

    refLocator(page, "e1");

    expect(mocks.getByRole).toHaveBeenCalled();
  });

  it("uses aria-ref locators when refs mode is aria", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefsMode = "aria";

    refLocator(page, "e1");

    expect(mocks.locator).toHaveBeenCalledWith("aria-ref=e1");
  });

  it("uses backend-marked DOM locators for ax refs", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { ax12: { role: "button", name: "OK", domMarker: true } };

    refLocator(page, "ax12");

    expect(mocks.locator).toHaveBeenCalledWith(`[${BROWSER_REF_MARKER_ATTRIBUTE}="ax12"]`);
  });

  it("falls back to role heuristics for ax refs without backend markers", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { ax12: { role: "button", name: "OK" } };

    refLocator(page, "ax12");

    expect(mocks.getByRole).toHaveBeenCalledWith("button", { name: "OK", exact: true });
  });

  it("rejects unknown ax refs instead of timing out on aria-ref locators", () => {
    const { page, mocks } = fakePage();

    expect(() => refLocator(page, "ax12")).toThrow(/Unknown ref/);
    expect(mocks.locator).not.toHaveBeenCalled();
  });
});

describe("pw-session role refs cache", () => {
  it("restores refs for a different Page instance (same CDP targetId)", () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = "t1";

    rememberRoleRefsForTarget({
      cdpUrl,
      targetId,
      refs: { e1: { role: "button", name: "OK" } },
      frameSelector: "iframe#main",
    });

    const { page, mocks } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId, page });

    refLocator(page, "e1");
    expect(mocks.frameLocator).toHaveBeenCalledWith("iframe#main");
  });
});

describe("pw-session ensurePageState", () => {
  it("stores unmanaged downloads under unique managed paths", async () => {
    const { page, handlers } = fakePage();
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    ensurePageState(page);

    const saveAsA = vi.fn(async () => {});
    const saveAsB = vi.fn(async () => {});
    const downloadA: MutableDownload = {
      suggestedFilename: () => "report.pdf",
      saveAs: saveAsA,
    };
    const downloadB: MutableDownload = {
      suggestedFilename: () => "report.pdf",
      saveAs: saveAsB,
    };

    handlers.get("download")?.[0]?.(downloadA);
    handlers.get("download")?.[0]?.(downloadB);

    const managedPathA = await downloadA.path?.();
    const managedPathB = await downloadB.path?.();

    expect(managedPathA).not.toBe(managedPathB);
    expect(path.dirname(managedPathA ?? "")).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.dirname(managedPathB ?? "")).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.basename(managedPathA ?? "")).toMatch(/-report\.pdf$/);
    expect(path.basename(managedPathB ?? "")).toMatch(/-report\.pdf$/);
    expect(saveAsA).toHaveBeenCalledWith(managedPathA);
    expect(saveAsB).toHaveBeenCalledWith(managedPathB);
    expect(mkdirSpy).toHaveBeenCalledWith(DEFAULT_DOWNLOAD_DIR, { recursive: true });
  });

  it("suppresses unmanaged download save rejections until path is awaited", async () => {
    const { page, handlers } = fakePage();
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    ensurePageState(page);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const err = new Error("save failed");
    const download: MutableDownload = {
      suggestedFilename: () => "report.pdf",
      saveAs: vi.fn(async () => {
        throw err;
      }),
    };

    try {
      handlers.get("download")?.[0]?.(download);
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      await expect(download.path?.()).rejects.toThrow("save failed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("leaves unmanaged download handling to explicit waiters while armed", () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    state.downloadWaiterDepth = 1;
    const download = {
      suggestedFilename: () => "report.pdf",
      saveAs: vi.fn(async () => {}),
    };

    handlers.get("download")?.[0]?.(download);

    expect(download).not.toHaveProperty("path");
    expect(download.saveAs).not.toHaveBeenCalled();
  });

  it("tracks page errors and network requests (best-effort)", () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);

    const req = {
      method: () => "GET",
      url: () => "https://example.com/api",
      resourceType: () => "xhr",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    } as unknown as import("playwright-core").Request;

    const resp = {
      request: () => req,
      status: () => 500,
      ok: () => false,
    } as unknown as import("playwright-core").Response;

    handlers.get("request")?.[0]?.(req);
    handlers.get("response")?.[0]?.(resp);
    handlers.get("requestfailed")?.[0]?.(req);
    handlers.get("pageerror")?.[0]?.(new Error("boom"));

    expect(state.errors.at(-1)?.message).toBe("boom");
    expect(state.requests.at(-1)).toMatchObject({
      method: "GET",
      url: "https://example.com/api",
      resourceType: "xhr",
      status: 500,
      ok: false,
      failureText: "net::ERR_FAILED",
    });
  });

  it("drops state on page close", () => {
    const { page, handlers } = fakePage();
    const state1 = ensurePageState(page);
    handlers.get("close")?.[0]?.();

    const state2 = ensurePageState(page);
    expect(state2).not.toBe(state1);
    expect(state2.console).toEqual([]);
    expect(state2.errors).toEqual([]);
    expect(state2.requests).toEqual([]);
  });
});
