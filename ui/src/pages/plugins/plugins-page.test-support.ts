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
  PluginSearchResult,
} from "../../lib/plugins/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
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
  searchResults: PluginSearchResult[] | null;
  applyMutationResult: (result: PluginMutationResult) => void;
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

export function createResult(plugin = createPlugin()): PluginListResult {
  return { plugins: [plugin], diagnostics: [], mutationAllowed: true };
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

export function createGateway(client: GatewayBrowserClient, connected = true): GatewayHarness {
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
    patchFromSnapshot: ApplicationContext["runtimeConfig"]["patchFromSnapshot"];
    subscribe: (listener: (state: RuntimeConfigTestState) => void) => () => void;
  };
  notify: () => void;
};

export function createRuntimeConfigHarness(
  refreshConfig: ApplicationContext["runtimeConfig"]["refresh"],
  runtimeConfigState: RuntimeConfigTestState,
): RuntimeConfigTestHarness {
  const listeners = new Set<(state: RuntimeConfigTestState) => void>();
  const patch = vi.fn<
    (options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>
  >(async () => true);
  const runtimeConfig = {
    state: runtimeConfigState,
    refresh: refreshConfig,
    ensureLoaded: vi.fn(async () => undefined),
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

export async function mountPage(
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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

export async function clickRowAction(page: TestPluginsPage, pluginSelector: string, label: string) {
  const button = [...page.querySelectorAll<HTMLButtonElement>(`${pluginSelector} button`)].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").includes(label),
  );
  button?.click();
  await page.updateComplete;
}

export function resetPluginsPageTestState(): void {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
