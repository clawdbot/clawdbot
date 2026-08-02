/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { DefaultModelSelection, ModelProviderLogoutTarget } from "./data.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import type { ModelProvidersRouteData } from "./model-providers-page.ts";
import "./model-providers-page.ts";

type ModelProvidersPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  busy: Record<string, boolean>;
  data: ModelProvidersData | null;
  addProvider: () => Promise<void>;
  addProviderId: string;
  addProviderKey: string;
  addProviderOpen: boolean;
  defaultsDraft: DefaultModelSelection | null;
  keyDraft: string;
  keyEditorProvider: string | null;
  logout: (cardId: string, targets: ModelProviderLogoutTarget[]) => Promise<void>;
  messages: Record<string, { kind: "success" | "error"; text: string; warning?: string }>;
  pendingLogoutProvider: string | null;
  probe: (cardId: string, providers: string[]) => Promise<void>;
  probeResults: Record<string, ModelsProbeResult>;
  routeData: ModelProvidersRouteData | undefined;
  saveDefaultModels: () => Promise<void>;
  saveKey: (provider: string, configKey: string) => Promise<void>;
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

  it("removes thinking and fast overrides through the shared config draft", async () => {
    const { context, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.querySelector("#settings-model-behavior")).not.toBeNull());

    const groups = page.querySelectorAll<HTMLElement & { value: string }>(
      "#settings-model-behavior wa-radio-group",
    );
    expect(groups).toHaveLength(2);
    groups[0]!.value = "";
    groups[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    groups[1]!.value = "";
    groups[1]!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(runtimeConfig.removeFormValue).toHaveBeenNthCalledWith(1, [
      "agents",
      "defaults",
      "thinkingDefault",
    ]);
    expect(runtimeConfig.removeFormValue).toHaveBeenNthCalledWith(2, [
      "agents",
      "defaults",
      "fastModeDefault",
    ]);
  });

  it("keeps invalid explicit thinking and fast values resettable", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.state.configForm = {
      agents: { defaults: { thinkingDefault: 42, fastModeDefault: "bogus" } },
    } as unknown as typeof runtimeConfig.state.configForm;
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.querySelector("#settings-model-behavior")).not.toBeNull());

    const behavior = page.querySelector("#settings-model-behavior")!;
    const groups = behavior.querySelectorAll<HTMLElement & { value: string }>("wa-radio-group");
    expect([...groups].map((group) => group.value)).toEqual(["", ""]);
    const resetButtons = behavior.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Reset to default"]',
    );
    expect(resetButtons).toHaveLength(2);
    resetButtons.forEach((button) => button.click());

    expect(runtimeConfig.removeFormValue).toHaveBeenNthCalledWith(1, [
      "agents",
      "defaults",
      "thinkingDefault",
    ]);
    expect(runtimeConfig.removeFormValue).toHaveBeenNthCalledWith(2, [
      "agents",
      "defaults",
      "fastModeDefault",
    ]);
  });

  it("keeps a committed provider-key save successful when config refresh fails", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.refresh.mockImplementationOnce(async () => {
      runtimeConfig.state.lastError = "config.get failed after provider-key commit";
    });
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    page.keyEditorProvider = "openai";
    page.keyDraft = "replacement";

    await page.saveKey("openai", "openai");

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(page.keyEditorProvider).toBeNull();
    expect(page.messages.openai).toEqual({
      kind: "success",
      text: "Secret saved.",
      warning: "config.get failed after provider-key commit",
    });
  });

  it("keeps committed provider-add feedback visible when its refresh fails", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.refresh.mockImplementationOnce(async () => {
      runtimeConfig.state.lastError = "config.get failed after provider add";
    });
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "new-provider-key";

    await page.addProvider();
    await page.updateComplete;

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(page.addProviderOpen).toBe(true);
    expect(page.addProviderKey).toBe("");
    const form = page.querySelector(".model-providers__add-form")?.parentElement;
    expect(
      [...form!.querySelectorAll('[role="status"]')].map((message) => message.textContent?.trim()),
    ).toEqual(["Provider anthropic added.", "config.get failed after provider add"]);
  });

  it("keeps committed default models visible until their authoritative refresh succeeds", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.refresh.mockImplementationOnce(async () => {
      runtimeConfig.state.lastError = "config.get failed after saving default models";
    });
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    const selection: DefaultModelSelection = {
      primary: "openai/gpt-5",
      fallbacks: [],
      utilityModel: null,
    };
    page.defaultsDraft = selection;

    await page.saveDefaultModels();

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(page.defaultsDraft).toBe(selection);
    expect(page.messages.defaults).toEqual({
      kind: "success",
      text: "Default models saved.",
      warning: "config.get failed after saving default models",
    });
  });

  it("keeps a replacement agent's default-model draft after a global model write", async () => {
    const { agentSelection, context, notifySelection, runtimeConfig } = createHarness("main");
    const gate = deferred<void>();
    runtimeConfig.ensureLoaded.mockImplementationOnce(async () => gate.promise);
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    const selection: DefaultModelSelection = {
      primary: "openai/gpt-5",
      fallbacks: [],
      utilityModel: null,
    };
    page.defaultsDraft = selection;

    const saving = page.saveDefaultModels();
    await vi.waitFor(() => expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce());
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    gate.resolve();
    await saving;

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(page.defaultsDraft).toBe(selection);
    expect(page.messages.defaults).toBeUndefined();
  });

  it("keeps global provider writes without clearing a replacement agent's credential draft", async () => {
    const { agentSelection, context, notifySelection, runtimeConfig } = createHarness("main");
    const gate = deferred<void>();
    runtimeConfig.ensureLoaded.mockImplementationOnce(async () => gate.promise);
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    page.keyEditorProvider = "openai";
    page.keyDraft = "main-agent-key";

    const saving = page.saveKey("openai", "openai");
    await vi.waitFor(() => expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce());
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    page.keyEditorProvider = "anthropic";
    page.keyDraft = "writer-agent-unsaved-key";
    gate.resolve();
    await saving;

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(runtimeConfig.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: { models: { providers: { openai: { apiKey: "main-agent-key" } } } },
      }),
    );
    expect(page.keyEditorProvider).toBe("anthropic");
    expect(page.keyDraft).toBe("writer-agent-unsaved-key");
    expect(page.messages.openai).toBeUndefined();
  });

  it("keeps a replacement agent's matching add-provider draft after a global write", async () => {
    const { agentSelection, context, notifySelection, runtimeConfig } = createHarness("main");
    const gate = deferred<void>();
    runtimeConfig.ensureLoaded.mockImplementationOnce(async () => gate.promise);
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "shared-provider-key";

    const adding = page.addProvider();
    await vi.waitFor(() => expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce());
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "shared-provider-key";
    gate.resolve();
    await adding;

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(page.addProviderOpen).toBe(true);
    expect(page.addProviderId).toBe("anthropic");
    expect(page.addProviderKey).toBe("shared-provider-key");
    expect(page.messages.add).toBeUndefined();
  });

  it("stops queued agent-scoped logouts after the selected agent changes", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    request.mockClear();
    const firstLogout = deferred<unknown>();
    request.mockImplementationOnce(async () => firstLogout.promise);

    const loggingOut = page.logout("openai", [
      { provider: "openai", profileIds: ["openai:first"] },
      { provider: "alias", profileIds: ["openai:second"] },
    ]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authLogout", {
        provider: "openai",
        profileIds: ["openai:first"],
        agentId: "main",
      }),
    );
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    agentSelection.state.scopeId = "main";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("main"));
    firstLogout.resolve({});
    await loggingOut;

    expect(request.mock.calls.filter(([method]) => method === "models.authLogout")).toHaveLength(1);
  });

  it("stops queued agent-scoped logouts when route data changes the selected agent", async () => {
    const { agentSelection, context, request, snapshot } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    request.mockClear();
    const firstLogout = deferred<unknown>();
    request.mockImplementationOnce(async () => firstLogout.promise);

    const loggingOut = page.logout("openai", [
      { provider: "openai", profileIds: ["openai:first"] },
      { provider: "alias", profileIds: ["openai:second"] },
    ]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    page.pendingLogoutProvider = "openai";
    page.messages = { openai: { kind: "error", text: "Previous agent failure" } };
    page.probeResults = {
      openai: { provider: "openai", status: "ok", results: [] },
    };
    agentSelection.state.scopeId = "writer";
    page.routeData = {
      data: { ...EMPTY_MODEL_PROVIDERS_DATA, config: {}, updatedAt: 1 },
      client: snapshot.client,
      agentId: "writer",
    };
    await page.updateComplete;
    expect(page.selectedAgentId).toBe("writer");
    expect(page.busy).toEqual({});
    expect(page.pendingLogoutProvider).toBeNull();
    expect(page.messages).toEqual({});
    expect(page.probeResults).toEqual({});
    firstLogout.resolve({});
    await loggingOut;

    expect(request.mock.calls.filter(([method]) => method === "models.authLogout")).toHaveLength(1);
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
