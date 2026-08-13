/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginSearchResult,
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
  type RuntimeConfigTestState,
} from "./plugins-page.test-support.ts";
import type { PluginsRouteData } from "./plugins-page.ts";

function clickHubTab(page: HTMLElement, tab: "installed" | "discover" | "skills" | "workshop") {
  page
    .querySelector(`#plugins-tab-${tab}`)
    ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
}

describe("PluginsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(resetPluginsPageTestState);

  it("accepts matching route data without issuing a duplicate list request", async () => {
    const { client, request } = createClient(async () => createResult());
    const harness = createGateway(client);
    const result = createResult();
    const routeData: PluginsRouteData = createPluginsRouteData(harness.gateway, result);

    const { page } = await mountPage(createContext(harness.gateway), routeData);

    expect(page.result).toBe(result);
    expect(request).not.toHaveBeenCalled();
    expect(page.querySelectorAll("h1")).toHaveLength(1);
    expect(page.querySelector("h1")?.textContent).toBe("Plugins");
  });

  it("surfaces an initial catalog load failure", async () => {
    const { client } = createClient(async () => {
      throw new Error("catalog unavailable");
    });
    const harness = createGateway(client);
    const { page } = await mountPage(createContext(harness.gateway));

    await waitForFast(() =>
      expect(page.querySelector(".plugins-page-error")?.textContent).toContain(
        "catalog unavailable",
      ),
    );
    expect(
      page.querySelector(".plugins-page-error")?.textContent?.match(/catalog unavailable/gu),
    ).toHaveLength(1);
  });

  it("fetches proxied icons with auth fallback and revokes their blob URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:firecrawl-icon");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          new Blob(
            [
              new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52,
                0, 0, 0, 2, 0, 0, 0, 1,
              ]),
            ],
            { type: "image/png" },
          ),
          {
            status: 200,
            headers: { "content-type": "image/png" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    harness.gateway.connection.token = "first";
    harness.gateway.connection.password = "second";
    const result = createResult(
      createPlugin({ id: "remote-icon", name: "FireCrawl", hasIcon: true }),
    );
    const routeData: PluginsRouteData = createPluginsRouteData(harness.gateway, result);

    const { page } = await mountPage(createContext(harness.gateway), routeData);

    await waitForFast(() => {
      expect(
        page.querySelector('[data-plugin-id="remote-icon"] img.plugins-icon')?.getAttribute("src"),
      ).toBe("blob:firecrawl-icon");
    });
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer first", "Bearer second"]);
    page.applyMutationResult({
      ok: true,
      plugin: createPlugin({ id: "other-plugin", name: "Other Plugin" }),
      restartRequired: false,
    });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    page.remove();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:firecrawl-icon");
  });

  it("keeps the monogram fallback when a proxied SVG exceeds the safe icon subset", async () => {
    const createObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          new Blob(
            [
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><filter id="work"><feTurbulence /></filter><path filter="url(#work)" d="M0 0h24v24H0z"/></svg>`,
            ],
            { type: "image/svg+xml" },
          ),
          { status: 200, headers: { "content-type": "image/svg+xml" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    const result = createResult(
      createPlugin({ id: "unsafe-icon", name: "Unsafe Icon", hasIcon: true }),
    );

    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result),
    );

    await waitForFast(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(
      page.querySelector('[data-plugin-id="unsafe-icon"] .plugins-tile--fallback')?.textContent,
    ).toContain("UI");
  });

  it("refreshes the authoritative catalog after a same-client reconnect", async () => {
    const refreshed = createResult(createPlugin({ enabled: true, state: "enabled" }));
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.list") {
        return refreshed;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const routeData: PluginsRouteData = createPluginsRouteData(harness.gateway);
    const { page } = await mountPage(createContext(harness.gateway), routeData);

    harness.emit(client, false);
    harness.emit(client, true);

    await waitForFast(() => expect(page.result?.plugins[0]?.enabled).toBe(true));
    expect(request).toHaveBeenCalledWith(
      "plugins.list",
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("debounces two-character ClawHub searches and cancels stale input", async () => {
    vi.useFakeTimers();
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.search") {
        return { results: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway),
    );

    clickHubTab(page, "discover");
    const search = page.querySelector<HTMLInputElement>("#plugins-global-search")!;
    search.value = "w";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.value = "work";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.value = "workboard";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "plugins.search",
      {
        query: "workboard",
        limit: 20,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("commits only the latest ClawHub search result", async () => {
    vi.useFakeTimers();
    const first = deferred<{ results: PluginSearchResult[] }>();
    const second = deferred<{ results: PluginSearchResult[] }>();
    const { client, request } = createClient(async (method, params) => {
      if (method !== "plugins.search") {
        throw new Error(`Unexpected method ${method}`);
      }
      return (params as { query: string }).query === "first" ? first.promise : second.promise;
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(
        harness.gateway,
        createResult(),
        createPluginsRouteLocation("/settings/plugins/discover"),
      ),
    );
    const search = page.querySelector<HTMLInputElement>("#plugins-global-search")!;
    search.value = "first";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    search.value = "second";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(request).toHaveBeenCalledTimes(2);

    const latest: PluginSearchResult = {
      score: 1,
      package: {
        name: "latest-plugin",
        displayName: "Latest Plugin",
        family: "code-plugin",
        channel: "community",
        isOfficial: false,
      },
    };
    second.resolve({ results: [latest] });
    await vi.waitFor(() => expect(page.searchResults).toEqual([latest]));
    first.resolve({ results: [] });
    await Promise.resolve();

    expect(page.searchResults).toEqual([latest]);
  });

  it("refreshes plugins and runtime config without discarding a pending config draft", async () => {
    const enabledPlugin = createPlugin({ enabled: true, state: "enabled" });
    const refreshed = createResult(enabledPlugin);
    const calls: Array<[string, unknown]> = [];
    const { client } = createClient(async (method, params) => {
      calls.push([method, params]);
      if (method === "plugins.setEnabled") {
        return { ok: true, plugin: enabledPlugin, restartRequired: true };
      }
      if (method === "plugins.list") {
        return refreshed;
      }
      if (method === "config.get") {
        return { config: {}, hash: "fresh" };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const runtimeConfigState: RuntimeConfigTestState = {
      configFormDirty: true,
      lastError: null,
    };
    const refreshConfig = vi.fn(async () => {
      await client.request("config.get", {});
    });
    const { page } = await mountPage(
      createContext(harness.gateway, refreshConfig, runtimeConfigState),
      createPluginsRouteData(harness.gateway),
    );

    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");

    await waitForFast(() => expect(page.result?.plugins[0]?.enabled).toBe(true));
    await waitForFast(() => expect(refreshConfig).toHaveBeenCalledOnce());
    expect(refreshConfig).toHaveBeenCalledWith();
    expect(runtimeConfigState.configFormDirty).toBe(true);
    expect(calls).toContainEqual(["plugins.setEnabled", { pluginId: "workboard", enabled: true }]);
    expect(calls).toContainEqual(["plugins.list", {}]);
    expect(calls).toContainEqual(["config.get", {}]);
  });

  it.each(["install", "enable", "uninstall"] as const)(
    "flushes a pending config draft before plugin %s and refreshes afterward",
    async (action) => {
      vi.useFakeTimers();
      const method =
        action === "install"
          ? "plugins.install"
          : action === "enable"
            ? "plugins.setEnabled"
            : "plugins.uninstall";
      const order: string[] = [];
      let config: Record<string, unknown> = { pending: false };
      let hash = "hash-1";
      const enabledPlugin = createPlugin({ enabled: true, state: "enabled" });
      const installedPlugin = createPlugin({
        id: "example-plugin",
        name: "Example Plugin",
        origin: "global",
        installed: true,
        enabled: true,
        state: "enabled",
      });
      const removablePlugin = createPlugin({
        id: "community-thing",
        name: "Community Thing",
        origin: "global",
        removable: true,
        featured: false,
      });
      const { client } = createClient(async (requestMethod, params) => {
        if (requestMethod === "config.get") {
          order.push(requestMethod);
          return {
            config,
            sourceConfig: config,
            raw: JSON.stringify(config),
            hash,
            valid: true,
            issues: [],
          };
        }
        if (requestMethod === "config.set") {
          order.push(requestMethod);
          config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
          hash = "hash-2";
          return { hash };
        }
        if (requestMethod === method) {
          order.push(requestMethod);
          config = { ...config, pluginMutation: action };
          hash = "hash-3";
          if (action === "uninstall") {
            return {
              ok: true,
              pluginId: "community-thing",
              restartRequired: true,
              removed: ["config entry"],
            };
          }
          return {
            ok: true,
            plugin: action === "install" ? installedPlugin : enabledPlugin,
            restartRequired: true,
          };
        }
        if (requestMethod === "plugins.list") {
          order.push(requestMethod);
          return createResult(action === "install" ? installedPlugin : enabledPlugin);
        }
        throw new Error(`Unexpected method ${requestMethod}`);
      });
      const gatewayHarness = createGateway(client);
      const runtimeConfig = createRuntimeConfigCapability(gatewayHarness.gateway);
      await runtimeConfig.ensureLoaded();
      const context = {
        ...createContext(gatewayHarness.gateway, runtimeConfig.refresh),
        runtimeConfig,
      } as ApplicationContext;
      const { page } = await mountPage(context, {
        gateway: gatewayHarness.gateway,
        gatewaySnapshot: gatewayHarness.gateway.snapshot,
        location: createPluginsRouteLocation(),
        result: {
          plugins: [createPlugin(), removablePlugin],
          diagnostics: [],
          mutationAllowed: true,
        },
        error: null,
      });
      order.length = 0;
      runtimeConfig.patchForm(["pending"], true);

      if (action === "install") {
        await page.install("search:example-plugin", {
          source: "clawhub",
          packageName: "example-plugin",
        } as PluginInstallRequest);
      } else if (action === "enable") {
        await page.updateEnabled("workboard", true);
      } else {
        await page.uninstall("community-thing", "plugin:community-thing");
      }

      expect(order).toEqual(["config.set", method, "config.get", "plugins.list"]);
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
      expect(runtimeConfig.state.configForm).toMatchObject({
        pending: true,
        pluginMutation: action,
      });
      runtimeConfig.dispose();
    },
  );

  it("keeps the enable action retryable after a failed enable", async () => {
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.setEnabled") {
        throw new Error("Enable failed");
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway),
    );

    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("Enable failed"),
    );

    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
    await waitForFast(() => {
      const calls = request.mock.calls.filter(([method]) => method === "plugins.setEnabled");
      expect(calls).toHaveLength(2);
      expect(calls.map(([, params]) => params)).toEqual([
        { pluginId: "workboard", enabled: true },
        { pluginId: "workboard", enabled: true },
      ]);
    });
  });

  it("reschedules an active ClawHub query after reconnect", async () => {
    vi.useFakeTimers();
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.list") {
        return createResult();
      }
      if (method === "plugins.search") {
        return { results: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway),
    );

    clickHubTab(page, "discover");
    const search = page.querySelector<HTMLInputElement>("#plugins-global-search")!;
    search.value = "calendar";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    harness.emit(client, false);
    await vi.advanceTimersByTimeAsync(300);
    expect(request.mock.calls.some(([method]) => method === "plugins.search")).toBe(false);

    harness.emit(client, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(request).toHaveBeenCalledWith(
      "plugins.search",
      {
        query: "calendar",
        limit: 20,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("clears visible catalog loading when a mutation supersedes a manual refresh", async () => {
    const manualRefresh = deferred<PluginListResult>();
    const enabledPlugin = createPlugin({ enabled: true, state: "enabled" });
    const refreshed = createResult(enabledPlugin);
    let listCalls = 0;
    const { client } = createClient(async (method) => {
      if (method === "plugins.list") {
        listCalls += 1;
        return listCalls === 1 ? manualRefresh.promise : refreshed;
      }
      if (method === "plugins.setEnabled") {
        return { ok: true, plugin: enabledPlugin, restartRequired: false };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway),
    );

    page.querySelector<HTMLButtonElement>(".plugins-refresh")?.click();
    await page.updateComplete;
    expect(page.loading).toBe(true);
    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");

    await waitForFast(() => expect(page.busy["plugin:workboard"]).toBeUndefined());
    expect(page.loading).toBe(false);
    expect(page.querySelector<HTMLButtonElement>(".plugins-refresh")?.disabled).toBe(false);
    manualRefresh.resolve(createResult());
    await Promise.resolve();
    expect(page.loading).toBe(false);
  });

  it("keeps a committed enable successful when its config refresh fails", async () => {
    const enabledPlugin = createPlugin({ enabled: true, state: "enabled" });
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.setEnabled") {
        return { ok: true, plugin: enabledPlugin, restartRequired: false };
      }
      if (method === "plugins.list") {
        return createResult(enabledPlugin);
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const runtimeConfigState: RuntimeConfigTestState = {
      configFormDirty: false,
      lastError: null,
    };
    const refreshConfig = vi.fn(async () => {
      throw new Error("config.get failed after plugin commit");
    });
    const { page } = await mountPage(
      createContext(harness.gateway, refreshConfig, runtimeConfigState),
      createPluginsRouteData(harness.gateway),
    );

    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
    await waitForFast(() =>
      expect(page.querySelector('[role="status"]')?.textContent).toContain(
        "config.get failed after plugin commit",
      ),
    );
    expect(page.result?.plugins[0]?.enabled).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "plugins.setEnabled")).toHaveLength(
      1,
    );
    expect(refreshConfig).toHaveBeenCalledOnce();
  });

  it("does not let an old mutation clear replacement-source busy state", async () => {
    const staleMutation = deferred<unknown>();
    const freshMutation = deferred<unknown>();
    const disabledResult = createResult();
    const enabledPlugin = createPlugin({ enabled: true, state: "enabled" });
    const { client: initialClient } = createClient(async (method) => {
      if (method === "plugins.setEnabled") {
        return staleMutation.promise;
      }
      throw new Error(`Unexpected initial method ${method}`);
    });
    let replacementListCount = 0;
    const { client: replacementClient } = createClient(async (method) => {
      if (method === "plugins.list") {
        replacementListCount += 1;
        return replacementListCount === 1 ? disabledResult : createResult(enabledPlugin);
      }
      if (method === "plugins.setEnabled") {
        return freshMutation.promise;
      }
      if (method === "config.get") {
        return { config: {}, hash: "replacement" };
      }
      throw new Error(`Unexpected replacement method ${method}`);
    });
    const harness = createGateway(initialClient);
    const refreshConfig = vi.fn(async () => {
      await replacementClient.request("config.get", {});
    });
    const { page } = await mountPage(
      createContext(harness.gateway, refreshConfig),
      createPluginsRouteData(harness.gateway, disabledResult),
    );

    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
    expect(page.busy["plugin:workboard"]).toBe(true);

    harness.emit(replacementClient, true);
    await waitForFast(() => expect(replacementListCount).toBe(1));
    await page.updateComplete;
    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
    expect(page.busy["plugin:workboard"]).toBe(true);

    staleMutation.resolve({ ok: true, plugin: enabledPlugin, restartRequired: false });
    await Promise.resolve();
    expect(page.busy["plugin:workboard"]).toBe(true);

    freshMutation.resolve({ ok: true, plugin: enabledPlugin, restartRequired: false });
    await waitForFast(() => expect(page.busy["plugin:workboard"]).toBeUndefined());
  });

  it("uninstalls a removable plugin after inline confirmation", async () => {
    const removable = createPlugin({
      id: "community-thing",
      name: "Community Thing",
      origin: "global",
      removable: true,
      featured: false,
    });
    const calls: Array<[string, unknown]> = [];
    const { client } = createClient(async (method, params) => {
      calls.push([method, params]);
      if (method === "plugins.uninstall") {
        return {
          ok: true,
          pluginId: "community-thing",
          restartRequired: true,
          removed: ["config entry", "install record", "directory"],
        };
      }
      if (method === "plugins.list") {
        return createResult();
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, {
        plugins: [createPlugin(), removable],
        diagnostics: [],
        mutationAllowed: true,
      }),
    );

    await clickRowAction(page, '[data-plugin-id="community-thing"]', "Remove");
    page
      .querySelector<HTMLButtonElement>(
        '[data-plugin-id="community-thing"] .plugins-remove-confirm .btn.danger',
      )
      ?.click();

    await waitForFast(() =>
      expect(calls).toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]),
    );
    await waitForFast(() =>
      expect(page.querySelector(".plugins-page-notice")?.textContent).toContain(
        "Removed community-thing",
      ),
    );
    expect(calls).toContainEqual(["plugins.list", {}]);
  });

  it("adds an MCP server through the shared config seam", async () => {
    const { client } = createClient(async (method) => {
      if (method === "plugins.list") {
        return createResult();
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const gatewayHarness = createGateway(client);
    const runtimeConfigState: RuntimeConfigTestState = {
      configFormDirty: false,
      lastError: null,
      configSnapshot: { sourceConfig: { mcp: { servers: {} } }, hash: "base" },
    };
    const configHarness = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      runtimeConfigState,
    );
    const { page } = await mountPage(
      createContext(
        gatewayHarness.gateway,
        configHarness.runtimeConfig.refresh,
        runtimeConfigState,
        configHarness,
      ),
      {
        gateway: gatewayHarness.gateway,
        gatewaySnapshot: gatewayHarness.gateway.snapshot,
        location: createPluginsRouteLocation(),
        result: createResult(),
        error: null,
      },
    );

    const addButton = [
      ...page.querySelectorAll<HTMLButtonElement>(".settings-section__actions .btn"),
    ].find((button) => button.textContent?.includes("Add server"));
    addButton?.click();
    await page.updateComplete;

    const form = page.querySelector<HTMLFormElement>(".mcp-server-form")!;
    form.querySelector<HTMLInputElement>('[name="mcp-name"]')!.value = "context7";
    form.querySelector<HTMLInputElement>('[name="mcp-target"]')!.value =
      "https://mcp.context7.com/mcp";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await waitForFast(() => expect(configHarness.runtimeConfig.patch).toHaveBeenCalledOnce());
    const patchArgs = expectDefined(
      expectDefined(configHarness.runtimeConfig.patch.mock.calls[0], "MCP add patch call")[0],
      "MCP add patch payload",
    ) as {
      raw: Record<string, unknown>;
      note: string;
    };
    expect(patchArgs.note).toContain("context7");
    expect(patchArgs.raw).toEqual({
      mcp: {
        servers: {
          context7: { url: "https://mcp.context7.com/mcp", transport: "streamable-http" },
        },
      },
    });
    await waitForFast(() =>
      expect(page.querySelector('[role="status"].plugins-row-message')?.textContent).toContain(
        "Added MCP server context7",
      ),
    );
  });

  it("removes an MCP server with an explicit merge-patch null", async () => {
    const { client } = createClient(async () => createResult());
    const gatewayHarness = createGateway(client);
    const configHarness = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      {
        configFormDirty: false,
        lastError: null,
        configSnapshot: {
          sourceConfig: {
            mcp: {
              servers: {
                github: { url: "https://api.githubcopilot.com/mcp/" },
                local: { command: "npx", args: ["some-mcp", "--token", "tok-test-1234"] },
              },
            },
          },
          hash: "base",
        },
      },
    );
    const { page } = await mountPage(
      createContext(
        gatewayHarness.gateway,
        configHarness.runtimeConfig.refresh,
        configHarness.runtimeConfig.state,
        configHarness,
      ),
      {
        gateway: gatewayHarness.gateway,
        gatewaySnapshot: gatewayHarness.gateway.snapshot,
        location: createPluginsRouteLocation(),
        result: createResult(),
        error: null,
      },
    );

    expect(page.querySelector('[data-mcp-name="github"]')).not.toBeNull();
    await clickRowAction(page, '[data-mcp-name="github"]', "Remove");

    await waitForFast(() => expect(configHarness.runtimeConfig.patch).toHaveBeenCalledOnce());
    const patchArgs = expectDefined(
      expectDefined(configHarness.runtimeConfig.patch.mock.calls[0], "MCP remove patch call")[0],
      "MCP remove patch payload",
    ) as {
      raw: Record<string, unknown>;
    };
    // RFC 7396 merge semantics: deletion must be an explicit null, not omission.
    expect(patchArgs.raw).toEqual({ mcp: { servers: { github: null } } });
  });

  it("shows connector add failures on the connector card", async () => {
    const { client } = createClient(async () => createResult());
    const gatewayHarness = createGateway(client);
    const configHarness = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      { configFormDirty: false, lastError: null, configSnapshot: { sourceConfig: {}, hash: "h" } },
    );
    configHarness.runtimeConfig.patch.mockImplementation(async () => {
      configHarness.runtimeConfig.state.lastError = "rate limit exceeded for config.patch";
      return false;
    });
    const { page } = await mountPage(
      createContext(
        gatewayHarness.gateway,
        configHarness.runtimeConfig.refresh,
        configHarness.runtimeConfig.state,
        configHarness,
      ),
      {
        gateway: gatewayHarness.gateway,
        gatewaySnapshot: gatewayHarness.gateway.snapshot,
        location: createPluginsRouteLocation(),
        result: createResult(),
        error: null,
      },
    );

    clickHubTab(page, "discover");
    await page.updateComplete;
    page
      .querySelector<HTMLButtonElement>(
        '[data-connector-id="context7"] .settings-row__control button',
      )
      ?.click();

    await waitForFast(() =>
      expect(
        page.querySelector('[data-connector-id="context7"] [role="alert"]')?.textContent,
      ).toContain("rate limit exceeded"),
    );
    // The MCP-section message stays clear; the failure belongs to the card.
    expect(page.querySelector(".plugins-group-message")).toBeNull();
  });

  it("rejects invalid MCP server names before touching config", async () => {
    const { client } = createClient(async () => createResult());
    const gatewayHarness = createGateway(client);
    const configHarness = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      { configFormDirty: false, lastError: null, configSnapshot: { sourceConfig: {}, hash: "h" } },
    );
    const { page } = await mountPage(
      createContext(
        gatewayHarness.gateway,
        configHarness.runtimeConfig.refresh,
        configHarness.runtimeConfig.state,
        configHarness,
      ),
      {
        gateway: gatewayHarness.gateway,
        gatewaySnapshot: gatewayHarness.gateway.snapshot,
        location: createPluginsRouteLocation(),
        result: createResult(),
        error: null,
      },
    );

    const addButton = [
      ...page.querySelectorAll<HTMLButtonElement>(".settings-section__actions .btn"),
    ].find((button) => button.textContent?.includes("Add server"));
    addButton?.click();
    await page.updateComplete;
    const form = page.querySelector<HTMLFormElement>(".mcp-server-form")!;
    form.querySelector<HTMLInputElement>('[name="mcp-name"]')!.value = "bad name!";
    form.querySelector<HTMLInputElement>('[name="mcp-target"]')!.value = "https://x.example/mcp";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await waitForFast(() =>
      expect(page.querySelector('[role="alert"].plugins-row-message')?.textContent).toContain(
        "Server names use",
      ),
    );
    expect(configHarness.runtimeConfig.patch).not.toHaveBeenCalled();
  });
});
