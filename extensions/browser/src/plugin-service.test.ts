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
  validateOverrideSpecifier?: (specifier: string) => string;
};
type StartLazyPluginServiceModuleParamsWithValidator = {
  validateOverrideSpecifier: (specifier: string) => string;
};

const runtimeMocks = vi.hoisted(() => ({
  startLazyPluginServiceModule: vi.fn(async (_params: StartLazyPluginServiceModuleParams) => null),
  stopBrowserControlService: vi.fn(async () => undefined),
}));

vi.mock("./sdk-node-runtime.js", () => ({
  startLazyPluginServiceModule: runtimeMocks.startLazyPluginServiceModule,
}));

vi.mock("./control-service.js", () => ({
  stopBrowserControlService: runtimeMocks.stopBrowserControlService,
}));

describe("createBrowserPluginService", () => {
  beforeEach(() => {
    runtimeMocks.startLazyPluginServiceModule.mockClear();
    runtimeMocks.stopBrowserControlService.mockClear();
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
    if (!params?.validateOverrideSpecifier) {
      throw new Error("expected browser plugin service to pass validateOverrideSpecifier");
    }
    return { validateOverrideSpecifier: params.validateOverrideSpecifier };
  }

  it("does not start the control server during gateway startup by default", async () => {
    const service = createBrowserPluginService();

    await service.start(SERVICE_CONTEXT);

    expect(runtimeMocks.startLazyPluginServiceModule).not.toHaveBeenCalled();
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
