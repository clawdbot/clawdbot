import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { NewSessionModelControl } from "./model-control.ts";

function contextWith(
  models: ModelCatalogEntry[],
  runtime = "openclaw",
  featureMethods: string[] = [],
  cloudPlacementSupported?: boolean,
) {
  const request = vi.fn().mockResolvedValue({ models });
  const navigate = vi.fn();
  const context = {
    navigate,
    gateway: {
      snapshot: {
        phase: "connected",
        client: { request },
        hello: { features: { methods: featureMethods } },
      },
    },
    sessions: {
      state: {
        result: {
          defaults: {
            model: "openai/gpt-5.6-luna",
            modelProvider: "openai",
            agentRuntime: {
              id: runtime,
              ...(cloudPlacementSupported === undefined ? {} : { cloudPlacementSupported }),
              source: "defaults",
            },
          },
          sessions: [],
        },
      },
    },
  } as unknown as ApplicationContext;
  return { context, navigate, request };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function renderControl(
  control: NewSessionModelControl,
  context: ApplicationContext,
  agentId = "main",
  agent: GatewayAgentRow | null = {
    id: "main",
    model: { primary: "openai/gpt-5.6-luna" },
    thinkingDefault: "medium",
  },
) {
  const container = document.createElement("div");
  render(
    control.render({
      ...(agent ? { agent } : {}),
      agentId,
      context,
      sending: false,
    }),
    container,
  );
  return container;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("new-session model runtime", () => {
  it("keeps CLI agents hidden and undiscovered while the Labs gate is off", async () => {
    const { context, request } = contextWith([
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
    ]);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);
    control.loadCatalogTargets(context, "main", false);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalledWith("sessions.catalog.list", expect.anything());
    expect(
      renderControl(control, context).querySelector("[data-chat-model-target-group]"),
    ).toBeNull();
  });

  it("lists create-capable CLI agents and selects the canonical catalog target", async () => {
    const { context, request } = contextWith(
      [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }],
      "openclaw",
      ["sessions.catalog.list"],
    );
    request.mockImplementation((method: string) =>
      method === "sessions.catalog.list"
        ? Promise.resolve({
            catalogs: [
              {
                id: "anthropic",
                label: "Claude Code",
                capabilities: { createSession: { model: "anthropic/claude-sonnet-4-6" } },
                hosts: [],
              },
              {
                id: "history-only",
                label: "History only",
                capabilities: {},
                hosts: [],
              },
            ],
          })
        : Promise.resolve({
            models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }],
          }),
    );
    const onCatalogTargetSelect = vi.fn();
    const control = new NewSessionModelControl(
      () => undefined,
      () => undefined,
      onCatalogTargetSelect,
    );

    control.load(context, "main", true);
    control.loadCatalogTargets(context, "main", true);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.catalog.list",
        { agentId: "main", limitPerHost: 1 },
        { signal: expect.any(AbortSignal) },
      ),
    );
    await vi.waitFor(() => {
      const container = renderControl(control, context);
      expect(container.querySelector('[data-chat-model-target-group="cliAgents"]')).not.toBeNull();
      expect(container.querySelector('[data-chat-model-target="anthropic"]')).not.toBeNull();
      expect(
        container.querySelector('[data-chat-model-select="true"]')?.getAttribute("aria-disabled"),
      ).toBe("false");
      expect(container.textContent).not.toContain("History only");
    });

    renderControl(control, context)
      .querySelector<HTMLButtonElement>('[data-chat-model-target="anthropic"]')
      ?.click();

    expect(onCatalogTargetSelect).toHaveBeenCalledExactlyOnceWith("anthropic");
  });

  it("does not discover CLI agents when the Gateway omits catalog support", async () => {
    const { context, request } = contextWith([
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
    ]);
    const control = new NewSessionModelControl(() => undefined);

    control.loadCatalogTargets(context, "main", true);
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
  });

  it("preserves a browser preference when an older server omits thinking profiles", async () => {
    const { context } = contextWith([
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
        reasoning: true,
      },
    ]);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });

    expect(control.isRestoringPreference()).toBe(true);
    await vi.waitFor(() => expect(control.selected).toBe("openai/gpt-5.6-sol"));
    expect(control.isRestoringPreference()).toBe(false);
    expect(control.thinkingLevel).toBe("high");
  });

  it("does not mark ordinary catalog loading as preference restoration", async () => {
    const { context, request } = contextWith([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ]);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);

    expect(control.isRestoringPreference()).toBe(false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  });

  it("renders initial metadata loading without synthesizing the configured default", async () => {
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    request.mockReturnValueOnce(pending.promise);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const container = renderControl(control, context);
    expect(container.querySelector('[data-chat-model-select="true"]')?.textContent).toContain(
      "Loading models",
    );
    expect(
      container.querySelector('[data-chat-model-select="true"]')?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(0);
    pending.resolve({ models: [] });
  });

  it("does not auth-block a cached all-cold catalog until revalidation completes", async () => {
    const models: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
      },
    ];
    const agent = { id: "main", model: { primary: "openai/gpt-5.6-luna" } };
    const refresh = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith(models);
    const firstControl = new NewSessionModelControl(() => undefined);
    firstControl.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(firstControl.isModelUnavailable(agent)).toBe(true));
    request.mockReturnValueOnce(refresh.promise);

    const remountedControl = new NewSessionModelControl(() => undefined);
    remountedControl.load(context, "main", true, { agent });

    let container = renderControl(remountedControl, context, "main", agent);
    expect(container.querySelector('[data-chat-model-catalog-state="refreshing"]')).not.toBeNull();
    expect(remountedControl.isModelUnavailable(agent)).toBe(false);
    expect(container.textContent).not.toContain(
      "Authentication failed. Review the provider credential or sign-in, then retry.",
    );
    expect(
      container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]'),
    ).not.toBeNull();
    refresh.resolve({ models });
    await vi.waitFor(() => expect(remountedControl.isModelUnavailable(agent)).toBe(true));
    container = renderControl(remountedControl, context, "main", agent);
    expect(container.querySelector('[data-chat-model-catalog-state="ready"]')).not.toBeNull();
    expect(container.textContent).toContain(
      "Authentication failed. Review the provider credential or sign-in, then retry.",
    );
  });

  it("keeps a shared metadata request alive when its first control is torn down", async () => {
    const models: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
    ];
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    request.mockImplementationOnce((_method, _params, options?: { signal?: AbortSignal }) => {
      options?.signal?.addEventListener(
        "abort",
        () => pending.reject(new DOMException("metadata request aborted", "AbortError")),
        { once: true },
      );
      return pending.promise;
    });
    const firstControl = new NewSessionModelControl(() => undefined);
    firstControl.load(context, "main", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    firstControl.reset();
    const remountedControl = new NewSessionModelControl(() => undefined);
    remountedControl.load(context, "main", true);
    pending.resolve({ models });

    await vi.waitFor(() => {
      const container = renderControl(remountedControl, context);
      expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
      expect(
        container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]'),
      ).not.toBeNull();
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("waits for selected-agent defaults after chat metadata resolves", async () => {
    const { context, request } = contextWith([
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", reasoning: true },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ]);
    const notify = vi.fn();
    const control = new NewSessionModelControl(notify);

    control.load(context, "main", true);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledTimes(2);
    });

    let container = renderControl(control, context, "main", null);
    const loadingModelTrigger = container.querySelector('[data-chat-model-select="true"]');
    expect(loadingModelTrigger?.textContent).toContain("Loading models");
    expect(loadingModelTrigger?.textContent).not.toContain("Default model");
    expect(container.querySelector('[data-chat-thinking-select="true"]')?.textContent).toContain(
      "Medium",
    );
    expect(control.selected).toBe("");
    expect(control.thinkingLevel).toBe("");

    container = renderControl(control, context, "main", {
      id: "main",
      model: { primary: "openai/gpt-5.6-sol" },
      thinkingDefault: "high",
    });
    expect(
      container.querySelector(
        '[data-chat-model-option="openai/gpt-5.6-sol"][data-chat-model-default="true"]',
      )?.textContent,
    ).toContain("GPT-5.6 Sol");
    expect(container.querySelector('[data-chat-model-select="true"]')?.textContent).toContain(
      "GPT-5.6 Sol",
    );
    const thinkingPicker = container.querySelector('[data-chat-thinking-select="true"]');
    expect(thinkingPicker).not.toBeNull();
    expect(thinkingPicker?.textContent).toContain("High");
    expect(
      container
        .querySelector('[data-chat-thinking-slider="true"]')
        ?.getAttribute("data-chat-thinking-values"),
    ).toContain("high");
    expect(control.selected).toBe("");
    expect(control.thinkingLevel).toBe("");
  });

  it("shows Medium for a hydrated agent without a projected thinking default", async () => {
    const { context, request } = contextWith([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ]);
    const notify = vi.fn();
    const control = new NewSessionModelControl(notify);

    control.load(context, "main", true);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledTimes(2);
    });

    const container = renderControl(control, context, "main", {
      id: "main",
      model: { primary: "openai/gpt-5.6-sol" },
    });
    expect(container.querySelector('[data-chat-model-select="true"]')?.textContent).toContain(
      "GPT-5.6 Sol",
    );
    expect(container.querySelector('[data-chat-thinking-select="true"]')?.textContent).toContain(
      "Medium",
    );
    expect(control.selected).toBe("");
    expect(control.thinkingLevel).toBe("");
  });

  it("preserves an explicitly remembered Off effort", async () => {
    const agent = {
      id: "main",
      model: { primary: "openai/gpt-5.6-sol" },
      thinkingDefault: "high",
    } satisfies GatewayAgentRow;
    const { context } = contextWith([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ]);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true, {
      agent,
      preference: { thinkingLevel: "off" },
    });

    await vi.waitFor(() => expect(control.thinkingLevel).toBe("off"));
    const container = renderControl(control, context, "main", agent);
    expect(container.querySelector('[data-chat-thinking-select="true"]')?.textContent).toContain(
      "Off",
    );
    expect(control.selected).toBe("");
  });

  it.each([
    ["generic transport error", new Error("metadata unavailable")],
    ["request timeout", new Error("gateway request timeout for chat.metadata")],
  ])("renders %s as unavailable instead of a default-only catalog", async (_label, error) => {
    const { context, request } = contextWith([]);
    request.mockRejectedValueOnce(error);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);

    await vi.waitFor(() => {
      const container = renderControl(control, context);
      expect(
        container
          .querySelector("[data-chat-model-catalog-state]")
          ?.getAttribute("data-chat-model-catalog-state"),
      ).toBe("error");
    });
    const container = renderControl(control, context);
    expect(container.querySelector('[data-chat-model-select="true"]')?.textContent).toContain(
      "Models unavailable",
    );
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(0);
    expect(container.querySelector('[data-chat-model-catalog-retry="true"]')).not.toBeNull();
  });

  it("recovers the complete catalog after retrying an initial failure", async () => {
    const models: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
    ];
    const { context, request } = contextWith(models);
    request.mockRejectedValueOnce(new Error("metadata unavailable"));
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector('[data-chat-model-catalog-state="error"]'),
      ).not.toBeNull(),
    );

    renderControl(control, context)
      .querySelector<HTMLButtonElement>('[data-chat-model-catalog-retry="true"]')
      ?.click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelectorAll("[data-chat-model-option]"),
      ).toHaveLength(3),
    );
  });

  it("renders an all-cold catalog as disabled intent with a setup action", async () => {
    const { context, navigate, request } = contextWith([
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
        available: false,
      },
    ]);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      const container = renderControl(control, context);
      expect(
        container
          .querySelector("[data-chat-model-catalog-state]")
          ?.getAttribute("data-chat-model-catalog-state"),
      ).toBe("ready");
      expect(container.querySelector('[data-chat-model-select="true"]')?.textContent).toContain(
        "GPT-5.6 Luna",
      );
    });
    const container = renderControl(control, context);
    const options = container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]");
    expect(
      control.isModelUnavailable({
        id: "main",
        model: { primary: "openai/gpt-5.6-luna" },
      }),
    ).toBe(true);
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain("Sign-in needed");
    expect([...options].every((option) => option.disabled)).toBe(true);
    expect(container.textContent).toContain(
      "Authentication failed. Review the provider credential or sign-in, then retry.",
    );
    expect(container.querySelector('[data-chat-model-catalog-retry="true"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')?.click();
    expect(navigate).toHaveBeenCalledWith("model-setup");
  });

  it("keeps a successful empty catalog explicit when its refresh fails", async () => {
    const refresh = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector('[data-chat-model-catalog-state="ready"]'),
      ).not.toBeNull(),
    );
    request.mockReturnValueOnce(refresh.promise);

    control.load(context, "main", true);
    expect(renderControl(control, context).textContent).toContain("No models available");
    expect(renderControl(control, context).textContent).not.toContain("Authentication failed");

    refresh.reject(new Error("refresh failed"));
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector('[data-chat-model-catalog-state="error"]'),
      ).not.toBeNull(),
    );
    const container = renderControl(control, context);
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(0);
    expect(container.querySelector('[data-chat-model-select="true"]')?.textContent).toContain(
      "Couldn’t refresh models",
    );
    expect(container.textContent).not.toContain("Authentication failed");
    expect(container.textContent).not.toContain("GPT-5.6 Luna");
  });

  it("treats a disconnected stale all-cold catalog as offline and non-authoritative", async () => {
    const coldModels: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
      },
    ];
    const { context } = contextWith(coldModels);
    const control = new NewSessionModelControl(() => undefined);
    const agent = { id: "main", model: { primary: "openai/gpt-5.6-luna" } };
    control.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(control.isModelUnavailable(agent)).toBe(true));

    const offlineContext = {
      ...context,
      gateway: {
        ...context.gateway,
        snapshot: { ...context.gateway.snapshot, client: null, phase: "reconnecting" },
      },
    } as unknown as ApplicationContext;
    control.load(offlineContext, "main", true, { agent });

    const container = renderControl(control, offlineContext, "main", agent);
    expect(container.querySelector('[data-chat-model-catalog-state="offline"]')).not.toBeNull();
    expect(container.textContent).toContain("Offline");
    expect(container.textContent).not.toContain("Authentication failed");
    expect(control.isModelUnavailable(agent)).toBe(false);
  });

  it("drops the stale auth gate on refresh error and restores selection after recovery", async () => {
    const coldModels: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
      },
    ];
    const availableModels: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", available: true },
    ];
    const { context, request } = contextWith(coldModels);
    const control = new NewSessionModelControl(() => undefined);
    const agent = { id: "main", model: { primary: "openai/gpt-5.6-luna" } };
    control.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(control.isModelUnavailable(agent)).toBe(true));

    request.mockRejectedValueOnce(new Error("refresh failed"));
    control.load(context, "main", true, { agent });
    await vi.waitFor(() =>
      expect(
        renderControl(control, context, "main", agent).querySelector(
          '[data-chat-model-catalog-state="error"]',
        ),
      ).not.toBeNull(),
    );
    let container = renderControl(control, context, "main", agent);
    expect(container.textContent).toContain("Couldn’t refresh models");
    expect(container.textContent).not.toContain("Authentication failed");
    expect(control.isModelUnavailable(agent)).toBe(false);

    request.mockResolvedValueOnce({ models: availableModels });
    container.querySelector<HTMLButtonElement>('[data-chat-model-catalog-retry="true"]')?.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(
        renderControl(control, context, "main", agent).querySelector(
          "[data-chat-model-catalog-state]",
        ),
      ).toBeNull(),
    );
    expect(control.isModelUnavailable(agent)).toBe(false);
    container = renderControl(control, context, "main", agent);
    expect(
      container.querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-5.6-luna"]')
        ?.disabled,
    ).toBe(false);
  });

  it("preserves the remembered pair when metadata validation fails", async () => {
    const { context, request } = contextWith([]);
    request.mockRejectedValueOnce(new Error("metadata unavailable"));
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true, {
      preference: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" },
    });

    expect(control.isRestoringPreference()).toBe(true);
    await vi.waitFor(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe("anthropic/claude-sonnet-4-6");
    expect(control.thinkingLevel).toBe("high");
  });

  it("preserves a live selection when an ordinary metadata refresh fails", async () => {
    const { context, request } = contextWith([]);
    const notify = vi.fn();
    const control = new NewSessionModelControl(notify);
    control.load(context, "main", true);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledTimes(2);
    });
    control.selected = "anthropic/claude-sonnet-4-6";
    control.thinkingLevel = "high";
    request.mockRejectedValueOnce(new Error("metadata unavailable"));

    control.load(context, "main", true);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledTimes(4);
    });
    expect(control.selected).toBe("anthropic/claude-sonnet-4-6");
    expect(control.thinkingLevel).toBe("high");
  });

  it("retains a successful same-agent catalog through refresh failure and recovery", async () => {
    const models: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
    ];
    const refresh = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith(models);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelectorAll("[data-chat-model-option]"),
      ).toHaveLength(2),
    );
    request.mockReturnValueOnce(refresh.promise);

    control.load(context, "main", true);

    let container = renderControl(control, context);
    expect(container.querySelector('[data-chat-model-catalog-state="refreshing"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(2);

    refresh.reject(new Error("refresh failed"));
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector('[data-chat-model-catalog-state="error"]'),
      ).not.toBeNull(),
    );
    container = renderControl(control, context);
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(2);
    expect(container.textContent).toContain("Couldn’t refresh models");

    container.querySelector<HTMLButtonElement>('[data-chat-model-catalog-retry="true"]')?.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector("[data-chat-model-catalog-state]"),
      ).toBeNull(),
    );
    expect(
      renderControl(control, context).querySelectorAll("[data-chat-model-option]"),
    ).toHaveLength(2);
  });

  it("keeps stale same-agent data across reconnect invalidation until replacement arrives", async () => {
    const oldModels: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
    ];
    const newModels: ModelCatalogEntry[] = [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
    ];
    const reconnect = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith(oldModels);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector(
          '[data-chat-model-option="openai/gpt-5.6-luna"]',
        ),
      ).not.toBeNull(),
    );

    control.invalidate(false);
    request.mockReturnValueOnce(reconnect.promise);
    control.load(context, "main", true);

    expect(
      renderControl(control, context).querySelector(
        '[data-chat-model-option="openai/gpt-5.6-luna"]',
      ),
    ).not.toBeNull();
    reconnect.resolve({ models: newModels });
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelectorAll("[data-chat-model-option]"),
      ).toHaveLength(2),
    );
    const container = renderControl(control, context);
    expect(container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]')).toBeNull();
    expect(container.querySelector('[data-chat-model-option="openai/gpt-5.6-sol"]')).not.toBeNull();
  });

  it("clears the old catalog on agent switch and ignores the late old-agent result", async () => {
    const main = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    request.mockImplementation((_method, params: { agentId?: string }) =>
      params.agentId === "main"
        ? main.promise
        : Promise.resolve({
            models: [
              {
                id: "claude-sonnet-5",
                name: "Claude Sonnet 5",
                provider: "anthropic",
              },
            ],
          }),
    );
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);
    control.load(context, "research", true);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        renderControl(control, context, "research").querySelector(
          '[data-chat-model-option="anthropic/claude-sonnet-5"]',
        ),
      ).not.toBeNull(),
    );

    main.resolve({
      models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }],
    });
    await Promise.resolve();
    await Promise.resolve();

    const container = renderControl(control, context, "research");
    expect(
      container.querySelector('[data-chat-model-option="anthropic/claude-sonnet-5"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]')).toBeNull();
  });

  it("coalesces equivalent concurrent metadata loads", async () => {
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    request.mockReturnValueOnce(pending.promise);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);
    control.load(context, "main", true);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    pending.resolve({ models: [] });
  });

  it("drops a stored model and its reasoning override when the model is unavailable", async () => {
    const { context, request } = contextWith([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ]);
    const notify = vi.fn();
    const onSelectionChange = vi.fn();
    const control = new NewSessionModelControl(notify, onSelectionChange);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });
    await vi.waitFor(() => expect(control.selected).toBe("openai/gpt-5.6-sol"));
    expect(control.thinkingLevel).toBe("high");

    control.load(context, "main", true, {
      preference: { model: "anthropic/retired-model", thinkingLevel: "high" },
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(control.selected).toBe(""));
    expect(control.thinkingLevel).toBe("");
    expect(onSelectionChange).toHaveBeenLastCalledWith({ model: "", thinkingLevel: "" });
  });

  it("drops a stored reasoning override when its option is no longer available", async () => {
    const { context, request } = contextWith([
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
        reasoning: true,
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "high", label: "high" },
        ],
        thinkingDefault: "high",
      },
    ]);
    const onSelectionChange = vi.fn();
    const control = new NewSessionModelControl(() => undefined, onSelectionChange);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });
    await vi.waitFor(() => expect(control.thinkingLevel).toBe("high"));

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "retired" },
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(control.thinkingLevel).toBe(""));
    expect(control.selected).toBe("openai/gpt-5.6-sol");
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      model: "openai/gpt-5.6-sol",
      thinkingLevel: "",
    });
  });

  it("clears xhigh when an interactive model switch targets a profile ending at high", async () => {
    const levels = (ids: string[]) => ids.map((id) => ({ id, label: id }));
    const { context, request } = contextWith([
      {
        id: "k3",
        name: "Kimi K3",
        provider: "kimi",
        reasoning: true,
        thinkingLevels: levels(["off", "low", "medium", "high", "xhigh"]),
        thinkingDefault: "high",
      },
      {
        id: "limited",
        name: "Limited",
        provider: "demo",
        reasoning: true,
        thinkingLevels: levels(["off", "low", "medium", "high"]),
        thinkingDefault: "medium",
      },
    ]);
    const onSelectionChange = vi.fn();
    const control = new NewSessionModelControl(() => undefined, onSelectionChange);
    control.load(context, "main", true);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(
        renderControl(control, context).querySelector('[data-chat-model-option="demo/limited"]'),
      ).not.toBeNull();
    });
    control.selected = "kimi/k3";
    control.thinkingLevel = "xhigh";

    renderControl(control, context)
      .querySelector<HTMLButtonElement>('[data-chat-model-option="demo/limited"]')
      ?.click();

    expect(control.selected).toBe("demo/limited");
    expect(control.thinkingLevel).toBe("");
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      model: "demo/limited",
      thinkingLevel: "",
    });
  });

  it("uses model catalog runtime metadata for an explicit cloud target", async () => {
    const { context, request } = contextWith([
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        agentRuntime: { id: "codex", cloudPlacementSupported: true, source: "model" },
      },
    ]);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      control.selected = "openai/gpt-5.6-luna";
      expect(control.resolveAgentRuntime({ context })).toEqual({
        id: "codex",
        cloudPlacementSupported: true,
        source: "model",
      });
    });
  });

  it("falls back to the selected agent runtime for its default model", () => {
    const { context } = contextWith([]);
    const agent = {
      id: "main",
      agentRuntime: { id: "claude-cli", cloudPlacementSupported: false, source: "agent" },
    } satisfies GatewayAgentRow & {
      agentRuntime: { id: string; cloudPlacementSupported: boolean; source: "agent" };
    };
    const control = new NewSessionModelControl(() => undefined);

    expect(control.resolveAgentRuntime({ agent, context })).toEqual({
      id: "claude-cli",
      cloudPlacementSupported: false,
      source: "agent",
    });
  });

  it("falls back to the session defaults runtime capability", () => {
    const { context } = contextWith([], "codex", [], true);
    const control = new NewSessionModelControl(() => undefined);

    expect(control.resolveAgentRuntime({ context })).toEqual({
      id: "codex",
      cloudPlacementSupported: true,
      source: "defaults",
    });
  });

  it.each(["auto", "default"])(
    "leaves the %s runtime selector unresolved for server-side policy",
    (runtime) => {
      const { context } = contextWith([], runtime);
      const control = new NewSessionModelControl(() => undefined);

      expect(control.resolveAgentRuntime({ context })).toBeUndefined();
    },
  );

  it("does not apply default runtime metadata to an explicit model", async () => {
    const { context } = contextWith(
      [{ id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" }],
      "codex",
    );
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    control.selected = "anthropic/sonnet-4.6";

    await vi.waitFor(() => expect(control.resolveAgentRuntime({ context })).toBeUndefined());
  });
});
