/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";
import { renderModelProviders } from "./view.ts";

type ModelProvidersViewProps = Parameters<typeof renderModelProviders>[0];
type SegmentedGroup = HTMLElement & { disabled: boolean; value: string };

function card(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  return {
    id: "openai",
    displayName: "OpenAI",
    profiles: [],
    credentialProviderIds: ["openai"],
    logoutTargets: [],
    hasConfigApiKey: false,
    modelCount: 1,
    availableModelCount: 1,
    apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
    ...overrides,
  };
}

function props(overrides: Partial<ModelProvidersViewProps> = {}): ModelProvidersViewProps {
  return {
    connected: true,
    loading: false,
    refreshing: false,
    error: null,
    providerUsageFailed: false,
    supplementalLoading: false,
    updatedAt: 1,
    costDays: 30,
    credentialAgentLabel: "Writer",
    cards: [card()],
    configuredModels: [{ id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true }],
    defaultModels: { primary: "openai/gpt-5", fallbacks: [], utilityModel: null },
    defaultModelsDirty: false,
    thinkingLevel: "off",
    thinkingOverridden: true,
    fastMode: false,
    fastModeOverridden: true,
    configBusy: false,
    quickAddSupported: true,
    unconfiguredProviders: [{ id: "anthropic", displayName: "Anthropic" }],
    canMutate: true,
    mutationBlockedReason: null,
    providerUsageStalled: false,
    probeAvailable: true,
    busy: {},
    messages: {},
    probeResults: {},
    keyEditorProvider: null,
    keyDraft: "",
    pendingLogoutProvider: null,
    addProviderOpen: false,
    addProviderId: "",
    addProviderKey: "",
    onRefresh: () => undefined,
    onOpenKeyEditor: () => undefined,
    onCloseKeyEditor: () => undefined,
    onKeyDraftChange: () => undefined,
    onSaveKey: () => undefined,
    onRemoveKey: () => undefined,
    onProbe: () => undefined,
    onRequestLogout: () => undefined,
    onCancelLogout: () => undefined,
    onLogout: () => undefined,
    onAddProviderToggle: () => undefined,
    onAddProviderIdChange: () => undefined,
    onAddProviderKeyChange: () => undefined,
    onAddProvider: () => undefined,
    onPrimaryChange: () => undefined,
    onFallbackAdd: () => undefined,
    onFallbackRemove: () => undefined,
    onUtilityChange: () => undefined,
    onDefaultModelsSave: () => undefined,
    onDefaultModelsReset: () => undefined,
    onThinkingChange: () => undefined,
    onThinkingReset: () => undefined,
    onFastModeChange: () => undefined,
    onFastModeReset: () => undefined,
    onOpenModelSetup: () => undefined,
    ...overrides,
  };
}

function mount(viewProps: ModelProvidersViewProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderModelProviders(viewProps), container);
  return container;
}

function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function button(container: Element, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    text(entry).includes(label),
  );
}

function settingsRow(container: Element, label: string): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => text(candidate.querySelector(".settings-row__title")) === label,
  );
  if (!match) {
    throw new Error(`Missing settings row: ${label}`);
  }
  return match;
}

function selectSegment(group: SegmentedGroup, value: string) {
  group.value = value;
  group.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("renderModelProviders", () => {
  it("surfaces a provider-usage failure on the provider list", () => {
    const container = document.createElement("div");
    render(renderModelProviders(props({ providerUsageFailed: true })), container);

    expect(container.textContent).toContain(
      "Provider usage is unavailable; the last request failed. Refresh to retry.",
    );
  });

  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("hides quick API-key setup when provider capabilities are unavailable", () => {
    const container = mount(
      props({
        configuredModels: [],
        quickAddSupported: false,
        unconfiguredProviders: [],
      }),
    );

    expect(text(container)).not.toContain("Add provider");
    expect(container.querySelector('[data-model-readiness="model-required"]')).not.toBeNull();
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });

  it("renders model behavior next to default models and emits canonical values", () => {
    const onThinkingChange = vi.fn();
    const onFastModeChange = vi.fn();
    const container = mount(
      props({
        thinkingLevel: "low",
        fastMode: "auto",
        onThinkingChange,
        onFastModeChange,
      }),
    );

    const behavior = container.querySelector("#settings-model-behavior");
    expect(behavior).not.toBeNull();
    const thinking = settingsRow(behavior!, "Thinking").querySelector<SegmentedGroup>(
      "wa-radio-group",
    );
    const fastMode = settingsRow(behavior!, "Fast mode").querySelector<SegmentedGroup>(
      "wa-radio-group",
    );
    expect(thinking?.value).toBe("low");
    expect(fastMode?.value).toBe("auto");
    expect([...fastMode!.querySelectorAll("wa-radio")].map((entry) => text(entry))).toEqual([
      "Default",
      "Auto",
      "Fast",
      "Standard",
    ]);

    selectSegment(thinking!, "high");
    selectSegment(fastMode!, "off");
    expect(onThinkingChange).toHaveBeenCalledWith("high", expect.any(HTMLElement));
    expect(onFastModeChange).toHaveBeenCalledWith(false);
  });

  it("shows inherited model policy, restores overrides, and preserves advanced thinking", () => {
    const onThinkingReset = vi.fn();
    const onFastModeReset = vi.fn();
    const container = mount(
      props({
        thinkingLevel: "adaptive",
        fastMode: true,
        onThinkingReset,
        onFastModeReset,
      }),
    );
    const behavior = container.querySelector("#settings-model-behavior")!;
    const thinkingRow = settingsRow(behavior, "Thinking");
    const fastRow = settingsRow(behavior, "Fast mode");

    expect(thinkingRow.querySelector<SegmentedGroup>("wa-radio-group")?.value).toBe("adaptive");
    expect(text(thinkingRow)).toContain("Adaptive");
    expect(text(thinkingRow)).toContain("Default: Model policy");
    expect(text(fastRow)).toContain("Default: Model policy");

    selectSegment(thinkingRow.querySelector<SegmentedGroup>("wa-radio-group")!, "");
    selectSegment(fastRow.querySelector<SegmentedGroup>("wa-radio-group")!, "");
    expect(onThinkingReset).toHaveBeenCalledOnce();
    expect(onFastModeReset).toHaveBeenCalledOnce();

    render(
      renderModelProviders(
        props({
          thinkingLevel: undefined,
          thinkingOverridden: false,
          fastMode: undefined,
          fastModeOverridden: false,
        }),
      ),
      container,
    );
    const inheritedBehavior = container.querySelector("#settings-model-behavior")!;
    const inheritedThinking = settingsRow(inheritedBehavior, "Thinking");
    const inheritedFast = settingsRow(inheritedBehavior, "Fast mode");
    expect(inheritedThinking.querySelector<SegmentedGroup>("wa-radio-group")?.value).toBe("");
    expect(inheritedFast.querySelector<SegmentedGroup>("wa-radio-group")?.value).toBe("");
    expect(
      (
        inheritedThinking.querySelector('wa-radio[value=""]') as HTMLElement & {
          checked: boolean;
        }
      ).checked,
    ).toBe(true);
    expect(
      (inheritedFast.querySelector('wa-radio[value=""]') as HTMLElement & { checked: boolean })
        .checked,
    ).toBe(true);
    expect(text(inheritedThinking)).toContain("Using default: Model policy");
    expect(text(inheritedFast)).toContain("Using default: Model policy");
  });

  it("restores controlled model behavior when a reset is rejected", () => {
    const viewProps = props({
      thinkingLevel: "high",
      fastMode: true,
    });
    const container = mount(viewProps);
    const behavior = container.querySelector("#settings-model-behavior")!;
    const thinking = settingsRow(behavior, "Thinking").querySelector<SegmentedGroup>(
      "wa-radio-group",
    )!;
    const fastMode = settingsRow(behavior, "Fast mode").querySelector<SegmentedGroup>(
      "wa-radio-group",
    )!;

    selectSegment(thinking, "");
    selectSegment(fastMode, "");
    render(renderModelProviders(viewProps), container);

    expect(thinking.value).toBe("high");
    expect(fastMode.value).toBe("on");
    expect(
      (thinking.querySelector('wa-radio[value="high"]') as HTMLElement & { checked: boolean })
        .checked,
    ).toBe(true);
    expect(
      (fastMode.querySelector('wa-radio[value="on"]') as HTMLElement & { checked: boolean })
        .checked,
    ).toBe(true);
  });

  it("locks model behavior while shared config work is pending", () => {
    const container = mount(props({ configBusy: true }));
    const behavior = container.querySelector("#settings-model-behavior");
    const groups = behavior?.querySelectorAll<SegmentedGroup>("wa-radio-group") ?? [];

    expect(groups).toHaveLength(2);
    expect([...groups].every((group) => group.disabled)).toBe(true);
  });

  it("locks provider and default-model mutations while shared config work is pending", () => {
    const container = mount(
      props({
        configBusy: true,
        defaultModelsDirty: true,
        defaultModels: {
          primary: "openai/gpt-5",
          fallbacks: ["anthropic/claude"],
          utilityModel: null,
        },
        configuredModels: [
          { id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true },
          { id: "anthropic/claude", provider: "anthropic", name: "Claude", available: true },
        ],
        cards: [
          card({
            hasConfigApiKey: true,
            apiKey: { source: "config" },
            logoutTargets: [{ provider: "openai", profileIds: ["openai:oauth"] }],
          }),
        ],
        keyEditorProvider: "openai",
        keyDraft: "replacement",
        addProviderOpen: true,
        addProviderId: "anthropic",
        addProviderKey: "new-provider-key",
      }),
    );

    const defaults = container.querySelector(".model-providers__defaults");
    const defaultSelects = [...(defaults?.querySelectorAll("wa-select") ?? [])];
    expect(defaultSelects).toHaveLength(3);
    expect(defaultSelects.every((select) => select.hasAttribute("disabled"))).toBe(true);
    expect(
      [
        ...(defaults?.querySelectorAll<HTMLButtonElement>(
          ".model-providers__fallback-row button",
        ) ?? []),
      ].every((control) => control.disabled),
    ).toBe(true);
    expect(button(container, "Save")?.disabled).toBe(true);

    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(
      provider?.querySelector<HTMLInputElement>(".model-providers__inline-form input")?.disabled,
    ).toBe(true);
    expect(button(provider!, "Replace key")?.disabled).toBe(true);
    expect(button(provider!, "Remove key")?.disabled).toBe(true);
    expect(button(provider!, "Log out")?.disabled).toBe(true);

    const addForm = container.querySelector(".model-providers__add-form");
    expect(
      [
        ...(addForm?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
          "select, input, button",
        ) ?? []),
      ].map((control) => control.disabled),
    ).toEqual([true, true, true]);
  });

  it("locks an already-open provider form after mutation access is revoked", () => {
    const onAddProvider = vi.fn();
    const onAddProviderToggle = vi.fn();
    const container = mount(
      props({
        addProviderOpen: true,
        addProviderId: "anthropic",
        addProviderKey: "new-provider-key",
        canMutate: false,
        mutationBlockedReason: "Operator admin access required",
        onAddProvider,
        onAddProviderToggle,
      }),
    );
    const addForm = container.querySelector(".model-providers__add-form");
    const controls = [
      ...(addForm?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        "select, input, button",
      ) ?? []),
    ];

    expect(controls.map((control) => control.disabled)).toEqual([true, true, true]);
    addForm?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onAddProvider).not.toHaveBeenCalled();

    const cancel = button(addForm!.closest(".settings-section")!, "Cancel");
    expect(cancel?.disabled).toBe(false);
    cancel?.click();
    expect(onAddProviderToggle).toHaveBeenCalledOnce();
  });

  it("freezes provider and credential fields while adding a provider", () => {
    const container = mount(
      props({
        addProviderOpen: true,
        addProviderId: "anthropic",
        addProviderKey: "new-provider-key",
        busy: { add: true },
      }),
    );
    const addForm = container.querySelector(".model-providers__add-form");

    expect(
      [
        ...(addForm?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("select, input") ?? []),
      ].map((control) => control.disabled),
    ).toEqual([true, true]);
  });

  it("keeps committed credential success visible beside its refresh warning", () => {
    const container = mount(
      props({
        messages: {
          openai: {
            kind: "success",
            text: "Secret saved.",
            warning: "Config refresh failed after the secret was committed.",
          },
        },
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');
    const messages = [...(provider?.querySelectorAll('[role="status"]') ?? [])];

    expect(messages.map((message) => text(message))).toEqual([
      "Secret saved.",
      "Config refresh failed after the secret was committed.",
    ]);
    expect(messages[0]?.classList.contains("success")).toBe(true);
    expect(messages[1]?.classList.contains("warning")).toBe(true);
  });

  it("keeps committed default-model success visible beside its refresh warning", () => {
    const container = mount(
      props({
        messages: {
          defaults: {
            kind: "success",
            text: "Default models saved.",
            warning: "Config refresh failed after the model defaults were committed.",
          },
        },
      }),
    );
    const defaults = container.querySelector(".model-providers__defaults");
    const messages = [...(defaults?.querySelectorAll('[role="status"]') ?? [])];

    expect(messages.map((message) => text(message))).toEqual([
      "Default models saved.",
      "Config refresh failed after the model defaults were committed.",
    ]);
    expect(messages[0]?.classList.contains("success")).toBe(true);
    expect(messages[1]?.classList.contains("warning")).toBe(true);
  });

  it("announces provider and default-model mutation failures as accessible alerts", () => {
    const container = mount(
      props({
        messages: {
          openai: { kind: "error", text: "Provider credential could not be saved." },
          defaults: { kind: "error", text: "Default models could not be saved." },
        },
      }),
    );

    expect(text(container.querySelector('[data-provider-id="openai"] [role="alert"]'))).toBe(
      "Provider credential could not be saved.",
    );
    expect(text(container.querySelector('.model-providers__defaults [role="alert"]'))).toBe(
      "Default models could not be saved.",
    );
  });

  it("keeps model behavior available while provider data loads", () => {
    const container = mount(props({ loading: true, thinkingLevel: "high", fastMode: true }));
    const behavior = container.querySelector("#settings-model-behavior");

    expect(behavior).not.toBeNull();
    expect(
      settingsRow(behavior!, "Thinking").querySelector<SegmentedGroup>("wa-radio-group")?.value,
    ).toBe("high");
    expect(
      settingsRow(behavior!, "Fast mode").querySelector<SegmentedGroup>("wa-radio-group")?.value,
    ).toBe("on");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[data-provider-id="openai"]')).toBeNull();
  });

  it("renders credential provenance and probe results", () => {
    const container = mount(
      props({
        probeResults: {
          openai: {
            provider: "openai",
            status: "ok",
            latencyMs: 145,
            results: [
              {
                profileId: "openai:default",
                label: "Default profile",
                status: "ok",
                latencyMs: 145,
              },
            ],
          },
        },
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(text(provider)).toContain("Credentials for Writer");
    expect(text(provider)).toContain("Global usage and cost");
    expect(text(provider)).toContain("API key from environment (OPENAI_API_KEY)");
    expect(text(provider)).toContain("Connected");
    expect(text(provider)).toContain("145 ms");
    expect(text(provider)).toContain("Default profile");
  });

  it("puts model recovery first when credentials expose no selectable models", () => {
    const onOpenModelSetup = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            auth: { kind: "ok", profileCount: 1 },
            profiles: [{ profileId: "openai:chatgpt", type: "oauth", status: "ok" }],
            modelCount: 0,
            availableModelCount: 0,
          }),
        ],
        configuredModels: [],
        defaultModels: { primary: "", fallbacks: [], utilityModel: null },
        onOpenModelSetup,
      }),
    );

    const readiness = container.querySelector('[data-model-readiness="model-required"]');
    expect(text(readiness)).toContain("Connect a verified AI model");
    expect(text(readiness)).toContain("Model required");
    expect(container.querySelector(".model-providers__defaults")).toBeNull();
    expect(text(container.querySelector('[data-provider-id="openai"]'))).toContain(
      "Credentials configured",
    );

    button(readiness!, "Connect a verified AI model")?.click();
    expect(onOpenModelSetup).toHaveBeenCalledOnce();
  });

  it("does not present catalog-rejected credentials as signed in", () => {
    const container = mount(
      props({
        cards: [
          card({
            auth: { kind: "ok", profileCount: 1 },
            profiles: [{ profileId: "openai:chatgpt", type: "oauth", status: "ok" }],
            catalogStatus: "auth-rejected",
            modelCount: 0,
            availableModelCount: 0,
          }),
        ],
        configuredModels: [],
        defaultModels: { primary: "", fallbacks: [], utilityModel: null },
      }),
    );

    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(text(provider)).toContain("Credentials rejected");
    expect(text(provider)).not.toContain("Signed in");
  });

  it("does not report an unverified API key as ready", () => {
    const container = mount(
      props({
        cards: [
          card({
            auth: { kind: "api-key", profileCount: 0 },
          }),
        ],
      }),
    );

    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(text(provider)).toContain("Credentials configured");
    expect(text(provider)).not.toContain("Ready");
  });

  it("starts provider setup before showing disabled model controls", () => {
    const onOpenModelSetup = vi.fn();
    const container = mount(
      props({
        cards: [],
        configuredModels: [],
        defaultModels: { primary: "", fallbacks: [], utilityModel: null },
        onOpenModelSetup,
      }),
    );

    const readiness = container.querySelector('[data-model-readiness="model-required"]');
    expect(text(readiness)).toContain("Model required");
    expect(button(readiness!, "Connect a verified AI model")).toBeDefined();
    expect(container.querySelector(".model-providers__defaults")).toBeNull();
  });

  it("recovers from a saved default that is no longer selectable", () => {
    const container = mount(
      props({
        configuredModels: [
          {
            id: "retired-model",
            provider: "openai",
            name: "Retired model",
            available: false,
          },
        ],
        defaultModels: {
          primary: "openai/retired-model",
          fallbacks: [],
          utilityModel: null,
        },
      }),
    );

    expect(container.querySelector('[data-model-readiness="model-required"]')).not.toBeNull();
    expect(container.querySelector(".model-providers__defaults")).toBeNull();
  });

  it("shows defaults normally when a selectable model exists", () => {
    const container = mount(props());
    expect(container.querySelector('[data-model-readiness="model-required"]')).toBeNull();
    expect(container.querySelector(".model-providers__defaults")).not.toBeNull();
  });

  it("labels provider usage and session cost as global", () => {
    const container = mount(
      props({
        cards: [
          card({
            localCost: { totalCost: 12, totalTokens: 1_000, sessionCount: 2 },
          }),
        ],
      }),
    );

    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(text(provider)).toContain("Credentials for Writer");
    expect(text(provider)).toContain("Global usage and cost");
    expect(text(provider)).toContain("Global session spend · 30d");
  });

  it("preserves complete graphemes in custom provider fallback icons", () => {
    const cases = [
      { id: "🧭-proxy", expected: "🧭" },
      { id: "🇺🇸-proxy", expected: "🇺🇸" },
      { id: "👩‍💻-proxy", expected: "👩‍💻" },
      { id: "e\u0301-proxy", expected: "E\u0301" },
      { id: "ß-provider", expected: "S" },
    ];
    const container = mount(
      props({
        cards: cases.map(({ id }) => card({ id, displayName: id, credentialProviderIds: [id] })),
      }),
    );

    for (const { id, expected } of cases) {
      const row = [...container.querySelectorAll<HTMLElement>("[data-provider-id]")].find(
        (candidate) => candidate.dataset.providerId === id,
      );
      expect(row?.querySelector(".provider-brand-icon--fallback")?.textContent?.trim()).toBe(
        expected,
      );
    }
  });

  it("does not invent config key provenance when auth status is unavailable", () => {
    const container = mount(
      props({
        cards: [card({ apiKey: undefined, hasConfigApiKey: true })],
      }),
    );

    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(text(provider)).not.toContain("API key set in config");
    expect(text(provider)).toContain("Not configured");
  });

  it("renders mixed credential probes as connected with warnings", () => {
    const container = mount(
      props({
        probeResults: {
          openai: {
            provider: "openai",
            status: "ok",
            latencyMs: 145,
            results: [
              {
                label: "Configured credential · openai/gpt-5.6-sol",
                status: "unknown",
                error:
                  "The configured credential could not be resolved. Update or remove it, then retry.",
              },
              {
                profileId: "openai:default",
                label: "Profile Default · openai/gpt-5.6-sol",
                status: "ok",
                latencyMs: 145,
              },
            ],
          },
        },
      }),
    );

    const probe = container.querySelector(".model-providers__probe--warning");
    expect(text(probe)).toContain("Connected with warnings");
    expect(text(probe)).toContain("Configured credential · openai/gpt-5.6-sol");
    expect(text(probe)).toContain("Profile Default · openai/gpt-5.6-sol");
    expect(text(probe)).toContain("Update or remove it, then retry");
  });

  it("renders categorized probe errors", () => {
    const container = mount(
      props({
        probeResults: {
          openai: {
            provider: "openai",
            status: "billing",
            error: "Account has no credits",
            results: [
              {
                label: "API key",
                status: "billing",
                error: "Account has no credits",
              },
            ],
          },
        },
      }),
    );
    const probe = container.querySelector(".model-providers__probe--error");
    expect(text(probe)).toContain("Billing problem");
    expect(text(probe)).toContain("Account has no credits");
  });

  it("presents no-model probe results as a setup state, not a connection failure", () => {
    const container = mount(
      props({
        cards: [
          card({
            auth: { kind: "ok", profileCount: 1 },
            profiles: [{ profileId: "openai:chatgpt", type: "oauth", status: "ok" }],
            modelCount: 0,
            availableModelCount: 0,
          }),
        ],
        configuredModels: [],
        probeResults: {
          openai: {
            provider: "openai",
            status: "no_model",
            error: "No model is available for this provider.",
            results: [
              {
                profileId: "openai:chatgpt",
                label: "ChatGPT",
                status: "no_model",
              },
            ],
          },
        },
      }),
    );

    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(text(provider)).toContain("Credentials configured");
    expect(text(provider)).toContain("No models available");
    expect(text(provider)).not.toContain("Connection failed");
  });

  it("qualifies slash-bearing model IDs with their catalog provider", () => {
    const container = mount(
      props({
        configuredModels: [
          {
            id: "anthropic/claude-sonnet-4",
            provider: "openrouter",
            name: "Claude Sonnet 4",
            available: true,
          },
        ],
        defaultModels: {
          primary: "openrouter/anthropic/claude-sonnet-4",
          fallbacks: [],
          utilityModel: null,
        },
      }),
    );
    const option = container.querySelector(
      'wa-option[value="openrouter/anthropic/claude-sonnet-4"]',
    );
    expect(option?.hasAttribute("selected")).toBe(true);
  });

  it("renders alias defaults and distinct automatic or disabled utility states", () => {
    const aliasEntry = {
      id: "claude-opus",
      provider: "anthropic",
      name: "Claude Opus",
      available: true,
      selectionRef: "opus",
    };
    const automatic = mount(
      props({
        configuredModels: [aliasEntry],
        defaultModels: { primary: "opus", fallbacks: [], utilityModel: null },
      }),
    );
    expect(automatic.querySelector('wa-option[value="opus"]')?.hasAttribute("selected")).toBe(true);
    expect(
      text(
        automatic
          .querySelectorAll(".model-providers__defaults wa-select")[1]
          ?.querySelector("wa-option[selected]") ?? null,
      ),
    ).toContain("Automatic");

    const disabled = mount(
      props({
        configuredModels: [aliasEntry],
        defaultModels: { primary: "opus", fallbacks: [], utilityModel: "" },
      }),
    );
    expect(
      text(
        disabled
          .querySelectorAll(".model-providers__defaults wa-select")[1]
          ?.querySelector("wa-option[selected]") ?? null,
      ),
    ).toBe("Disabled");
  });

  it("disables probing when the gateway does not advertise the method", () => {
    const onProbe = vi.fn();
    const container = mount(props({ probeAvailable: false, onProbe }));
    const testButton = button(container, "Test connection");
    expect(testButton?.disabled).toBe(true);
    expect(testButton?.title).toContain("newer gateway");
    testButton?.click();
    expect(onProbe).not.toHaveBeenCalled();
  });

  it("uses every credential owner id for connection probes", () => {
    const onProbe = vi.fn();
    const container = mount(
      props({
        cards: [card({ credentialProviderIds: ["anthropic", "claude-cli"] })],
        onProbe,
      }),
    );
    button(container, "Test connection")?.click();
    expect(onProbe).toHaveBeenCalledWith("openai", ["anthropic", "claude-cli"]);
  });

  it("shows logout confirmation only for OAuth or token profiles", () => {
    const onLogout = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            credentialProviderIds: ["openai", "openai-codex"],
            logoutTargets: [{ provider: "openai-codex", profileIds: ["openai:oauth"] }],
            profiles: [
              {
                profileId: "openai:oauth",
                type: "oauth",
                status: "ok",
                logoutSupported: true,
              },
            ],
          }),
        ],
        pendingLogoutProvider: "openai",
        onLogout,
      }),
    );
    expect(text(container.querySelector(".model-providers__confirm"))).toContain(
      "Log out of OpenAI?",
    );
    container.querySelector<HTMLButtonElement>(".model-providers__confirm .btn.danger")?.click();
    expect(onLogout).toHaveBeenCalledWith("openai", [
      { provider: "openai-codex", profileIds: ["openai:oauth"] },
    ]);
  });

  it("uses the original config key for credential mutations", () => {
    const onSaveKey = vi.fn();
    const onRemoveKey = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            configKey: "OpenAI",
            apiKey: { source: "config" },
            hasConfigApiKey: true,
          }),
        ],
        keyEditorProvider: "openai",
        keyDraft: "replacement",
        onSaveKey,
        onRemoveKey,
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(provider).not.toBeNull();
    button(provider!, "Save")?.click();
    button(provider!, "Remove key")?.click();
    expect(onSaveKey).toHaveBeenCalledWith("openai", "OpenAI");
    expect(onRemoveKey).toHaveBeenCalledWith("openai", "OpenAI");
  });

  it("shows the current key-operation failure over an older card success", () => {
    const container = mount(
      props({
        messages: {
          openai: { kind: "success", text: "Older success" },
          "key:openai": { kind: "error", text: "Current failure" },
        },
      }),
    );
    expect(text(container.querySelector('[data-provider-id="openai"] .callout'))).toBe(
      "Current failure",
    );
  });

  it("disables API-key mutations for explicit non-API-key auth modes", () => {
    const container = mount(
      props({
        cards: [card({ configAuthMode: "oauth" })],
      }),
    );
    const setKey = button(container, "Set API key");
    expect(setKey?.disabled).toBe(true);
    expect(setKey?.title).toContain('auth mode is "oauth"');
  });

  it("hides API-key setup for providers that explicitly do not support it", () => {
    const container = mount(
      props({
        cards: [card({ apiKeySupported: false })],
      }),
    );
    expect(button(container, "Set API key")).toBeUndefined();
  });
});
