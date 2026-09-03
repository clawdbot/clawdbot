/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  button,
  card,
  mount,
  props,
  selectSegment,
  settingsRow,
  text,
  type SegmentedGroup,
} from "./view.test-support.ts";
import { renderModelProviders } from "./view.ts";

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

  it("renders each configured provider as a separate standard card", () => {
    const container = mount(
      props({
        cards: [
          card(),
          card({ id: "anthropic", displayName: "Claude", credentialProviderIds: ["anthropic"] }),
        ],
      }),
    );

    expect(
      container.querySelectorAll(".model-providers__provider-list > .settings-group"),
    ).toHaveLength(2);
  });

  it("renders a minute-precision update time beside an icon refresh action", () => {
    const container = mount(props({ updatedAt: new Date(2026, 7, 31, 18, 51, 22).getTime() }));
    const updated = text(container.querySelector(".model-providers__updated"));
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');

    expect(updated).toContain("Updated");
    expect(updated).not.toMatch(/:\d{2}:\d{2}/u);
    expect(refresh?.querySelector("svg")).not.toBeNull();
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });

  it("renders one Defaults section with the five default rows and canonical values", () => {
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
    expect(text(container.querySelector(".settings-section__heading"))).toBe("Defaults");
    expect(text(container.querySelector(".settings-section__desc"))).toBe(
      "Applies across all providers and models where applicable.",
    );
    expect(
      [...container.querySelectorAll(".model-providers__defaults .settings-row")].map((entry) =>
        text(
          entry.querySelector(".model-providers__label-with-help > span:first-child") ??
            entry.querySelector(".settings-row__title"),
        ),
      ),
    ).toEqual(["Model", "Utility Model", "Fallback Model", "Thinking", "Fast Mode"]);
    const thinking = settingsRow(behavior!, "Thinking").querySelector<SegmentedGroup>(
      "wa-radio-group",
    );
    const fastMode = settingsRow(behavior!, "Fast Mode").querySelector<SegmentedGroup>(
      "wa-radio-group",
    );
    expect(thinking?.value).toBe("low");
    expect(fastMode?.value).toBe("auto");
    expect([...fastMode!.querySelectorAll("wa-radio")].map((entry) => text(entry))).toEqual([
      "Default",
      "Auto",
      "On",
      "Off",
    ]);
    expect(container.querySelector('button[aria-label="About thinking defaults"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="About fast mode defaults"]')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="About thinking defaults"] svg'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="About fast mode defaults"] svg'),
    ).not.toBeNull();
    expect(container.querySelector(".model-providers__form-actions")).toBeNull();

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
    const fastRow = settingsRow(behavior, "Fast Mode");

    expect(thinkingRow.querySelector<SegmentedGroup>("wa-radio-group")?.value).toBe("adaptive");
    expect(text(thinkingRow)).toContain("Adaptive");
    expect(text(thinkingRow)).not.toContain("Default: Model policy");
    expect(text(fastRow)).not.toContain("Default: Model policy");
    const thinkingDefaultHelp = thinkingRow.querySelector(
      'wa-radio[value=""] .model-providers__segment-info',
    );
    const fastModeDefaultHelp = fastRow.querySelector(
      'wa-radio[value=""] .model-providers__segment-info',
    );
    expect(
      (
        thinkingDefaultHelp?.closest("openclaw-tooltip") as
          | (HTMLElement & { content?: string })
          | null
      )?.content,
    ).toContain("model's thinking policy");
    expect(
      (
        fastModeDefaultHelp?.closest("openclaw-tooltip") as
          | (HTMLElement & { content?: string })
          | null
      )?.content,
    ).toContain("Unlike Auto");
    expect(thinkingRow.querySelector('wa-radio[value=""]')?.hasAttribute("title")).toBe(false);
    expect(fastRow.querySelector('wa-radio[value=""]')?.hasAttribute("title")).toBe(false);

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
    const inheritedFast = settingsRow(inheritedBehavior, "Fast Mode");
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
    expect(text(inheritedThinking)).not.toContain("Using default: Model policy");
    expect(text(inheritedFast)).not.toContain("Using default: Model policy");
    expect(
      inheritedBehavior.querySelectorAll('button[aria-label="Reset to default"]'),
    ).toHaveLength(0);
  });

  it("keeps invalid explicit model behavior values resettable", () => {
    const onThinkingReset = vi.fn();
    const onFastModeReset = vi.fn();
    const container = mount(
      props({
        thinkingLevel: undefined,
        thinkingOverridden: true,
        fastMode: undefined,
        fastModeOverridden: true,
        onThinkingReset,
        onFastModeReset,
      }),
    );
    const behavior = container.querySelector("#settings-model-behavior")!;
    const thinking = settingsRow(behavior, "Thinking");
    const fast = settingsRow(behavior, "Fast Mode");

    thinking.querySelector<HTMLElement>('wa-radio[value=""]')?.click();
    fast.querySelector<HTMLElement>('wa-radio[value=""]')?.click();
    expect(onThinkingReset).toHaveBeenCalledOnce();
    expect(onFastModeReset).toHaveBeenCalledOnce();
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
    const fastMode = settingsRow(behavior, "Fast Mode").querySelector<SegmentedGroup>(
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
    expect(button(defaults!, "Save")).toBeUndefined();

    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(
      provider?.querySelector<HTMLInputElement>(".model-providers__inline-form input")?.disabled,
    ).toBe(true);
    expect(button(provider!, "Replace key")?.disabled).toBe(true);
    expect(button(provider!, "Remove key")?.disabled).toBe(true);
    expect(button(provider!, "Log out")?.disabled).toBe(true);
  });

  it("locks defaults after mutation access is revoked", () => {
    const container = mount(
      props({
        canMutate: false,
        mutationBlockedReason: "Operator admin access required",
        messages: {
          defaults: {
            kind: "error",
            text: "Configuration changes require operator.admin access.",
          },
        },
      }),
    );

    const defaults = container.querySelector(".model-providers__defaults");
    expect(
      [...(defaults?.querySelectorAll("wa-select, wa-radio-group") ?? [])].every((control) =>
        control.hasAttribute("disabled"),
      ),
    ).toBe(true);
    expect(text(defaults)).not.toContain("operator.admin access");
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
      settingsRow(behavior!, "Fast Mode").querySelector<SegmentedGroup>("wa-radio-group")?.value,
    ).toBe("on");
    expect(text(container)).not.toContain("Configure a provider before selecting default models.");
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
    expect(text(provider)).toContain("Access");
    expect(text(provider)).not.toContain("Usage and cost");
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
    expect(container.querySelector(".model-providers__defaults")).not.toBeNull();
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
            auth: { kind: "expiring", profileCount: 1 },
            profiles: [{ profileId: "openai:chatgpt", type: "oauth", status: "expiring" }],
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
    expect(text(provider)).not.toContain("Expiring");
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
    expect(container.querySelector(".model-providers__defaults")).not.toBeNull();
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
    expect(container.querySelector(".model-providers__defaults")).not.toBeNull();
  });

  it("shows defaults normally when a selectable model exists", () => {
    const container = mount(props());
    expect(container.querySelector('[data-model-readiness="model-required"]')).toBeNull();
    expect(container.querySelector(".model-providers__defaults")).not.toBeNull();
  });

  it("labels provider usage and session cost by scope", () => {
    const container = mount(
      props({
        cards: [
          card({
            localCost: {
              totalCost: 12,
              totalTokens: 1_000,
              sessionCount: 2,
              missingCostEntries: 0,
            },
          }),
        ],
      }),
    );

    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(text(provider)).toContain("Access");
    expect(text(provider)).toContain("Usage and cost · all agents");
    expect(text(provider)).toContain("Session spend · last 30 days");
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
    expect(text(provider)).not.toContain("Access");
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
    ).toBe("Auto");

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

  it("shows logout confirmation for removable saved profiles", () => {
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

  it("starts provider-owned login from an unconfigured card", () => {
    const onLogin = vi.fn();
    const loginOption = {
      id: "xai-oauth",
      label: "xAI OAuth",
      mode: "login",
    } as const;
    const container = mount(
      props({
        cards: [
          card({
            id: "xai",
            displayName: "xAI",
            profiles: [],
            apiKey: undefined,
            accessOptions: [loginOption],
          }),
        ],
        onLogin,
      }),
    );

    button(container, "Sign in with xAI OAuth")?.click();

    expect(onLogin).toHaveBeenCalledWith("xai", loginOption);
  });

  it("starts provider setup from an unconfigured card", () => {
    const onLogin = vi.fn();
    const setupOption = { id: "vllm", label: "vLLM", mode: "setup" } as const;
    const container = mount(
      props({
        cards: [
          card({
            id: "vllm",
            displayName: "vLLM",
            profiles: [],
            apiKey: undefined,
            accessOptions: [setupOption],
          }),
        ],
        onLogin,
      }),
    );

    button(container, "Set up vLLM")?.click();

    expect(onLogin).toHaveBeenCalledWith("vllm", setupOption);
  });
});
