// Browser tests cover pw tools core.screenshots element selector plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { CDPSession } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import type { PageState } from "./pw-session-contracts.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const sessionMocks = getPwToolsCoreSessionMocks();
const mod = await import("./pw-tools-core.interactions.js");
const downloads = await import("./pw-tools-core.downloads.js");

function screenshotElement(screenshot: () => Promise<Buffer>) {
  return {
    elementHandle: async () => ({
      screenshot,
      scrollIntoViewIfNeeded: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }),
  };
}

function createFileChooserPageMocks() {
  const fileChooser = { setFiles: vi.fn(async () => {}) };
  const press = vi.fn(async () => {});
  const waitForEvent = vi.fn(async () => fileChooser);
  setPwToolsCoreCurrentPage({
    waitForEvent,
    keyboard: { press },
  });
  return { fileChooser, press, waitForEvent };
}

describe("pw-tools-core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("screenshots an element selector", async () => {
    const elementScreenshot = vi.fn(async () => Buffer.from("E"));
    const page = {
      locator: vi.fn(() => ({
        first: () => screenshotElement(elementScreenshot),
      })),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };
    setPwToolsCoreCurrentPage(page);

    const res = await mod.takeScreenshotViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      element: "#main",
      type: "png",
      timeoutMs: 1234,
    });

    expect(res.buffer.toString()).toBe("E");
    expect(sessionMocks.getPageForTargetId).toHaveBeenCalled();
    expect(page.locator as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("#main");
    expect(elementScreenshot).toHaveBeenCalledWith({ type: "png", timeout: 0 });
  });
  it("screenshots a ref locator", async () => {
    const refScreenshot = vi.fn(async () => Buffer.from("R"));
    setPwToolsCoreCurrentRefLocator(screenshotElement(refScreenshot));
    const page = {
      locator: vi.fn(),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };
    setPwToolsCoreCurrentPage(page);

    const res = await mod.takeScreenshotViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "76",
      type: "jpeg",
      timeoutMs: 2345,
    });

    expect(res.buffer.toString()).toBe("R");
    expect(sessionMocks.refLocator).toHaveBeenCalledWith(page, "76");
    expect(refScreenshot).toHaveBeenCalledWith({ type: "jpeg", timeout: 0 });
  });
  it("rejects fullPage for element or ref screenshots", async () => {
    setPwToolsCoreCurrentRefLocator({ screenshot: vi.fn(async () => Buffer.from("R")) });
    setPwToolsCoreCurrentPage({
      locator: vi.fn(() => ({
        first: () => ({ screenshot: vi.fn(async () => Buffer.from("E")) }),
      })),
      screenshot: vi.fn(async () => Buffer.from("P")),
    });

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
  it("does not start a queued screenshot after its timeout", async () => {
    let release!: () => void;
    const previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = sessionMocks.ensurePageState() as unknown as PageState;
    state.emulation = { transitionTail: previous };
    const screenshot = vi.fn(async () => Buffer.from("late"));
    setPwToolsCoreCurrentPage({ screenshot });

    try {
      await expect(
        mod.takeScreenshotViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          timeoutMs: 10,
        }),
      ).rejects.toThrow("timed out");
      const pending = state.emulation.transitionTail;
      release();
      await pending;
      expect(screenshot).not.toHaveBeenCalled();
      expect(sessionMocks.restoreRoleRefsForTarget).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
  it.each(["screenshot", "labels", "resize"] as const)(
    "skips a cancelled queued %s",
    async (kind) => {
      let release!: () => void;
      const previous = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state = sessionMocks.ensurePageState() as unknown as PageState;
      state.emulation = { transitionTail: previous };
      const page = { screenshot: vi.fn(), evaluate: vi.fn(), setViewportSize: vi.fn() };
      setPwToolsCoreCurrentPage(page);
      const controller = new AbortController();
      const opts = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1", signal: controller.signal };
      const { resizeViewportViaPlaywright } = await import("./pw-tools-core.snapshot.js");
      const pending =
        kind === "resize"
          ? resizeViewportViaPlaywright({ ...opts, width: 1280, height: 720 })
          : kind === "labels"
            ? mod.screenshotWithLabelsViaPlaywright({ ...opts, refs: {} })
            : mod.takeScreenshotViaPlaywright(opts);
      const rejected = expect(pending).rejects.toThrow("request closed");
      try {
        await vi.waitFor(() => expect(state.emulation?.transitionTail).not.toBe(previous));
        controller.abort(new Error("request closed"));
        release();
        await rejected;
        expect(page.screenshot).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
        expect(page.setViewportSize).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );
  it.each([
    "Page.getLayoutMetrics",
    "Page.captureScreenshot",
    "Emulation.setTouchEmulationEnabled",
    "Playwright.screenshot",
  ])("rejects mutations behind an interrupted %s until it settles", async (blockedMethod) => {
    vi.useFakeTimers();
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const waitAt = async (method: string) => {
      if (method === blockedMethod) {
        started.resolve();
        await release.promise;
      }
    };
    const send = vi.fn(async (method: string) => {
      await waitAt(method);
      return method === "Page.getLayoutMetrics"
        ? {
            visualViewport: { pageX: 0, pageY: 0, scale: 1 },
            cssLayoutViewport: { pageX: 0, pageY: 0 },
            cssContentSize: { x: 0, y: 0, width: 390, height: 664 },
          }
        : { data: Buffer.from("capture").toString("base64") };
    });
    const session = { send } as unknown as CDPSession;
    const page = {
      viewportSize: () => ({ width: 390, height: 664 }),
      setViewportSize: vi.fn(async () => {}),
      screenshot: vi.fn(async () => {
        await waitAt("Playwright.screenshot");
        return Buffer.from("capture");
      }),
    };
    setPwToolsCoreCurrentPage(page);
    const state = sessionMocks.ensurePageState() as unknown as PageState;
    state.emulation = {
      session: Promise.resolve(session),
      ...(blockedMethod === "Playwright.screenshot"
        ? {}
        : { metricsOwner: { session, viewport: { width: 390, height: 664 } } }),
      touch: { session, enabled: true },
    };
    const { resizeViewportViaPlaywright } = await import("./pw-tools-core.snapshot.js");
    const { setDeviceViaPlaywright } = await import("./pw-tools-core.state.js");
    const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
    const controller = new AbortController();
    const outcome = (operation: Promise<unknown>) =>
      operation.then(
        () => "success",
        (error: unknown) => String(error),
      );
    const screenshot = outcome(
      mod.takeScreenshotViaPlaywright({ ...target, timeoutMs: 25, signal: controller.signal }),
    );
    const mutations: Promise<string>[] = [];
    try {
      await started.promise;
      const outcomes: string[] = [];
      mutations.push(
        outcome(resizeViewportViaPlaywright({ ...target, width: 800, height: 600 })).then(
          (value) => {
            outcomes.push(value);
            return value;
          },
        ),
      );
      if (blockedMethod === "Playwright.screenshot") {
        controller.abort(new Error("request closed"));
        await vi.advanceTimersByTimeAsync(25);
        expect(await screenshot).toContain("request closed");
      } else {
        await vi.advanceTimersByTimeAsync(25);
        expect(await screenshot).toContain("timed out");
      }
      mutations.push(
        outcome(setDeviceViaPlaywright({ ...target, name: "Desktop Chrome" })).then((value) => {
          outcomes.push(value);
          return value;
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect([...outcomes]).toEqual([
        expect.stringContaining("close and reopen this tab"),
        expect.stringContaining("close and reopen this tab"),
      ]);
      expect(page.setViewportSize).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await screenshot;
      await Promise.all(mutations);
      await state.emulation?.transitionTail;
      vi.useRealTimers();
    }
    expect(page.setViewportSize).not.toHaveBeenCalled();
    await resizeViewportViaPlaywright({ ...target, width: 1280, height: 720 });
    expect(page.setViewportSize).toHaveBeenCalledExactlyOnceWith({ width: 1280, height: 720 });
  });
  it("arms the next file chooser and sets files (default timeout)", async () => {
    const uploadPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-upload-${crypto.randomUUID()}.txt`);
    await fs.mkdir(path.dirname(uploadPath), { recursive: true });
    await fs.writeFile(uploadPath, "fixture", "utf8");
    const canonicalUploadPath = await fs.realpath(uploadPath);
    const fileChooser = {
      setFiles: vi.fn(
        async (_paths: string[], _options: { timeout: number; signal: AbortSignal }) => {},
      ),
    };
    const waitForEvent = vi.fn(
      async (_eventValue: string, _opts: { timeout: number; signal: AbortSignal }) => fileChooser,
    );
    setPwToolsCoreCurrentPage({
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    });

    try {
      await downloads.armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        paths: [uploadPath],
      });

      // waitForEvent is awaited immediately; handler continues async.
      await Promise.resolve();

      expect(waitForEvent).toHaveBeenCalledWith("filechooser", {
        timeout: 0,
        signal: expect.any(AbortSignal),
      });
      await vi.waitFor(() => {
        expect(fileChooser.setFiles).toHaveBeenCalledExactlyOnceWith([canonicalUploadPath], {
          timeout: expect.any(Number),
          signal: expect.any(AbortSignal),
        });
      });
      const { timeout, signal } = fileChooser.setFiles.mock.calls[0]![1];
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(120_000);
      expect(signal.aborted).toBe(false);
    } finally {
      await fs.rm(uploadPath, { force: true });
    }
  });
  it("revalidates file-chooser paths at use-time and cancels missing files", async () => {
    const missingPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-missing-${crypto.randomUUID()}.txt`);
    const { fileChooser, press } = createFileChooserPageMocks();

    await downloads.armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: [missingPath],
    });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(press).toHaveBeenCalledWith("Escape");
    });
    expect(fileChooser.setFiles).not.toHaveBeenCalled();
  });
  it("arms the next file chooser and escapes if no paths provided", async () => {
    const { fileChooser, press } = createFileChooserPageMocks();

    await downloads.armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      paths: [],
    });
    await Promise.resolve();

    expect(fileChooser.setFiles).not.toHaveBeenCalled();
    expect(press).toHaveBeenCalledWith("Escape");
  });
});
