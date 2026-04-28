import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("./sdk-node-runtime.js", () => ({
  startLazyPluginServiceModule: runtimeMocks.startLazyPluginServiceModule,
}));

describe("createBrowserPluginService", () => {
  beforeEach(() => {
    runtimeMocks.startLazyPluginServiceModule.mockClear();
  });

  function getStartParams(): StartLazyPluginServiceModuleParamsWithValidator {
    const params = runtimeMocks.startLazyPluginServiceModule.mock.calls[0]?.[0];
    if (!params?.validateOverrideSpecifier) {
      throw new Error("expected browser plugin service to pass validateOverrideSpecifier");
    }
    return { validateOverrideSpecifier: params.validateOverrideSpecifier };
  }

  it("passes a browser override validator to the lazy service loader", async () => {
    const service = createBrowserPluginService();

    await service.start(SERVICE_CONTEXT);

    const params = getStartParams();
    expect(params.validateOverrideSpecifier(" ./server.js ")).toBe("./server.js");
  });

  it("rejects unsafe browser override specifiers", async () => {
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
