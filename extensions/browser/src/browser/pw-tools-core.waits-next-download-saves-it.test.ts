import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

  async function waitForImplicitDownloadOutput(params: {
    downloadUrl: string;
    suggestedFilename: string;
  }) {
    const harness = createDownloadEventHarness();
    const saveAs = vi.fn(async () => {});

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
    const outPath = (vi.mocked(saveAs).mock.calls as unknown as Array<[string]>)[0]?.[0];
    if (typeof outPath !== "string") {
      throw new Error("download save path was not captured");
    }
    return { res, outPath };
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
    tempDir: string;
    content: string;
  }) {
    const savedPath = params.saveAs.mock.calls[0]?.[0];
    expect(typeof savedPath).toBe("string");
    expect(savedPath).not.toBe(params.targetPath);
    const [savedDirReal, tempDirReal] = await Promise.all([
      fs.realpath(path.dirname(String(savedPath))).catch(() => path.dirname(String(savedPath))),
      fs.realpath(params.tempDir).catch(() => params.tempDir),
    ]);
    expect(savedDirReal).toBe(tempDirReal);
    expect(path.basename(String(savedPath))).toContain(".openclaw-output-");
    expect(path.basename(String(savedPath))).toContain(".part");
    expect(await fs.readFile(params.targetPath, "utf8")).toBe(params.content);
  }

  it("waits for the next download and atomically finalizes explicit output paths", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const targetPath = path.join(tempDir, "file.bin");

      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "file-content", "utf8");
      });
      const download = {
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
      await expectAtomicDownloadSave({ saveAs, targetPath, tempDir, content: "file-content" });
      await expect(fs.realpath(res.path)).resolves.toBe(await fs.realpath(targetPath));
    });
  });

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
      saveAs: vi.fn(async () => {}),
    });

    await p;
    expect(state.downloadWaiterDepth).toBe(0);
    expect(harness.activeHandlerCount()).toBe(0);
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
      await expectAtomicDownloadSave({ saveAs, targetPath, tempDir, content: "report-content" });
      await expect(fs.realpath(res.path)).resolves.toBe(await fs.realpath(targetPath));
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not overwrite outside files when explicit output path is a hardlink alias",
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

        await expect(p).rejects.toThrow(/alias escape blocked|Hardlinked path is not allowed/i);
        expect(await fs.readFile(linkedPath, "utf8")).toBe("outside-before");
        expect(await fs.readFile(outsidePath, "utf8")).toBe("outside-before");
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
    expect(path.dirname(outPath)).toBe(expectedRootedDownloadsDir);
    expect(path.basename(outPath)).toMatch(/-file\.bin$/);
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
      path.resolve(path.join(path.sep, "tmp", "openclaw-preferred", "downloads")),
    );
    expect(path.basename(outPath)).toMatch(/-passwd$/);
    expect(path.normalize(res.path)).toContain(
      path.normalize(`${path.join("tmp", "openclaw-preferred", "downloads")}${path.sep}`),
    );
  });
  it("waits for a matching response and returns its body", async () => {
    let responseHandler: ((resp: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (resp: unknown) => void) => {
      if (event === "response") {
        responseHandler = handler;
      }
    });
    const off = vi.fn();
    setPwToolsCoreCurrentPage({ on, off });

    const resp = {
      url: () => "https://example.com/api/data",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      text: async () => '{"ok":true,"value":123}',
    };

    const p = mod.responseBodyViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      url: "**/api/data",
      timeoutMs: 1000,
      maxChars: 10,
    });

    await Promise.resolve();
    expect(responseHandler).toBeDefined();
    responseHandler?.(resp);

    const res = await p;
    expect(res.url).toBe("https://example.com/api/data");
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true');
    expect(res.truncated).toBe(true);
  });
});
