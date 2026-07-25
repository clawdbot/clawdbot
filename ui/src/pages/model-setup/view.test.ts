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
      brandId: "openai",
      label: "Codex CLI",
      detail: "Signed in locally",
      modelRef: "openai/gpt-5",
      recommended: true,
      credentials: true,
      icon: "https://cdn.example.com/codex.png",
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
  manualProviders: [
    {
      id: "openai",
      brandId: "openai",
      label: "OpenAI",
      hint: "Use a project API key.",
      icon: "https://cdn.example.com/openai.png",
    },
  ],
  authOptions: [
    {
      id: "openai-oauth",
      brandId: "openai",
      label: "OpenAI",
      kind: "oauth",
      featured: true,
      hint: "Continue in your browser.",
      icon: "https://cdn.example.com/openai.png",
    },
    {
      id: "other-device",
      label: "Other provider",
      kind: "device-code",
      featured: false,
    },
  ],
  recommendedInstalls: [
    {
      id: "ollama",
      brandId: "ollama",
      label: "Ollama",
      hint: "Run open models locally",
      website: "https://ollama.com/download",
      icon: "https://cdn.simpleicons.org/ollama",
    },
  ],
  workspace: "/tmp/workspace",
  setupComplete: false,
};

function props(overrides: Partial<ModelSetupViewProps> = {}): ModelSetupViewProps {
  return {
    page: { phase: "ready", result: detected },
    activation: { phase: "idle" },
    verify: { phase: "idle" },
    wizard: { phase: "idle" },
    wizardValue: undefined,
    canAdmin: true,
    canVerify: true,
    gatewayTooOld: false,
    actionsDisabled: false,
    manualProviderId: "openai",
    manualApiKey: "",
    manualError: null,
    moreSignInOpen: false,
    iconUrls: {
      "https://cdn.example.com/codex.png": "blob:codex",
      "https://cdn.example.com/openai.png": "blob:openai",
      "https://cdn.simpleicons.org/ollama": "blob:ollama",
    },
    onDetect: vi.fn(),
    onVerify: vi.fn(),
    onActivateCandidate: vi.fn(),
    onStartAuth: vi.fn(),
    onManualProviderChange: vi.fn(),
    onManualApiKeyChange: vi.fn(),
    onManualConnect: vi.fn(),
    onMoreSignInToggle: vi.fn(),
    onIconError: vi.fn(),
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
    vi.unstubAllGlobals();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
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
    expect(
      container.querySelector('[data-candidate-kind="codex-cli"] [data-provider-icon="codex"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-auth-choice="openai-oauth"] [data-provider-icon="codex"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('.model-setup__manual [data-provider-icon="codex"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-auth-choice="other-device"] .provider-brand-icon--fallback')
        ?.textContent,
    ).toContain("O");
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("renders recommended install cards only when candidates and sign-ins are empty", () => {
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: { ...detected, candidates: [], authOptions: [] },
        },
      }),
    );

    expect(text(container)).toContain("Recommended installs");
    expect(text(container)).toContain("Ollama Run open models locally");
    const card = container.querySelector('[data-recommended-install="ollama"]');
    const icon = card?.querySelector<HTMLElement>('[data-provider-icon="ollama"]');
    const link = card?.querySelector<HTMLAnchorElement>("a");
    expect(icon).not.toBeNull();
    expect(card?.querySelector("img")).toBeNull();
    expect(link?.href).toBe("https://ollama.com/download");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener");

    const withSignIn = mount(
      props({
        page: { phase: "ready", result: { ...detected, candidates: [] } },
      }),
    );
    expect(withSignIn.querySelector(".model-setup__empty")).toBeNull();
  });

  it("renders Claude Code with the Claude mark and Codex with the OpenAI mark", () => {
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [],
            authOptions: [],
            recommendedInstalls: [
              {
                id: "claude-code",
                brandId: "claude",
                label: "Claude Code",
                hint: "Anthropic's coding agent CLI",
                website: "https://code.claude.com/docs/en/quickstart",
                icon: "https://cdn.example.com/claude-code.png",
              },
              {
                id: "codex-cli",
                brandId: "openai",
                label: "Codex CLI",
                hint: "OpenAI's coding agent CLI",
                website: "https://developers.openai.com/codex/cli/",
                icon: "https://cdn.example.com/codex-cli.png",
              },
            ],
          },
        },
      }),
    );

    expect(
      container.querySelector(
        '[data-recommended-install="claude-code"] [data-provider-icon="claude"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-recommended-install="codex-cli"] [data-provider-icon="codex"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("never renders remote icon URLs directly", () => {
    const container = mount(props({ iconUrls: {} }));

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("https://cdn.example.com");
  });

  it("uses explicit brand identity without guessing from labels or opaque ids", () => {
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [],
            authOptions: [],
            recommendedInstalls: [],
            manualProviders: [
              {
                id: "custom-login",
                brandId: "claude",
                label: "Company account",
                icon: "https://cdn.example.com/custom.png",
              },
            ],
          },
        },
        manualProviderId: "custom-login",
        iconUrls: {},
      }),
    );

    expect(
      container.querySelector('.model-setup__manual [data-provider-icon="claude"]'),
    ).not.toBeNull();
    expect(container.querySelector(".model-setup__manual img")).toBeNull();
  });

  it("keeps legacy entries without brand identity on the remote artwork path", () => {
    const iconUrl = "https://cdn.example.com/openai.png";
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [],
            authOptions: [],
            recommendedInstalls: [],
            manualProviders: [
              {
                id: "openai-api-key",
                label: "OpenAI",
                icon: iconUrl,
              },
            ],
          },
        },
        manualProviderId: "openai-api-key",
        iconUrls: { [iconUrl]: "blob:legacy-openai" },
      }),
    );

    expect(container.querySelector(".model-setup__manual [data-provider-icon]")).toBeNull();
    expect(container.querySelector<HTMLImageElement>(".model-setup__manual img")?.src).toBe(
      "blob:legacy-openai",
    );

    const loadingContainer = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [],
            authOptions: [],
            recommendedInstalls: [],
            manualProviders: [
              {
                id: "openai-api-key",
                label: "OpenAI",
                icon: iconUrl,
              },
            ],
          },
        },
        manualProviderId: "openai-api-key",
        iconUrls: {},
      }),
    );

    expect(loadingContainer.querySelector(".model-setup__manual [data-provider-icon]")).toBeNull();
    expect(
      loadingContainer.querySelector(".model-setup__manual .provider-brand-icon--fallback")
        ?.textContent,
    ).toContain("O");
  });

  it("uses proxied artwork for unknown providers and invalidates broken blobs", () => {
    const iconUrl = "https://cdn.example.com/acme.png";
    const onIconError = vi.fn();
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [],
            authOptions: [],
            recommendedInstalls: [],
            manualProviders: [
              {
                id: "acme",
                label: "Acme",
                icon: iconUrl,
              },
            ],
          },
        },
        manualProviderId: "acme",
        iconUrls: { [iconUrl]: "blob:acme" },
        onIconError,
      }),
    );

    const image = container.querySelector<HTMLImageElement>(".model-setup__manual img");
    expect(image?.src).toBe("blob:acme");
    expect(image?.alt).toBe("Acme");
    image?.dispatchEvent(new Event("error"));
    expect(onIconError).toHaveBeenCalledWith(iconUrl);
    expect(container.innerHTML).not.toContain(iconUrl);
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

  it("renders an idle current connection and verifies it", () => {
    const onVerify = vi.fn();
    const container = mount(
      props({
        page: { phase: "ready", result: { ...detected, configuredModel: "openai/gpt-5" } },
        onVerify,
      }),
    );
    const current = container.querySelector(".model-setup__current");
    expect(container.querySelector(".settings-section")).toBe(current);
    expect(text(current!)).toContain("Current connection openai/gpt-5 Verify connection");
    current?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onVerify).toHaveBeenCalledOnce();
  });

  it("renders connection verification progress", () => {
    const container = mount(
      props({
        page: { phase: "ready", result: { ...detected, configuredModel: "openai/gpt-5" } },
        verify: { phase: "checking" },
        actionsDisabled: true,
      }),
    );
    expect(text(container)).toContain("Checking — asking openai/gpt-5 for a quick reply…");
    expect(
      container.querySelector<HTMLButtonElement>(".model-setup__current button")?.disabled,
    ).toBe(true);
  });

  it("renders successful connection verification with the answering model", () => {
    const container = mount(
      props({
        page: { phase: "ready", result: { ...detected, configuredModel: "openai/gpt-5" } },
        verify: { phase: "ok", modelRef: "anthropic/claude-opus-4-8", latencyMs: 1234 },
      }),
    );
    expect(text(container)).toContain("Answered in 1234 ms");
    const current = container.querySelector(".model-setup__current");
    expect(current?.textContent).toContain("anthropic/claude-opus-4-8");
    expect(current?.querySelector("strong")?.textContent).not.toContain("openai/gpt-5");
  });

  it("renders failed connection verification", () => {
    const container = mount(
      props({
        page: { phase: "ready", result: { ...detected, configuredModel: "openai/gpt-5" } },
        verify: { phase: "failed", status: "billing", error: "No credits" },
      }),
    );
    expect(text(container)).toContain("Billing problem No credits");
  });

  it("hides the current connection without a configured model", () => {
    const container = mount(props());
    expect(container.querySelector(".model-setup__current")).toBeNull();
  });

  it("shows the current model without verification controls for non-admin and unsupported gateways", () => {
    const result = { ...detected, configuredModel: "openai/gpt-5" };
    const nonAdmin = mount(
      props({ page: { phase: "ready", result }, canAdmin: false, canVerify: false }),
    );
    expect(text(nonAdmin)).toContain("Current connection openai/gpt-5");
    expect(nonAdmin.querySelector(".model-setup__current button")).toBeNull();

    const unsupportedGateway = mount(props({ page: { phase: "ready", result }, canVerify: false }));
    expect(text(unsupportedGateway)).toContain("Current connection openai/gpt-5");
    expect(unsupportedGateway.querySelector(".model-setup__current button")).toBeNull();
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

  it("copies device codes through the plain-HTTP clipboard fallback", async () => {
    vi.stubGlobal("navigator", {});
    let copiedText: string | undefined;
    const execCommand = vi.fn().mockImplementation(() => {
      copiedText = document.querySelector<HTMLTextAreaElement>("textarea")?.value;
      return true;
    });
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
    const container = wizardStep({
      id: "device",
      type: "note",
      deviceCode: { code: "ABCD-EFGH" },
    });

    const copy = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Copy",
    );
    expect(copy).toBeDefined();
    copy?.click();

    await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(copiedText).toBe("ABCD-EFGH");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it.each([
    { sensitive: false, expectedType: "text" },
    { sensitive: true, expectedType: "password" },
  ])(
    "labels a $expectedType input with the visible text-step message",
    ({ sensitive, expectedType }) => {
      const container = wizardStep(
        {
          id: "access-value",
          type: "text",
          message: "Provider access value",
          sensitive,
          placeholder: "Enter value",
        },
        "initial value",
      );
      const input = container.querySelector<HTMLInputElement>("#model-setup-wizard-text-input");
      const label = container.querySelector<HTMLLabelElement>(
        'label[for="model-setup-wizard-text-input"]',
      );
      expect(label?.textContent).toBe("Provider access value");
      expect(input?.type).toBe(expectedType);
      expect(input?.labels).toContain(label);
    },
  );

  it("renders select and confirm steps", () => {
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
