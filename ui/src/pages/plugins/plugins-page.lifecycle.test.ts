/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createClient,
  createContext,
  createGateway,
  createPlugin,
  createPluginsRouteData,
  createResult,
  deferred,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

describe("PluginsPage lifecycle confirmation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
  });

  afterEach(resetPluginsPageTestState);

  it("does not install on a replacement Gateway after confirmation started", async () => {
    const available = createPlugin({
      id: "community-thing",
      name: "Community Thing",
      origin: "global",
      installed: false,
      enabled: false,
      state: "not-installed",
      install: { source: "official", pluginId: "community-thing" },
    });
    const { client: initialClient, request: initialRequest } = createClient(async () => {
      throw new Error("The initial Gateway must not receive a request while confirmation is open.");
    });
    const { client: replacementClient, request: replacementRequest } = createClient(
      async (method) => {
        if (method === "plugins.list") {
          return createResult(available);
        }
        if (method === "plugins.install") {
          return {
            ok: true,
            plugin: { ...available, installed: true },
            restartRequired: true,
          } satisfies PluginMutationResult;
        }
        throw new Error(`Unexpected replacement method ${method}`);
      },
    );
    const harness = createGateway(initialClient);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, createResult(available)),
    );
    const request = {
      source: "official",
      pluginId: "community-thing",
    } satisfies PluginInstallRequest;
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);

    const install = page.install(request, "plugin:community-thing");
    await waitForFast(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    harness.emit(replacementClient, true);
    confirmation.resolve(true);
    await install;

    expect(initialRequest).not.toHaveBeenCalledWith("plugins.install", request);
    expect(replacementRequest).not.toHaveBeenCalledWith("plugins.install", request);
  });

  it("does not uninstall on a replacement Gateway after confirmation started", async () => {
    const removable = createPlugin({
      id: "community-thing",
      name: "Community Thing",
      origin: "global",
      removable: true,
      featured: false,
    });
    const result = {
      plugins: [createPlugin(), removable],
      diagnostics: [],
      mutationAllowed: true,
    } satisfies PluginListResult;
    const { client: initialClient, request: initialRequest } = createClient(async () => {
      throw new Error("The initial Gateway must not receive a request while confirmation is open.");
    });
    const { client: replacementClient, request: replacementRequest } = createClient(
      async (method) => {
        if (method === "plugins.list") {
          return result;
        }
        if (method === "plugins.uninstall") {
          return {
            ok: true,
            pluginId: "community-thing",
            restartRequired: true,
            removed: ["install record"],
          };
        }
        throw new Error(`Unexpected replacement method ${method}`);
      },
    );
    const harness = createGateway(initialClient);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result),
    );
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);

    const uninstall = page.uninstall("community-thing", "plugin:community-thing");
    await waitForFast(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    harness.emit(replacementClient, true);
    confirmation.resolve(true);
    await uninstall;

    expect(initialRequest).not.toHaveBeenCalledWith("plugins.uninstall", {
      pluginId: "community-thing",
    });
    expect(replacementRequest).not.toHaveBeenCalledWith("plugins.uninstall", {
      pluginId: "community-thing",
    });
  });
});
