// Browser tests cover register.files downloads plugin behavior.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliSharedModule from "../browser-cli-shared.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";
import * as cliCoreApiModule from "../core-api.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    (
      _opts: unknown,
      req: { path?: string },
      extra?: { timeoutMs?: number },
    ) => Promise<Record<string, unknown>>
  >(async (_opts: unknown, req: { path?: string }) =>
    req.path === "/wait/download" || req.path === "/download"
      ? { download: { path: "/tmp/openclaw/downloads/file.txt" } }
      : { ok: true },
  ),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);
vi.spyOn(cliCoreApiModule, "resolveExistingUploadPaths").mockResolvedValue({
  ok: true,
  paths: ["/tmp/openclaw/uploads/a.pdf", "/tmp/openclaw/uploads/b.pdf"],
});

const { registerBrowserActionInputCommands } = await import("./register.js");

function createActionInputProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionInputCommands(browser, parentOpts);
  return program;
}

function getLastRequestOptions(): { timeoutMs?: number } | undefined {
  return mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as { timeoutMs?: number } | undefined;
}

describe("browser action input file/download commands", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    vi.mocked(cliCoreApiModule.resolveExistingUploadPaths).mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    getBrowserCliRuntime().exit.mockImplementation(() => {});
  });

  it("arms uploads with normalized paths and element targeting options", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "upload",
        "/tmp/openclaw/uploads/a.pdf",
        "media://inbound/b",
        "--input-ref",
        "file-input",
        "--element",
        "input[type=file]",
        "--target-id",
        "tab-1",
        "--timeout-ms",
        "45000",
      ],
      { from: "user" },
    );

    expect(cliCoreApiModule.resolveExistingUploadPaths).toHaveBeenCalledWith({
      requestedPaths: ["/tmp/openclaw/uploads/a.pdf", "media://inbound/b"],
    });
    const request = mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as
      | { path?: string; body?: Record<string, unknown> }
      | undefined;
    expect(request).toMatchObject({
      path: "/hooks/file-chooser",
      body: {
        paths: ["/tmp/openclaw/uploads/a.pdf", "/tmp/openclaw/uploads/b.pdf"],
        inputRef: "file-input",
        element: "input[type=file]",
        targetId: "tab-1",
        timeoutMs: 45000,
      },
    });
    expect(getLastRequestOptions()?.timeoutMs).toBeGreaterThan(45000);
  });

  it("keeps the outer waitfordownload request open for the advertised default wait", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "waitfordownload"], { from: "user" });

    expect(getLastRequestOptions()?.timeoutMs).toBeGreaterThan(120000);
  });

  it("accepts signed and zero-padded download timeouts", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "waitfordownload", "--timeout-ms", "+025000"], {
      from: "user",
    });

    expect(getLastRequestOptions()?.timeoutMs).toBeGreaterThan(25_000);
  });

  it("uses custom download timeouts as the inner wait plus outer slack", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      ["browser", "download", "ref-1", "file.txt", "--timeout-ms", "25000"],
      {
        from: "user",
      },
    );

    expect(getLastRequestOptions()?.timeoutMs).toBeGreaterThan(25000);
  });

  it("rejects non-decimal file and download timeouts before dispatch", async () => {
    const downloadProgram = createActionInputProgram();
    await expect(
      downloadProgram.parseAsync(
        ["browser", "download", "ref-1", "file.txt", "--timeout-ms", "1e3"],
        { from: "user" },
      ),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");

    const waitProgram = createActionInputProgram();
    await expect(
      waitProgram.parseAsync(["browser", "waitfordownload", "--timeout-ms", "0x1000"], {
        from: "user",
      }),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("rejects conflicting dialog actions without arming the hook", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "dialog", "--accept", "--dismiss"], { from: "user" });

    const errorCall = getBrowserCliRuntime().error.mock.calls.at(-1);
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(String(errorCall?.[0])).toContain("Specify only one of --accept or --dismiss");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });
});
