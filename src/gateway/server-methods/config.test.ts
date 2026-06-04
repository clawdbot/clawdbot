/**
 * Tests for config gateway methods, writes, validation, and auth transitions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigSchemaResponseCacheForTests,
  configHandlers,
  loadConfigSchemaResponseForTests,
  resolveConfigOpenCommand,
} from "./config.js";
import { createConfigHandlerHarness } from "./config.test-helpers.js";

const { execFileMock, loadGatewayRuntimeConfigSchemaMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  loadGatewayRuntimeConfigSchemaMock: vi.fn(() => ({
    schema: { type: "object" },
    uiHints: undefined,
    version: "test-schema",
  })),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } = await import("./node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    execFile: Object.assign(execFileMock, {
      __promisify__: vi.fn(),
    }) as typeof import("node:child_process").execFile,
  });
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
}));

function invokeExecFileCallback(args: unknown[], error: Error | null) {
  const callback = args.at(-1);
  if (typeof callback !== "function") {
    throw new Error("expected execFile callback");
  }
  callback(error);
}

function mockExecFileError(error: Error) {
  execFileMock.mockImplementation((...args: unknown[]) => {
    invokeExecFileCallback(args, error);
    return {} as never;
  });
}

async function invokeConfigOpenFile() {
  const harness = createConfigHandlerHarness({ method: "config.openFile" });
  await configHandlers["config.openFile"](harness.options);
  return harness;
}

afterEach(() => {
  vi.useRealTimers();
  clearConfigSchemaResponseCacheForTests();
  vi.clearAllMocks();
});

describe("resolveConfigOpenCommand", () => {
  it("uses open on macOS", () => {
    expect(resolveConfigOpenCommand("/tmp/openclaw.json", "darwin")).toEqual({
      command: "open",
      args: ["/tmp/openclaw.json"],
    });
  });

  it("uses xdg-open on Linux", () => {
    expect(resolveConfigOpenCommand("/tmp/openclaw.json", "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/openclaw.json"],
    });
  });

  it("uses a quoted PowerShell literal on Windows", () => {
    expect(resolveConfigOpenCommand(String.raw`C:\tmp\o'hai & calc.json`, "win32")).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`Start-Process -LiteralPath 'C:\tmp\o''hai & calc.json'`,
      ],
    });
  });
});

describe("config.openFile", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
  });

  it("opens the configured file without shell interpolation", async () => {
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/config $(touch pwned).json";
    execFileMock.mockImplementation((...args: unknown[]) => {
      expect(["open", "xdg-open", "powershell.exe"]).toContain(args[0]);
      expect(args[1]).toEqual(["/tmp/config $(touch pwned).json"]);
      invokeExecFileCallback(args, null);
      return {} as never;
    });

    const { respond } = await invokeConfigOpenFile();

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        path: "/tmp/config $(touch pwned).json",
      },
      undefined,
    );
  });

  it("returns a detailed error and logs details when the opener fails", async () => {
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/config.json";
    mockExecFileError(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));

    const { respond, logGateway } = await invokeConfigOpenFile();

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: false,
        path: "/tmp/config.json",
        error: "Failed to open config file: spawn xdg-open ENOENT",
      },
      undefined,
    );
    expect(logGateway.warn).toHaveBeenCalledWith(
      "config.openFile failed path=/tmp/config.json: spawn xdg-open ENOENT",
    );
  });

  it("returns actionable headless environment error when xdg-open reports no method available", async () => {
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/config.json";
    mockExecFileError(new Error("xdg-open: no method available for opening '/tmp/config.json'"));

    const { respond, logGateway } = await invokeConfigOpenFile();

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: false,
        path: "/tmp/config.json",
        error:
          "Cannot open file in headless environment. File path: /tmp/config.json. This environment appears to lack a graphical or terminal browser handler.",
      },
      undefined,
    );
    expect(logGateway.warn).toHaveBeenCalledWith(
      "config.openFile failed path=/tmp/config.json: xdg-open: no method available for opening '/tmp/config.json'",
    );
  });
});

describe("config schema response cache", () => {
  it("reuses a recent schema build across burst config requests", () => {
    loadConfigSchemaResponseForTests();
    loadConfigSchemaResponseForTests();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(1);
  });

  it("can be cleared when config writes change schema inputs", () => {
    loadConfigSchemaResponseForTests();
    clearConfigSchemaResponseCacheForTests();
    loadConfigSchemaResponseForTests();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache schema responses when cache expiry would exceed Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    loadConfigSchemaResponseForTests();
    loadConfigSchemaResponseForTests();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(2);
  });
});
