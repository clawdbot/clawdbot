import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const getRuntimeConfigMock = vi.fn();
const mutateConfigFileMock = vi.fn();
const replaceConfigFileMock = vi.fn();
const logWarnMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
}));

vi.mock("../../config/mutate.js", () => ({
  mutateConfigFile: (...args: unknown[]) => mutateConfigFileMock(...args),
  replaceConfigFile: (...args: unknown[]) => replaceConfigFileMock(...args),
}));

vi.mock("../../logger.js", () => ({
  logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

const { withPluginRuntimePluginScope } = await import("./gateway-request-scope.js");
const { createRuntimeConfig, resetRuntimeConfigDeprecationWarningStateForTest } =
  await import("./runtime-config.js");
const deprecatedConfigCode = "runtime-config-load-write";

describe("createRuntimeConfig", () => {
  beforeEach(() => {
    resetRuntimeConfigDeprecationWarningStateForTest();
    getRuntimeConfigMock.mockReset();
    mutateConfigFileMock.mockReset();
    replaceConfigFileMock.mockReset();
    logWarnMock.mockClear();
    getRuntimeConfigMock.mockReturnValue({ plugins: {} });
    mutateConfigFileMock.mockResolvedValue({ previousHash: null, nextHash: "next" });
    replaceConfigFileMock.mockResolvedValue({ previousHash: null, nextHash: "next" });
  });

  it("reads config from the runtime snapshot for current and deprecated loadConfig", () => {
    const runtimeConfig = { plugins: { entries: {} } };
    getRuntimeConfigMock.mockReturnValue(runtimeConfig);
    const configApi = createRuntimeConfig();

    expect(configApi.current()).toBe(runtimeConfig);
    expect(configApi.loadConfig()).toBe(runtimeConfig);
    expect(getRuntimeConfigMock).toHaveBeenCalledTimes(2);
    expect(logWarnMock).toHaveBeenCalledWith(
      `plugin runtime config.loadConfig() is deprecated (${deprecatedConfigCode}); use config.current().`,
    );
  });

  it("attributes deprecated loadConfig warnings to the active plugin scope", () => {
    const runtimeConfig = { plugins: { entries: {} } };
    getRuntimeConfigMock.mockReturnValue(runtimeConfig);
    const configApi = createRuntimeConfig();

    const loaded = withPluginRuntimePluginScope(
      { pluginId: "legacy-plugin", pluginSource: "/plugins/legacy-plugin/index.js" },
      () => configApi.loadConfig(),
    );

    expect(loaded).toBe(runtimeConfig);
    expect(logWarnMock).toHaveBeenCalledWith(
      `plugin "legacy-plugin" runtime config.loadConfig() is deprecated (${deprecatedConfigCode}); use config.current(). Source: /plugins/legacy-plugin/index.js`,
    );
  });

  it("keeps deprecated loadConfig warning attribution per plugin", () => {
    const configApi = createRuntimeConfig();

    withPluginRuntimePluginScope({ pluginId: "first" }, () => configApi.loadConfig());
    withPluginRuntimePluginScope({ pluginId: "first" }, () => configApi.loadConfig());
    withPluginRuntimePluginScope({ pluginId: "second" }, () => configApi.loadConfig());

    expect(logWarnMock).toHaveBeenCalledTimes(2);
    expect(logWarnMock).toHaveBeenNthCalledWith(
      1,
      `plugin "first" runtime config.loadConfig() is deprecated (${deprecatedConfigCode}); use config.current().`,
    );
    expect(logWarnMock).toHaveBeenNthCalledWith(
      2,
      `plugin "second" runtime config.loadConfig() is deprecated (${deprecatedConfigCode}); use config.current().`,
    );
  });

  it("routes deprecated writeConfigFile through replaceConfigFile with afterWrite", async () => {
    const configApi = createRuntimeConfig();
    const nextConfig = { plugins: { entries: {} } } as OpenClawConfig;

    await configApi.writeConfigFile(nextConfig);

    expect(logWarnMock).toHaveBeenCalledWith(
      `plugin runtime config.writeConfigFile() is deprecated (${deprecatedConfigCode}); use config.mutateConfigFile(...) or config.replaceConfigFile(...).`,
    );
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig,
      afterWrite: { mode: "auto" },
      writeOptions: undefined,
    });
  });

  it("attributes deprecated writeConfigFile warnings to the active plugin scope", async () => {
    const configApi = createRuntimeConfig();
    const nextConfig = { plugins: { entries: {} } } as OpenClawConfig;

    await withPluginRuntimePluginScope(
      { pluginId: "legacy-plugin", pluginSource: "/plugins/legacy-plugin/index.js" },
      async () => await configApi.writeConfigFile(nextConfig),
    );

    expect(logWarnMock).toHaveBeenCalledWith(
      `plugin "legacy-plugin" runtime config.writeConfigFile() is deprecated (${deprecatedConfigCode}); use config.mutateConfigFile(...) or config.replaceConfigFile(...). Source: /plugins/legacy-plugin/index.js`,
    );
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig,
      afterWrite: { mode: "auto" },
      writeOptions: undefined,
    });
  });

  it("preserves explicit afterWrite intent for deprecated writeConfigFile", async () => {
    const configApi = createRuntimeConfig();
    const nextConfig = { plugins: { entries: {} } } as OpenClawConfig;

    await configApi.writeConfigFile(nextConfig, {
      afterWrite: { mode: "none", reason: "test-controlled" },
    });

    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig,
      afterWrite: { mode: "none", reason: "test-controlled" },
      writeOptions: { afterWrite: { mode: "none", reason: "test-controlled" } },
    });
  });
});
