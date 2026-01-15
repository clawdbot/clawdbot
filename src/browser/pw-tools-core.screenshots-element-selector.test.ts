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

  it("screenshots an element selector", async () => {
    const elementScreenshot = vi.fn(async () => Buffer.from("E"));
    currentPage = {
      locator: vi.fn(() => ({
        first: () => ({ screenshot: elementScreenshot }),
      })),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };

    const mod = await importModule();
    const res = await mod.takeScreenshotViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      element: "#main",
      type: "png",
    });

    expect(res.buffer.toString()).toBe("E");
    expect(sessionMocks.getPageForTargetId).toHaveBeenCalled();
    expect(currentPage.locator as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("#main");
    expect(elementScreenshot).toHaveBeenCalledWith({ type: "png" });
  });
  it("screenshots a ref locator", async () => {
    const refScreenshot = vi.fn(async () => Buffer.from("R"));
    currentRefLocator = { screenshot: refScreenshot };
    currentPage = {
      locator: vi.fn(),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };

    const mod = await importModule();
    const res = await mod.takeScreenshotViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "76",
      type: "jpeg",
    });

    expect(res.buffer.toString()).toBe("R");
    expect(sessionMocks.refLocator).toHaveBeenCalledWith(currentPage, "76");
    expect(refScreenshot).toHaveBeenCalledWith({ type: "jpeg" });
  });
  it("rejects fullPage for element or ref screenshots", async () => {
    currentRefLocator = { screenshot: vi.fn(async () => Buffer.from("R")) };
    currentPage = {
      locator: vi.fn(() => ({
        first: () => ({ screenshot: vi.fn(async () => Buffer.from("E")) }),
      })),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };

    const mod = await importModule();

    await expect(
      mod.takeScreenshotViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        element: "#x",
        fullPage: true,
      }),
    ).rejects.toThrow(/fullPage is not supported/i);

    await expect(
      mod.takeScreenshotViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        fullPage: true,
      }),
    ).rejects.toThrow(/fullPage is not supported/i);
  });
  it("arms the next file chooser and sets files (default timeout)", async () => {
    const fileChooser = { setFiles: vi.fn(async () => {}) };
    const waitForEvent = vi.fn(async (_event: string, _opts: unknown) => fileChooser);
    currentPage = {
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    };

    const mod = await importModule();
    await mod.armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/tmp/a.txt"],
    });

    // waitForEvent is awaited immediately; handler continues async.
    await Promise.resolve();

    expect(waitForEvent).toHaveBeenCalledWith("filechooser", {
      timeout: 120_000,
    });
    expect(fileChooser.setFiles).toHaveBeenCalledWith(["/tmp/a.txt"]);
  });
  it("arms the next file chooser and escapes if no paths provided", async () => {
    const fileChooser = { setFiles: vi.fn(async () => {}) };
    const press = vi.fn(async () => {});
    const waitForEvent = vi.fn(async () => fileChooser);
    currentPage = {
      waitForEvent,
      keyboard: { press },
    };

    const mod = await importModule();
    await mod.armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      paths: [],
    });
    await Promise.resolve();

    expect(fileChooser.setFiles).not.toHaveBeenCalled();
    expect(press).toHaveBeenCalledWith("Escape");
  });
});
