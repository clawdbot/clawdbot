import type { RouteLocation } from "@openclaw/uirouter";
import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginMutationResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { PluginRowMessage } from "./plugin-row-message.ts";
import type { PluginsConsentController } from "./plugins-consent-controller.ts";
import type { PluginsRouteData } from "./plugins-page.ts";
import "./plugins-page.ts";

type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

const PLUGINS_GATEWAY_HELLO = gatewayHelloForMethods([
  "config.set",
  "plugins.inspect",
  "plugins.install",
  "plugins.list",
  "plugins.setEnabled",
  "plugins.uninstall",
]);

type GatewayHarness = {
  gateway: ApplicationGateway;
  emit: (client: GatewayBrowserClient | null, connected: boolean) => ApplicationGatewaySnapshot;
};

type TestPluginsPage = HTMLElement & {
  surface: "discovery" | "settings";
  routeData?: PluginsRouteData;
  updateComplete: Promise<boolean>;
  result: PluginListResult | null;
  loading: boolean;
  busy: Record<string, boolean>;
  messages: Record<string, PluginRowMessage>;
  applyMutationResult: (result: PluginMutationResult) => void;
  consentController: Pick<PluginsConsentController, "install">;
  refreshCatalog: () => Promise<void>;
  updateEnabled: (pluginId: string, enabled: boolean, key?: string) => Promise<void>;
  uninstall: (pluginId: string, rowKey: string) => Promise<void>;
};

export type RuntimeConfigTestState = {
  configFormDirty: boolean;
  lastError: string | null;
  configSnapshot?: { sourceConfig: Record<string, unknown>; hash: string } | null;
};

export function createPlugin(overrides: Partial<PluginCatalogItem> = {}): PluginCatalogItem {
  return {
    id: "workboard",
    name: "Workboard",
    description: t("subtitles.workboard"),
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    featured: true,
    order: 10,
    ...overrides,
  };
}

export function createResult(
  pluginOrPlugins: PluginCatalogItem | PluginCatalogItem[] = createPlugin(),
): PluginListResult {
  return {
    plugins: Array.isArray(pluginOrPlugins) ? pluginOrPlugins : [pluginOrPlugins],
    diagnostics: [],
    mutationAllowed: true,
  };
}

export function createInspectResult(
  overrides: Partial<PluginsInspectResult> = {},
): PluginsInspectResult {
  return {
    ok: true,
    reviewToken: "review-token-workboard",
    plugin: {
      id: "workboard",
      name: "Workboard",
      origin: "global",
      installed: true,
      enabled: false,
    },
    source: { kind: "npm", packageName: "workboard" },
    declared: {
      channels: [],
      providers: [],
      tools: [],
      contracts: [],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    },
    grants: {
      hooks: {
        allowPromptInjection: { effective: true },
        allowConversationAccess: { effective: false },
      },
    },
    ...overrides,
  };
}

export function createPluginsRouteLocation(url = "/settings/plugins"): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

export function createPluginsRouteData(
  gateway: ApplicationGateway,
  result: PluginListResult | null = createResult(),
  location = createPluginsRouteLocation(),
): PluginsRouteData {
  return { gateway, gatewaySnapshot: gateway.snapshot, location, result, error: null };
}

export function createClient(handler: RequestHandler) {
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
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: PLUGINS_GATEWAY_HELLO,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

export function createGateway(client: GatewayBrowserClient, connected = true): GatewayHarness {
  let snapshot = createSnapshot(client, connected);
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://localhost", token: "", password: "", bootstrapToken: "" },
    connectionRevision: 0,
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
    ensureSchemaLoaded: ReturnType<typeof vi.fn<() => Promise<undefined>>>;
    patch: ReturnType<
      typeof vi.fn<(options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>>
    >;
    patchFromSnapshot: ApplicationContext["runtimeConfig"]["patchFromSnapshot"];
    runExternalMutation: ApplicationContext["runtimeConfig"]["runExternalMutation"];
    subscribe: (listener: (state: RuntimeConfigTestState) => void) => () => void;
  };
  notify: () => void;
};

export function createRuntimeConfigHarness(
  refreshConfig: ApplicationContext["runtimeConfig"]["refresh"],
  runtimeConfigState: RuntimeConfigTestState,
  getClient?: () => GatewayBrowserClient | null,
): RuntimeConfigTestHarness {
  const listeners = new Set<(state: RuntimeConfigTestState) => void>();
  const patch = vi.fn<
    (options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>
  >(async () => true);
  const runtimeConfig = {
    state: runtimeConfigState,
    refresh: refreshConfig,
    ensureLoaded: vi.fn(async () => undefined),
    ensureSchemaLoaded: vi.fn(async () => undefined),
    patch,
    patchFromSnapshot: vi.fn(async (build) => {
      const config = runtimeConfigState.configSnapshot?.sourceConfig ?? {};
      const built = build(config);
      if ("error" in built) {
        runtimeConfigState.lastError = built.error;
        return false;
      }
      return patch(built.options);
    }),
    runExternalMutation: vi.fn(async (task) => {
      const client = getClient?.() ?? null;
      if (!client) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: "Configuration is unavailable; reconnect and try again.",
        };
      }
      try {
        const value = await task(client);
        try {
          await refreshConfig();
          return { ok: true as const, value, refresh: { ok: true as const } };
        } catch (error) {
          return {
            ok: true as const,
            value,
            refresh: {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      } catch (error) {
        return {
          ok: false as const,
          reason: "error" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
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

export function createContext(
  gateway: ApplicationGateway,
  refreshConfig: ApplicationContext["runtimeConfig"]["refresh"] = vi.fn(async () => undefined),
  runtimeConfigState: RuntimeConfigTestState = {
    configFormDirty: false,
    lastError: null,
  },
  harness = createRuntimeConfigHarness(
    refreshConfig,
    runtimeConfigState,
    () => gateway.snapshot.client,
  ),
): ApplicationContext {
  return {
    gateway,
    basePath: "",
    resourceBasePath: "",
    runtimeConfig: harness.runtimeConfig,
    navigate: vi.fn(),
    replace: vi.fn(),
  } as unknown as ApplicationContext;
}

export async function mountPage(
  context: ApplicationContext,
  routeData?: PluginsRouteData,
): Promise<{ page: TestPluginsPage; provider: ApplicationContextProvider }> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-plugins-page") as unknown as TestPluginsPage;
  page.surface = routeData?.location.pathname.includes("/settings/plugins")
    ? "settings"
    : "discovery";
  page.routeData = routeData;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

export async function activatePluginControl(
  page: TestPluginsPage,
  pluginSelector: string,
  label: string,
) {
  const controls = [
    ...page.querySelectorAll<HTMLElement>(`${pluginSelector} button, ${pluginSelector} wa-switch`),
  ];
  const control =
    controls.find((element) =>
      (element.getAttribute("aria-label") ?? element.textContent ?? "").includes(label),
    ) ?? controls.find((element) => element.tagName.toLowerCase() === "wa-switch");
  if (!control) {
    throw new Error(`No plugin control matching ${label} under ${pluginSelector}`);
  }
  if (control.tagName.toLowerCase() === "wa-switch") {
    const toggle = control as HTMLElement & { checked: boolean };
    toggle.checked = !toggle.checked;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    control.click();
  }
  await page.updateComplete;
}

export function resetPluginsPageTestState(): void {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
