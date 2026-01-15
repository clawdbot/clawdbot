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

  it("last file-chooser arm wins", async () => {
    let resolve1: ((value: unknown) => void) | null = null;
    let resolve2: ((value: unknown) => void) | null = null;

    const fc1 = { setFiles: vi.fn(async () => {}) };
    const fc2 = { setFiles: vi.fn(async () => {}) };

    const waitForEvent = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve1 = r;
          }) as Promise<unknown>,
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve2 = r;
          }) as Promise<unknown>,
      );

    currentPage = {
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    };

    const mod = await importModule();
    await mod.armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      paths: ["/tmp/1"],
    });
    await mod.armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      paths: ["/tmp/2"],
    });

    resolve1?.(fc1);
    resolve2?.(fc2);
    await Promise.resolve();

    expect(fc1.setFiles).not.toHaveBeenCalled();
    expect(fc2.setFiles).toHaveBeenCalledWith(["/tmp/2"]);
  });
  it("arms the next dialog and accepts/dismisses (default timeout)", async () => {
    const accept = vi.fn(async () => {});
    const dismiss = vi.fn(async () => {});
    const dialog = { accept, dismiss };
    const waitForEvent = vi.fn(async () => dialog);
    currentPage = {
      waitForEvent,
    };

    const mod = await importModule();
    await mod.armDialogViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      accept: true,
      promptText: "x",
    });
    await Promise.resolve();

    expect(waitForEvent).toHaveBeenCalledWith("dialog", { timeout: 120_000 });
    expect(accept).toHaveBeenCalledWith("x");
    expect(dismiss).not.toHaveBeenCalled();

    accept.mockClear();
    dismiss.mockClear();
    waitForEvent.mockClear();

    await mod.armDialogViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      accept: false,
    });
    await Promise.resolve();

    expect(waitForEvent).toHaveBeenCalledWith("dialog", { timeout: 120_000 });
    expect(dismiss).toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
  it("waits for selector, url, load state, and function", async () => {
    const waitForSelector = vi.fn(async () => {});
    const waitForURL = vi.fn(async () => {});
    const waitForLoadState = vi.fn(async () => {});
    const waitForFunction = vi.fn(async () => {});
    const waitForTimeout = vi.fn(async () => {});

    currentPage = {
      locator: vi.fn(() => ({
        first: () => ({ waitFor: waitForSelector }),
      })),
      waitForURL,
      waitForLoadState,
      waitForFunction,
      waitForTimeout,
      getByText: vi.fn(() => ({ first: () => ({ waitFor: vi.fn() }) })),
    };

    const mod = await importModule();
    await mod.waitForViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      selector: "#main",
      url: "**/dash",
      loadState: "networkidle",
      fn: "window.ready===true",
      timeoutMs: 1234,
      timeMs: 50,
    });

    expect(waitForTimeout).toHaveBeenCalledWith(50);
    expect(currentPage.locator as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("#main");
    expect(waitForSelector).toHaveBeenCalledWith({
      state: "visible",
      timeout: 1234,
    });
    expect(waitForURL).toHaveBeenCalledWith("**/dash", { timeout: 1234 });
    expect(waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 1234,
    });
    expect(waitForFunction).toHaveBeenCalledWith("window.ready===true", {
      timeout: 1234,
    });
  });
});
