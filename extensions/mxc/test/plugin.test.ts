import type {
  OpenClawPluginApi,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  createEmptyPluginRegistry,
  createPluginRecord,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  assertMxcReadinessMock,
  warnMxcHostPrepIfNeededMock,
  createMxcSandboxBackendFactoryMock,
  mxcSandboxBackendManagerMock,
  resolveMxcBinaryPathMock,
} = vi.hoisted(() => {
  return {
    assertMxcReadinessMock: vi.fn(),
    warnMxcHostPrepIfNeededMock: vi.fn(),
    createMxcSandboxBackendFactoryMock: vi.fn(() => async () => {
      throw new Error("MXC provider must not run in registration tests");
    }),
    mxcSandboxBackendManagerMock: { describeRuntime: vi.fn(), removeRuntime: vi.fn() },
    resolveMxcBinaryPathMock: vi.fn(() => "mxc-test-binary"),
  };
});

vi.mock("../src/binary-resolver.js", () => ({
  resolveMxcBinaryPath: resolveMxcBinaryPathMock,
}));

vi.mock("../src/mxc-backend-factory.js", () => ({
  createMxcSandboxBackendFactory: createMxcSandboxBackendFactoryMock,
}));

vi.mock("../src/mxc-backend.js", () => ({
  mxcSandboxBackendManager: mxcSandboxBackendManagerMock,
}));

vi.mock("../src/readiness.js", () => ({
  assertMxcReadiness: assertMxcReadinessMock,
  warnMxcHostPrepIfNeeded: warnMxcHostPrepIfNeededMock,
}));

import { registerMxcPlugin } from "../src/plugin.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function readBackend() {
  return {
    factory: getSandboxBackendFactory("mxc"),
    manager: getSandboxBackendManager("mxc"),
    resolveWorkdir: getSandboxBackendWorkdirResolver("mxc"),
  };
}

const stops: Array<() => Promise<void>> = [];

const nonFullRegistrationModes = [
  "discovery",
  "tool-discovery",
  "setup-only",
  "setup-runtime",
  "cli-metadata",
] as const satisfies readonly OpenClawPluginApi["registrationMode"][];

function setProcessPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
}

function restoreProcessPlatformForTest(): void {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

function createApi(
  pluginConfig: Record<string, unknown> | undefined = {},
  registrationMode: OpenClawPluginApi["registrationMode"] = "full",
) {
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
  const registerService = vi.fn();
  const api = createTestPluginApi({
    id: "mxc",
    pluginConfig,
    registrationMode,
    registerService,
    registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
  });
  const cleanup = async (
    context: Parameters<NonNullable<PluginRuntimeLifecycleRegistration["cleanup"]>>[0],
  ) => {
    for (const lifecycle of lifecycles.toReversed()) {
      await lifecycle.cleanup?.(context);
    }
  };
  const stop = () => cleanup({ reason: "disable" });
  stops.push(stop);

  return { api, registerService, lifecycles, cleanup, stop };
}

describe("registerMxcPlugin", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertMxcReadinessMock.mockClear();
    warnMxcHostPrepIfNeededMock.mockClear();
    createMxcSandboxBackendFactoryMock.mockClear();
    resolveMxcBinaryPathMock.mockReset();
    resolveMxcBinaryPathMock.mockReturnValue("mxc-test-binary");
    setProcessPlatformForTest("win32");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const stop of stops.splice(0).toReversed()) {
      await stop();
    }
    warnSpy.mockRestore();
    restoreProcessPlatformForTest();
  });

  test("warns and stays dormant on non-Windows platforms", () => {
    setProcessPlatformForTest("darwin");
    const original = readBackend();
    const { api, registerService, lifecycles } = createApi();

    registerMxcPlugin(api);

    expect(warnSpy).toHaveBeenCalledWith(
      "[mxc] Sandbox backend is Windows-only and not available on darwin. Plugin will be dormant.",
    );
    expect(resolveMxcBinaryPathMock).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(readBackend()).toEqual(original);
    expect(lifecycles).toEqual([]);
    expect(registerService).not.toHaveBeenCalled();
  });

  test.each(nonFullRegistrationModes)(
    "does not register runtime hooks during %s registration",
    (registrationMode) => {
      const original = readBackend();
      const { api, registerService, lifecycles } = createApi(
        { timeoutSeconds: 60 },
        registrationMode,
      );

      registerMxcPlugin(api);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(resolveMxcBinaryPathMock).not.toHaveBeenCalled();
      expect(assertMxcReadinessMock).not.toHaveBeenCalled();
      expect(warnMxcHostPrepIfNeededMock).not.toHaveBeenCalled();
      expect(createMxcSandboxBackendFactoryMock).not.toHaveBeenCalled();
      expect(readBackend()).toEqual(original);
      expect(lifecycles).toEqual([]);
      expect(registerService).not.toHaveBeenCalled();
    },
  );

  test.each(["disable", "restart"] as const)(
    "registers eagerly on Windows and restores hooks on global %s",
    async (reason) => {
      const original = readBackend();
      const { api, cleanup, stop } = createApi({ timeoutSeconds: 60 });

      registerMxcPlugin(api);

      expect(resolveMxcBinaryPathMock).toHaveBeenCalledWith(undefined);
      expect(assertMxcReadinessMock).toHaveBeenCalledWith();
      expect(warnMxcHostPrepIfNeededMock).toHaveBeenCalledWith();
      expect(createMxcSandboxBackendFactoryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutSeconds: 60,
        }),
      );
      expect(readBackend()).toEqual({
        factory: expect.any(Function),
        manager: mxcSandboxBackendManagerMock,
        resolveWorkdir: null,
      });
      await cleanup({ reason });
      expect(readBackend()).toEqual(original);
      await stop();
      expect(readBackend()).toEqual(original);
    },
  );

  test.each(["disable", "restart", "reset", "delete"] as const)(
    "preserves backend hooks during scoped %s cleanup",
    async (reason) => {
      const generation = createApi();
      registerMxcPlugin(generation.api);
      const backend = readBackend();
      for (const scope of [
        { sessionKey: "agent:other:main" },
        { runId: "other-run" },
        { sessionKey: "" },
        { runId: "" },
      ]) {
        await generation.cleanup({ reason, ...scope });
        expect(readBackend()).toEqual(backend);
      }
      if (reason === "reset" || reason === "delete") {
        await generation.cleanup({ reason });
        expect(readBackend()).toEqual(backend);
      }
    },
  );

  test.each(["older-first", "newer-first"] as const)(
    "preserves live registrations when generations retire %s",
    async (order) => {
      const original = readBackend();
      const older = createApi();
      registerMxcPlugin(older.api);
      const olderBackend = readBackend();
      const newer = createApi();
      registerMxcPlugin(newer.api);
      const newerBackend = readBackend();
      expect(newerBackend.factory).not.toBe(olderBackend.factory);
      const first = order === "older-first" ? older : newer;
      const last = order === "older-first" ? newer : older;
      await first.stop();
      expect(readBackend()).toEqual(order === "older-first" ? newerBackend : olderBackend);
      await last.stop();
      expect(readBackend()).toEqual(original);
      await first.stop();
      expect(readBackend()).toEqual(original);
    },
  );

  test("retires a registered backend even when no plugin services ever start", async () => {
    const original = readBackend();
    const originalRegistry = getActivePluginRegistry();
    const { registry } = createPluginRegistryFixture();
    const record = createPluginRecord({ id: "mxc" });
    registry.registry.plugins.push(record);
    registerMxcPlugin(registry.createApi(record, { config: {}, pluginConfig: {} }));
    try {
      expect(readBackend().factory).toEqual(expect.any(Function));
      setActivePluginRegistry(registry.registry);
      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect.poll(readBackend).toEqual(original);
    } finally {
      for (const { lifecycle } of registry.registry.runtimeLifecycles.toReversed()) {
        await lifecycle.cleanup?.({ reason: "disable" });
      }
      if (originalRegistry) {
        setActivePluginRegistry(originalRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });

  test("keeps the existing binary-resolution failure path after host support passes", () => {
    resolveMxcBinaryPathMock.mockImplementation(() => {
      throw new Error("missing binary");
    });
    const original = readBackend();
    const { api, registerService, lifecycles } = createApi();

    expect(() => registerMxcPlugin(api)).toThrow(
      "[mxc] MXC sandbox backend cannot load: missing binary. Install @microsoft/mxc-sdk or set mxcBinaryPath.",
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(readBackend()).toEqual(original);
    expect(lifecycles).toEqual([]);
    expect(registerService).not.toHaveBeenCalled();
  });
});
