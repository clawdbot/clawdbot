// Bundled plugin install failures must never be reported as successful commands.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findBundledPluginSourceMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  configWriteMock,
} from "./plugins-cli-test-helpers.js";

const { installManagedPluginSourceMock } = vi.hoisted(() => ({
  installManagedPluginSourceMock: vi.fn(),
}));

vi.mock("../plugins/management-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/management-service.js")>()),
  installManagedPluginSource: installManagedPluginSourceMock,
}));

describe("plugin install bundled failure propagation", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    installManagedPluginSourceMock.mockReset();
  });

  it("fails when direct bundled source execution fails", async () => {
    findBundledPluginSourceMock.mockReturnValue({
      pluginId: "bundled-demo",
      localPath: "/app/dist/extensions/bundled-demo",
    });
    installManagedPluginSourceMock.mockResolvedValue({
      ok: false,
      error: "bundled plugin installation failed",
    });

    await expect(runPluginsCommand(["plugins", "install", "bundled-demo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(installManagedPluginSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ source: "bundled" }),
      }),
    );
    expect(runtimeErrors.at(-1)).toContain("bundled plugin installation failed");
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("fails when an npm package-not-found bundled fallback fails", async () => {
    findBundledPluginSourceMock.mockImplementation((...args: unknown[]) => {
      const { lookup } = args[0] as { lookup: { kind: string; value: string } };
      return lookup.kind === "npmSpec" && lookup.value === "fallback-demo"
        ? {
            pluginId: "fallback-demo",
            localPath: "/app/dist/extensions/fallback-demo",
          }
        : undefined;
    });
    installManagedPluginSourceMock.mockImplementation(
      async ({ request }: { request: { source: string } }) =>
        request.source === "npm"
          ? {
              ok: false,
              error: "npm package unavailable",
              code: "npm_package_not_found",
            }
          : {
              ok: false,
              error: "bundled fallback installation failed",
            },
    );

    await expect(
      runPluginsCommand(["plugins", "install", "fallback-demo", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(installManagedPluginSourceMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        request: expect.objectContaining({ source: "npm" }),
      }),
    );
    expect(installManagedPluginSourceMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: expect.objectContaining({ source: "bundled" }),
      }),
    );
    expect(runtimeErrors.at(-1)).toContain("bundled fallback installation failed");
    expect(configWriteMock).not.toHaveBeenCalled();
  });
});
