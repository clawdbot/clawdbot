import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

const pathMocks = vi.hoisted(() => ({
  resolveStrictExistingUploadPaths:
    vi.fn<
      (args: {
        requestedPaths: string[];
      }) => Promise<{ ok: true; paths: string[] } | { ok: false; error: string }>
    >(),
}));

const interactionMocks = vi.hoisted(() => ({
  clickViaPlaywright: vi.fn<(opts: { signal?: AbortSignal }) => Promise<void>>(async () => {}),
}));

vi.mock("./paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  return {
    ...actual,
    resolveStrictExistingUploadPaths: pathMocks.resolveStrictExistingUploadPaths,
  };
});

vi.mock("./pw-tools-core.interactions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-tools-core.interactions.js")>()),
  ...interactionMocks,
}));

installPwToolsCoreTestHooks();
const sessionMocks = getPwToolsCoreSessionMocks();
const { armFileUploadViaPlaywright, uploadViaPlaywright } =
  await import("./pw-tools-core.downloads.js");

function createFileChooserPageMocks() {
  const element = vi.fn(async () => {
    throw new Error("manual upload event dispatch is forbidden");
  });
  const fileChooser = { setFiles: vi.fn(async () => {}), element };
  const press = vi.fn(async () => {});
  const waitForEvent = vi.fn(async () => fileChooser);
  setPwToolsCoreCurrentPage({
    waitForEvent,
    keyboard: { press },
  });
  return { fileChooser, press };
}

function nativeAbortError(signal: AbortSignal) {
  return Object.assign(new Error("Operation aborted", { cause: signal.reason }), {
    name: "AbortError",
  });
}

function createAtomicFileChooserPageMocks() {
  const fileChooser = {
    setFiles: vi.fn<
      (paths: string[], options: { timeout?: number; signal: AbortSignal }) => Promise<void>
    >(async () => {}),
  };
  const events = new EventEmitter();
  const waitForEvent = vi.fn(
    async (_event: string, { signal }: { signal: AbortSignal }) =>
      await new Promise<typeof fileChooser>((resolve, reject) => {
        const cleanup = () => {
          events.off("filechooser", onChooser);
          signal.removeEventListener("abort", onAbort);
        };
        const onChooser = (chooser: typeof fileChooser) => {
          cleanup();
          resolve(chooser);
        };
        const onAbort = () => {
          cleanup();
          reject(nativeAbortError(signal));
        };
        events.once("filechooser", onChooser);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      }),
  );
  const press = vi.fn(async () => {});
  const currentPage = { waitForEvent, keyboard: { press } };
  setPwToolsCoreCurrentPage(currentPage);
  return {
    currentPage,
    emitChooser: (observed = fileChooser) => {
      events.emit("filechooser", observed);
    },
    fileChooser,
    listenerCount: () => events.listenerCount("filechooser"),
    press,
  };
}

describe("armFileUploadViaPlaywright upload path validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    interactionMocks.clickViaPlaywright.mockReset().mockResolvedValue(undefined);
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: true,
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
    });
  });

  it("sets resolved files once and leaves browser events to Playwright", async () => {
    const { fileChooser } = createFileChooserPageMocks();

    await armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
    });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(fileChooser.setFiles).toHaveBeenCalledWith(
        ["/home/user/.openclaw/media/inbound/report.pdf"],
        { timeout: expect.any(Number), signal: expect.any(AbortSignal) },
      );
    });
    expect(fileChooser.setFiles).toHaveBeenCalledTimes(1);
    expect(fileChooser.element).not.toHaveBeenCalled();
  });

  it("escapes the chooser when paths are outside managed upload roots", async () => {
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: false,
      error: "Invalid path: must stay within inbound media directory",
    });
    const { fileChooser, press } = createFileChooserPageMocks();

    await armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/etc/passwd"],
    });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(press).toHaveBeenCalledWith("Escape");
    });
    expect(fileChooser.setFiles).not.toHaveBeenCalled();
  });

  it("awaits synchronous chooser dispatch and file assignment", async () => {
    const page = createAtomicFileChooserPageMocks();
    let finishSetFiles!: () => void;
    page.fileChooser.setFiles.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishSetFiles = resolve;
        }),
    );
    interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());

    let settled = false;
    const upload = uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "e12",
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
    }).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1));
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedPage: page.currentPage }),
    );
    expect(page.fileChooser.setFiles).toHaveBeenCalledWith(
      ["/home/user/.openclaw/media/inbound/report.pdf"],
      { timeout: expect.any(Number), signal: expect.any(AbortSignal) },
    );
    expect(settled).toBe(false);
    finishSetFiles();
    await upload;
    expect(page.listenerCount()).toBe(0);
  });

  it("accepts only the first chooser emitted by the guarded click", async () => {
    const page = createAtomicFileChooserPageMocks();
    const unrelatedChooser = { setFiles: vi.fn(async () => {}) };
    interactionMocks.clickViaPlaywright.mockImplementation(async () => {
      page.emitChooser();
      page.emitChooser(unrelatedChooser);
    });

    await uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      ref: "e12",
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
    });

    expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1);
    expect(unrelatedChooser.setFiles).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
  });

  it("removes the chooser listener when the guarded click fails", async () => {
    const page = createAtomicFileChooserPageMocks();
    interactionMocks.clickViaPlaywright.mockRejectedValue(new Error("stale ref"));

    await expect(
      uploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        ref: "e12",
        paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
      }),
    ).rejects.toThrow("stale ref");

    page.emitChooser();
    expect(page.listenerCount()).toBe(0);
    expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
  });

  it("propagates strict path revalidation failures", async () => {
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: false,
      error: "Invalid path: upload target changed",
    });
    const page = createAtomicFileChooserPageMocks();
    interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());

    await expect(
      uploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        ref: "e12",
        paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
      }),
    ).rejects.toThrow("Invalid path: upload target changed");
    expect(page.press).not.toHaveBeenCalled();
    expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
  });

  it("propagates file assignment failures", async () => {
    const page = createAtomicFileChooserPageMocks();
    page.fileChooser.setFiles.mockRejectedValue(new Error("setFiles failed"));
    interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());

    await expect(
      uploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        ref: "e12",
        paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
      }),
    ).rejects.toThrow("setFiles failed");
    expect(page.listenerCount()).toBe(0);
  });

  it("times out without leaving a chooser listener", async () => {
    vi.useFakeTimers();
    try {
      const page = createAtomicFileChooserPageMocks();
      const upload = uploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        ref: "e12",
        paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
        timeoutMs: 500,
      });
      const rejection = expect(upload).rejects.toThrow(
        "Timeout 500ms exceeded while completing file upload",
      );

      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      page.emitChooser();
      expect(page.listenerCount()).toBe(0);
      expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
      expect(sessionMocks.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds file assignment by the same request deadline", async () => {
    vi.useFakeTimers();
    try {
      const page = createAtomicFileChooserPageMocks();
      page.fileChooser.setFiles.mockImplementation(
        async (_paths, options) =>
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(nativeAbortError(options.signal)),
              { once: true },
            );
          }),
      );
      interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());
      const upload = uploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        ref: "e12",
        paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
        timeoutMs: 500,
      });
      const rejection = expect(upload).rejects.toThrow(
        "Timeout 500ms exceeded while completing file upload",
      );

      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(page.press).not.toHaveBeenCalled();
      expect(page.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds strict path revalidation by the same request deadline", async () => {
    vi.useFakeTimers();
    try {
      const page = createAtomicFileChooserPageMocks();
      pathMocks.resolveStrictExistingUploadPaths.mockImplementation(
        async () => await new Promise(() => {}),
      );
      interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());
      const upload = uploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        ref: "e12",
        paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
        timeoutMs: 500,
      });
      const rejection = expect(upload).rejects.toThrow(
        "Timeout 500ms exceeded while completing file upload",
      );

      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(page.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins native cancellation before another upload on the same page starts", async () => {
    const page = createAtomicFileChooserPageMocks();
    let firstSignal: AbortSignal | undefined;
    let finishCancellation!: () => void;
    page.fileChooser.setFiles
      .mockImplementationOnce(
        async (_paths, options) =>
          await new Promise<void>((_resolve, reject) => {
            firstSignal = options.signal;
            finishCancellation = () => reject(nativeAbortError(options.signal));
          }),
      )
      .mockResolvedValueOnce(undefined);
    interactionMocks.clickViaPlaywright
      .mockImplementationOnce(async () => page.emitChooser())
      .mockImplementationOnce(async () => page.emitChooser());

    const first = uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "e1",
      paths: ["/home/user/.openclaw/media/inbound/first.pdf"],
    });
    await vi.waitFor(() => expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1));
    const second = uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "e2",
      paths: ["/home/user/.openclaw/media/inbound/second.pdf"],
    });

    const firstRejection = expect(first).rejects.toThrow("superseded by another waiter");
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1);
    finishCancellation();
    await firstRejection;
    await second;
    expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(2);
    expect(page.listenerCount()).toBe(0);
  });

  it("preserves the cleanup tail when a queued owner aborts", async () => {
    const page = createAtomicFileChooserPageMocks();
    let firstSignal: AbortSignal | undefined;
    let finishCancellation!: () => void;
    page.fileChooser.setFiles
      .mockImplementationOnce(
        async (_paths, options) =>
          await new Promise<void>((_resolve, reject) => {
            firstSignal = options.signal;
            finishCancellation = () => reject(nativeAbortError(options.signal));
          }),
      )
      .mockResolvedValueOnce(undefined);
    interactionMocks.clickViaPlaywright
      .mockImplementationOnce(async () => page.emitChooser())
      .mockImplementationOnce(async () => page.emitChooser());

    const first = uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      ref: "e1",
      paths: ["/home/user/.openclaw/media/inbound/first.pdf"],
    });
    const firstRejection = expect(first).rejects.toThrow("superseded by another waiter");
    await vi.waitFor(() => expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1));

    const secondController = new AbortController();
    const second = uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      ref: "e2",
      paths: ["/home/user/.openclaw/media/inbound/second.pdf"],
      signal: secondController.signal,
    });
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
    secondController.abort(new Error("queued upload aborted"));
    await expect(second).rejects.toThrow("queued upload aborted");

    const third = uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      ref: "e3",
      paths: ["/home/user/.openclaw/media/inbound/third.pdf"],
    });
    await Promise.resolve();
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1);

    finishCancellation();
    await firstRejection;
    await third;
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(2);
    expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(2);
    expect(page.listenerCount()).toBe(0);
  });

  it("waits for a superseded click to settle before arming the next chooser", async () => {
    const page = createAtomicFileChooserPageMocks();
    let finishFirstClick!: () => void;
    interactionMocks.clickViaPlaywright
      .mockImplementationOnce(
        async () =>
          await new Promise<void>((resolve) => {
            finishFirstClick = () => {
              page.emitChooser();
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async () => page.emitChooser());

    const first = uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      ref: "e1",
      paths: ["/home/user/.openclaw/media/inbound/first.pdf"],
    });
    await vi.waitFor(() => expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1));
    const second = uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      ref: "e2",
      paths: ["/home/user/.openclaw/media/inbound/second.pdf"],
    });
    await Promise.resolve();
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1);

    finishFirstClick();
    await expect(first).rejects.toThrow("superseded by another waiter");
    await second;
    expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1);
    expect(page.press).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
  });

  it("aborts without leaving a chooser listener", async () => {
    const page = createAtomicFileChooserPageMocks();
    const controller = new AbortController();
    const upload = uploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      ref: "e12",
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1));
    controller.abort(new Error("request aborted"));
    await expect(upload).rejects.toThrow("request aborted");
    page.emitChooser();
    expect(page.listenerCount()).toBe(0);
    expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
    expect(sessionMocks.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
  });
});
