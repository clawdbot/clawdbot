import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import type { DefaultModelSelection, ModelProviderLogoutTarget } from "./data.ts";
import type { ModelProvidersData } from "./load.ts";
import type { ModelBehaviorConfig } from "./page-mutations.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import "./model-providers-page.ts";

export type ModelProvidersPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  busy: Record<string, boolean>;
  data: ModelProvidersData | null;
  defaultsDraft: (DefaultModelSelection & Partial<ModelBehaviorConfig>) | null;
  keyEditor: { provider: string; draft: string } | null;
  logout: (cardId: string, targets: ModelProviderLogoutTarget[]) => Promise<void>;
  messages: Record<string, { kind: "success" | "error"; text: string; warning?: string }>;
  pendingLogoutProvider: string | null;
  providerLogin: {
    start: (cardId: string, option: { id: string; label: string; mode: "login" }) => void;
  };
  probe: (cardId: string, providers: string[]) => Promise<void>;
  probeResults: Record<string, ModelsProbeResult>;
  refresh: (mode: "discover" | "prepared" | "revalidate") => Promise<void>;
  routeData: ModelProvidersRouteData | undefined;
  requestUpdate: () => void;
  saveDefaults: () => Promise<void>;
  saveKey: (provider: string, configKey: string) => Promise<void>;
  selectedAgentId: string;
};

export type AgentSelectElement = HTMLElement & {
  onSelect: (value: string) => void;
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function createHarness(initialScopeId: string) {
  let pendingAuthStatus: Promise<void> | null = null;
  let releaseAuthStatus: (() => void) | null = null;
  const deferNextAuthStatus = () => {
    pendingAuthStatus = new Promise<void>((resolve) => {
      releaseAuthStatus = resolve;
    });
    return () => releaseAuthStatus?.();
  };
  let usageStatus: unknown = { updatedAt: 1, providers: [] };
  let usageStatusRejects = false;
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    switch (method) {
      case "models.authStatus": {
        if (pendingAuthStatus) {
          const gate = pendingAuthStatus;
          pendingAuthStatus = null;
          await gate;
        }
        return {
          ts: 1,
          providers: [],
          providerCapabilities: [{ provider: "anthropic", apiKeySupported: true }],
        };
      }
      case "models.list":
        return { models: [] };
      case "config.get":
        return { config: {}, hash: "hash" };
      case "usage.status":
        if (usageStatusRejects) {
          throw new Error("usage.status unavailable");
        }
        return usageStatus;
      case "sessions.usage":
        return { aggregates: { byProvider: [] } };
      default:
        return {};
    }
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gatewaySource = publishableGateway(snapshot);
  let selectionListener: (() => void) | undefined;
  const agentSelection = {
    state: {
      selectedId: initialScopeId as string | null,
      scopeId: initialScopeId as string | null,
    },
    set: vi.fn(),
    setScope: vi.fn(),
    subscribe(listener: () => void) {
      selectionListener = listener;
      return () => {
        selectionListener = undefined;
      };
    },
  };
  const subscribe = () => () => undefined;
  const runtimeConfig = {
    canPatch: true,
    state: {
      connected: true,
      configSnapshot: { config: {} },
      configForm: {
        agents: { defaults: { thinkingDefault: "low", fastModeDefault: "auto" } },
      },
      configLoading: false,
      configSaving: false,
      configApplying: false,
      configNeedsApply: false,
      configFormMode: "form",
      configFormDirty: false,
      configAutoSaveStatus: "idle",
      lastError: null as string | null,
    },
    ensureLoaded: vi.fn(async (): Promise<void> => undefined),
    patch: vi.fn(async () => true),
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    refresh: vi.fn(async () => undefined),
    save: vi.fn(async () => true),
    apply: vi.fn(async () => true),
    discardDraft: vi.fn(async () => undefined),
    runExternalMutation: vi.fn(async <T>(task: (client: GatewayBrowserClient) => Promise<T>) => ({
      ok: true as const,
      value: await task(client),
      refresh: { ok: true as const },
    })),
    subscribe,
  };
  const context = {
    gateway: gatewaySource.gateway,
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "project",
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
        },
        agentsLoading: false,
        agentsError: null as string | null,
      },
      ensureList: vi.fn(),
      refreshList: vi.fn(),
      subscribe,
    },
    agentSelection,
    runtimeConfig,
    overlays: {
      snapshot: { updateRunning: false, updateReconciliationPending: false },
      subscribe,
    },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    agentSelection,
    context,
    deferNextAuthStatus,
    notifySelection: () => selectionListener?.(),
    request,
    runtimeConfig,
    snapshot,
    publishPhase: (phase: ApplicationGatewaySnapshot["phase"]) => {
      snapshot.phase = phase;
      gatewaySource.publish({ ...snapshot });
    },
    emitEvent: (event: string, payload?: unknown) => gatewaySource.emitEvent(event, payload),
    setUsageStatus: (value: unknown) => {
      usageStatus = value;
    },
    failUsageStatus: () => {
      usageStatusRejects = true;
    },
  };
}

export function publishableGateway(initial: ApplicationGatewaySnapshot) {
  let current = initial;
  const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  return {
    gateway: {
      get snapshot() {
        return current;
      },
      subscribe(listener: (value: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeEvents(listener: (event: GatewayEventFrame) => void) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
    publish(next: ApplicationGatewaySnapshot) {
      current = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
    emitEvent(event: string, payload: unknown = {}) {
      const frame = { event, payload } as GatewayEventFrame;
      for (const listener of eventListeners) {
        listener(frame);
      }
    },
  };
}

export function requestCount(request: ReturnType<typeof vi.fn>, method: string): number {
  return request.mock.calls.filter(([candidate]) => candidate === method).length;
}

export async function advanceUsageRetries(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

export function focusDocument(): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
}

export function appendPage(context: ApplicationContext) {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement(
    "openclaw-model-providers-page",
  ) as ModelProvidersPageTestElement;
  page.context = context;
  provider.append(page);
  document.body.append(provider);
  return page;
}
