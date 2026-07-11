// Browser tests cover pw tools core.interactions.set input files plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const resolveStrictExistingUploadPaths =
  vi.fn<typeof import("./paths.js").resolveStrictExistingUploadPaths>();

vi.mock("./pw-session.js", () => {
  return {
    ensurePageState,
    forceDisconnectPlaywrightForTarget,
    getPageForTargetId,
    isBrowserObservedDialogBlockedError,
    markObservedDialogsHandledRemotelyForPage,
    refLocator,
    restoreRoleRefsForTarget,
    wasBrowserNavigationSourcePreservedAfterPolicyDenial: vi.fn(() => false),
    withPageNavigationRequestGuard: vi.fn(
      async ({
        action,
        page: guardedPage,
      }: {
        action: (url: string) => Promise<unknown>;
        page: { url: () => string };
      }) => await action(guardedPage.url()),
    ),
  };
});

vi.mock("./paths.js", () => {
  return {
    resolveStrictExistingUploadPaths,
  };
});

const { setInputFilesViaPlaywright } = await import("./pw-tools-core.interactions.js");

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
  };
  return { setInputFiles, elementHandle };
}

describe("setInputFilesViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = null;
    locator = null;
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
    expect(setInputFiles).toHaveBeenCalledWith(["/private/tmp/openclaw/uploads/ok.txt"]);
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
