/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult, WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { renderModelSetup } from "./view.ts";

type ModelSetupViewProps = Parameters<typeof renderModelSetup>[0];

const detected: SystemAgentSetupDetectResult = {
  candidates: [
    {
      kind: "codex-cli",
      label: "Codex CLI",
      detail: "Signed in locally",
      modelRef: "openai/gpt-5",
      recommended: true,
      credentials: true,
    },
  ],
  unavailableCandidates: [
    {
      id: "gemini-cli",
      label: "Gemini CLI",
      detail: "Installed",
      reason: "No active login",
    },
  ],
  manualProviders: [{ id: "openai", label: "OpenAI", hint: "Use a project API key." }],
  authOptions: [
    {
      id: "openai-oauth",
      label: "OpenAI",
      kind: "oauth",
      featured: true,
      hint: "Continue in your browser.",
    },
    {
      id: "other-device",
      label: "Other provider",
      kind: "device-code",
      featured: false,
    },
  ],
  workspace: "/tmp/workspace",
  setupComplete: false,
};

function props(overrides: Partial<ModelSetupViewProps> = {}): ModelSetupViewProps {
  return {
    page: { phase: "ready", result: detected },
    activation: { phase: "idle" },
    wizard: { phase: "idle" },
    wizardValue: undefined,
    canAdmin: true,
    gatewayTooOld: false,
    actionsDisabled: false,
    manualProviderId: "openai",
    manualApiKey: "",
    manualError: null,
    moreSignInOpen: false,
    onDetect: vi.fn(),
    onActivateCandidate: vi.fn(),
    onStartAuth: vi.fn(),
    onManualProviderChange: vi.fn(),
    onManualApiKeyChange: vi.fn(),
    onManualConnect: vi.fn(),
    onMoreSignInToggle: vi.fn(),
    onOpenChat: vi.fn(),
    onWizardValueChange: vi.fn(),
    onWizardAnswer: vi.fn(),
    onWizardCancel: vi.fn(),
    onWizardClose: vi.fn(),
    ...overrides,
  };
}

function mount(viewProps: ModelSetupViewProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderModelSetup(viewProps), container);
  return container;
}

function text(container: Element): string {
  return container.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function wizardStep(step: WizardStep, value: unknown = step.initialValue): HTMLDivElement {
  return mount(
    props({
      wizard: {
        phase: "step",
        authChoice: "provider-auth",
        step,
        busy: false,
        validationError: null,
      },
      wizardValue: value,
    }),
  );
}

describe("renderModelSetup", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });

  it("renders candidate, unavailable, sign-in, and manual sections", () => {
    const container = mount(props());
    expect(text(container)).toContain("Connect your AI");
    expect(text(container)).toContain("Found on this Gateway");
    expect(text(container)).toContain("Codex CLI");
    expect(text(container)).toContain("openai/gpt-5 · Signed in locally");
    expect(text(container)).toContain("Detected, but not auto-tested");
    expect(text(container)).toContain("No active login");
    expect(text(container)).toContain("Sign in with a provider");
    expect(text(container)).toContain("Connect with an API key or token");
    expect(container.querySelector<HTMLSelectElement>(".model-setup__manual select")?.value).toBe(
      "openai",
    );
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("renders admin and older-gateway gates without actions", () => {
    const admin = mount(props({ canAdmin: false }));
    expect(text(admin)).toContain("Model setup requires operator.admin access.");
    expect(admin.querySelector(".settings-section")).toBeNull();

    const old = mount(props({ gatewayTooOld: true }));
    expect(text(old)).toContain("The Gateway is running an older OpenClaw version");
    expect(old.querySelector(".settings-section")).toBeNull();
  });

  it("renders the success banner and opens chat", () => {
    const onOpenChat = vi.fn();
    const container = mount(
      props({
        activation: { phase: "success", modelRef: "openai/gpt-5", latencyMs: 91 },
        onOpenChat,
      }),
    );
    expect(text(container)).toContain("Your AI is ready");
    expect(text(container)).toContain("openai/gpt-5 · 91 ms");
    container.querySelector<HTMLButtonElement>(".model-setup__success button")?.click();
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(container.querySelector(".settings-section")).toBeNull();
  });

  it("renders manual activation progress and failure inline", () => {
    const testing = mount(
      props({
        activation: {
          phase: "testing",
          targetId: "manual:openai",
          modelRef: "openai",
        },
        actionsDisabled: true,
      }),
    );
    expect(text(testing)).toContain("Testing — asking OpenAI for a quick reply…");
    expect(testing.querySelector<HTMLButtonElement>(".model-setup__manual button")?.disabled).toBe(
      true,
    );

    const failure = mount(
      props({
        activation: {
          phase: "failure",
          targetId: "manual:openai",
          status: "billing",
          error: "No credits",
        },
      }),
    );
    expect(text(failure)).toContain("Billing problem No credits");
  });

  it("renders note links and device codes", () => {
    const container = wizardStep({
      id: "device",
      type: "note",
      title: "Authorize device",
      message: "Use this code",
      externalUrl: "https://example.com/device",
      deviceCode: { code: "ABCD-EFGH", expiresInMinutes: 10 },
    });
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/device"]');
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noreferrer");
    expect(text(container)).toContain("ABCD-EFGH");
    expect(text(container)).toContain("Expires in 10 minutes");
  });

  it("renders sensitive text, select, and confirm steps", () => {
    const sensitive = wizardStep(
      { id: "token", type: "text", sensitive: true, placeholder: "Paste token" },
      "secret",
    );
    expect(sensitive.querySelector<HTMLInputElement>('input[name="wizard-text"]')?.type).toBe(
      "password",
    );

    const select = wizardStep(
      {
        id: "account",
        type: "select",
        options: [
          { value: "personal", label: "Personal", hint: "Your account" },
          { value: "work", label: "Work" },
        ],
      },
      "personal",
    );
    expect(select.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(text(select)).toContain("Your account");

    const confirm = wizardStep({ id: "confirm", type: "confirm", message: "Continue?" });
    expect(text(confirm)).toContain("Yes");
    expect(text(confirm)).toContain("No");
  });

  it.each(["multiselect", "progress", "action"] as const)("renders the %s wizard step", (type) => {
    const container = wizardStep({
      id: type,
      type,
      message: `${type} message`,
      ...(type === "multiselect"
        ? { options: [{ value: "one", label: "One" }], initialValue: ["one"] }
        : {}),
    });
    expect(text(container)).toContain(`${type} message`);
    expect(text(container)).toContain("Continue");
  });
});
