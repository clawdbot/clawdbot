// Browser tests cover pw tools core.waits next download saves it plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

const tmpDirMocks = vi.hoisted(() => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw"),
}));
const chromeMocks = vi.hoisted(() => ({
  getChromeWebSocketUrl: vi.fn(async () => "ws://127.0.0.1/devtools/browser/mock"),
}));
const clientFetchMocks = vi.hoisted(() => ({
  resolveBrowserRateLimitMessage: vi.fn(() => undefined),
}));
vi.mock("./chrome.js", () => chromeMocks);
vi.mock("./client-fetch.js", () => clientFetchMocks);

const sessionMocks = getPwToolsCoreSessionMocks();

let mod: Pick<
  typeof import("./pw-tools-core.downloads.js"),
  "downloadViaPlaywright" | "waitForDownloadViaPlaywright"
> &
  Pick<typeof import("./pw-tools-core.responses.js"), "responseBodyViaPlaywright">;
let tmpDirModule: typeof import("../infra/tmp-openclaw-dir.js");

describe("pw-tools-core", () => {
  installPwToolsCoreTestHooks();

  beforeAll(async () => {
    vi.doMock("./pw-session.js", () => sessionMocks);
    vi.doMock("./chrome.js", () => chromeMocks);
    tmpDirModule = await import("../infra/tmp-openclaw-dir.js");
    vi.spyOn(tmpDirModule, "resolvePreferredOpenClawTmpDir").mockImplementation(
      tmpDirMocks.resolvePreferredOpenClawTmpDir,
    );
    const [downloads, responses] = await Promise.all([
      import("./pw-tools-core.downloads.js"),
      import("./pw-tools-core.responses.js"),
    ]);
    mod = {
      downloadViaPlaywright: downloads.downloadViaPlaywright,
      waitForDownloadViaPlaywright: downloads.waitForDownloadViaPlaywright,
      responseBodyViaPlaywright: responses.responseBodyViaPlaywright,
    };
  });

  beforeEach(() => {
    for (const fn of Object.values(tmpDirMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(chromeMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(clientFetchMocks)) {
      fn.mockClear();
    }
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw");
  });

  async function withTempDir<T>(run: (tempDir: string) => Promise<T>): Promise<T> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-download-test-"));
    try {
      return await run(tempDir);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  function requireSaveAsPath(saveAs: ReturnType<typeof vi.fn>): string {
    const [call] = saveAs.mock.calls;
    if (!call) {
      throw new Error("expected download saveAs call");
    }
    const [savedPath] = call;
    if (typeof savedPath !== "string") {
      throw new Error("expected download saveAs path");
    }
    return savedPath;
  }

  async function waitForImplicitDownloadOutput(params: {
    downloadUrl: string;
    suggestedFilename: string;
  }) {
    const harness = createDownloadEventHarness();
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "download-content", "utf8");
    });

    const p = mod.waitForDownloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      timeoutMs: 1000,
    });

    await Promise.resolve();
    harness.trigger({
      url: () => params.downloadUrl,
      suggestedFilename: () => params.suggestedFilename,
      saveAs,
    });

    const res = await p;
    const outPath = requireSaveAsPath(saveAs);
    return { res, outPath };
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    let error: unknown;
    try {
      await fs.access(targetPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }

  function createDownloadEventHarness() {
    const downloadHandlers = new Set<(download: unknown) => void>();
    const on = vi.fn((event: string, handler: (download: unknown) => void) => {
      if (event === "download") {
        downloadHandlers.add(handler);
      }
    });
    const off = vi.fn((event: string, handler: (download: unknown) => void) => {
      if (event === "download") {
        downloadHandlers.delete(handler);
      }
    });
    setPwToolsCoreCurrentPage({ on, off });
    return {
      trigger: (download: unknown) => {
        for (const handler of downloadHandlers) {
          handler(download);
        }
      },
      expectArmed: () => {
        expect(downloadHandlers.size).toBeGreaterThan(0);
      },
      activeHandlerCount: () => downloadHandlers.size,
    };
  }

  async function expectAtomicDownloadSave(params: {
    saveAs: ReturnType<typeof vi.fn>;
    targetPath: string;
    content: string;
  }) {
    const savedPath = requireSaveAsPath(params.saveAs);
    expect(savedPath).not.toBe(params.targetPath);
    const savedParentName = path.basename(path.dirname(savedPath));
    expect(
      savedParentName.includes("fs-safe-output") ||
        savedParentName === path.basename(path.dirname(params.targetPath)),
    ).toBe(true);
    expect(path.basename(savedPath)).toContain(path.basename(params.targetPath));
    expect(path.basename(savedPath)).toMatch(/\.part$/);
    expect(await fs.readFile(params.targetPath, "utf8")).toBe(params.content);
    await expectPathMissing(savedPath);
  }

  it("waits for the next download and atomically finalizes explicit output paths", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const targetPath = path.join(tempDir, "file.bin");

      type DownloadFixture = {
        url: () => string;
        suggestedFilename: () => string;
        saveAs: (outPath: string) => Promise<void>;
      };
      const saveAs = vi.fn(async function (this: DownloadFixture, outPath: string) {
        expect(this).toBe(download);
        await fs.writeFile(outPath, "file-content", "utf8");
      });
      const download: DownloadFixture = {
        url: () => "https://example.com/file.bin",
        suggestedFilename: () => "file.bin",
        saveAs,
      };

      const p = mod.waitForDownloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        path: targetPath,
        timeoutMs: 1000,
      });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger(download);

      const res = await p;
      await expectAtomicDownloadSave({ saveAs, targetPath, content: "file-content" });
      await expect(fs.realpath(res.path)).resolves.toBe(await fs.realpath(targetPath));
    });
  });

  it("creates missing explicit download output parents through the safe output directory path", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const targetPath = path.join(tempDir, "nested", "deeper", "file.bin");

      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "nested-content", "utf8");
      });

      const p = mod.waitForDownloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        path: targetPath,
        timeoutMs: 1000,
      });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger({
        url: () => "https://example.com/file.bin",
        suggestedFilename: () => "file.bin",
        saveAs,
      });

      await p;
      await expectAtomicDownloadSave({
        saveAs,
        targetPath,
        content: "nested-content",
      });
    });
  });

  it("preserves missing-file errors from the download producer", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const targetPath = path.join(tempDir, "file.bin");
      const producerError = Object.assign(new Error("download source disappeared"), {
        code: "ENOENT",
      });
      const saveAs = vi.fn(async () => {
        throw producerError;
      });

      const pending = mod.waitForDownloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        path: targetPath,
        timeoutMs: 1000,
      });

      await Promise.resolve();
      harness.trigger({
        url: () => "https://example.com/file.bin",
        suggestedFilename: () => "file.bin",
        saveAs,
      });

      await expect(pending).rejects.toBe(producerError);
      await expectPathMissing(targetPath);
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not write outside the output root when a download parent is swapped after save",
    async () => {
      await withTempDir(async (tempDir) => {
        const rootDir = path.join(tempDir, "downloads");
        const targetParent = path.join(rootDir, "race");
        const outsideDir = path.join(tempDir, "outside");
        const targetPath = path.join(targetParent, "file.bin");
        const outsideTargetPath = path.join(outsideDir, "file.bin");
        await fs.mkdir(targetParent, { recursive: true });
        await fs.mkdir(outsideDir);

        const harness = createDownloadEventHarness();
        let parentSwappedBeforeFinalize = false;
        const saveAs = vi.fn(async (outPath: string) => {
          await fs.writeFile(outPath, "race-content", "utf8");
          const beforeSwap = await fs.lstat(targetParent);
          expect(beforeSwap.isDirectory()).toBe(true);
          expect(beforeSwap.isSymbolicLink()).toBe(false);
          await fs.rm(targetParent, { recursive: true, force: true });
          await fs.symlink(outsideDir, targetParent);
          const afterSwap = await fs.lstat(targetParent);
          expect(afterSwap.isSymbolicLink()).toBe(true);
          parentSwappedBeforeFinalize = true;
        });

        const p = mod.waitForDownloadViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          path: targetPath,
          rootDir,
          timeoutMs: 1000,
        });

        await Promise.resolve();
        harness.expectArmed();
        harness.trigger({
          url: () => "https://example.com/file.bin",
          suggestedFilename: () => "file.bin",
          saveAs,
        });

        await expect(p).rejects.toThrow(/path alias|outside workspace|directory changed/i);
        expect(parentSwappedBeforeFinalize).toBe(true);
        expect(saveAs).toHaveBeenCalledOnce();
        await expectPathMissing(outsideTargetPath);
        await expect(fs.readdir(outsideDir)).resolves.toStrictEqual([]);
      });
    },
  );

  it("marks explicit download waiters as owning the next download until cleanup", async () => {
    const harness = createDownloadEventHarness();
    const state = sessionMocks.ensurePageState();
    expect(state.downloadWaiterDepth).toBe(0);

    const p = mod.waitForDownloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      timeoutMs: 1000,
    });

    await Promise.resolve();
    harness.expectArmed();
    expect(state.downloadWaiterDepth).toBe(1);
    harness.trigger({
      url: () => "https://example.com/file.bin",
      suggestedFilename: () => "file.bin",
      saveAs: vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "file-content", "utf8");
      }),
    });

    await p;
    expect(state.downloadWaiterDepth).toBe(0);
    expect(harness.activeHandlerCount()).toBe(0);
  });

  it("rejects blocked wait/download sources before writing the file", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const navigationGuard = getPwToolsCoreNavigationGuardMocks();
      const targetPath = path.join(tempDir, "blocked.bin");
      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "private-content", "utf8");
      });
      navigationGuard.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        new Error("Navigation blocked: private IP address"),
      );
      const pending = mod.waitForDownloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        path: targetPath,
        timeoutMs: 1000,
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger({
        url: () => "http://127.0.0.1/private.bin",
        suggestedFilename: () => "private.bin",
        saveAs,
      });

      await expect(pending).rejects.toThrow(/blocked|private|ssrf/i);
      expect(navigationGuard.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
        url: "http://127.0.0.1/private.bin",
        ssrfPolicy: { allowPrivateNetwork: false },
        browserProxyMode: undefined,
      });
      expect(saveAs).not.toHaveBeenCalled();
      await expectPathMissing(targetPath);
    });
  });

  it("blocks wait/download navigation before a download event is emitted", async () => {
    const harness = createDownloadEventHarness();
    const blocked = new Error("Navigation blocked: private IP address");
    blocked.name = "SsrFBlockedError";
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        onPolicyDenied,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        onPolicyDenied?: (event: { state: "detected"; error: unknown }) => void;
        page: { url: () => string };
      }) => {
        const pending = action(page.url());
        onPolicyDenied?.({ state: "detected", error: blocked });
        return await pending;
      },
    );

    const pending = mod.waitForDownloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      timeoutMs: 1000,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    await expect(pending).rejects.toBe(blocked);
    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.anything(),
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    );
    expect(harness.activeHandlerCount()).toBe(0);
  });

  it("lets only the latest overlapping explicit waiter save the download", async () => {
    const harness = createDownloadEventHarness();
    const state = sessionMocks.ensurePageState();
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "latest-content", "utf8");
    });

    const first = mod.waitForDownloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      timeoutMs: 1000,
    });
    void first.catch(() => {});
    const latest = mod.waitForDownloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      timeoutMs: 1000,
    });

    await Promise.resolve();
    expect(state.downloadWaiterDepth).toBe(2);
    harness.trigger({
      url: () => "https://example.com/latest.bin",
      suggestedFilename: () => "latest.bin",
      saveAs,
    });

    await expect(first).rejects.toThrow("superseded by another waiter");
    await expect(latest).resolves.toMatchObject({ suggestedFilename: "latest.bin" });
    expect(saveAs).toHaveBeenCalledOnce();
    expect(state.downloadWaiterDepth).toBe(0);
    expect(harness.activeHandlerCount()).toBe(0);
  });

  it("rechecks waiter ownership after asynchronous download URL validation", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const navigationGuard = getPwToolsCoreNavigationGuardMocks();
      let releaseValidation!: () => void;
      const validationPending = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      navigationGuard.assertBrowserNavigationResultAllowed.mockImplementationOnce(
        async () => await validationPending,
      );

      const firstSaveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "stale-content", "utf8");
      });
      const first = mod.waitForDownloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        path: path.join(tempDir, "stale.bin"),
        timeoutMs: 1000,
      });
      await Promise.resolve();
      harness.trigger({
        url: () => "https://example.com/stale.bin",
        suggestedFilename: () => "stale.bin",
        saveAs: firstSaveAs,
      });
      await vi.waitFor(() =>
        expect(navigationGuard.assertBrowserNavigationResultAllowed).toHaveBeenCalledOnce(),
      );

      const latestSaveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "latest-content", "utf8");
      });
      const latest = mod.waitForDownloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        path: path.join(tempDir, "latest.bin"),
        timeoutMs: 1000,
      });

      releaseValidation();
      await expect(first).rejects.toThrow("superseded by another waiter");
      expect(firstSaveAs).not.toHaveBeenCalled();

      harness.trigger({
        url: () => "https://example.com/latest.bin",
        suggestedFilename: () => "latest.bin",
        saveAs: latestSaveAs,
      });
      await expect(latest).resolves.toMatchObject({ suggestedFilename: "latest.bin" });
      expect(latestSaveAs).toHaveBeenCalledOnce();
    });
  });

  it("clicks a ref and atomically finalizes explicit download paths", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();

      const click = vi.fn(async () => {});
      setPwToolsCoreCurrentRefLocator({ click });

      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "report-content", "utf8");
      });
      const download = {
        url: () => "https://example.com/report.pdf",
        suggestedFilename: () => "report.pdf",
        saveAs,
      };

      const targetPath = path.join(tempDir, "report.pdf");
      const p = mod.downloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "e12",
        path: targetPath,
        timeoutMs: 1000,
      });

      await Promise.resolve();
      harness.expectArmed();
      expect(click).toHaveBeenCalledWith({ timeout: 1000 });

      harness.trigger(download);

      const res = await p;
      await expectAtomicDownloadSave({ saveAs, targetPath, content: "report-content" });
      await expect(fs.realpath(res.path)).resolves.toBe(await fs.realpath(targetPath));
    });
  });

  it("rejects blocked click download sources before writing the file", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const navigationGuard = getPwToolsCoreNavigationGuardMocks();
      const click = vi.fn(async () => {});
      setPwToolsCoreCurrentRefLocator({ click });
      const targetPath = path.join(tempDir, "blocked.pdf");
      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "private-content", "utf8");
      });
      navigationGuard.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        new Error("Navigation blocked: private IP address"),
      );
      const pending = mod.downloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "e12",
        path: targetPath,
        timeoutMs: 1000,
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger({
        url: () => "http://127.0.0.1/private.pdf",
        suggestedFilename: () => "private.pdf",
        saveAs,
      });

      await expect(pending).rejects.toThrow(/blocked|private|ssrf/i);
      expect(navigationGuard.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
        url: "http://127.0.0.1/private.pdf",
        ssrfPolicy: { allowPrivateNetwork: false },
        browserProxyMode: undefined,
      });
      expect(saveAs).not.toHaveBeenCalled();
      await expectPathMissing(targetPath);
    });
  });

  it("guards the explicit download click before dispatch", async () => {
    const harness = createDownloadEventHarness();
    const blocked = new Error("Navigation blocked: private IP address");
    blocked.name = "SsrFBlockedError";
    const click = vi.fn(async () => {});
    setPwToolsCoreCurrentRefLocator({ click });
    sessionMocks.withPageNavigationRequestGuard.mockRejectedValueOnce(blocked);

    const pending = mod.downloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "e12",
      path: "/tmp/blocked.pdf",
      timeoutMs: 1000,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    await expect(pending).rejects.toThrow(/blocked|private|ssrf/i);
    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    expect(harness.activeHandlerCount()).toBe(0);
  });

  it("keeps the explicit request guard active after the click window", async () => {
    const harness = createDownloadEventHarness();
    const blocked = new Error("Navigation blocked: private IP address");
    blocked.name = "SsrFBlockedError";
    const click = vi.fn(async () => {});
    setPwToolsCoreCurrentRefLocator({ click });
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        onPolicyDenied,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        onPolicyDenied?: (event: { state: "detected"; error: unknown }) => void;
        page: { url: () => string };
      }) => {
        const pending = action(page.url());
        await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
        onPolicyDenied?.({ state: "detected", error: blocked });
        return await pending;
      },
    );

    const pending = mod.downloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "e12",
      path: "/tmp/blocked-delayed.pdf",
      timeoutMs: 1000,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    await expect(pending).rejects.toBe(blocked);
    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledTimes(2);
    expect(harness.activeHandlerCount()).toBe(0);
  });

  it("does not save after a click failure cancels pending URL validation", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const navigationGuard = getPwToolsCoreNavigationGuardMocks();
      let releaseValidation!: () => void;
      const validationPending = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      navigationGuard.assertBrowserNavigationResultAllowed.mockImplementationOnce(
        async () => await validationPending,
      );

      const targetPath = path.join(tempDir, "cancelled.bin");
      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "late-content", "utf8");
      });
      const click = vi.fn(async () => {
        harness.trigger({
          url: () => "https://example.com/cancelled.bin",
          suggestedFilename: () => "cancelled.bin",
          saveAs,
        });
        await Promise.resolve();
        throw new Error("click failed");
      });
      setPwToolsCoreCurrentRefLocator({ click });

      const pending = mod.downloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "e12",
        path: targetPath,
        timeoutMs: 1000,
      });

      await expect(pending).rejects.toThrow("click failed");
      expect(navigationGuard.assertBrowserNavigationResultAllowed).toHaveBeenCalledOnce();
      releaseValidation();
      await Promise.resolve();
      expect(saveAs).not.toHaveBeenCalled();
      await expectPathMissing(targetPath);
    });
  });

  it.runIf(process.platform !== "win32")(
    "replaces an in-root hardlink name without overwriting the outside file",
    async () => {
      await withTempDir(async (tempDir) => {
        const outsidePath = path.join(tempDir, "outside.txt");
        await fs.writeFile(outsidePath, "outside-before", "utf8");
        const linkedPath = path.join(tempDir, "linked.txt");
        await fs.link(outsidePath, linkedPath);

        const harness = createDownloadEventHarness();
        const saveAs = vi.fn(async (outPath: string) => {
          await fs.writeFile(outPath, "download-content", "utf8");
        });
        const p = mod.waitForDownloadViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          path: linkedPath,
          timeoutMs: 1000,
        });

        await Promise.resolve();
        harness.expectArmed();
        harness.trigger({
          url: () => "https://example.com/file.bin",
          suggestedFilename: () => "file.bin",
          saveAs,
        });

        await expect(p).resolves.toMatchObject({ path: linkedPath });
        expect(await fs.readFile(linkedPath, "utf8")).toBe("download-content");
        expect(await fs.readFile(outsidePath, "utf8")).toBe("outside-before");
        expect((await fs.stat(linkedPath)).ino).not.toBe((await fs.stat(outsidePath)).ino);
      });
    },
  );

  it("uses preferred tmp dir when waiting for download without explicit path", async () => {
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw-preferred");
    const { res, outPath } = await waitForImplicitDownloadOutput({
      downloadUrl: "https://example.com/file.bin",
      suggestedFilename: "file.bin",
    });
    expect(typeof outPath).toBe("string");
    const expectedRootedDownloadsDir = path.resolve(
      path.join(path.sep, "tmp", "openclaw-preferred", "downloads"),
    );
    const expectedDownloadsTail = `${path.join("tmp", "openclaw-preferred", "downloads")}${path.sep}`;
    expect(path.dirname(outPath)).toBe(await fs.realpath(expectedRootedDownloadsDir));
    expect(path.basename(outPath)).toContain(path.basename(res.path));
    expect(path.basename(outPath)).toMatch(/\.part$/);
    await expect(fs.readFile(res.path, "utf8")).resolves.toBe("download-content");
    expect(path.normalize(res.path)).toContain(path.normalize(expectedDownloadsTail));
    expect(tmpDirMocks.resolvePreferredOpenClawTmpDir).toHaveBeenCalled();
  });

  it("sanitizes suggested download filenames to prevent traversal escapes", async () => {
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw-preferred");
    const { res, outPath } = await waitForImplicitDownloadOutput({
      downloadUrl: "https://example.com/evil",
      suggestedFilename: "../../../../etc/passwd",
    });
    expect(typeof outPath).toBe("string");
    expect(path.dirname(outPath)).toBe(
      await fs.realpath(
        path.resolve(path.join(path.sep, "tmp", "openclaw-preferred", "downloads")),
      ),
    );
    expect(path.basename(outPath)).toContain(path.basename(res.path));
    expect(path.basename(outPath)).toMatch(/\.part$/);
    await expect(fs.readFile(res.path, "utf8")).resolves.toBe("download-content");
    expect(path.normalize(res.path)).toContain(
      path.normalize(`${path.join("tmp", "openclaw-preferred", "downloads")}${path.sep}`),
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects implicit downloads when the output directory is a symlink",
    async () => {
      await withTempDir(async (tempDir) => {
        const outsideDir = path.join(tempDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.symlink(outsideDir, path.join(tempDir, "downloads"));
        tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue(tempDir);

        const harness = createDownloadEventHarness();
        const saveAs = vi.fn(async (outPath: string) => {
          await fs.writeFile(outPath, "should-not-write", "utf8");
        });

        const p = mod.waitForDownloadViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          timeoutMs: 1000,
        });

        await Promise.resolve();
        harness.expectArmed();
        harness.trigger({
          url: () => "https://example.com/file.bin",
          suggestedFilename: () => "file.bin",
          saveAs,
        });

        await expect(p).rejects.toThrow(/output directory/i);
        expect(saveAs).not.toHaveBeenCalled();
        await expect(fs.readdir(outsideDir)).resolves.toStrictEqual([]);
      });
    },
  );
  it("waits for a matching response and returns its body", async () => {
    let responseHandler: ((resp: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (resp: unknown) => void) => {
      if (event === "response") {
        responseHandler = handler;
      }
    });
    const off = vi.fn();
    setPwToolsCoreCurrentPage({ on, off });

    const bodyBytes = Buffer.from('{"ok":true,"value":123}');
    const resp = {
      url: () => "https://example.com/api/data",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      body: async () => bodyBytes,
    };

    const p = mod.responseBodyViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      url: "**/api/data",
      timeoutMs: 1000,
      maxChars: 10,
    });

    await Promise.resolve();
    if (!responseHandler) {
      throw new Error("expected Playwright response handler");
    }
    responseHandler(resp);

    const res = await p;
    expect(res.url).toBe("https://example.com/api/data");
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true');
    expect(res.truncated).toBe(true);
  });

  it("does not split a surrogate pair when truncating response body text", async () => {
    let responseHandler: ((resp: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (resp: unknown) => void) => {
      if (event === "response") {
        responseHandler = handler;
      }
    });
    const off = vi.fn();
    setPwToolsCoreCurrentPage({ on, off });

    const p = mod.responseBodyViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      url: "**/emoji",
      timeoutMs: 1000,
      maxChars: 1,
    });

    await Promise.resolve();
    if (!responseHandler) {
      throw new Error("expected Playwright response handler");
    }
    responseHandler({
      url: () => "https://example.com/emoji",
      status: () => 200,
      headers: () => ({ "content-type": "text/plain" }),
      body: async () => Buffer.from("🙂B"),
    });

    await expect(p).resolves.toMatchObject({ body: "", truncated: true });
  });

  it("preserves the prefix while bounding decode for a large response", async () => {
    let responseHandler: ((resp: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (resp: unknown) => void) => {
      if (event === "response") {
        responseHandler = handler;
      }
    });
    const off = vi.fn();
    setPwToolsCoreCurrentPage({ on, off });

    const bodyBytes = Buffer.from("x".repeat(500_000));
    const subarray = vi.spyOn(bodyBytes, "subarray");
    const p = mod.responseBodyViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      url: "**/large",
      timeoutMs: 1000,
      maxChars: 10,
    });

    await Promise.resolve();
    if (!responseHandler) {
      throw new Error("expected Playwright response handler");
    }
    responseHandler({
      url: () => "https://example.com/large",
      status: () => 200,
      headers: () => ({ "content-type": "text/plain", "content-length": "500000" }),
      body: async () => bodyBytes,
    });

    await expect(p).resolves.toMatchObject({ body: "x".repeat(10), truncated: true });
    expect(subarray).toHaveBeenCalledWith(0, 40);
  });
});
