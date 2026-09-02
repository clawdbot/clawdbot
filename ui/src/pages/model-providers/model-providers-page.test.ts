/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelsProbeResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { readModelProviderConfig, type DefaultModelSelection } from "./data.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  chooseProviderSetup,
  createHarness,
  createProviderSetupHarness,
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
    void page.refresh({ force: true });
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

  it("opens model setup from the Configure Models action", async () => {
    const { context } = createHarness("main");
    const page = appendPage(context);
    await page.updateComplete;

    const action = [
      ...page.querySelectorAll<HTMLButtonElement>(".page-header-actions button"),
    ].find((button) => button.textContent?.includes("Configure Models"));
    expect(action?.querySelector("svg")).not.toBeNull();
    action?.click();
    expect(context.navigate).toHaveBeenCalledWith("model-setup");
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

  it.each([false, true])(
    "configures an opaque catalog choice without changing defaults, retaining refresh failure %s",
    async (refreshFails) => {
      const { context, request, runtimeConfig, authChoice, config } = createProviderSetupHarness();
      const originalRequest = request.getMockImplementation()!;
      let configured = false;
      request.mockImplementation(async (method: string) => {
        if (method === "config.get" && configured && refreshFails) {
          throw new Error("config.get failed after provider add");
        }
        if (method === "openclaw.setup.prepare.start") {
          return { sessionId: "provider-prepare", done: false, status: "running" };
        }
        if (method === "wizard.next") {
          configured = true;
          return { done: true, status: "done", preparedModelRef: "catalog-vendor/model" };
        }
        return originalRequest(method);
      });
      await runtimeConfig.ensureLoaded();
      const page = appendPage(context);
      try {
        await waitForFast(() => expect(page.data?.config).toEqual(config));
        expect(requestCount(request, "openclaw.setup.detect")).toBe(0);
        await chooseProviderSetup(page, authChoice);
        expect(requestCount(request, "openclaw.setup.detect")).toBe(1);
        expect(page.querySelector('.model-providers__add-form input[type="password"]')).toBeNull();
        page.querySelector<HTMLButtonElement>(".model-providers__add-form .primary")?.click();
        await waitForFast(() =>
          expect(page.textContent).toContain("Provider Catalog vendor configured."),
        );
        expect(request).toHaveBeenCalledWith(
          "openclaw.setup.prepare.start",
          { sessionId: expect.any(String), agentId: "main", authChoice },
          { timeoutMs: null },
        );
        expect(requestCount(request, "config.patch")).toBe(0);
        expect(requestCount(request, "openclaw.setup.activate.start")).toBe(0);
        expect(
          readModelProviderConfig(runtimeConfig.state.configSnapshot?.config ?? null).defaults
            .primary,
        ).toBe("existing/default");
        expect(page.textContent).not.toContain("Connection verified");
        if (refreshFails) {
          expect(page.textContent).toContain("config.get failed after provider add");
        }
      } finally {
        page.remove();
        runtimeConfig.dispose();
      }
    },
  );

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
    page.keyEditorProvider = "openai";
    page.keyDraft = "main-agent-key";

    const saving = page.saveKey("openai", "openai");
    await vi.waitFor(() => expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce());
    agentSelection.state.selectedId = "writer";
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

  it.each(["agent", "connection"] as const)(
    "cancels provider setup on a %s change without clearing the next selection",
    async (scope) => {
      const {
        agentSelection,
        context,
        notifySelection,
        runtimeConfig,
        request,
        publishPhase,
        authChoice,
        config,
      } = createProviderSetupHarness();
      const runMutation = vi.spyOn(runtimeConfig, "runExternalMutation");
      const gate = deferred<unknown>();
      const originalRequest = request.getMockImplementation()!;
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.prepare.start") {
          return gate.promise;
        }
        if (method === "wizard.cancel") {
          return { status: "cancelled" };
        }
        return originalRequest(method);
      });
      await runtimeConfig.ensureLoaded();
      const page = appendPage(context);
      try {
        await waitForFast(() => expect(page.data?.config).toEqual(config));
        await chooseProviderSetup(page, authChoice);
        page.querySelector<HTMLButtonElement>(".model-providers__add-form .primary")?.click();
        await waitForFast(() =>
          expect(requestCount(request, "openclaw.setup.prepare.start")).toBe(1),
        );
        expect(runMutation).toHaveBeenCalledOnce();
        const pendingSetup = runMutation.mock.results[0]!.value;
        if (scope === "agent") {
          agentSelection.state.selectedId = "writer";
          agentSelection.state.scopeId = "writer";
          notifySelection();
          await waitForFast(() => expect(page.selectedAgentId).toBe("writer"));
          agentSelection.state.selectedId = "main";
          agentSelection.state.scopeId = "main";
          notifySelection();
        } else {
          publishPhase("reconnecting");
          publishPhase("connected");
        }
        await waitForFast(() => expect(requestCount(request, "wizard.cancel")).toBe(1));
        await waitForFast(() => expect(page.data?.config).toEqual(config));
        await chooseProviderSetup(page, authChoice);
        gate.resolve({ done: true, status: "done", preparedModelRef: "catalog-vendor/model" });
        await pendingSetup;
        await page.updateComplete;
        expect(
          page.querySelector<HTMLSelectElement>(".model-providers__add-form select")?.value,
        ).toBe(authChoice);
        expect(page.textContent).not.toContain("Provider Catalog vendor configured.");
      } finally {
        gate.resolve({ done: true, status: "cancelled" });
        page.remove();
        runtimeConfig.dispose();
      }
    },
  );

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
    page.keyEditorProvider = "openai";
    page.keyDraft = "synthetic-route-agent-key";
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
    expect(page.keyEditorProvider).toBeNull();
    expect(page.keyDraft).toBe("");
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
    page.keyEditorProvider = "openai";
    page.keyDraft = "synthetic-selected-agent-key";
    page.defaultsDraft = defaultsDraft;
    notifySelection();
    expect(page.keyEditorProvider).toBe("openai");
    expect(page.keyDraft).toBe("synthetic-selected-agent-key");
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
    expect(page.keyEditorProvider).toBeNull();
    expect(page.keyDraft).toBe("");
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
