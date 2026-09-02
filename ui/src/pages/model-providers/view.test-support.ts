import { render } from "lit";
import type { ModelProviderCard } from "./data.ts";
import { renderModelProviders } from "./view.ts";

export type ModelProvidersViewProps = Parameters<typeof renderModelProviders>[0];
export type SegmentedGroup = HTMLElement & { disabled: boolean; value: string };

export function card(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  return {
    id: "openai",
    displayName: "OpenAI",
    profiles: [],
    credentialProviderIds: ["openai"],
    logoutTargets: [],
    accessOptions: [],
    hasConfigApiKey: false,
    modelCount: 1,
    availableModelCount: 1,
    runtimeAvailableModelCount: 0,
    runtimeLabels: [],
    apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
    ...overrides,
  };
}

export function props(overrides: Partial<ModelProvidersViewProps> = {}): ModelProvidersViewProps {
  return {
    connected: true,
    loading: false,
    refreshing: false,
    error: null,
    providerUsageFailed: false,
    supplementalLoading: false,
    updatedAt: 1,
    costDays: 30,
    cards: [card()],
    configuredModels: [{ id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true }],
    defaultModels: { primary: "openai/gpt-5", fallbacks: [], utilityModel: null },
    thinkingLevel: "off",
    thinkingOverridden: true,
    fastMode: false,
    fastModeOverridden: true,
    configBusy: false,
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
    providerLoginBusy: false,
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
    onLogin: () => undefined,
    onPrimaryChange: () => undefined,
    onFallbackChange: () => undefined,
    onUtilityChange: () => undefined,
    onThinkingChange: () => undefined,
    onThinkingReset: () => undefined,
    onFastModeChange: () => undefined,
    onFastModeReset: () => undefined,
    onOpenModelSetup: () => undefined,
    ...overrides,
  };
}

export function mount(viewProps: ModelProvidersViewProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderModelProviders(viewProps), container);
  return container;
}

export function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

export function button(container: Element, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    text(entry).includes(label),
  );
}

export function settingsRow(container: Element, label: string): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) =>
      text(
        candidate.querySelector(".model-providers__label-with-help > span:first-child") ??
          candidate.querySelector(".settings-row__title"),
      ) === label,
  );
  if (!match) {
    throw new Error(`Missing settings row: ${label}`);
  }
  return match;
}

export function selectSegment(group: SegmentedGroup, value: string) {
  group.value = value;
  group.dispatchEvent(new Event("change", { bubbles: true }));
}
