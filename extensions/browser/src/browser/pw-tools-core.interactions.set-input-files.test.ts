// Browser tests cover pw tools core.interactions.set input files plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.fn();
const stat = vi.fn();
const detectMime = vi.fn();

let page: Record<string, unknown> | null = null;
let locator: Record<string, unknown> | null = null;

const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => ({}));
const restoreRoleRefsForTarget = vi.fn(() => {});
const isBrowserObservedDialogBlockedError = vi.fn(() => false);
const markObservedDialogsHandledRemotelyForPage = vi.fn(() => ({}));
const refLocator = vi.fn(() => {
  if (!locator) {
    throw new Error("test: locator not set");
  }
  return locator;
});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const assertPageNavigationCompletedSafely = vi.fn(async () => {});
const withPageNavigationRequestGuard = vi.fn(
  async ({
    action,
    page: guardedPage,
  }: {
    action: (url: string) => Promise<unknown>;
    page: { url: () => string };
  }) => await action(guardedPage.url()),
);

const resolveStrictExistingUploadPaths =
  vi.fn<typeof import("./paths.js").resolveStrictExistingUploadPaths>();

vi.mock("./pw-session.js", () => {
  return {
    assertPageNavigationCompletedSafely,
    ensurePageState,
    forceDisconnectPlaywrightForTarget,
    getPageForTargetId,
    isBrowserObservedDialogBlockedError,
    markObservedDialogsHandledRemotelyForPage,
    refLocator,
    restoreRoleRefsForTarget,
    isPolicyDenyNavigationError: vi.fn(() => false),
    quarantineBlockedNavigationTarget: vi.fn(async () => {}),
    wasBrowserNavigationSourcePreservedAfterPolicyDenial: vi.fn(() => false),
    withPageNavigationRequestGuard,
  };
});

vi.mock("./paths.js", () => {
  return {
    resolveStrictExistingUploadPaths,
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    readFile,
    stat,
  },
}));

vi.mock("openclaw/plugin-sdk/media-mime", () => ({
  detectMime,
}));

const { setFileChooserFilesViaPlaywright, setInputFilesViaPlaywright } =
  await import("./pw-tools-core.interactions.js");

function seedSingleLocatorPage(): {
  setInputFiles: ReturnType<typeof vi.fn>;
  elementHandle: ReturnType<typeof vi.fn>;
} {
  const setInputFiles = vi.fn(async () => {});
  const elementHandle = vi.fn(async () => {
    throw new Error("manual upload event dispatch is forbidden");
  });
  locator = {
    setInputFiles,
    elementHandle,
  };
  page = {
    locator: vi.fn(() => ({ first: () => locator })),
    url: vi.fn(() => "https://allowed.example/form"),
  };
  return { setInputFiles, elementHandle };
}

describe("setFileChooserFilesViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = {
      url: vi.fn(() => "https://allowed.example/form"),
    };
    locator = null;
    readFile.mockResolvedValue(Buffer.from("upload contents"));
    stat.mockResolvedValue({ size: Buffer.byteLength("upload contents"), mtimeMs: 1700000000000 });
    detectMime.mockResolvedValue("text/plain");
    resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: true,
      paths: ["/private/tmp/openclaw/uploads/ok.txt"],
    });
  });

  it("keeps chooser path handoff for unguarded local sessions", async () => {
    const fileChooser = { setFiles: vi.fn(async () => {}) };

    await setFileChooserFilesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      page: page as never,
      fileChooser: fileChooser as never,
      paths: ["/tmp/openclaw/uploads/ok.txt"],
      timeoutMs: 250,
    });

    expect(resolveStrictExistingUploadPaths).toHaveBeenCalledWith({
      requestedPaths: ["/tmp/openclaw/uploads/ok.txt"],
    });
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(fileChooser.setFiles).toHaveBeenCalledWith(["/private/tmp/openclaw/uploads/ok.txt"], {
      timeout: 250,
    });
  });

  it("converts guarded chooser uploads to payloads before Playwright path handoff", async () => {
    const fileChooser = { setFiles: vi.fn(async () => {}) };

    await setFileChooserFilesViaPlaywright({
      cdpUrl: "https://browser.example/cdp",
      targetId: "T1",
      page: page as never,
      fileChooser: fileChooser as never,
      paths: ["/tmp/openclaw/uploads/ok.txt"],
      timeoutMs: 250,
      ssrfPolicy: {},
    });

    expect(stat).toHaveBeenCalledWith("/private/tmp/openclaw/uploads/ok.txt");
    expect(readFile).toHaveBeenCalledWith("/private/tmp/openclaw/uploads/ok.txt");
    expect(fileChooser.setFiles).toHaveBeenCalledWith(
      [
        {
          name: "ok.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("upload contents"),
          lastModifiedMs: 1700000000000,
        },
      ],
      { timeout: 250 },
    );
  });
});

describe("setInputFilesViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = null;
    locator = null;
    readFile.mockResolvedValue(Buffer.from("upload contents"));
    stat.mockResolvedValue({ size: Buffer.byteLength("upload contents"), mtimeMs: 1700000000000 });
    detectMime.mockResolvedValue("text/plain");
    resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: true,
      paths: ["/private/tmp/openclaw/uploads/ok.txt"],
    });
  });

  it("sets resolved files once and leaves browser events to Playwright", async () => {
    const { setInputFiles, elementHandle } = seedSingleLocatorPage();

    await setInputFilesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      inputRef: "e7",
      paths: ["/tmp/openclaw/uploads/ok.txt"],
    });

    expect(resolveStrictExistingUploadPaths).toHaveBeenCalledWith({
      requestedPaths: ["/tmp/openclaw/uploads/ok.txt"],
    });
    expect(refLocator).toHaveBeenCalledWith(page, "e7");
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(detectMime).not.toHaveBeenCalled();
    expect(setInputFiles).toHaveBeenCalledWith(["/private/tmp/openclaw/uploads/ok.txt"]);
    expect(setInputFiles).toHaveBeenCalledTimes(1);
    expect(elementHandle).not.toHaveBeenCalled();
  });

  it("converts guarded remote uploads to payloads before Playwright path handoff", async () => {
    const { setInputFiles, elementHandle } = seedSingleLocatorPage();

    await setInputFilesViaPlaywright({
      cdpUrl: "https://browser.example/cdp",
      targetId: "T1",
      inputRef: "e7",
      paths: ["/tmp/openclaw/uploads/ok.txt"],
      ssrfPolicy: {},
    });

    expect(stat).toHaveBeenCalledWith("/private/tmp/openclaw/uploads/ok.txt");
    expect(readFile).toHaveBeenCalledWith("/private/tmp/openclaw/uploads/ok.txt");
    expect(detectMime).toHaveBeenCalledWith({
      buffer: Buffer.from("upload contents"),
      filePath: "/private/tmp/openclaw/uploads/ok.txt",
    });
    expect(setInputFiles).toHaveBeenCalledWith([
      {
        name: "ok.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("upload contents"),
        lastModifiedMs: 1700000000000,
      },
    ]);
    expect(setInputFiles).toHaveBeenCalledTimes(1);
    expect(elementHandle).not.toHaveBeenCalled();
  });

  it("falls back to an octet-stream payload when mime detection has no answer", async () => {
    detectMime.mockResolvedValueOnce(undefined);
    const { setInputFiles } = seedSingleLocatorPage();

    await setInputFilesViaPlaywright({
      cdpUrl: "https://browser.example/cdp",
      targetId: "T1",
      inputRef: "e7",
      paths: ["/tmp/openclaw/uploads/ok.txt"],
      ssrfPolicy: {},
    });

    expect(setInputFiles).toHaveBeenCalledWith([
      {
        name: "ok.txt",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("upload contents"),
        lastModifiedMs: 1700000000000,
      },
    ]);
  });

  it("checks the Playwright aggregate payload size cap before reading guarded remote upload files", async () => {
    stat.mockResolvedValueOnce({ size: 50 * 1024 * 1024 });
    const { setInputFiles } = seedSingleLocatorPage();

    await expect(
      setInputFilesViaPlaywright({
        cdpUrl: "https://browser.example/cdp",
        targetId: "T1",
        inputRef: "e7",
        paths: ["/tmp/openclaw/uploads/too-large.bin"],
        ssrfPolicy: {},
      }),
    ).rejects.toThrow("Cannot set buffer larger than 50Mb");

    expect(readFile).not.toHaveBeenCalled();
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it("allows a guarded remote upload below the aggregate payload cap", async () => {
    stat.mockResolvedValueOnce({ size: 50 * 1024 * 1024 - 1, mtimeMs: 1700000000000 });
    const { setInputFiles } = seedSingleLocatorPage();

    await setInputFilesViaPlaywright({
      cdpUrl: "https://browser.example/cdp",
      targetId: "T1",
      inputRef: "e7",
      paths: ["/tmp/openclaw/uploads/limit.bin"],
      ssrfPolicy: {},
    });

    expect(readFile).toHaveBeenCalledWith("/private/tmp/openclaw/uploads/ok.txt");
    expect(setInputFiles).toHaveBeenCalledWith([
      {
        name: "ok.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("upload contents"),
        lastModifiedMs: 1700000000000,
      },
    ]);
  });

  it("checks the aggregate cap across multiple guarded remote upload payloads", async () => {
    stat
      .mockResolvedValueOnce({ size: 30 * 1024 * 1024, mtimeMs: 1700000000000 })
      .mockResolvedValueOnce({ size: 30 * 1024 * 1024, mtimeMs: 1700000001000 });
    resolveStrictExistingUploadPaths.mockResolvedValueOnce({
      ok: true,
      paths: ["/private/tmp/openclaw/uploads/one.txt", "/private/tmp/openclaw/uploads/two.txt"],
    });
    const { setInputFiles } = seedSingleLocatorPage();

    await expect(
      setInputFilesViaPlaywright({
        cdpUrl: "https://browser.example/cdp",
        targetId: "T1",
        inputRef: "e7",
        paths: ["/tmp/openclaw/uploads/one.txt", "/tmp/openclaw/uploads/two.txt"],
        ssrfPolicy: {},
      }),
    ).rejects.toThrow("Cannot set buffer larger than 50Mb");

    expect(readFile).not.toHaveBeenCalled();
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it("keeps guarded loopback uploads as path handoffs inside the browser policy guard", async () => {
    const { setInputFiles } = seedSingleLocatorPage();

    await setInputFilesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      browserFilesystemLocal: true,
      targetId: "T1",
      inputRef: "e7",
      paths: ["/tmp/openclaw/uploads/ok.txt"],
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(detectMime).not.toHaveBeenCalled();
    expect(setInputFiles).toHaveBeenCalledWith(["/private/tmp/openclaw/uploads/ok.txt"]);
    expect(withPageNavigationRequestGuard).toHaveBeenCalledTimes(1);
    expect(setInputFiles).toHaveBeenCalledTimes(1);
    expect(assertPageNavigationCompletedSafely).toHaveBeenCalledTimes(1);
  });

  it("converts guarded loopback uploads to payloads when the browser filesystem is remote", async () => {
    const { setInputFiles, elementHandle } = seedSingleLocatorPage();

    await setInputFilesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      browserFilesystemLocal: false,
      targetId: "T1",
      inputRef: "e7",
      paths: ["/tmp/openclaw/uploads/ok.txt"],
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    expect(stat).toHaveBeenCalledWith("/private/tmp/openclaw/uploads/ok.txt");
    expect(readFile).toHaveBeenCalledWith("/private/tmp/openclaw/uploads/ok.txt");
    expect(detectMime).toHaveBeenCalledWith({
      buffer: Buffer.from("upload contents"),
      filePath: "/private/tmp/openclaw/uploads/ok.txt",
    });
    expect(setInputFiles).toHaveBeenCalledWith([
      {
        name: "ok.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("upload contents"),
        lastModifiedMs: 1700000000000,
      },
    ]);
    expect(withPageNavigationRequestGuard).toHaveBeenCalledTimes(1);
    expect(setInputFiles).toHaveBeenCalledTimes(1);
    expect(elementHandle).not.toHaveBeenCalled();
  });

  it("throws and skips setInputFiles when use-time validation fails", async () => {
    resolveStrictExistingUploadPaths.mockResolvedValueOnce({
      ok: false,
      error: "Invalid path: must stay within inbound media directory",
    });

    const { setInputFiles } = seedSingleLocatorPage();

    await expect(
      setInputFilesViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        element: "input[type=file]",
        paths: ["/tmp/openclaw/uploads/missing.txt"],
      }),
    ).rejects.toThrow("Invalid path: must stay within inbound media directory");

    expect(setInputFiles).not.toHaveBeenCalled();
  });
});
