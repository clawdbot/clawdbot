// Browser tests cover pw tools core.upload paths plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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

vi.mock("./paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  return {
    ...actual,
    resolveStrictExistingUploadPaths: pathMocks.resolveStrictExistingUploadPaths,
  };
});

installPwToolsCoreTestHooks();
const { armFileUploadViaPlaywright } = await import("./pw-tools-core.downloads.js");

function createFileChooserPageMocks() {
  const fileChooser = { setFiles: vi.fn(async () => {}) };
  const press = vi.fn(async () => {});
  const waitForEvent = vi.fn(async () => fileChooser);
  setPwToolsCoreCurrentPage({
    waitForEvent,
    keyboard: { press },
  });
  return { fileChooser, press };
}

describe("armFileUploadViaPlaywright upload path validation", () => {
  beforeEach(() => {
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: true,
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
    });
  });

  it("sets files using resolved inbound media paths", async () => {
    const { fileChooser } = createFileChooserPageMocks();

    await armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
    });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(fileChooser.setFiles).toHaveBeenCalledWith([
        "/home/user/.openclaw/media/inbound/report.pdf",
      ]);
    });
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
});
