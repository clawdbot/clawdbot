import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";

const outputMocks = vi.hoisted(() => ({
  writeExternalFileWithinOutputRoot: vi.fn(),
}));

vi.mock("./output-files.js", () => outputMocks);

describe("createDownloadCaptureForPage", () => {
  beforeEach(() => {
    outputMocks.writeExternalFileWithinOutputRoot.mockReset();
  });

  it("hands off the deadline before atomic output finalization", async () => {
    let releaseFinalize = () => {};
    const finalizeReleased = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    let markFinalizeStarted = () => {};
    const finalizeStarted = new Promise<void>((resolve) => {
      markFinalizeStarted = resolve;
    });
    outputMocks.writeExternalFileWithinOutputRoot.mockImplementation(
      async (params: {
        path: string;
        write: (tempPath: string) => Promise<void>;
      }): Promise<string> => {
        await params.write(`${params.path}.part`);
        markFinalizeStarted();
        await finalizeReleased;
        return params.path;
      },
    );

    const handlers = new Set<(download: unknown) => void>();
    const page = {
      on: (_event: string, handler: (download: unknown) => void) => handlers.add(handler),
      off: (_event: string, handler: (download: unknown) => void) => handlers.delete(handler),
    };
    const state = { downloadWaiterDepth: 0 };
    const cancel = vi.fn(async () => {});
    const capture = createDownloadCaptureForPage(page as never, state, 50, {
      outputPath: "/tmp/download.bin",
    });

    for (const handler of handlers) {
      handler({
        cancel,
        saveAs: vi.fn(async () => {}),
        suggestedFilename: () => "download.bin",
      });
    }
    await finalizeStarted;

    const outcome = await Promise.race([
      capture.promise.then(
        () => "settled",
        () => "settled",
      ),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    expect(outcome).toBe("pending");
    expect(cancel).not.toHaveBeenCalled();

    releaseFinalize();
    await expect(capture.promise).resolves.toMatchObject({ path: "/tmp/download.bin" });
    expect(state.downloadWaiterDepth).toBe(0);
    expect(handlers.size).toBe(0);
  });

  it("preserves an already-captured save when its passive owner stops waiting", async () => {
    let releaseSave = () => {};
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let markSaveStarted = () => {};
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    outputMocks.writeExternalFileWithinOutputRoot.mockImplementation(
      async (params: {
        path: string;
        write: (tempPath: string) => Promise<void>;
      }): Promise<string> => {
        await params.write(`${params.path}.part`);
        return params.path;
      },
    );

    const handlers = new Set<(download: unknown) => void>();
    const page = {
      on: (_event: string, handler: (download: unknown) => void) => handlers.add(handler),
      off: (_event: string, handler: (download: unknown) => void) => handlers.delete(handler),
    };
    const state = { downloadWaiterDepth: 0 };
    const cancel = vi.fn(async () => {});
    const capture = createDownloadCaptureForPage(page as never, state, 50);

    for (const handler of handlers) {
      handler({
        cancel,
        saveAs: vi.fn(async () => {
          markSaveStarted();
          await saveReleased;
        }),
        suggestedFilename: () => "download.bin",
      });
    }
    await saveStarted;
    capture.cancel();

    const outcome = await Promise.race([
      capture.promise.then(
        () => "settled",
        () => "settled",
      ),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    expect(outcome).toBe("pending");
    expect(cancel).not.toHaveBeenCalled();

    releaseSave();
    await expect(capture.promise).resolves.toMatchObject({
      suggestedFilename: "download.bin",
    });
  });
});
