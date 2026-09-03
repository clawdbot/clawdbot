/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DefaultModelSelection } from "./data.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import { MODELS_CONNECT_NAVIGATION } from "./location.ts";
import {
  appendPage,
  createEmptyModelProvidersRouteData,
  createHarness,
  deferred,
  publishableGateway,
  requestCount,
  type AgentSelectElement,
  type ModelProvidersPageTestElement,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage agent scope", () => {
  it.each(["direct", "preload"] as const)(
    "recovers a failed %s provider usage result on the next page activation",
    async (loadSource) => {
      const { context, request, snapshot } = createHarness("main");
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const originalRequest = request.getMockImplementation()!;
      let providerUnavailable = loadSource === "direct";
      request.mockImplementation(async (method: string) => {
        if (method === "usage.status" && providerUnavailable) {
          throw new Error("provider usage unreachable");
        }
        return originalRequest(method);
      });
      const page = document.createElement(
        "openclaw-model-providers-page",
      ) as ModelProvidersPageTestElement;
      page.context = context;
      page.routeData = createEmptyModelProvidersRouteData(context);
      if (loadSource === "preload") {
        const routeData = {
          gateway: context.gateway,
          gatewaySnapshot: snapshot,
          data: {
            ...EMPTY_MODEL_PROVIDERS_DATA,
            config: {},
            providerUsage: { ok: false as const, error: { kind: "request-failed" as const } },
            updatedAt: Date.now(),
          },
          client: snapshot.client,
          agentId: "main",
        };
        page.routeData = routeData;
      }
      document.body.append(page);
      await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: false }));
      const previousCalls = requestCount(request, "usage.status");
      providerUnavailable = false;

      window.dispatchEvent(new Event("focus"));

      await vi.waitFor(() => {
        expect(requestCount(request, "usage.status")).toBe(previousCalls + 1);
      });
      await waitForFast(() =>
        expect(page.data?.providerUsage).toEqual({
          ok: true,
          value: { updatedAt: 1, providers: [] },
        }),
      );
    },
  );

  it.each(["direct", "preload"] as const)(
    "keeps a successful empty %s provider usage result fresh on page activation",
    async (loadSource) => {
      const { context, request, snapshot } = createHarness("main");
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const page = document.createElement(
        "openclaw-model-providers-page",
      ) as ModelProvidersPageTestElement;
      page.context = context;
      page.routeData = createEmptyModelProvidersRouteData(context);
      if (loadSource === "preload") {
        page.routeData = {
          gateway: context.gateway,
          gatewaySnapshot: snapshot,
          data: {
            ...EMPTY_MODEL_PROVIDERS_DATA,
            config: {},
            providerUsage: { ok: true, value: { updatedAt: 1, providers: [] } },
            updatedAt: Date.now(),
          },
          client: snapshot.client,
          agentId: "main",
        };
      }
      document.body.append(page);
      await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: true }));
      const previousCalls = requestCount(request, "usage.status");

      window.dispatchEvent(new Event("focus"));

      expect(requestCount(request, "usage.status")).toBe(previousCalls);
      expect(page.data?.providerUsage).toEqual({
        ok: true,
        value: { updatedAt: 1, providers: [] },
      });
    },
  );

  it("recovers a failed provider usage result after a same-client reconnect", async () => {
    const { context, request, snapshot } = createHarness("main");
    const source = publishableGateway(snapshot);
    (context as { gateway: unknown }).gateway = source.gateway;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const originalRequest = request.getMockImplementation()!;
    let providerUnavailable = true;
    request.mockImplementation(async (method: string) => {
      if (method === "usage.status" && providerUnavailable) {
        throw new Error("provider usage unreachable");
      }
      return originalRequest(method);
    });
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: false }));
    providerUnavailable = false;

    source.publish({ ...snapshot, phase: "reconnecting" });
    source.publish({ ...snapshot, phase: "connected" });

    await vi.waitFor(() => expect(requestCount(request, "usage.status")).toBe(2));
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: true }));
  });

  it("defers failed provider usage recovery while hidden until page activation", async () => {
    const { context, request, snapshot } = createHarness("main");
    const source = publishableGateway(snapshot);
    (context as { gateway: unknown }).gateway = source.gateway;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const originalRequest = request.getMockImplementation()!;
    let providerUnavailable = true;
    request.mockImplementation(async (method: string) => {
      if (method === "usage.status" && providerUnavailable) {
        throw new Error("provider usage unreachable");
      }
      return originalRequest(method);
    });
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: false }));
    providerUnavailable = false;

    source.publish({ ...snapshot, phase: "reconnecting" });
    source.publish({ ...snapshot, phase: "connected" });
    expect(requestCount(request, "usage.status")).toBe(1);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(requestCount(request, "usage.status")).toBe(2));
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: true }));
  });

  it("supersedes a hung load on disconnect so reconnect can replace it", async () => {
    const { context, request, snapshot, deferNextAuthStatus } = createHarness("main");
    const source = publishableGateway(snapshot);
    (context as { gateway: unknown }).gateway = source.gateway;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: true }));
    deferNextAuthStatus();
    void page.refresh("discover");
    await vi.waitFor(() => expect(requestCount(request, "models.authStatus")).toBe(2));

    source.publish({ ...snapshot, phase: "reconnecting" });
    source.publish({ ...snapshot, phase: "connected" });

    await vi.waitFor(() => expect(requestCount(request, "models.authStatus")).toBe(3));
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: true }));
  });

  it("keeps direct data visible while a same-client reconnect replaces it", async () => {
    const { context, deferNextAuthStatus, request, snapshot } = createHarness("main");
    const source = publishableGateway(snapshot);
    (context as { gateway: unknown }).gateway = source.gateway;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: true }));
    const previousData = page.data;
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { agents: { defaults: { model: "openai/replacement-model" } } },
          hash: "replacement-hash",
        };
      }
      return originalRequest(method);
    });
    const release = deferNextAuthStatus();

    source.publish({ ...snapshot, phase: "reconnecting" });
    source.publish({ ...snapshot, phase: "connected" });
    await vi.waitFor(() => expect(requestCount(request, "models.authStatus")).toBe(2));
    expect(page.data).toBe(previousData);

    release();
    await waitForFast(() =>
      expect(page.data?.config).toEqual({
        agents: { defaults: { model: "openai/replacement-model" } },
      }),
    );
  });

  it("adopts published model changes without discovery or supplemental reloads", async () => {
    const { context, emitEvent, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: true }));
    await vi.waitFor(() => expect(requestCount(request, "sessions.usage")).toBe(1));
    const previousUsage = page.data?.providerUsage;
    const modelsBefore = requestCount(request, "models.list");
    const authBefore = requestCount(request, "models.authStatus");
    const configBefore = requestCount(request, "config.get");
    const usageBefore = requestCount(request, "usage.status");
    const costBefore = requestCount(request, "sessions.usage");
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "models.list") {
        return {
          models: [{ id: "grok-4.6", name: "Grok 4.6", provider: "xai", available: true }],
        };
      }
      return originalRequest(method);
    });

    emitEvent("chat.metadata.changed");

    await waitForFast(() =>
      expect(page.data?.models?.map((model) => model.id)).toEqual(["grok-4.6"]),
    );
    expect(requestCount(request, "models.list")).toBe(modelsBefore + 1);
    expect(requestCount(request, "models.authStatus")).toBe(authBefore + 1);
    expect(requestCount(request, "config.get")).toBe(configBefore + 1);
    expect(requestCount(request, "usage.status")).toBe(usageBefore);
    expect(requestCount(request, "sessions.usage")).toBe(costBefore);
    expect(page.data?.providerUsage).toBe(previousUsage);
    expect(request.mock.calls.findLast(([method]) => method === "models.list")).toEqual([
      "models.list",
      { agentId: "main", preparedOnly: true, view: "configured" },
      { signal: expect.any(AbortSignal) },
    ]);
    expect(
      request.mock.calls.some(
        ([method, params]) => method === "models.list" && params?.refresh === true,
      ),
    ).toBe(false);
  });

  it("queues one prepared read when publication arrives during discovery", async () => {
    const { context, emitEvent, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    await vi.waitFor(() => expect(requestCount(request, "sessions.usage")).toBe(1));
    const discovery = deferred<{
      models: Array<{ id: string; name: string; provider: string; available: boolean }>;
    }>();
    const originalRequest = request.getMockImplementation()!;
    let discoverySignal: AbortSignal | undefined;
    let published = false;
    request.mockImplementation(
      async (
        method: string,
        params?: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => {
        if (method === "models.list" && params?.refresh === true) {
          discoverySignal = options?.signal;
          return discovery.promise;
        }
        if (method === "models.list" && params?.preparedOnly === true) {
          return {
            models: published
              ? [{ id: "grok-4.6", name: "Grok 4.6", provider: "xai", available: true }]
              : [],
          };
        }
        return originalRequest(method);
      },
    );
    request.mockClear();

    const refresh = page.refresh("discover");
    await vi.waitFor(() =>
      expect(
        request.mock.calls.some(
          ([method, params]) => method === "models.list" && params?.refresh === true,
        ),
      ).toBe(true),
    );
    emitEvent("chat.metadata.changed");
    emitEvent("chat.metadata.changed");
    emitEvent("config.changed");
    expect(requestCount(request, "models.list")).toBe(1);
    expect(discoverySignal?.aborted).toBe(false);

    published = true;
    discovery.resolve({
      models: [{ id: "grok-4.5", name: "Grok 4.5", provider: "xai", available: true }],
    });
    await refresh;
    await waitForFast(() =>
      expect(page.data?.models?.map((model) => model.id)).toEqual(["grok-4.6"]),
    );

    expect(discoverySignal?.aborted).toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
      [
        "models.list",
        { agentId: "main", refresh: true, view: "configured" },
        { signal: expect.any(AbortSignal) },
      ],
      [
        "models.list",
        { agentId: "main", preparedOnly: true, view: "configured" },
        { signal: expect.any(AbortSignal) },
      ],
    ]);
  });

  it("switches application ownership from the concrete agent picker", async () => {
    const { agentSelection, context } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.querySelector("openclaw-agent-select")).not.toBeNull());

    page.querySelector<AgentSelectElement>("openclaw-agent-select")?.onSelect("writer");

    expect(agentSelection.set).toHaveBeenCalledWith("writer");
    expect(agentSelection.setScope).not.toHaveBeenCalled();
  });

  it("links the page subtitle to the model providers guide", async () => {
    const { context } = createHarness("main");
    const page = appendPage(context);
    await page.updateComplete;

    const link = page.querySelector<HTMLAnchorElement>(".page-subtitle a");
    expect(link?.textContent?.trim()).toBe("Learn more");
    expect(link?.href).toBe("https://docs.openclaw.ai/concepts/model-providers");
  });

  it("opens the Connect flow inside Models", async () => {
    const { context } = createHarness("main");
    const page = appendPage(context);
    await page.updateComplete;

    const action = [
      ...page.querySelectorAll<HTMLButtonElement>(".page-header-actions button"),
    ].find((button) => button.textContent?.includes("Connect a model"));
    expect(action?.querySelector("svg")).not.toBeNull();
    action?.click();
    expect(context.navigate).toHaveBeenCalledWith("model-providers", MODELS_CONNECT_NAVIGATION);
  });

  it("renders regular Connect as one embedded Models flow", async () => {
    const { context, snapshot } = createHarness("main");
    const page = appendPage(context);
    page.routeData = {
      view: "connect",
      firstRun: false,
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      data: EMPTY_MODEL_PROVIDERS_DATA,
      client: snapshot.client,
      agentId: "main",
    };

    await waitForFast(() => expect(page.querySelector("openclaw-model-setup-page")).not.toBeNull());
    const setup = page.querySelector<HTMLElement & { embedded: boolean }>(
      "openclaw-model-setup-page",
    );
    expect(setup?.embedded).toBe(true);
    expect(page.querySelector(".page-title")?.textContent?.trim()).toBe("Models");
    expect(page.querySelector("[data-models-manage]")).not.toBeNull();
    expect(page.querySelector(".model-providers__defaults")).toBeNull();
  });

  it("keeps first-run Connect focused without Models management chrome", async () => {
    const { context, snapshot } = createHarness("main");
    const page = appendPage(context);
    page.routeData = {
      view: "connect",
      firstRun: true,
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      data: EMPTY_MODEL_PROVIDERS_DATA,
      client: snapshot.client,
      agentId: "main",
    };

    await waitForFast(() => expect(page.querySelector("openclaw-model-setup-page")).not.toBeNull());
    const setup = page.querySelector<HTMLElement & { embedded: boolean }>(
      "openclaw-model-setup-page",
    );
    expect(setup?.embedded).toBe(false);
    expect(page.querySelector("[data-models-manage]")).toBeNull();
  });

  it("autosaves model behavior changes", async () => {
    const { context, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.querySelector("#settings-model-behavior")).not.toBeNull());

    const groups = page.querySelectorAll<HTMLElement & { value: string }>("wa-radio-group");
    expect(groups).toHaveLength(2);
    groups[0]!.value = "high";
    groups[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patchForm).not.toHaveBeenCalled();
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: {
        agents: {
          defaults: {
            fastModeDefault: "auto",
            thinkingDefault: "high",
          },
        },
      },
      note: "Update defaults from Control UI",
      replacePaths: ["agents.defaults.model.fallbacks"],
    });
  });

  it("preserves trailing fallbacks when replacing the visible fallback", async () => {
    const { context, runtimeConfig } = createHarness("main");
    const model = {
      primary: "openai/gpt-5",
      fallbacks: ["anthropic/claude-sonnet", "google/gemini-pro"],
    };
    Object.assign(runtimeConfig.state.configForm.agents.defaults, { model });
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: runtimeConfig.state.configForm,
      models: [
        { id: "gpt-5", name: "GPT-5", provider: "openai", available: true },
        {
          id: "claude-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
          available: true,
        },
        { id: "gemini-pro", name: "Gemini Pro", provider: "google", available: true },
        { id: "grok", name: "Grok", provider: "xai", available: true },
      ],
    };
    page.requestUpdate();
    await page.updateComplete;
    runtimeConfig.patch.mockClear();

    const fallback = [
      ...page.querySelectorAll<HTMLElement & { value: string; updateComplete: Promise<unknown> }>(
        "wa-select",
      ),
    ].find((select) => select.querySelector('[slot="label"]')?.textContent === "Fallback Model");
    expect(fallback).toBeDefined();
    fallback!.value = "xai/grok";
    await fallback!.updateComplete;
    fallback!.dispatchEvent(new Event("change", { bubbles: true }));

    await waitForFast(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5",
              fallbacks: ["xai/grok", "google/gemini-pro"],
            },
            utilityModel: null,
            thinkingDefault: "low",
            fastModeDefault: "auto",
          },
        },
      },
      note: "Update defaults from Control UI",
      replacePaths: ["agents.defaults.model.fallbacks"],
    });
  });

  it("autosaves removal of inherited behavior overrides", async () => {
    const { context, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.querySelector("#settings-model-behavior")).not.toBeNull());

    const groups = page.querySelectorAll<HTMLElement & { value: string }>(
      "#settings-model-behavior wa-radio-group",
    );
    expect(groups).toHaveLength(2);
    groups[0]!.value = "";
    groups[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: {
        agents: {
          defaults: {
            fastModeDefault: "auto",
            thinkingDefault: null,
          },
        },
      },
      note: "Update defaults from Control UI",
      replacePaths: ["agents.defaults.model.fallbacks"],
    });
  });

  it("keeps invalid explicit thinking and fast values resettable", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.state.configForm = {
      agents: { defaults: { thinkingDefault: 42, fastModeDefault: "bogus" } },
    } as unknown as typeof runtimeConfig.state.configForm;
    const page = appendPage(context);
    await waitForFast(() => expect(page.querySelector("#settings-model-behavior")).not.toBeNull());

    const behavior = page.querySelector("#settings-model-behavior")!;
    const groups = behavior.querySelectorAll<HTMLElement & { value: string }>("wa-radio-group");
    expect([...groups].map((group) => group.value)).toEqual(["", ""]);
    const defaults = behavior.querySelectorAll<HTMLElement>('wa-radio[value=""]');
    expect(defaults).toHaveLength(2);
    defaults[0]?.click();
    await waitForFast(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
  });

  it("disables defaults without showing an admin warning when config patches are unavailable", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.canPatch = false;
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const defaults = page.querySelector(".model-providers__defaults");

    expect(
      [...(defaults?.querySelectorAll("wa-select, wa-radio-group") ?? [])].every((control) =>
        control.hasAttribute("disabled"),
      ),
    ).toBe(true);
    expect(page.textContent).not.toContain("operator.admin access");
  });
  it("keeps a committed provider-key save successful when config refresh fails", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.refresh.mockImplementationOnce(async () => {
      runtimeConfig.state.lastError = "config.get failed after provider-key commit";
    });
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    page.keyEditor = { provider: "openai", draft: "replacement" };

    await page.saveKey("openai", "openai");

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(page.keyEditor).toBeNull();
    expect(page.messages.openai).toEqual({
      kind: "success",
      text: "Secret saved.",
      warning: "config.get failed after provider-key commit",
    });
  });

  it("keeps committed default models visible until their authoritative refresh succeeds", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.refresh.mockImplementationOnce(async () => {
      runtimeConfig.state.lastError = "config.get failed after saving default models";
    });
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const selection: DefaultModelSelection = {
      primary: "openai/gpt-5",
      fallbacks: [],
      utilityModel: null,
    };
    page.defaultsDraft = selection;

    await page.saveDefaults();

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(page.defaultsDraft).toBe(selection);
    expect(page.messages.defaults).toEqual({
      kind: "success",
      text: "Defaults saved.",
      warning: "config.get failed after saving default models",
    });
  });

  it("keeps a replacement agent's default-model draft after a global model write", async () => {
    const { agentSelection, context, notifySelection, runtimeConfig } = createHarness("main");
    const gate = deferred<void>();
    runtimeConfig.ensureLoaded.mockImplementationOnce(async () => gate.promise);
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const selection: DefaultModelSelection = {
      primary: "openai/gpt-5",
      fallbacks: [],
      utilityModel: null,
    };
    page.defaultsDraft = selection;

    const saving = page.saveDefaults();
    await vi.waitFor(() => expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce());
    agentSelection.state.selectedId = "writer";
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
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    page.keyEditor = { provider: "openai", draft: "main-agent-key" };

    const saving = page.saveKey("openai", "openai");
    await vi.waitFor(() => expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce());
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    page.keyEditor = { provider: "anthropic", draft: "writer-agent-unsaved-key" };
    gate.resolve();
    await saving;

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(runtimeConfig.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: { models: { providers: { openai: { apiKey: "main-agent-key" } } } },
      }),
    );
    expect(page.keyEditor).toEqual({ provider: "anthropic", draft: "writer-agent-unsaved-key" });
    expect(page.messages.openai).toBeUndefined();
  });

  it("stops queued agent-scoped logouts after the selected agent changes", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
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
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    agentSelection.state.selectedId = "main";
    agentSelection.state.scopeId = "main";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("main"));
    firstLogout.resolve({});
    await loggingOut;

    expect(request.mock.calls.filter(([method]) => method === "models.authLogout")).toHaveLength(1);
  });

  it("finishes logout without waiting for full catalog discovery", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    request.mockClear();

    await page.logout("xai", [{ provider: "xai", profileIds: ["xai:owner"] }]);

    expect(request).toHaveBeenCalledWith("models.authLogout", {
      provider: "xai",
      profileIds: ["xai:owner"],
      agentId: "main",
    });
    expect(request).toHaveBeenCalledWith(
      "models.authStatus",
      { agentId: "main" },
      { signal: expect.any(AbortSignal) },
    );
    expect(
      request.mock.calls.some(
        ([method, params]) => method === "models.list" && params?.refresh === true,
      ),
    ).toBe(false);
    expect(page.busy["logout:xai"]).toBeUndefined();
    expect(page.messages.xai).toEqual({ kind: "success", text: "Logged out." });
  });

  it("finishes login without waiting for full catalog discovery", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "provider-login", done: true, status: "done" };
      }
      return originalRequest(method);
    });
    request.mockClear();

    page.providerLogin.start("xai", {
      id: "xai-oauth",
      label: "xAI OAuth",
      mode: "login",
    });

    await vi.waitFor(() =>
      expect(page.messages.xai).toEqual({
        kind: "success",
        text: "Signed in. Available models will update automatically; your default is unchanged.",
      }),
    );
    await vi.waitFor(() => expect(requestCount(request, "models.authStatus")).toBe(1));
    expect(
      request.mock.calls.some(
        ([method, params]) => method === "models.list" && params?.refresh === true,
      ),
    ).toBe(false);
  });

  it("saves a pending Models draft before login and refreshes their combined config", async () => {
    const { context, request, snapshot } = createHarness("main");
    const originalRequest = request.getMockImplementation()!;
    const order: string[] = [];
    let revision = 1;
    let storedConfig: Record<string, unknown> = {
      agents: { defaults: { modelPolicy: { allow: ["openai/gpt-5.6-sol"] } } },
    };
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        order.push("config.get");
        const raw = `${JSON.stringify(storedConfig, null, 2)}\n`;
        return {
          config: structuredClone(storedConfig),
          raw,
          hash: `hash-${revision}`,
          configRevisionHash: `hash-${revision}`,
          appliedConfigHash: `hash-${revision}`,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        order.push("config.set");
        storedConfig = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        revision += 1;
        return { hash: `hash-${revision}` };
      }
      if (method === "openclaw.setup.auth.start") {
        order.push("openclaw.setup.auth.start");
        const agents = storedConfig.agents as {
          defaults?: { modelPolicy?: { allow?: string[] } };
        };
        storedConfig = {
          ...storedConfig,
          agents: {
            ...agents,
            defaults: {
              ...agents.defaults,
              modelPolicy: {
                ...agents.defaults?.modelPolicy,
                allow: [...(agents.defaults?.modelPolicy?.allow ?? []), "xai/*"],
              },
            },
          },
        };
        revision += 1;
        return {
          sessionId: "coordinated-provider-login",
          done: true,
          status: "done",
        };
      }
      return await originalRequest(method);
    });
    const gatewayHarness = createGatewayHarness(snapshot.client as GatewayBrowserClient);
    const gateway = Object.assign(gatewayHarness.gateway, {
      subscribeEvents: () => () => undefined,
    });
    const runtimeConfig = createRuntimeConfigCapability(gatewayHarness.gateway);
    Object.assign(context, { gateway, runtimeConfig });
    await runtimeConfig.ensureLoaded();
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual(storedConfig));
    order.length = 0;

    runtimeConfig.patchForm(["messages", "responsePrefix"], "draft-prefix");
    page.providerLogin.start("xai", {
      id: "xai-oauth",
      label: "xAI OAuth",
      mode: "login",
    });

    await vi.waitFor(() => expect(page.messages.xai?.kind).toBe("success"));
    expect(order.indexOf("config.set")).toBeLessThan(order.indexOf("openclaw.setup.auth.start"));
    expect(order.indexOf("openclaw.setup.auth.start")).toBeLessThan(
      order.lastIndexOf("config.get"),
    );
    expect(storedConfig).toMatchObject({
      messages: { responsePrefix: "draft-prefix" },
      agents: { defaults: { modelPolicy: { allow: ["openai/gpt-5.6-sol", "xai/*"] } } },
    });
    expect(runtimeConfig.state.configForm).toMatchObject(storedConfig);
    runtimeConfig.dispose();
  });

  it("stops queued agent-scoped logouts when route data changes the selected agent", async () => {
    const { agentSelection, context, request, snapshot } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    request.mockClear();
    const firstLogout = deferred<unknown>();
    request.mockImplementationOnce(async () => firstLogout.promise);

    const loggingOut = page.logout("openai", [
      { provider: "openai", profileIds: ["openai:first"] },
      { provider: "alias", profileIds: ["openai:second"] },
    ]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const defaultsDraft: DefaultModelSelection = {
      primary: "openai/gpt-5",
      fallbacks: [],
      utilityModel: null,
    };
    page.keyEditor = { provider: "openai", draft: "synthetic-route-agent-key" };
    page.defaultsDraft = defaultsDraft;
    page.pendingLogoutProvider = "openai";
    page.messages = { openai: { kind: "error", text: "Previous agent failure" } };
    page.probeResults = {
      openai: { provider: "openai", status: "ok", results: [] },
    };
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
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
    expect(page.keyEditor).toBeNull();
    expect(page.defaultsDraft).toBe(defaultsDraft);
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
    const defaultsDraft: DefaultModelSelection = {
      primary: "openai/gpt-5",
      fallbacks: [],
      utilityModel: null,
    };
    page.busy = { "logout:openai": true };
    page.keyEditor = { provider: "openai", draft: "synthetic-selected-agent-key" };
    page.defaultsDraft = defaultsDraft;
    notifySelection();
    expect(page.keyEditor).toEqual({
      provider: "openai",
      draft: "synthetic-selected-agent-key",
    });
    expect(page.defaultsDraft).toBe(defaultsDraft);
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "models.authStatus",
        { agentId: "writer" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(1);
    expect(page.busy).toEqual({});
    expect(page.keyEditor).toBeNull();
    expect(page.defaultsDraft).toBe(defaultsDraft);
  });

  it("keeps the concrete selected owner after another page widens scope to all agents", async () => {
    const { agentSelection, context, request } = createHarness("writer");
    agentSelection.state.scopeId = null;

    const page = appendPage(context);

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "models.authStatus",
        { agentId: "writer" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(page.selectedAgentId).toBe("writer");
  });

  it("does not request model data before a concrete agent is selected", async () => {
    const { agentSelection, context, request } = createHarness("main");
    agentSelection.state.selectedId = null;
    agentSelection.state.scopeId = null;

    const page = appendPage(context);
    await page.updateComplete;

    expect(page.selectedAgentId).toBe("");
    expect(
      request.mock.calls.filter(
        ([method]) => method === "models.authStatus" || method === "models.list",
      ),
    ).toEqual([]);
  });

  it("shows a roster failure without automatically retrying it", async () => {
    const { agentSelection, context } = createHarness("main");
    agentSelection.state.selectedId = null;
    agentSelection.state.scopeId = null;
    context.agents.state.agentsList = null;
    context.agents.state.agentsError = "Agent roster unavailable";

    const page = appendPage(context);
    await page.updateComplete;

    expect(context.agents.ensureList).not.toHaveBeenCalled();
    expect(page.textContent).toContain("Agent roster unavailable");

    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
    expect(context.agents.refreshList).toHaveBeenCalledOnce();
  });

  it("recovers when the agent changes while a refresh is in flight", async () => {
    const { agentSelection, context, emitEvent, notifySelection, request, deferNextAuthStatus } =
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
    emitEvent("chat.metadata.changed");
    // Invalidate the in-flight refresh mid-await; the stale completion must
    // clear `refreshing` and its queued revalidation so the new agent's load
    // can proceed without a trailing request for the old owner.
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();
    release();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "models.authStatus",
        { agentId: "writer" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    await waitForFast(() => expect(page.data?.updatedAt).toEqual(expect.any(Number)));
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "models.list" && params?.agentId === "main" && params?.preparedOnly === true,
      ),
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "models.list" && params?.agentId === "writer" && params?.preparedOnly === true,
      ),
    ).toHaveLength(1);
  });

  it("discards stale route data when selection changes during preload", async () => {
    const { context, request, snapshot } = createHarness("writer");
    const staleData = { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: 1 };
    const page = document.createElement(
      "openclaw-model-providers-page",
    ) as ModelProvidersPageTestElement;
    page.context = context;
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
      data: staleData,
      client: snapshot.client,
      agentId: "main",
    };
    document.body.append(page);

    await waitForFast(() =>
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
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    request.mockClear();

    await page.probe("openai", ["openai"]);

    expect(request).toHaveBeenCalledWith("models.probe", {
      provider: "openai",
      agentId: "writer",
    });
  });

  it("stops queued provider probes after switching away from and back to the selected agent", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    request.mockClear();
    const firstProbe = deferred<ModelsProbeResult>();
    request.mockImplementationOnce(() => firstProbe.promise);

    const probing = page.probe("anthropic", ["anthropic", "claude-cli"]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.probe", {
        provider: "anthropic",
        agentId: "main",
      }),
    );
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    agentSelection.state.selectedId = "main";
    agentSelection.state.scopeId = "main";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("main"));
    firstProbe.resolve({ provider: "anthropic", status: "ok", results: [] });
    await probing;

    expect(request.mock.calls.filter(([method]) => method === "models.probe")).toHaveLength(1);
    expect(page.probeResults).toEqual({});
    expect(page.busy).toEqual({});
  });

  it("discards an in-flight probe result after the selected agent changes", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const pending = deferred<ModelsProbeResult>();
    request.mockImplementationOnce(() => pending.promise);

    const probing = page.probe("openai", ["openai"]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.probe", {
        provider: "openai",
        agentId: "main",
      }),
    );
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    pending.resolve({ provider: "openai", status: "ok", results: [] });
    await probing;

    expect(page.probeResults).toEqual({});
    expect(page.busy).toEqual({});
  });
});
