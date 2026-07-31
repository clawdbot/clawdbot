// Browser tests cover browser cli actions observe plugin behavior.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliSharedModule from "./browser-cli-shared.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "./browser-cli.test-support.js";
import * as cliCoreApiModule from "./core-api.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    (
      opts?: unknown,
      req?: unknown,
      extra?: { timeoutMs?: number },
    ) => Promise<Record<string, unknown>>
  >(async () => ({ response: { body: "ok" } })),
}));

const extractMocks = vi.hoisted(() => ({
  completeBrowserExtract: vi.fn(async () => ({
    content: [{ type: "text" as const, text: "[analyzed by test/model]\nThe answer." }],
    details: {
      url: "https://example.com",
      chars: 12,
      truncated: false,
      model: "test/model",
    },
  })),
  resolveBrowserExtractTimeoutMs: vi.fn(() => 60_000),
  validateBrowserExtractSchema: vi.fn(() => undefined),
}));

vi.mock("../browser-extract.js", () => extractMocks);

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserActionObserveCommands } = await import("./browser-cli-actions-observe.js");

function createActionObserveProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionObserveCommands(browser, parentOpts);
  return program;
}

describe("browser action observe commands", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    extractMocks.completeBrowserExtract.mockClear();
    extractMocks.resolveBrowserExtractTimeoutMs.mockClear();
    extractMocks.validateBrowserExtractSchema.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("captures page content privately and prints only the extracted answer", async () => {
    mocks.callBrowserRequest.mockResolvedValueOnce({
      ok: true,
      targetId: "t1",
      url: "https://example.com",
      html: "<main>Private page body</main>",
    });
    const program = createActionObserveProgram();

    await program.parseAsync(["browser", "extract", "What is the answer?", "--target-id", "t1"], {
      from: "user",
    });

    expect(mocks.callBrowserRequest).toHaveBeenCalledWith(
      expect.objectContaining({ json: false }),
      {
        method: "POST",
        path: "/extract",
        query: undefined,
        body: { targetId: "t1", timeoutMs: 60_000 },
      },
      { timeoutMs: 60_000 },
    );
    expect(extractMocks.completeBrowserExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        html: "<main>Private page body</main>",
        query: "What is the answer?",
        agentId: "main",
      }),
    );
    expect(getBrowserCliRuntimeCapture().runtimeLogs.join("\n")).toContain("The answer.");
    expect(getBrowserCliRuntimeCapture().runtimeLogs.join("\n")).not.toContain("Private page body");
  });

  it("passes extract scoping and structured-output flags through", async () => {
    mocks.callBrowserRequest.mockResolvedValueOnce({
      ok: true,
      targetId: "t1",
      url: "https://example.com",
      html: "<main>Scoped page body</main>",
    });
    const program = createActionObserveProgram();

    await program.parseAsync(
      [
        "browser",
        "extract",
        "What is the answer?",
        "--selector",
        "main",
        "--ignore-selector",
        "nav",
        "--ignore-selector",
        ".ad",
        "--schema",
        '{"type":"object"}',
      ],
      { from: "user" },
    );

    expect(mocks.callBrowserRequest).toHaveBeenCalledWith(
      expect.objectContaining({ json: false }),
      expect.objectContaining({
        body: expect.objectContaining({
          selector: "main",
          ignoreSelectors: ["nav", ".ad"],
        }),
      }),
      { timeoutMs: 60_000 },
    );
    expect(extractMocks.completeBrowserExtract).toHaveBeenCalledWith(
      expect.objectContaining({ schema: { type: "object" } }),
    );
  });

  it("passes a successful empty capture to extraction", async () => {
    mocks.callBrowserRequest.mockResolvedValueOnce({
      ok: true,
      targetId: "t1",
      url: "https://example.com",
      html: "",
    });
    const program = createActionObserveProgram();

    await program.parseAsync(["browser", "extract", "What is present?"], { from: "user" });

    expect(extractMocks.completeBrowserExtract).toHaveBeenCalledWith(
      expect.objectContaining({ html: "" }),
    );
  });

  it("rejects non-decimal responsebody numeric flags before dispatch", async () => {
    const program = createActionObserveProgram();

    await expect(
      program.parseAsync(["browser", "responsebody", "**/api", "--timeout-ms", "1e3"], {
        from: "user",
      }),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
    await expect(
      program.parseAsync(["browser", "responsebody", "**/api", "--max-chars", "-1"], {
        from: "user",
      }),
    ).rejects.toThrow("--max-chars must be a positive integer.");
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("passes responsebody limits through to the request and outer timeout", async () => {
    const program = createActionObserveProgram();

    await program.parseAsync(
      ["browser", "responsebody", "**/api", "--timeout-ms", "+030000", "--max-chars", "0100"],
      { from: "user" },
    );

    const request = mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as
      | { body?: { timeoutMs?: number; maxChars?: number } }
      | undefined;
    const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(request?.body?.timeoutMs).toBe(30000);
    expect(request?.body?.maxChars).toBe(100);
    expect(options?.timeoutMs).toBe(30000);
  });
});
