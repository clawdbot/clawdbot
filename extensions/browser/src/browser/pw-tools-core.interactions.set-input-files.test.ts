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
const refLocator = vi.fn(() => {
  if (!locator) {
    throw new Error("test: locator not set");
  }
  return locator;
});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});

const resolveStrictExistingPathsWithinRoot =
  vi.fn<typeof import("./paths.js").resolveStrictExistingPathsWithinRoot>();

vi.mock("./pw-session.js", () => {
  return {
    ensurePageState,
    forceDisconnectPlaywrightForTarget,
    getPageForTargetId,
    refLocator,
    restoreRoleRefsForTarget,
  };
});

vi.mock("./paths.js", () => {
  return {
    DEFAULT_UPLOAD_DIR: "/tmp/openclaw/uploads",
    resolveStrictExistingPathsWithinRoot,
  };
});

const { setInputFilesViaPlaywright } = await import("./pw-tools-core.interactions.js");

function seedSingleLocatorPage(): { setInputFiles: ReturnType<typeof vi.fn> } {
  const setInputFiles = vi.fn(async () => {});
  locator = {
    setInputFiles,
    elementHandle: vi.fn(async () => null),
  };
  page = {
    locator: vi.fn(() => ({ first: () => locator })),
  };
  return { setInputFiles };
}

describe("setInputFilesViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = null;
    locator = null;
    resolveStrictExistingPathsWithinRoot.mockResolvedValue({
      ok: true,
      paths: ["/private/tmp/openclaw/uploads/ok.txt"],
    });
  });

  it("revalidates upload paths and uses resolved canonical paths for inputRef", async () => {
    const { setInputFiles } = seedSingleLocatorPage();

    await setInputFilesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      inputRef: "e7",
      paths: ["/tmp/openclaw/uploads/ok.txt"],
    });

    expect(resolveStrictExistingPathsWithinRoot).toHaveBeenCalledWith({
      rootDir: "/tmp/openclaw/uploads",
      requestedPaths: ["/tmp/openclaw/uploads/ok.txt"],
      scopeLabel: "uploads directory (/tmp/openclaw/uploads)",
    });
    expect(refLocator).toHaveBeenCalledWith(page, "e7");
    expect(setInputFiles).toHaveBeenCalledWith(["/private/tmp/openclaw/uploads/ok.txt"]);
  });

  it("throws and skips setInputFiles when use-time validation fails", async () => {
    resolveStrictExistingPathsWithinRoot.mockResolvedValueOnce({
      ok: false,
      error: "Invalid path: must stay within uploads directory",
    });

    const { setInputFiles } = seedSingleLocatorPage();

    await expect(
      setInputFilesViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        element: "input[type=file]",
        paths: ["/tmp/openclaw/uploads/missing.txt"],
      }),
    ).rejects.toThrow("Invalid path: must stay within uploads directory");

    expect(setInputFiles).not.toHaveBeenCalled();
  });
});
