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
    updatedAt: 1,
    costDays: 30,
    credentialAgentLabel: "Writer",
    cards: [card()],
    configuredModels: [{ id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true }],
    defaultModels: { primary: "openai/gpt-5", fallbacks: [], utilityModel: null },
    defaultModelsDirty: false,
    thinkingLevel: "off",
    fastMode: false,
    configBusy: false,
    unconfiguredProviders: [{ id: "anthropic", displayName: "Anthropic" }],
    canMutate: true,
    mutationBlockedReason: null,
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
    onFastModeChange: () => undefined,
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
  beforeEach(async () => {
    await i18n.setLocale("en");
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
      "Auto",
      "Fast",
      "Standard",
    ]);

    selectSegment(thinking!, "high");
    selectSegment(fastMode!, "off");
    expect(onThinkingChange).toHaveBeenCalledWith("high", expect.any(HTMLElement));
    expect(onFastModeChange).toHaveBeenCalledWith(false);
  });

  it("locks model behavior while shared config work is pending", () => {
    const container = mount(props({ configBusy: true }));
    const behavior = container.querySelector("#settings-model-behavior");
    const groups = behavior?.querySelectorAll<SegmentedGroup>("wa-radio-group") ?? [];

    expect(groups).toHaveLength(2);
    expect([...groups].every((group) => group.disabled)).toBe(true);
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
    expect(text(readiness)).toContain("Connect your AI");
    expect(text(readiness)).toContain("No models available");
    expect(text(readiness)).toContain("Choose another provider");
    expect(container.querySelector(".model-providers__defaults")).toBeNull();
    expect(text(container.querySelector('[data-provider-id="openai"]'))).toContain("Signed in");

    button(readiness!, "Choose another provider")?.click();
    expect(onOpenModelSetup).toHaveBeenCalledOnce();
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
    expect(text(provider)).toContain("API key");
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
    expect(button(readiness!, "Connect your AI")).toBeDefined();
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

  it("shows config key provenance when auth status is unavailable", () => {
    const container = mount(
      props({
        cards: [card({ apiKey: undefined, hasConfigApiKey: true })],
      }),
    );

    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(text(provider)).toContain("API key set in config");
    expect(text(provider)).not.toContain("Not configured");
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
    expect(text(provider)).toContain("Signed in");
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
    const option = container.querySelector<HTMLOptionElement>(
      'option[value="openrouter/anthropic/claude-sonnet-4"]',
    );
    expect(option?.selected).toBe(true);
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
    expect(automatic.querySelector<HTMLOptionElement>('option[value="opus"]')?.selected).toBe(true);
    expect(
      text(
        automatic.querySelectorAll<HTMLSelectElement>(".model-providers__defaults select")[1]
          ?.selectedOptions[0] ?? null,
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
        disabled.querySelectorAll<HTMLSelectElement>(".model-providers__defaults select")[1]
          ?.selectedOptions[0] ?? null,
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
