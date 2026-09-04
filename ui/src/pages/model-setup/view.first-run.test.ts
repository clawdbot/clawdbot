/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { renderModelSetup } from "./view.ts";

type ModelSetupViewProps = Parameters<typeof renderModelSetup>[0];

const ready: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [],
  prepareOptions: [],
  recommendedInstalls: [],
  workspace: "/tmp/workspace",
  configuredModel: "openai/gpt-5",
  setupComplete: true,
};

function mount(overrides: Partial<ModelSetupViewProps> = {}): HTMLDivElement {
  const noop = vi.fn();
  const props: ModelSetupViewProps = {
    page: { phase: "ready", result: ready },
    activation: { phase: "idle" },
    verify: { phase: "idle" },
    wizard: { phase: "idle" },
    wizardMode: "auth",
    wizardValue: undefined,
    canAdmin: true,
    canVerify: true,
    canPrepare: true,
    gatewayTooOld: false,
    refreshWarning: null,
    actionsDisabled: false,
    manualProviderId: "",
    manualApiKey: "",
    manualError: null,
    moreSignInOpen: false,
    firstRun: true,
    iconUrls: {},
    onDetect: noop,
    onVerify: noop,
    onActivateCandidate: noop,
    onStartAuth: noop,
    onStartPrepare: noop,
    onManualProviderChange: noop,
    onUseManualProvider: noop,
    onManualApiKeyChange: noop,
    onManualConnect: noop,
    onMoreSignInToggle: noop,
    onIconError: noop,
    onOpenChat: noop,
    onSuccessClose: noop,
    onWizardValueChange: noop,
    onWizardAnswer: noop,
    onWizardCancel: noop,
    onWizardClose: noop,
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  render(renderModelSetup(props), container);
  return container;
}

describe("renderModelSetup first-run continuation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });

  it("keeps durable continuation without duplicating a fresh success action", () => {
    const onOpenChat = vi.fn();
    const container = mount({ onOpenChat });

    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue setup",
    );
    expect(continueButton).toBeDefined();
    continueButton?.click();
    expect(onOpenChat).toHaveBeenCalledOnce();

    const freshSuccess = mount({
      activation: { phase: "success", modelRef: "openai/gpt-5" },
    });
    expect(
      [...freshSuccess.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Continue setup",
      ),
    ).toHaveLength(1);
  });

  it.each([{ canAdmin: false }, { gatewayTooOld: true }])(
    "keeps continuation available with restricted setup controls",
    (access) => {
      const container = mount(access);
      expect(container.textContent).toContain("Continue setup");
    },
  );

  it("omits continuation outside first run", () => {
    const container = mount({ firstRun: false });
    expect(container.textContent).not.toContain("Continue setup");
  });
});
