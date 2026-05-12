import { beforeEach, describe, expect, it, vi } from "vitest";
import * as parentCoreApiModule from "../core-api.js";
import * as browserCliResizeModule from "./browser-cli-resize.js";
import * as browserCliSharedModule from "./browser-cli-shared.js";
import * as cliCoreApiModule from "./core-api.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  runBrowserResizeWithOutput: vi.fn(async (_params: unknown) => {}),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
vi.spyOn(browserCliResizeModule, "runBrowserResizeWithOutput").mockImplementation(
  mocks.runBrowserResizeWithOutput,
);
vi.spyOn(parentCoreApiModule, "runCommandWithRuntime").mockImplementation(
  async (_runtime, action, onError) => {
    try {
      await action();
    } catch (err) {
      onError?.(err);
    }
  },
);
const {
  createBrowserProgram: createBrowserProgramShared,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} = await import("./browser-cli.test-support.js");
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserStateCommands } = await import("./browser-cli-state.js");

describe("browser state option collisions", () => {
  const ansiPattern = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
  const stripAnsi = (value: string) => value.replace(ansiPattern, "");

  const createStateProgram = ({ withGatewayUrl = false } = {}) => {
    const { program, browser, parentOpts } = createBrowserProgramShared({ withGatewayUrl });
    registerBrowserStateCommands(browser, parentOpts);
    return program;
  };

  const getLastRequest = () => {
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected browser request call");
    }
    return call[1] as { body?: Record<string, unknown> };
  };

  const runBrowserCommand = async (argv: string[]) => {
    const program = createStateProgram();
    await program.parseAsync(["browser", ...argv], { from: "user" });
  };

  const runBrowserCommandAndGetRequest = async (argv: string[]) => {
    await runBrowserCommand(argv);
    return getLastRequest();
  };

  const expectErrorMessage = (expected: string) => {
    const calls = getBrowserCliRuntime().error.mock.calls;
    const lastCall = calls.at(-1);
    expect(lastCall).toHaveLength(1);
    expect(stripAnsi(String(lastCall?.[0]))).toBe(expected);
  };

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runBrowserResizeWithOutput.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    getBrowserCliRuntime().exit.mockImplementation(() => {});
  });

  it("forwards parent-captured --target-id on `browser cookies set`", async () => {
    const request = await runBrowserCommandAndGetRequest([
      "cookies",
      "set",
      "session",
      "abc",
      "--url",
      "https://example.com",
      "--target-id",
      "tab-1",
    ]);

    expect((request as { body?: { targetId?: string } }).body?.targetId).toBe("tab-1");
  });

  it("resolves --url via parent when addGatewayClientOptions captures it", async () => {
    const program = createStateProgram({ withGatewayUrl: true });
    await program.parseAsync(
      [
        "browser",
        "--url",
        "ws://gw",
        "cookies",
        "set",
        "session",
        "abc",
        "--url",
        "https://example.com",
      ],
      { from: "user" },
    );
    const request = getLastRequest() as { body?: { cookie?: { url?: string } } };
    expect(request.body?.cookie?.url).toBe("https://example.com");
  });

  it("inherits --url from parent when subcommand does not provide it", async () => {
    const program = createStateProgram({ withGatewayUrl: true });
    await program.parseAsync(
      ["browser", "--url", "https://inherited.example.com", "cookies", "set", "session", "abc"],
      { from: "user" },
    );
    const request = getLastRequest() as { body?: { cookie?: { url?: string } } };
    expect(request.body?.cookie?.url).toBe("https://inherited.example.com");
  });

  it("accepts legacy parent `--json` by parsing payload via positional headers fallback", async () => {
    const request = (await runBrowserCommandAndGetRequest([
      "set",
      "headers",
      "--json",
      '{"x-auth":"ok"}',
    ])) as {
      body?: { headers?: Record<string, string> };
    };
    expect(request.body?.headers).toEqual({ "x-auth": "ok" });
  });

  it("filters non-string header values from JSON payload", async () => {
    const request = (await runBrowserCommandAndGetRequest([
      "set",
      "headers",
      "--json",
      '{"x-auth":"ok","retry":3,"enabled":true}',
    ])) as {
      body?: { headers?: Record<string, string> };
    };
    expect(request.body?.headers).toEqual({ "x-auth": "ok" });
  });

  it("errors when set offline receives an invalid value", async () => {
    await runBrowserCommand(["set", "offline", "maybe"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expectErrorMessage("Expected on|off");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("errors when set media receives an invalid value", async () => {
    await runBrowserCommand(["set", "media", "sepia"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expectErrorMessage("Expected dark|light|none");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("errors when headers JSON is missing", async () => {
    await runBrowserCommand(["set", "headers"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expectErrorMessage(
      "Error: Missing headers JSON (pass --headers-json or positional JSON argument)",
    );
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("errors when headers JSON is not an object", async () => {
    await runBrowserCommand(["set", "headers", "--json", "[]"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expectErrorMessage("Error: Headers JSON must be a JSON object");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });
});
