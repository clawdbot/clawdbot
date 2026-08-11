// Browser tests cover plugin service plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config/config.js";
import { isDefaultBrowserPluginEnabled } from "./plugin-enabled.js";
import { createBrowserPluginService } from "./plugin-service.js";

const SERVICE_CONTEXT = {
  config: {},
  stateDir: "/tmp/openclaw-state",
  logger: console,
};

type StartLazyPluginServiceModuleParams = {
  loadDefaultModule?: () => Promise<Record<string, unknown>>;
  startExportNames?: string[];
  validateOverrideSpecifier?: (specifier: string) => string;
};
type StartLazyPluginServiceModuleParamsWithValidator = {
  loadDefaultModule: () => Promise<Record<string, unknown>>;
  startExportNames: string[];
  validateOverrideSpecifier: (specifier: string) => string;
};

const runtimeMocks = vi.hoisted(() => ({
  startLazyPluginServiceModule: vi.fn(async (_params: StartLazyPluginServiceModuleParams) => null),
  startBrowserControlServiceFromConfig: vi.fn(async () => null),
  stopBrowserControlService: vi.fn(async () => undefined),
  createGatewayPageShareSink: vi.fn(() => ({ id: "gateway-page-share-sink" })),
  setPageShareSink: vi.fn(),
}));

vi.mock("./sdk-node-runtime.js", () => ({
  startLazyPluginServiceModule: runtimeMocks.startLazyPluginServiceModule,
}));

vi.mock("./control-service.js", () => ({
  startBrowserControlServiceFromConfig: runtimeMocks.startBrowserControlServiceFromConfig,
  stopBrowserControlService: runtimeMocks.stopBrowserControlService,
}));

vi.mock("./browser/extension-relay/page-share.js", () => ({
  createGatewayPageShareSink: runtimeMocks.createGatewayPageShareSink,
  setPageShareSink: runtimeMocks.setPageShareSink,
}));

describe("createBrowserPluginService", () => {
  beforeEach(() => {
    runtimeMocks.startLazyPluginServiceModule.mockReset().mockResolvedValue(null);
    runtimeMocks.stopBrowserControlService.mockReset().mockResolvedValue(undefined);
    runtimeMocks.createGatewayPageShareSink
      .mockReset()
      .mockReturnValue({ id: "gateway-page-share-sink" });
    runtimeMocks.setPageShareSink.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function getStartParams(): StartLazyPluginServiceModuleParamsWithValidator {
    const [call] = runtimeMocks.startLazyPluginServiceModule.mock.calls;
    if (!call) {
      throw new Error("expected browser plugin service lazy loader call");
    }
    const [params] = call;
    if (
      !params?.validateOverrideSpecifier ||
      !params.loadDefaultModule ||
      !params.startExportNames
    ) {
      throw new Error("expected complete browser plugin service lazy loader params");
    }
    return {
      loadDefaultModule: params.loadDefaultModule,
      startExportNames: params.startExportNames,
      validateOverrideSpecifier: params.validateOverrideSpecifier,
    };
  }

  it("does not start the control server during gateway startup by default", async () => {
    const service = createBrowserPluginService();

    await service.start(SERVICE_CONTEXT);

    expect(runtimeMocks.startLazyPluginServiceModule).not.toHaveBeenCalled();
  });

  it("marks page-share delivery available for the full service lifecycle", async () => {
    const service = createBrowserPluginService();

    await service.start(SERVICE_CONTEXT);
    expect(runtimeMocks.setPageShareSink).toHaveBeenCalledWith({
      id: "gateway-page-share-sink",
    });

    await service.stop?.(SERVICE_CONTEXT);
    expect(runtimeMocks.setPageShareSink).toHaveBeenLastCalledWith(null);
  });

  it("starts during gateway startup when an extension-driver profile is configured", async () => {
    const service = createBrowserPluginService();

    await service.start({
      ...SERVICE_CONTEXT,
      config: {
        browser: {
          profiles: {
            chrome: { driver: "extension" },
          },
        },
      },
    });

    expect(runtimeMocks.startLazyPluginServiceModule).toHaveBeenCalledOnce();
    const module = await getStartParams().loadDefaultModule();
    expect(module).toHaveProperty("startBrowserControlServiceFromConfig");
  });

  for (const value of ["0", "", "disabled"]) {
    it(`does not start the control server for eager env value ${JSON.stringify(value)}`, async () => {
      vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", value);
      const service = createBrowserPluginService();

      await service.start(SERVICE_CONTEXT);

      expect(runtimeMocks.startLazyPluginServiceModule).not.toHaveBeenCalled();
    });
  }

  it("passes a browser override validator to the eager service loader", async () => {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
    const service = createBrowserPluginService();

    await service.start(SERVICE_CONTEXT);

    const params = getStartParams();
    expect(params.validateOverrideSpecifier(" ./server.js ")).toBe("./server.js");
  });

  it("preserves the standalone HTTP server for explicit eager startup", async () => {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
    const service = createBrowserPluginService();

    await service.start(SERVICE_CONTEXT);

    const params = getStartParams();
    const module = await params.loadDefaultModule();
    expect(params.startExportNames[0]).toBe("startBrowserControlServerFromConfig");
    expect(module).toHaveProperty("startBrowserControlServerFromConfig");
  });

  it("rejects unsafe browser override specifiers", async () => {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
    const service = createBrowserPluginService();

    await service.start(SERVICE_CONTEXT);

    const params = getStartParams();
    expect(() => params.validateOverrideSpecifier("data:text/javascript,boom")).toThrow(
      "Refusing unsafe browser control override specifier",
    );
    expect(() => params.validateOverrideSpecifier("HTTPS://example.invalid/mod.mjs")).toThrow(
      "Refusing unsafe browser control override specifier",
    );
    expect(() => params.validateOverrideSpecifier("node:fs")).toThrow(
      "Refusing unsafe browser control override specifier",
    );
  });

  it("stops an on-demand browser runtime even when startup stayed lazy", async () => {
    const service = createBrowserPluginService();

    await service.stop?.(SERVICE_CONTEXT);

    expect(runtimeMocks.stopBrowserControlService).toHaveBeenCalledOnce();
  });

  it("propagates on-demand cleanup failures", async () => {
    runtimeMocks.stopBrowserControlService.mockRejectedValueOnce(new Error("cleanup failed"));
    const service = createBrowserPluginService();

    await expect(service.stop?.(SERVICE_CONTEXT)).rejects.toThrow("cleanup failed");
  });

  it("retains a loaded service handle until failed cleanup can be retried", async () => {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error("loaded cleanup failed"))
      .mockResolvedValue(undefined);
    runtimeMocks.startLazyPluginServiceModule.mockResolvedValue({ stop } as never);
    const service = createBrowserPluginService();
    await service.start(SERVICE_CONTEXT);

    await expect(service.stop?.(SERVICE_CONTEXT)).rejects.toThrow("loaded cleanup failed");
    await expect(service.stop?.(SERVICE_CONTEXT)).resolves.toBeUndefined();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.stopBrowserControlService).not.toHaveBeenCalled();
  });
});

describe("isDefaultBrowserPluginEnabled", () => {
  it("defaults to enabled", () => {
    expect(isDefaultBrowserPluginEnabled({} as OpenClawConfig)).toBe(true);
  });

  it("respects explicit plugin disablement", () => {
    expect(
      isDefaultBrowserPluginEnabled({
        plugins: {
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig),
    ).toBe(false);
  });
});
