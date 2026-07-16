import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const sessionMocks = getPwToolsCoreSessionMocks();
const mod = await import("./pw-tools-core.js");

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
        first: () => ({ screenshot: elementScreenshot }),
      })),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };
    setPwToolsCoreCurrentPage(page);

    const res = await mod.takeScreenshotViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      element: "#main",
      type: "png",
    });

    expect(res.buffer.toString()).toBe("E");
    expect(sessionMocks.getPageForTargetId).toHaveBeenCalled();
    expect(page.locator as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("#main");
    expect(elementScreenshot).toHaveBeenCalledWith({ type: "png" });
  });
  it("screenshots a ref locator", async () => {
    const refScreenshot = vi.fn(async () => Buffer.from("R"));
    setPwToolsCoreCurrentRefLocator({ screenshot: refScreenshot });
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
    });

    expect(res.buffer.toString()).toBe("R");
    expect(sessionMocks.refLocator).toHaveBeenCalledWith(page, "76");
    expect(refScreenshot).toHaveBeenCalledWith({ type: "jpeg" });
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
  it("arms the next file chooser and sets files (default timeout)", async () => {
    const uploadPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-upload-${crypto.randomUUID()}.txt`);
    await fs.mkdir(path.dirname(uploadPath), { recursive: true });
    await fs.writeFile(uploadPath, "fixture", "utf8");
    const canonicalUploadPath = await fs.realpath(uploadPath);
    const fileChooser = { setFiles: vi.fn(async () => {}) };
    const waitForEvent = vi.fn(async (_event: string, _opts: unknown) => fileChooser);
    setPwToolsCoreCurrentPage({
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    });

    try {
      await mod.armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        paths: [uploadPath],
      });

      // waitForEvent is awaited immediately; handler continues async.
      await Promise.resolve();

      expect(waitForEvent).toHaveBeenCalledWith("filechooser", {
        timeout: 120_000,
      });
      await vi.waitFor(() => {
        expect(fileChooser.setFiles).toHaveBeenCalledWith([canonicalUploadPath]);
      });
    } finally {
      await fs.rm(uploadPath, { force: true });
    }
  });
  it("revalidates file-chooser paths at use-time and cancels missing files", async () => {
    const missingPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-missing-${crypto.randomUUID()}.txt`);
    const { fileChooser, press } = createFileChooserPageMocks();

    await mod.armFileUploadViaPlaywright({
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

    await mod.armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      paths: [],
    });
    await Promise.resolve();

    expect(fileChooser.setFiles).not.toHaveBeenCalled();
    expect(press).toHaveBeenCalledWith("Escape");
  });
});
