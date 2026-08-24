import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";

describe("Playwright download capture cancellation", () => {
  it("cancels a captured download before delayed validation can save bytes", async () => {
    const page = new EventEmitter();
    const state = { downloadWaiterDepth: 0 };
    const controller = new AbortController();
    const reason = new Error("download request aborted");
    const validation = createDeferred<void>();
    const beforeSave = vi.fn(async () => {
      await validation.promise;
    });
    const saveAs = vi.fn(async () => {});
    const cancel = vi.fn(async () => {});
    const capture = createDownloadCaptureForPage(page, state, 1_000, {
      beforeSave,
      signal: controller.signal,
    });
    const outcome = capture.promise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    try {
      page.emit("download", {
        url: () => "https://example.com/export.csv",
        suggestedFilename: () => "export.csv",
        saveAs,
        cancel,
      });
      expect(beforeSave).toHaveBeenCalledOnce();
      controller.abort(reason);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(cancel).toHaveBeenCalledOnce();
      expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe(reason);
      validation.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(saveAs).not.toHaveBeenCalled();
      expect(state.downloadWaiterDepth).toBe(0);
      expect(page.listenerCount("download")).toBe(0);
    } finally {
      validation.resolve();
      await outcome;
    }
  });

  it("cancels an in-progress download without publishing staged output", async () => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-cancel-"));
    const outputPath = path.join(outputRoot, "cancelled.bin");
    const page = new EventEmitter();
    const state = { downloadWaiterDepth: 0 };
    const controller = new AbortController();
    const reason = new Error("download request aborted");
    const saveGate = createDeferred<void>();
    const saveStarted = createDeferred<string>();
    const saveAs = vi.fn(async (tempPath: string) => {
      await fs.writeFile(tempPath, "cancelled partial contents", "utf8");
      saveStarted.resolve(tempPath);
      await saveGate.promise;
    });
    const cancel = vi.fn(async () => {
      saveGate.resolve();
    });
    const capture = createDownloadCaptureForPage(page, state, 1_000, {
      mode: "explicit",
      outputPath,
      outputRoot,
      signal: controller.signal,
    });
    const outcome = capture.promise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    try {
      page.emit("download", {
        url: () => "https://example.com/cancelled.bin",
        suggestedFilename: () => "cancelled.bin",
        saveAs,
        cancel,
      });
      const partialPath = await saveStarted.promise;
      await expect(fs.readFile(partialPath, "utf8")).resolves.toBe("cancelled partial contents");

      controller.abort(reason);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(cancel).toHaveBeenCalledOnce();
      await expect(outcome).resolves.toBe(reason);
      await vi.waitFor(async () => {
        await expect(fs.access(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
      await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(state.downloadWaiterDepth).toBe(0);
      expect(page.listenerCount("download")).toBe(0);
    } finally {
      saveGate.resolve();
      await outcome;
      await fs.rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("finishes atomic publication when cancellation arrives after its commit boundary", async () => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-publish-"));
    const outputPath = path.join(outputRoot, "published.bin");
    const renameStarted = createDeferred<void>();
    const releaseRename = createDeferred<void>();
    const renameFinished = createDeferred<void>();
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination).endsWith(`${path.sep}published.bin`)) {
        renameStarted.resolve();
        await releaseRename.promise;
      }
      try {
        await originalRename(source, destination);
      } finally {
        renameFinished.resolve();
      }
    });
    const page = new EventEmitter();
    const state = { downloadWaiterDepth: 0 };
    const controller = new AbortController();
    const reason = new Error("download aborted during publication");
    const cancel = vi.fn(async () => {});
    const capture = createDownloadCaptureForPage(page, state, 1_000, {
      mode: "explicit",
      outputPath,
      outputRoot,
      signal: controller.signal,
    });
    const outcome = capture.promise.then(
      (result) => result,
      (error: unknown) => error,
    );

    try {
      page.emit("download", {
        url: () => "https://example.com/published.bin",
        suggestedFilename: () => "published.bin",
        saveAs: async (tempPath: string) => {
          await fs.writeFile(tempPath, "completed download", "utf8");
        },
        cancel,
      });
      await renameStarted.promise;
      controller.abort(reason);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
      expect(cancel).not.toHaveBeenCalled();
      releaseRename.resolve();

      await expect(capture.promise).resolves.toMatchObject({ path: outputPath });
      await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("completed download");
      expect(state.downloadWaiterDepth).toBe(0);
    } finally {
      releaseRename.resolve();
      await renameFinished.promise;
      await outcome;
      rename.mockRestore();
      await fs.rm(outputRoot, { recursive: true, force: true });
    }
  });
});
