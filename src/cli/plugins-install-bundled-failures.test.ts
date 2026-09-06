import { beforeEach, describe, expect, it, vi } from "vitest";
// Bundled plugin install failures must never be reported as successful commands.
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import {
  findBundledPluginSourceMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  configWriteMock,
} from "./plugins-cli-test-helpers.js";

const { installManagedPluginMock } = vi.hoisted(() => ({
  installManagedPluginMock: vi.fn(),
}));

vi.mock("../plugins/management-mutations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/management-mutations.js")>()),
  installManagedPlugin: installManagedPluginMock,
}));

describe("plugin install bundled failure propagation", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    installManagedPluginMock.mockReset();
  });

  it("fails when direct bundled source execution fails", async () => {
    findBundledPluginSourceMock.mockReturnValue({
      pluginId: "bundled-demo",
      localPath: "/app/dist/extensions/bundled-demo",
    });
    installManagedPluginMock.mockRejectedValue(
      new ManagedPluginLifecycleError("bundled plugin installation failed", {
        installRejected: true,
      }),
    );

    await expect(runPluginsCommand(["plugins", "install", "bundled-demo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(installManagedPluginMock).toHaveBeenCalledWith(
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
    installManagedPluginMock.mockImplementation(
      async ({ request }: { request: { source: string } }) => {
        throw new ManagedPluginLifecycleError(
          request.source === "npm"
            ? "npm package unavailable"
            : "bundled fallback installation failed",
          {
            installRejected: true,
            ...(request.source === "npm" ? { code: "npm_package_not_found" } : {}),
          },
        );
      },
    );

    await expect(
      runPluginsCommand(["plugins", "install", "fallback-demo", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(installManagedPluginMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        request: expect.objectContaining({ source: "npm" }),
      }),
    );
    expect(installManagedPluginMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: expect.objectContaining({ source: "bundled" }),
      }),
    );
    expect(runtimeErrors.at(-1)).toContain("bundled fallback installation failed");
    expect(configWriteMock).not.toHaveBeenCalled();
  });
});
