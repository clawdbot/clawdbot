/**
 * Tests for config gateway methods, writes, validation, and auth transitions.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  clearConfigSchemaResponseCacheForTests,
  configHandlers,
  loadConfigSchemaResponseForTests,
  resolveConfigOpenCommand,
} from "./config.js";
import { createConfigHandlerHarness } from "./config.test-helpers.js";

const { runExecMock, loadGatewayRuntimeConfigSchemaMock } = vi.hoisted(() => ({
  runExecMock: vi.fn(),
  loadGatewayRuntimeConfigSchemaMock: vi.fn(() => ({
    schema: { type: "object" },
    uiHints: undefined,
    version: "test-schema",
  })),
}));

vi.mock("../../process/exec.js", () => ({ runExec: runExecMock }));

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
}));

function mockRunExecError(error: Error) {
  runExecMock.mockRejectedValue(error);
}

async function invokeConfigOpenFile() {
  const harness = createConfigHandlerHarness({ method: "config.openFile" });
  await expectDefined(
    configHandlers["config.openFile"],
    'configHandlers["config.openFile"] test invariant',
  )(harness.options);
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

  it("uses a quoted PowerShell FilePath on Windows", () => {
    expect(resolveConfigOpenCommand(String.raw`C:\tmp\o'hai & calc.json`, "win32")).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`Start-Process -FilePath 'C:\tmp\o''hai & calc.json'`,
      ],
    });
  });
});

describe("config.openFile", () => {
  it("opens the configured file without shell interpolation", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config $(touch pwned).json" }, async () => {
      runExecMock.mockImplementation(async (command: string, args: string[]) => {
        expect(["open", "xdg-open", "powershell.exe"]).toContain(command);
        expect(args).toEqual(["/tmp/config $(touch pwned).json"]);
        return { stdout: "", stderr: "" };
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
  });

  it("returns a detailed error and logs details when the opener fails", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
      mockRunExecError(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));

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
  });

  it("does not split surrogate pairs when truncating the failed config path", async () => {
    const pathPrefix = `/tmp/${"a".repeat(111)}`;
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: `${pathPrefix}😀tail.json` }, async () => {
      mockRunExecError(new Error("open failed"));

      const { logGateway } = await invokeConfigOpenFile();

      expect(logGateway.warn).toHaveBeenCalledWith(
        `config.openFile failed path=${pathPrefix}...: open failed`,
      );
    });
  });

  it("returns actionable headless environment error when xdg-open reports no method available", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
      mockRunExecError(new Error("xdg-open: no method available for opening '/tmp/config.json'"));

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
