import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  assertMxcReadinessMock,
  warnMxcHostPrepIfNeededMock,
  createMxcSandboxBackendFactoryMock,
  factoryMock,
  mxcSandboxBackendManagerMock,
  registerSandboxBackendMock,
  resolveMxcBinaryPathMock,
  unregisterMock,
} = vi.hoisted(() => {
  const factory = { id: "factory" };
  const unregister = vi.fn();
  return {
    assertMxcReadinessMock: vi.fn(),
    warnMxcHostPrepIfNeededMock: vi.fn(),
    createMxcSandboxBackendFactoryMock: vi.fn(() => factory),
    factoryMock: factory,
    mxcSandboxBackendManagerMock: { id: "manager" },
    registerSandboxBackendMock: vi.fn(() => unregister),
    resolveMxcBinaryPathMock: vi.fn(() => "mxc-test-binary"),
    unregisterMock: unregister,
  };
});

vi.mock("openclaw/plugin-sdk/sandbox", () => ({
  registerSandboxBackend: registerSandboxBackendMock,
}));

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

type MxcPluginApiForTest = Pick<
  OpenClawPluginApi,
  "pluginConfig" | "registerService" | "registrationMode"
>;

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
): {
  api: OpenClawPluginApi;
  registerService: ReturnType<typeof vi.fn>;
  services: OpenClawPluginService[];
} {
  const services: OpenClawPluginService[] = [];
  const registerService = vi.fn((service: OpenClawPluginService): void => {
    services.push(service);
  });
  const api = {
    pluginConfig,
    registrationMode,
    registerService,
  } satisfies MxcPluginApiForTest;

  return {
    api: api as unknown as OpenClawPluginApi,
    registerService,
    services,
  };
}

describe("registerMxcPlugin", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertMxcReadinessMock.mockClear();
    warnMxcHostPrepIfNeededMock.mockClear();
    createMxcSandboxBackendFactoryMock.mockClear();
    registerSandboxBackendMock.mockClear();
    resolveMxcBinaryPathMock.mockReset();
    resolveMxcBinaryPathMock.mockReturnValue("mxc-test-binary");
    unregisterMock.mockClear();
    setProcessPlatformForTest("win32");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    restoreProcessPlatformForTest();
  });

  test("warns and stays dormant on non-Windows platforms", () => {
    setProcessPlatformForTest("darwin");
    const { api, registerService } = createApi();

    registerMxcPlugin(api);

    expect(warnSpy).toHaveBeenCalledWith(
      "[mxc] Sandbox backend is Windows-only and not available on darwin. Plugin will be dormant.",
    );
    expect(resolveMxcBinaryPathMock).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(registerSandboxBackendMock).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
  });

  test.each(nonFullRegistrationModes)(
    "does not register runtime hooks during %s registration",
    (registrationMode) => {
      const { api, registerService } = createApi({ timeoutSeconds: 60 }, registrationMode);

      registerMxcPlugin(api);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(resolveMxcBinaryPathMock).not.toHaveBeenCalled();
      expect(assertMxcReadinessMock).not.toHaveBeenCalled();
      expect(warnMxcHostPrepIfNeededMock).not.toHaveBeenCalled();
      expect(createMxcSandboxBackendFactoryMock).not.toHaveBeenCalled();
      expect(registerSandboxBackendMock).not.toHaveBeenCalled();
      expect(registerService).not.toHaveBeenCalled();
    },
  );

  test("registers the sandbox backend on Windows when feature probes pass", () => {
    const { api, services } = createApi({ timeoutSeconds: 60 });

    registerMxcPlugin(api);

    expect(resolveMxcBinaryPathMock).toHaveBeenCalledWith(undefined);
    expect(assertMxcReadinessMock).toHaveBeenCalledWith();
    expect(warnMxcHostPrepIfNeededMock).toHaveBeenCalledWith();
    expect(createMxcSandboxBackendFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutSeconds: 60,
      }),
    );
    expect(registerSandboxBackendMock).toHaveBeenCalledWith("mxc", {
      factory: factoryMock,
      manager: mxcSandboxBackendManagerMock,
    });
    expect(services).toHaveLength(1);

    void services[0]?.stop?.({} as OpenClawPluginServiceContext);
    expect(unregisterMock).toHaveBeenCalledTimes(1);
  });

  test("keeps the existing binary-resolution failure path after host support passes", () => {
    resolveMxcBinaryPathMock.mockImplementation(() => {
      throw new Error("missing binary");
    });
    const { api, registerService } = createApi();

    expect(() => registerMxcPlugin(api)).toThrow(
      "[mxc] MXC sandbox backend cannot load: missing binary. Install @microsoft/mxc-sdk or set mxcBinaryPath.",
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(registerSandboxBackendMock).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
  });
});
