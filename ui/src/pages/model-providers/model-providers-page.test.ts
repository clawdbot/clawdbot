/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import type { ModelProvidersRouteData } from "./model-providers-page.ts";
import "./model-providers-page.ts";

type ModelProvidersPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  busy: Record<string, boolean>;
  data: ModelProvidersData | null;
  probe: (cardId: string, providers: string[]) => Promise<void>;
  probeResults: Record<string, ModelsProbeResult>;
  routeData: ModelProvidersRouteData | undefined;
  selectedAgentId: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(initialScopeId: string) {
  let pendingAuthStatus: Promise<void> | null = null;
  let releaseAuthStatus: (() => void) | null = null;
  const deferNextAuthStatus = () => {
    pendingAuthStatus = new Promise<void>((resolve) => {
      releaseAuthStatus = resolve;
    });
    return () => releaseAuthStatus?.();
  };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    switch (method) {
      case "models.authStatus": {
        if (pendingAuthStatus) {
          const gate = pendingAuthStatus;
          pendingAuthStatus = null;
          await gate;
        }
        return { ts: 1, providers: [] };
      }
      case "models.list":
        return { models: [] };
      case "config.get":
        return { config: {}, hash: "hash" };
      case "usage.status":
        return { updatedAt: 1, providers: [] };
      case "sessions.usage":
        return { aggregates: { byProvider: [] } };
      default:
        return {};
    }
  });
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  let selectionListener: (() => void) | undefined;
  const agentSelection = {
    state: { selectedId: initialScopeId, scopeId: initialScopeId as string | null },
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
    },
    ensureLoaded: vi.fn(async () => undefined),
    patchForm: vi.fn(),
    save: vi.fn(async () => true),
    apply: vi.fn(async () => true),
    discardDraft: vi.fn(async () => undefined),
    subscribe,
  };
  const context = {
    gateway: { snapshot, subscribe },
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
      },
      ensureList: vi.fn(),
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
  };
}

function appendPage(context: ApplicationContext) {
  const page = document.createElement(
    "openclaw-model-providers-page",
  ) as ModelProvidersPageTestElement;
  page.context = context;
  document.body.append(page);
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage agent scope", () => {
  it("links the page subtitle to the model providers guide", async () => {
    const { context } = createHarness("main");
    const page = appendPage(context);
    await page.updateComplete;

    const link = page.querySelector<HTMLAnchorElement>(".page-subtitle a");
    expect(link?.textContent?.trim()).toBe("Learn more");
    expect(link?.href).toBe("https://docs.openclaw.ai/concepts/model-providers");
  });

  it("patches thinking and fast mode through the shared config draft", async () => {
    const { context, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.querySelector("#settings-model-behavior")).not.toBeNull());

    const groups = page.querySelectorAll<HTMLElement & { value: string }>("wa-radio-group");
    expect(groups).toHaveLength(2);
    groups[0]!.value = "high";
    groups[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    groups[1]!.value = "off";
    groups[1]!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(runtimeConfig.patchForm).toHaveBeenNthCalledWith(
      1,
      ["agents", "defaults", "thinkingDefault"],
      "high",
    );
    expect(runtimeConfig.patchForm).toHaveBeenNthCalledWith(
      2,
      ["agents", "defaults", "fastModeDefault"],
      false,
    );
  });

  it("wires model config recovery and apply actions to the shared capability", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.state.configAutoSaveStatus = "error";
    runtimeConfig.state.configNeedsApply = true;
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.querySelector(".config-apply-banner")).not.toBeNull());

    const buttons = [...page.querySelectorAll<HTMLButtonElement>("button")];
    buttons.find((entry) => entry.textContent?.trim() === "Retry")?.click();
    buttons.find((entry) => entry.textContent?.trim() === "Restart & apply")?.click();

    expect(runtimeConfig.save).toHaveBeenCalledTimes(1);
    expect(runtimeConfig.apply).toHaveBeenCalledTimes(1);
  });

  it("reloads credential status when the agent selector changes", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "models.authStatus",
        { agentId: "main" },
        { signal: expect.any(AbortSignal) },
      ),
    );

    request.mockClear();
    page.busy = { "logout:openai": true };
    agentSelection.state.scopeId = "writer";
    notifySelection();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "models.authStatus",
        { agentId: "writer" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(1);
    expect(page.busy).toEqual({});
  });

  it("recovers when the agent changes while a refresh is in flight", async () => {
    const { agentSelection, context, notifySelection, request, deferNextAuthStatus } =
      createHarness("main");
    const release = deferNextAuthStatus();
    const page = appendPage(context);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "models.authStatus",
        { agentId: "main" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    // Invalidate the in-flight refresh mid-await; the stale completion must
    // clear `refreshing` so the new agent's load can proceed.
    agentSelection.state.scopeId = "writer";
    notifySelection();
    release();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "models.authStatus",
        { agentId: "writer" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    await vi.waitFor(() => expect(page.data?.updatedAt).toEqual(expect.any(Number)));
  });

  it("discards stale route data when selection changes during preload", async () => {
    const { context, request, snapshot } = createHarness("writer");
    const staleData = { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: 1 };
    const page = document.createElement(
      "openclaw-model-providers-page",
    ) as ModelProvidersPageTestElement;
    page.context = context;
    page.routeData = { data: staleData, client: snapshot.client, agentId: "main" };
    document.body.append(page);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "models.authStatus",
        { agentId: "writer" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(page.selectedAgentId).toBe("writer");
    expect(page.data).not.toBe(staleData);
  });

  it("probes credentials in the selected agent scope", async () => {
    const { context, request } = createHarness("writer");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    request.mockClear();

    await page.probe("openai", ["openai"]);

    expect(request).toHaveBeenCalledWith("models.probe", {
      provider: "openai",
      agentId: "writer",
    });
  });

  it("discards an in-flight probe result after the selected agent changes", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    const pending = deferred<ModelsProbeResult>();
    request.mockImplementationOnce(() => pending.promise);

    const probing = page.probe("openai", ["openai"]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.probe", {
        provider: "openai",
        agentId: "main",
      }),
    );
    page.selectedAgentId = "writer";
    pending.resolve({ provider: "openai", status: "ok", results: [] });
    await probing;

    expect(page.probeResults).toEqual({});
    expect(page.busy).toEqual({});
  });
});
