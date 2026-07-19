/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { PluginsRouteData } from "./plugins-page.ts";
import "./plugins-page.ts";

type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

type GatewayHarness = {
  gateway: ApplicationGateway;
  emit: (client: GatewayBrowserClient | null, connected: boolean) => ApplicationGatewaySnapshot;
};

type TestPluginsPage = HTMLElement & {
  routeData?: PluginsRouteData;
  updateComplete: Promise<boolean>;
  result: PluginListResult | null;
  loading: boolean;
  busy: Record<string, boolean>;
  activeTab: "installed" | "discover";
  applyMutationResult: (result: PluginMutationResult) => void;
};

type RuntimeConfigTestState = {
  configFormDirty: boolean;
  lastError: string | null;
  configSnapshot?: { sourceConfig: Record<string, unknown>; hash: string } | null;
};

function createPlugin(overrides: Partial<PluginCatalogItem> = {}): PluginCatalogItem {
  return {
    id: "workboard",
    name: "Workboard",
    description: "Agent work queue and thread handoff.",
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    featured: true,
    order: 10,
    ...overrides,
  };
}

function createResult(plugin = createPlugin()): PluginListResult {
  return { plugins: [plugin], diagnostics: [], mutationAllowed: true };
}

function createClient(handler: RequestHandler) {
  const request = vi.fn(handler);
  return {
    client: { request } as unknown as GatewayBrowserClient,
    request,
  };
}

function createSnapshot(
  client: GatewayBrowserClient | null,
  connected: boolean,
): ApplicationGatewaySnapshot {
  return {
    client,
    connected,
    reconnecting: !connected,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

function createGateway(client: GatewayBrowserClient, connected = true): GatewayHarness {
  let snapshot = createSnapshot(client, connected);
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://localhost", token: "", password: "", bootstrapToken: "" },
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } satisfies ApplicationGateway;
  return {
    gateway,
    emit(nextClient, nextConnected) {
      snapshot = createSnapshot(nextClient, nextConnected);
      for (const listener of listeners) {
        listener(snapshot);
      }
      return snapshot;
    },
  };
}

type RuntimeConfigTestHarness = {
  runtimeConfig: {
    state: RuntimeConfigTestState;
    refresh: ApplicationContext["runtimeConfig"]["refresh"];
    ensureLoaded: ReturnType<typeof vi.fn<() => Promise<undefined>>>;
    patch: ReturnType<
      typeof vi.fn<(options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>>
    >;
    subscribe: (listener: (state: RuntimeConfigTestState) => void) => () => void;
  };
  notify: () => void;
};

function createRuntimeConfigHarness(
  refreshConfig: ApplicationContext["runtimeConfig"]["refresh"],
  runtimeConfigState: RuntimeConfigTestState,
): RuntimeConfigTestHarness {
  const listeners = new Set<(state: RuntimeConfigTestState) => void>();
  const runtimeConfig = {
    state: runtimeConfigState,
    refresh: refreshConfig,
    ensureLoaded: vi.fn(async () => undefined),
    patch: vi.fn<(options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>>(
      async () => true,
    ),
    subscribe(listener: (state: RuntimeConfigTestState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    runtimeConfig,
    notify: () => {
      for (const listener of listeners) {
        listener(runtimeConfigState);
      }
    },
  };
}

function createContext(
  gateway: ApplicationGateway,
  refreshConfig: ApplicationContext["runtimeConfig"]["refresh"],
  runtimeConfigState: RuntimeConfigTestState = {
    configFormDirty: false,
    lastError: null,
  },
  harness = createRuntimeConfigHarness(refreshConfig, runtimeConfigState),
): ApplicationContext {
  return {
    gateway,
    basePath: "",
    runtimeConfig: harness.runtimeConfig,
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
}

async function mountPage(
  context: ApplicationContext,
  routeData?: PluginsRouteData,
): Promise<{ page: TestPluginsPage; provider: ApplicationContextProvider }> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-plugins-page") as unknown as TestPluginsPage;
  page.routeData = routeData;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function clickRowAction(page: TestPluginsPage, pluginSelector: string, label: string) {
  const button = [...page.querySelectorAll<HTMLButtonElement>(`${pluginSelector} button`)].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").includes(label),
  );
  button?.click();
  await page.updateComplete;
}

describe("PluginsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts matching route data without issuing a duplicate list request", async () => {
    const { client, request } = createClient(async () => createResult());
    const harness = createGateway(client);
    const result = createResult();
    const routeData: PluginsRouteData = {
      gateway: harness.gateway,
      gatewaySnapshot: harness.gateway.snapshot,
      initialTab: null,
      result,
      error: null,
    };

    const { page } = await mountPage(
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      routeData,
    );

    expect(page.result).toBe(result);
    expect(request).not.toHaveBeenCalled();
    expect(page.querySelectorAll("h1")).toHaveLength(1);
    expect(page.querySelector("h1")?.textContent).toBe("Plugins");
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
    const routeData: PluginsRouteData = {
      gateway: harness.gateway,
      gatewaySnapshot: harness.gateway.snapshot,
      initialTab: null,
      result,
      error: null,
    };

    const { page } = await mountPage(
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      routeData,
    );

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
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      {
        gateway: harness.gateway,
        gatewaySnapshot: harness.gateway.snapshot,
        initialTab: null,
        result,
        error: null,
      },
    );

    await waitForFast(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(
      page.querySelector('[data-plugin-id="unsafe-icon"] .plugins-tile--fallback')?.textContent,
    ).toContain("UI");
  });

  it("applies a ?tab=discover deep link from route data", async () => {
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    const routeData: PluginsRouteData = {
      gateway: harness.gateway,
      gatewaySnapshot: harness.gateway.snapshot,
      result: createResult(),
      error: null,
      initialTab: "discover",
    };
    const { page } = await mountPage(
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      routeData,
    );

    expect(page.activeTab).toBe("discover");
    const tabGroup = page.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "wa-tab-group",
    );
    await tabGroup?.updateComplete;
    expect(
      page.querySelector<HTMLElement & { active: boolean }>("#plugins-tab-discover")?.active,
    ).toBe(true);
  });

  it("routes the skills and workshop hub tabs through navigation", async () => {
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    const context = createContext(
      harness.gateway,
      vi.fn(async () => undefined),
    );
    const routeData: PluginsRouteData = {
      gateway: harness.gateway,
      gatewaySnapshot: harness.gateway.snapshot,
      initialTab: null,
      result: createResult(),
      error: null,
    };
    const { page } = await mountPage(context, routeData);

    page.querySelector<HTMLButtonElement>("#plugins-tab-skills")?.click();
    expect(context.navigate).toHaveBeenCalledWith("skills");
    page.querySelector<HTMLButtonElement>("#plugins-tab-workshop")?.click();
    expect(context.navigate).toHaveBeenCalledWith("skill-workshop");
    expect(page.activeTab).toBe("installed");

    // Catalog tabs switch locally for instant feedback and keep the URL in
    // sync with the ?tab=discover deep link.
    page.querySelector<HTMLButtonElement>("#plugins-tab-discover")?.click();
    expect(page.activeTab).toBe("discover");
    expect(context.navigate).toHaveBeenCalledWith("plugins", { search: "?tab=discover" });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>("#plugins-tab-installed")?.click();
    expect(page.activeTab).toBe("installed");
    expect(context.navigate).toHaveBeenCalledWith("plugins", undefined);
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
    const routeData: PluginsRouteData = {
      gateway: harness.gateway,
      gatewaySnapshot: harness.gateway.snapshot,
      initialTab: null,
      result: createResult(),
      error: null,
    };
    const { page } = await mountPage(
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      routeData,
    );

    harness.emit(client, false);
    harness.emit(client, true);

    await waitForFast(() => expect(page.result?.plugins[0]?.enabled).toBe(true));
    expect(request).toHaveBeenCalledWith("plugins.list", {});
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
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      {
        gateway: harness.gateway,
        gatewaySnapshot: harness.gateway.snapshot,
        initialTab: null,
        result: createResult(),
        error: null,
      },
    );

    page.querySelector<HTMLButtonElement>("#plugins-tab-discover")?.click();
    const search = page.querySelector<HTMLInputElement>("#plugins-global-search")!;
    search.value = "w";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.value = "work";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.value = "workboard";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("plugins.search", {
      query: "workboard",
      limit: 20,
    });
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
      {
        gateway: harness.gateway,
        gatewaySnapshot: harness.gateway.snapshot,
        initialTab: null,
        result: createResult(),
        error: null,
      },
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

  it("keeps the enable action retryable after a failed enable", async () => {
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.setEnabled") {
        throw new Error("Enable failed");
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      {
        gateway: harness.gateway,
        gatewaySnapshot: harness.gateway.snapshot,
        initialTab: null,
        result: createResult(),
        error: null,
      },
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
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      {
        gateway: harness.gateway,
        gatewaySnapshot: harness.gateway.snapshot,
        initialTab: null,
        result: createResult(),
        error: null,
      },
    );

    page.querySelector<HTMLButtonElement>("#plugins-tab-discover")?.click();
    const search = page.querySelector<HTMLInputElement>("#plugins-global-search")!;
    search.value = "calendar";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    harness.emit(client, false);
    await vi.advanceTimersByTimeAsync(300);
    expect(request.mock.calls.some(([method]) => method === "plugins.search")).toBe(false);

    harness.emit(client, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(request).toHaveBeenCalledWith("plugins.search", {
      query: "calendar",
      limit: 20,
    });
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
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      {
        gateway: harness.gateway,
        gatewaySnapshot: harness.gateway.snapshot,
        initialTab: null,
        result: createResult(),
        error: null,
      },
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

  it("surfaces and retries a runtime config refresh failure", async () => {
    const enabledPlugin = createPlugin({ enabled: true, state: "enabled" });
    const { client } = createClient(async (method) => {
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
    let refreshCalls = 0;
    const refreshConfig = vi.fn(async () => {
      refreshCalls += 1;
      runtimeConfigState.lastError = refreshCalls === 1 ? "config.get failed" : null;
    });
    const { page } = await mountPage(
      createContext(harness.gateway, refreshConfig, runtimeConfigState),
      {
        gateway: harness.gateway,
        gatewaySnapshot: harness.gateway.snapshot,
        initialTab: null,
        result: createResult(),
        error: null,
      },
    );

    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
    await waitForFast(() =>
      expect(page.querySelector(".plugins-page-error")?.textContent).toContain(
        "Could not refresh Control UI configuration: config.get failed",
      ),
    );

    page.querySelector<HTMLButtonElement>(".plugins-page-error button")?.click();
    await waitForFast(() => expect(page.querySelector(".plugins-page-error")).toBeNull());
    expect(refreshConfig).toHaveBeenCalledTimes(2);
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
    const { page } = await mountPage(createContext(harness.gateway, refreshConfig), {
      gateway: harness.gateway,
      gatewaySnapshot: harness.gateway.snapshot,
      initialTab: null,
      result: disabledResult,
      error: null,
    });

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
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      {
        gateway: harness.gateway,
        gatewaySnapshot: harness.gateway.snapshot,
        initialTab: null,
        result: { plugins: [createPlugin(), removable], diagnostics: [], mutationAllowed: true },
        error: null,
      },
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
        initialTab: null,
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
        initialTab: null,
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
        initialTab: null,
        result: createResult(),
        error: null,
      },
    );

    page.querySelector<HTMLButtonElement>("#plugins-tab-discover")?.click();
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
        initialTab: null,
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
