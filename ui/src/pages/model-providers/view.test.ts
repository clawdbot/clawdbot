/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";
import { renderModelProviders } from "./view.ts";

type ModelProvidersViewProps = Parameters<typeof renderModelProviders>[0];

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
    cards: [card()],
    configuredModels: [{ id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true }],
    defaultModels: { primary: "openai/gpt-5", fallbacks: [], utilityModel: null },
    defaultModelsDirty: false,
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
    expect(text(provider)).toContain("API key from environment (OPENAI_API_KEY)");
    expect(text(provider)).toContain("Connected");
    expect(text(provider)).toContain("145 ms");
    expect(text(provider)).toContain("Default profile");
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
