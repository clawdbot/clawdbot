/**
 * Tests for config gateway methods, writes, validation, and auth transitions.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  clearConfigSchemaResponseCacheForTests,
  configHandlers,
  loadConfigSchemaResponseForTests,
} from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const configWriteMocks = vi.hoisted(() => ({
  commitGatewayConfigWrite: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    readConfigFileSnapshotForWrite: configWriteMocks.readConfigFileSnapshotForWrite,
  };
});

vi.mock("./config-write-flow.js", async () => {
  const actual =
    await vi.importActual<typeof import("./config-write-flow.js")>("./config-write-flow.js");
  return {
    ...actual,
    commitGatewayConfigWrite: configWriteMocks.commitGatewayConfigWrite,
    resolveGatewayConfigRestartWriteResult: vi.fn(async () => ({
      payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
      sentinelPersisted: false,
      restart: undefined,
    })),
  };
});

const { execOpenPathMock, loadGatewayRuntimeConfigSchemaMock } = vi.hoisted(() => ({
  execOpenPathMock: vi.fn(),
  loadGatewayRuntimeConfigSchemaMock: vi.fn(() => ({
    schema: { type: "object" },
    uiHints: undefined as Record<string, { advanced?: boolean }> | undefined,
    version: "test-schema",
  })),
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: execOpenPathMock };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
}));

function mockOpenPathError(error: Error) {
  execOpenPathMock.mockRejectedValue(error);
}

let storedConfig: OpenClawConfig;
let storedHash: string;
let nextHash: number;

function currentWriteSnapshot() {
  const result = createConfigWriteSnapshot(storedConfig);
  result.snapshot.hash = storedHash;
  result.snapshot.raw = JSON.stringify(storedConfig);
  return result;
}

async function invokeConfigPatch(args: {
  raw: unknown;
  baseHash?: string;
  replacePaths?: string[];
}) {
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
      ...(args.replacePaths ? { replacePaths: args.replacePaths } : {}),
    },
  });
  await expectDefined(
    configHandlers["config.patch"],
    'configHandlers["config.patch"] test invariant',
  )(harness.options);
  return harness;
}

beforeEach(() => {
  storedConfig = {};
  storedHash = "base-hash";
  nextHash = 1;
  configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () =>
    currentWriteSnapshot(),
  );
  configWriteMocks.commitGatewayConfigWrite.mockImplementation(
    async ({
      snapshot,
      nextConfig,
    }: {
      snapshot: { hash?: string };
      nextConfig: OpenClawConfig;
    }) => {
      if (snapshot.hash !== storedHash) {
        throw new ConfigMutationConflictError("config changed since last load", {
          currentHash: storedHash,
        });
      }
      storedConfig = nextConfig;
      storedHash = `next-hash-${nextHash}`;
      nextHash += 1;
      return {
        path: "/tmp/openclaw.json",
        config: storedConfig,
        hash: storedHash,
        queueFollowUp: vi.fn(),
      };
    },
  );
});

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

describe("config.openFile", () => {
  it("opens the configured file without shell interpolation", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config $(touch pwned).json" }, async () => {
      execOpenPathMock.mockImplementation(async (command: { command: string; args: string[] }) => {
        expect(["open", "xdg-open", "powershell.exe"]).toContain(command.command);
        expect(command.args).toEqual(["/tmp/config $(touch pwned).json"]);
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
      mockOpenPathError(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));

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
      mockOpenPathError(new Error("open failed"));

      const { logGateway } = await invokeConfigOpenFile();

      expect(logGateway.warn).toHaveBeenCalledWith(
        `config.openFile failed path=${pathPrefix}...: open failed`,
      );
    });
  });

  it("returns actionable headless environment error when xdg-open reports no method available", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
      mockOpenPathError(new Error("xdg-open: no method available for opening '/tmp/config.json'"));

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
  it("returns resolved tier metadata through config.schema", async () => {
    loadGatewayRuntimeConfigSchemaMock.mockReturnValueOnce({
      schema: { type: "object" },
      uiHints: { "gateway.port": { advanced: false } },
      version: "test-schema",
    });
    const harness = createConfigHandlerHarness({ method: "config.schema" });
    await expectDefined(
      configHandlers["config.schema"],
      'configHandlers["config.schema"] test invariant',
    )(harness.options);

    expect(harness.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        uiHints: { "gateway.port": { advanced: false } },
      }),
      undefined,
    );
  });

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

describe("config.patch hash-free ui.prefs LWW", () => {
  it("persists a ui.prefs-only patch and returns the committed hash", async () => {
    const { respond } = await invokeConfigPatch({ raw: { ui: { prefs: { theme: "knot" } } } });

    expect(storedConfig.ui?.prefs?.theme).toBe("knot");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, hash: "next-hash-1" }),
      undefined,
    );
  });

  it("rejects a hash-free patch outside the LWW subtree", async () => {
    const { respond } = await invokeConfigPatch({ raw: { gateway: { port: 19_001 } } });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
  });

  it("rejects a mixed hash-free patch", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } }, gateway: { port: 19_001 } },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
    expect(storedConfig).toEqual({});
  });

  it("rejects an empty-object structural change outside the LWW subtree", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } }, gateway: {} },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
  });

  it.each([
    { name: "ui.prefs deletion", raw: { ui: { prefs: null } } },
    { name: "ui deletion", raw: { ui: null } },
    { name: "scalar ui.prefs", raw: { ui: { prefs: "stale-container" } } },
  ])("rejects hash-free container operation: $name", async ({ raw }) => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };

    const { respond } = await invokeConfigPatch({ raw });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("allows a hash-free per-key null deletion below ui.prefs", async () => {
    storedConfig = { ui: { prefs: { chatFollowUpMode: "queue", theme: "claw" } } };

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { chatFollowUpMode: null } } },
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash-1" }),
      undefined,
    );
    expect(storedConfig.ui?.prefs).toEqual({ theme: "claw" });
  });

  it("keeps destructive array replacement explicit for hash-free patches", async () => {
    storedConfig = { ui: { prefs: { sidebarEntries: ["route:usage", "route:tasks"] } } };

    const rejected = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
    });
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config.patch would remove entries from array path(s)"),
      }),
    );

    const accepted = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
      replacePaths: ["ui.prefs.sidebarEntries"],
    });
    expect(accepted.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash-1" }),
      undefined,
    );
    expect(storedConfig.ui?.prefs?.sidebarEntries).toEqual(["route:usage"]);
  });

  it("returns a noop for an unchanged hash-free patch", async () => {
    storedConfig = { ui: { prefs: { theme: "knot" } } };

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ noop: true }), undefined);
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("preserves stale-hash rejection for strict patches", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
      baseHash: "stale-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config changed since last load"),
      }),
    );
  });

  it("surfaces a hash-free commit race without replaying stale intent", async () => {
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => {
      storedConfig = { ui: { prefs: { locale: "de" } } };
      storedHash = "raced-hash";
      throw new ConfigMutationConflictError("config changed since last load", {
        currentHash: storedHash,
      });
    });

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config changed since last load"),
      }),
    );
    expect(storedConfig.ui?.prefs).toEqual({ locale: "de" });
  });
});
