/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelsProbeResult } from "../../api/types.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { updatePickers, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DefaultModelSelection } from "./data.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import {
  appendPage,
  createAuthStatus,
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

  it.each([
    {
      access: "read-only",
      hello: { auth: { role: "operator", scopes: ["operator.read"] } },
    },
    { access: "missing-auth", hello: null },
    { access: "missing-scopes", hello: { auth: { role: "operator" } } },
  ])("keeps saved account identities out of the $access page", async ({ hello }) => {
    const { context, request, snapshot } = createHarness("main");
    snapshot.hello = hello as typeof snapshot.hello;
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "models.authStatus") {
        return {
          ...createAuthStatus([
            {
              profiles: [{ profileId: "openai:owner@example.com", type: "oauth", status: "ok" }],
            },
          ]),
          providerCapabilities: [],
        };
      }
      return originalRequest(method);
    });

    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.authStatus?.providers).toHaveLength(1));
    await page.updateComplete;

    expect(page.querySelector(".model-providers__profiles")).toBeNull();
    expect(page.textContent).not.toContain("owner@example.com");
    expect(page.querySelector(".model-providers__credentials")?.textContent).toContain(
      "OAuth profiles: 1",
    );
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
            utilityModel: null,
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

    await updatePickers(page);
    const fallback = [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find(
      (select) =>
        select.querySelector('[role="listbox"]')?.getAttribute("aria-label") === "Fallback Model",
    );
    expect(fallback).toBeDefined();
    await choosePickerValue(fallback!, "xai/grok");

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
            utilityModel: null,
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
    await updatePickers(page);
    const defaults = page.querySelector(".model-providers__defaults");

    expect(
      [
        ...(defaults?.querySelectorAll("openclaw-select-picker button, wa-radio-group") ?? []),
      ].every((control) => control.hasAttribute("disabled")),
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

  it("keeps committed provider-add feedback visible when its refresh fails", async () => {
    const { context, runtimeConfig } = createHarness("main");
    runtimeConfig.refresh.mockImplementationOnce(async () => {
      runtimeConfig.state.lastError = "config.get failed after provider add";
    });
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
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

  it("keeps a replacement agent's matching add-provider draft after a global write", async () => {
    const { agentSelection, context, notifySelection, runtimeConfig } = createHarness("main");
    const gate = deferred<void>();
    runtimeConfig.ensureLoaded.mockImplementationOnce(async () => gate.promise);
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "shared-provider-key";

    const adding = page.addProvider();
    await vi.waitFor(() => expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce());
    agentSelection.state.selectedId = "writer";
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

  it("ignores logout completion after switching away from and back to the selected agent", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    request.mockClear();
    const firstLogout = deferred<unknown>();
    request.mockImplementationOnce(async () => firstLogout.promise);

    const loggingOut = page.profileActions.logout("openai", {
      provider: "openai",
      profileIds: ["openai:first"],
    });
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
    await toast.updateComplete;
    expect(toast.querySelector('[role="status"]')).toBeNull();
  });

  it.each([{ order: undefined }, { order: ["openai:two", "openai:one"] }])(
    "re-resolves priority after Reset ($order)",
    async ({ order }) => {
      const { context, request, snapshot } = createHarness("main");
      snapshot.hello = {
        type: "hello-ok",
        protocol: 3,
        auth: { role: "operator", scopes: ["operator.admin"] },
      };
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual({}));
      const originalRequest = request.getMockImplementation()!;
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === "models.authStatus") {
          return createAuthStatus([{ profileOrder: order }], 2);
        }
        void params;
        return originalRequest(method);
      });
      page.data = {
        ...EMPTY_MODEL_PROVIDERS_DATA,
        config: {},
        authStatus: await request("models.authStatus"),
        updatedAt: 1,
      } as ModelProvidersData;

      const initialProvider = page.data.authStatus!.providers[0]!;
      initialProvider.profileOrder = ["openai:one", "openai:two"];
      initialProvider.profileOrderStored = true;

      page.profileActions.setOrder("openai", "openai", null);

      await vi.waitFor(() =>
        expect(page.data?.authStatus?.providers[0]?.profileOrder).toEqual(order),
      );
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "openai",
        agentId: "main",
      });
      expect(page.data?.authStatus?.providers[0]?.profileOrderStored).not.toBe(true);
      await vi.waitFor(() => expect(page.profileOrders.openai).toBeUndefined());
      await page.updateComplete;
      expect(page.querySelectorAll(".model-providers__profile-position")).toHaveLength(
        order ? 2 : 0,
      );
    },
  );

  it("drains a queued profile order after switching agents during an active save", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const originalRequest = request.getMockImplementation()!;
    const firstSave = deferred<unknown>();
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authOrderSet" && requestCount(request, method) === 1) {
        return firstSave.promise;
      }
      void params;
      return originalRequest(method);
    });

    page.profileActions.setOrder("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    page.profileActions.setOrder("openai", "openai", ["openai:one", "openai:two"]);

    firstSave.resolve({});
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(2));
    const orderCalls = request.mock.calls.filter(([method]) => method === "models.authOrderSet");
    expect(orderCalls.at(-1)).toEqual([
      "models.authOrderSet",
      {
        provider: "openai",
        profileIds: ["openai:one", "openai:two"],
        agentId: "writer",
      },
    ]);
  });

  it("restores committed priority and keeps controls available after a rejected save", async () => {
    const { context, request, snapshot } = createHarness("main");
    snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as typeof snapshot.hello;
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      authStatus: createAuthStatus(),
      updatedAt: 1,
    };
    page.requestUpdate();
    await page.updateComplete;
    request.mockRejectedValueOnce(new Error("Priority could not be saved"));
    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:two"] .model-providers__profile-grip',
      )!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await vi.waitFor(() =>
      expect(toast.querySelector('[role="status"]')?.textContent).toContain(
        "Priority could not be saved",
      ),
    );
    await page.updateComplete;

    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.messages.openai).toBeUndefined();
    expect(toast.querySelector(".app-toast--bottom .app-toast__icon")).not.toBeNull();
    expect(
      [...page.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
        (row) => row.dataset.profileId,
      ),
    ).toEqual(["openai:one", "openai:two"]);
    expect(
      page.querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:two"] .model-providers__profile-grip',
      )?.disabled,
    ).toBe(false);
  });

  it("ignores logout completion when route data changes the selected agent", async () => {
    const { agentSelection, context, request, snapshot } = createHarness("main");
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    request.mockClear();
    const firstLogout = deferred<unknown>();
    request.mockImplementationOnce(async () => firstLogout.promise);

    const loggingOut = page.profileActions.logout("openai", {
      provider: "openai",
      profileIds: ["openai:first"],
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const defaultsDraft: DefaultModelSelection = {
      primary: "openai/gpt-5",
      fallbacks: [],
      utilityModel: null,
    };
    page.keyEditorProvider = "openai";
    page.keyDraft = "synthetic-route-agent-key";
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "synthetic-route-provider-key";
    page.defaultsDraft = defaultsDraft;
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
    expect(page.messages).toEqual({});
    expect(page.probeResults).toEqual({});
    expect(page.keyEditorProvider).toBeNull();
    expect(page.keyDraft).toBe("");
    expect(page.addProviderOpen).toBe(false);
    expect(page.addProviderId).toBe("");
    expect(page.addProviderKey).toBe("");
    expect(page.defaultsDraft).toBe(defaultsDraft);
    firstLogout.resolve({});
    await loggingOut;

    expect(request.mock.calls.filter(([method]) => method === "models.authLogout")).toHaveLength(1);
    await toast.updateComplete;
    expect(toast.querySelector('[role="status"]')).toBeNull();
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
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "synthetic-selected-provider-key";
    page.defaultsDraft = defaultsDraft;
    notifySelection();
    expect(page.keyEditorProvider).toBe("openai");
    expect(page.keyDraft).toBe("synthetic-selected-agent-key");
    expect(page.addProviderOpen).toBe(true);
    expect(page.addProviderId).toBe("anthropic");
    expect(page.addProviderKey).toBe("synthetic-selected-provider-key");
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
    expect(page.addProviderOpen).toBe(false);
    expect(page.addProviderId).toBe("");
    expect(page.addProviderKey).toBe("");
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
