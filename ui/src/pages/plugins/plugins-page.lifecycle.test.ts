/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  clickRowAction,
  createClient,
  createContext,
  createGateway,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  createRuntimeConfigHarness,
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

  function createQueuedRuntimeConfig(client: ReturnType<typeof createClient>["client"]) {
    const queued = deferred<void>();
    const release = deferred<void>();
    const harness = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      { configFormDirty: false, lastError: null },
      () => client,
    );
    harness.runtimeConfig.runExternalMutation = async (task, options) => {
      queued.resolve();
      await release.promise;
      if (options?.canDispatch && !options.canDispatch()) {
        return {
          ok: false,
          reason: "unavailable",
          error: options.dispatchError ?? "Mutation scope changed before dispatch.",
        };
      }
      return { ok: true, value: await task(client), refresh: { ok: true } };
    };
    return { harness, queued: queued.promise, release };
  }

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

    const install = page.consentController.install(request, "plugin:community-thing");
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

  it("does not install after its confirmed Gateway source changes while config writes drain", async () => {
    const available = createPlugin({
      id: "community-thing",
      name: "Community Thing",
      origin: "global",
      installed: false,
      enabled: false,
      state: "not-installed",
      install: { source: "official", pluginId: "community-thing" },
    });
    const { client, request: gatewayRequest } = createClient(async (method) => {
      if (method === "plugins.install") {
        return {
          ok: true,
          plugin: { ...available, installed: true },
          restartRequired: true,
        } satisfies PluginMutationResult;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const initialGateway = createGateway(client);
    const replacementGateway = createGateway(client);
    const config = createQueuedRuntimeConfig(client);
    const initialContext = createContext(
      initialGateway.gateway,
      undefined,
      undefined,
      config.harness,
    );
    const { page, provider } = await mountPage(
      initialContext,
      createPluginsRouteData(initialGateway.gateway, createResult(available)),
    );
    const request = {
      source: "official",
      pluginId: "community-thing",
    } satisfies PluginInstallRequest;

    const install = page.consentController.install(request, "plugin:community-thing");
    await config.queued;
    provider.setContext(
      createContext(replacementGateway.gateway, undefined, undefined, config.harness),
    );
    await page.updateComplete;
    config.release.resolve();
    await install;

    expect(gatewayRequest).not.toHaveBeenCalledWith("plugins.install", request);
  });

  it("does not uninstall after its confirmed Gateway source changes while config writes drain", async () => {
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
    const { client, request: gatewayRequest } = createClient(async (method) => {
      if (method === "plugins.uninstall") {
        return {
          ok: true,
          pluginId: "community-thing",
          restartRequired: true,
          removed: ["install record"],
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const initialGateway = createGateway(client);
    const replacementGateway = createGateway(client);
    const config = createQueuedRuntimeConfig(client);
    const initialContext = createContext(
      initialGateway.gateway,
      undefined,
      undefined,
      config.harness,
    );
    const { page, provider } = await mountPage(
      initialContext,
      createPluginsRouteData(initialGateway.gateway, result),
    );

    const uninstall = page.uninstall("community-thing", "plugin:community-thing");
    await config.queued;
    provider.setContext(
      createContext(replacementGateway.gateway, undefined, undefined, config.harness),
    );
    await page.updateComplete;
    config.release.resolve();
    await uninstall;

    expect(gatewayRequest).not.toHaveBeenCalledWith("plugins.uninstall", {
      pluginId: "community-thing",
    });
  });

  it("reconfirms an install-policy retry after a same-client reconnect", async () => {
    const available = createPlugin({
      id: "community-thing",
      name: "Community Thing",
      origin: "global",
      installed: false,
      enabled: false,
      state: "not-installed",
      install: { source: "official", pluginId: "community-thing" },
    });
    let installCalls = 0;
    const { client } = createClient(async (method, params) => {
      if (method === "plugins.list") {
        return createResult(available);
      }
      if (method !== "plugins.install") {
        throw new Error(`Unexpected method ${method}`);
      }
      installCalls += 1;
      if (!(params as PluginInstallRequest).acknowledgeInstallPolicyWarning) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "install requires review",
          details: {
            installPolicyCode: "install_policy_warning_acknowledgement_required",
            targetName: "community-thing",
            targetType: "plugin",
            requestMode: "install",
            reason: "Review this plugin before installing it.",
          },
        });
      }
      return {
        ok: true,
        plugin: { ...available, installed: true },
        restartRequired: true,
      } satisfies PluginMutationResult;
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(
        harness.gateway,
        createResult(available),
        createPluginsRouteLocation("/settings/plugins/discover"),
      ),
    );
    const request = {
      source: "official",
      pluginId: "community-thing",
    } satisfies PluginInstallRequest;

    await page.consentController.install(request, "plugin:community-thing");
    expect(installCalls).toBe(1);
    expect(showConfirmDialog).toHaveBeenCalledOnce();
    harness.emit(client, false);
    harness.emit(client, true);
    await waitForFast(() =>
      expect(page.querySelector('[data-plugin-id="community-thing"]')).not.toBeNull(),
    );
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);

    await clickRowAction(page, '[data-plugin-id="community-thing"]', "Install anyway");
    await waitForFast(() => expect(showConfirmDialog).toHaveBeenCalledTimes(2));
    expect(installCalls).toBe(1);

    confirmation.resolve(true);
    await waitForFast(() => expect(installCalls).toBe(2));
  });
});
