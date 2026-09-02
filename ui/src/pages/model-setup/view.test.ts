/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import {
  detected,
  mount,
  props,
  text,
  type ModelSetupViewProps,
} from "./test-helpers/view.test-support.ts";

function wizardStep(
  step: WizardStep,
  value: unknown = step.initialValue,
  wizardMode: ModelSetupViewProps["wizardMode"] = "auth",
): HTMLDivElement {
  return mount(
    props({
      wizard: {
        phase: "step",
        authChoice: "provider-auth",
        step,
        busy: false,
        validationError: null,
      },
      wizardMode,
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
    expect(text(container)).toContain("Connect a verified AI model");
    expect(text(container)).toContain("Found on this Gateway");
    expect(text(container)).toContain("Codex CLI");
    expect(text(container)).toContain("openai/gpt-5 · Signed in locally");
    expect(text(container)).toContain("Found, but needs attention");
    expect(text(container)).toContain("This local runtime must be configured outside OpenClaw");
    expect(text(container)).toContain("Sign in with a provider");
    expect(text(container)).toContain("Run a model locally");
    expect(text(container)).toContain("LM Studio");
    expect(text(container)).toContain("Connect with an API key or token");
    expect(
      container.querySelector('[data-manual-provider="openai"][data-selected]'),
    ).not.toBeNull();
    expect(text(container.querySelector(".model-setup-provider-select__trigger")!)).toContain(
      "OpenAI",
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
      container.querySelector('[data-prepare-choice="lmstudio"] [data-provider-icon="lmstudio"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-auth-choice="other-device"] .provider-brand-icon--fallback')
        ?.textContent,
    ).toContain("O");
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it.each(["logged in · ChatGPT account · alex@example.com", "logged in · API key (usage-billed)"])(
    "shows detected authentication without credential values: %s",
    (detail) => {
      const secret = "synthetic-private-token";
      const container = mount(
        props({
          page: {
            phase: "ready",
            result: {
              ...detected,
              candidates: [{ ...detected.candidates[0]!, detail: `${detail} · token=${secret}` }],
            },
          },
        }),
      );
      const row = container.querySelector('[data-candidate-kind="codex-cli"]')!;

      expect(text(row)).toContain(detail);
      expect(text(row)).not.toContain(secret);
    },
  );

  it("identifies provider families separately from their credential methods", () => {
    const container = mount(
      props({
        manualProviderId: "qwen-cn",
        page: {
          phase: "ready",
          result: {
            ...detected,
            manualProviders: [
              {
                id: "qwen-cn",
                brandId: "qwen",
                groupLabel: "Qwen Cloud",
                label: "Coding Plan API Key for China (subscription)",
                hint: "Endpoint: coding.dashscope.aliyuncs.com",
              },
              {
                id: "zai-cn",
                brandId: "zai",
                groupLabel: "Z.AI",
                label: "Coding-Plan-CN",
              },
            ],
          },
        },
      }),
    );

    expect(text(container.querySelector(".model-setup-provider-select__trigger")!)).toContain(
      "Qwen Cloud Coding Plan API Key for China (subscription)",
    );
    expect(
      container.querySelector('[data-manual-provider="qwen-cn"] [data-provider-icon="alibaba"]'),
    ).not.toBeNull();
    expect(text(container.querySelector('[data-manual-provider="zai-cn"]')!)).toContain(
      "Z.AI Coding-Plan-CN",
    );
  });

  it("renders the provider picker with the shared Web Awesome primitive", () => {
    const container = mount(props());
    const picker = container.querySelector(".model-setup-provider-select");
    const options = Array.from(
      container.querySelectorAll<HTMLElement & { checked: boolean; value: string }>(
        "wa-dropdown-item[data-manual-provider]",
      ),
    );

    expect(picker?.localName).toBe("wa-dropdown");
    expect(options.map((option) => option.value).toSorted()).toEqual(["gemini-api-key", "openai"]);
    expect(options.find((option) => option.value === "openai")?.checked).toBe(true);
    expect(options.find((option) => option.value === "gemini-api-key")?.checked).toBe(false);
  });

  it("claims Escape before the app shortcut and restores the provider trigger", () => {
    const container = mount(props());
    const picker = container.querySelector<HTMLElement & { open: boolean }>(
      ".model-setup-provider-select",
    )!;
    const trigger = picker.querySelector<HTMLElement>('[slot="trigger"]')!;
    const appShortcut = vi.fn();
    const handleAppShortcut = (event: KeyboardEvent) => {
      if (!event.defaultPrevented) {
        appShortcut();
      }
    };
    document.addEventListener("keydown", handleAppShortcut);
    picker.open = true;

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    picker.dispatchEvent(event);
    picker.dispatchEvent(new CustomEvent("wa-after-hide"));
    document.removeEventListener("keydown", handleAppShortcut);

    expect(picker.open).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(appShortcut).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus to the credential field after Tab dismisses the picker", () => {
    const container = mount(props());
    const picker = container.querySelector<HTMLElement & { open: boolean }>(
      ".model-setup-provider-select",
    )!;
    const option = picker.querySelector<HTMLElement>("[data-manual-provider]")!;
    const accessValue = container.querySelector<HTMLElement>('input[type="password"]')!;
    picker.open = true;
    option.focus();

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    option.dispatchEvent(event);
    picker.dispatchEvent(new CustomEvent("wa-after-hide"));

    expect(event.defaultPrevented).toBe(true);
    expect(picker.open).toBe(false);
    expect(document.activeElement).toBe(accessValue);
  });

  it("returns focus to the provider trigger after Shift+Tab dismisses the picker", () => {
    const container = mount(props());
    const picker = container.querySelector<HTMLElement & { open: boolean }>(
      ".model-setup-provider-select",
    )!;
    const trigger = picker.querySelector<HTMLElement>('[slot="trigger"]')!;
    const option = picker.querySelector<HTMLElement>("[data-manual-provider]")!;
    picker.open = true;
    option.focus();

    option.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
        shiftKey: true,
      }),
    );
    picker.dispatchEvent(new CustomEvent("wa-after-hide"));

    expect(picker.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the credential when the selected provider is chosen again", () => {
    const onManualProviderChange = vi.fn();
    const container = mount(props({ onManualProviderChange }));
    const picker = container.querySelector<HTMLElement & { open: boolean }>(
      ".model-setup-provider-select",
    )!;
    const trigger = picker.querySelector<HTMLElement>('[slot="trigger"]')!;
    const option = picker.querySelector<HTMLElement & { checked: boolean }>(
      '[data-manual-provider="openai"]',
    )!;
    picker.open = true;
    trigger.focus();
    picker.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        cancelable: true,
        detail: { item: option },
      }),
    );

    expect(onManualProviderChange).not.toHaveBeenCalled();
    expect(option.checked).toBe(true);
    expect(picker.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("focuses the selected provider when the shared dropdown opens", () => {
    const container = mount(
      props({
        manualProviderId: "gemini-api-key",
        page: {
          phase: "ready",
          result: {
            ...detected,
            manualProviders: [
              ...detected.manualProviders,
              { id: "zai", groupLabel: "Z.AI", label: "API key" },
            ],
          },
        },
      }),
    );
    const picker = container.querySelector(".model-setup-provider-select")!;
    picker.dispatchEvent(new CustomEvent("wa-after-show"));

    const options = Array.from(
      picker.querySelectorAll<HTMLElement & { active: boolean }>("[data-manual-provider]"),
    );
    expect(
      options.find((option) => option.dataset.manualProvider === "gemini-api-key")?.active,
    ).toBe(true);
    expect(options.find((option) => option.dataset.manualProvider === "openai")?.active).toBe(
      false,
    );
  });

  it("changes provider from the shared dropdown selection event", () => {
    const onManualProviderChange = vi.fn();
    const container = mount(props({ onManualProviderChange }));
    const picker = container.querySelector(".model-setup-provider-select")!;
    const trigger = picker.querySelector<HTMLElement>('[slot="trigger"]')!;
    const option = picker.querySelector('[data-manual-provider="gemini-api-key"]')!;

    picker.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        cancelable: true,
        detail: { item: option },
      }),
    );
    picker.dispatchEvent(new CustomEvent("wa-after-hide"));

    expect(onManualProviderChange).toHaveBeenCalledWith("gemini-api-key");
    expect(document.activeElement).toBe(trigger);
  });

  it("does not repeat the method when an older gateway omits the provider group", () => {
    const container = mount(
      props({
        manualProviderId: "legacy",
        page: {
          phase: "ready",
          result: {
            ...detected,
            manualProviders: [{ id: "legacy", label: "Legacy provider" }],
          },
        },
      }),
    );
    const trigger = container.querySelector(".model-setup-provider-select__trigger")!;
    const option = container.querySelector('[data-manual-provider="legacy"]')!;

    expect(trigger.querySelector("strong")?.textContent?.trim()).toBe("Legacy provider");
    expect(trigger.querySelector(".model-setup-provider-select__copy > span")).toBeNull();
    expect(option.getAttribute("aria-label")).toBe("Legacy provider");
  });

  it("shows verified connections in an actionable success dialog", () => {
    const onOpenChat = vi.fn();
    const onSuccessClose = vi.fn();
    const container = mount(
      props({
        activation: { phase: "success", modelRef: "openai/gpt-5.6-sol", latencyMs: 73 },
        onOpenChat,
        onSuccessClose,
      }),
    );

    const dialog = container.querySelector('openclaw-modal-dialog[label="Connection verified"]');
    expect(dialog).not.toBeNull();
    expect(text(dialog!)).toContain(
      "OpenClaw received a real reply from openai/gpt-5.6-sol. You can start chatting now.",
    );
    expect(text(dialog!)).toContain("Verified in 73 ms");
    dialog?.querySelector<HTMLButtonElement>(".primary")?.click();
    expect(onOpenChat).toHaveBeenCalledOnce();
    dialog?.querySelectorAll<HTMLButtonElement>("button").item(0).click();
    expect(onSuccessClose).toHaveBeenCalledOnce();
  });

  it("only rechecks unavailable runtimes without a supported setup route", () => {
    const onDetect = vi.fn();
    const container = mount(props({ onDetect }));
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '[data-unavailable-candidate="pi-cli"] button',
    );

    expect([...buttons].map((button) => button.textContent?.trim())).toEqual(["Check again"]);
    buttons[0]?.click();

    expect(onDetect).toHaveBeenCalledOnce();
  });

  it("derives prepare rows from accepted choice ids and hides usable local candidates", () => {
    const onStartPrepare = vi.fn();
    const container = mount(props({ onStartPrepare }));

    const ollama = container.querySelector<HTMLButtonElement>(
      '[data-prepare-choice="ollama"] button',
    );
    const llamaCpp = container.querySelector<HTMLButtonElement>(
      '[data-prepare-choice="llama-cpp"] button',
    );
    expect(ollama?.textContent).toContain("Choose connection");
    expect(llamaCpp?.textContent).toContain("Set up model");
    expect(
      container.querySelector<HTMLButtonElement>('[data-prepare-choice="lmstudio"] button')
        ?.textContent,
    ).toContain("Connect server");
    const llamaCppRow = container.querySelector('[data-prepare-choice="llama-cpp"]');
    expect(llamaCppRow?.querySelector('[data-provider-icon="llamacpp"]')).not.toBeNull();
    expect(text(llamaCppRow!)).toContain("llama.cpp");
    expect(text(llamaCppRow!)).not.toContain("Gemma");
    expect(llamaCppRow?.classList.contains("model-setup__prepare-row--featured")).toBe(false);
    ollama?.click();
    expect(onStartPrepare).toHaveBeenCalledWith(expect.objectContaining({ id: "ollama" }));

    const withUsableOllama = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [
              ...detected.candidates,
              {
                kind: "provider-auto:ollama",
                label: "Ollama",
                detail: "available locally",
                modelRef: "ollama/qwen3:8b",
                recommended: false,
              },
            ],
          },
        },
      }),
    );
    expect(withUsableOllama.querySelector('[data-prepare-choice="ollama"]')).toBeNull();
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

  it("keeps setup context behind the success dialog and opens chat", () => {
    const onOpenChat = vi.fn();
    const container = mount(
      props({
        activation: { phase: "success", modelRef: "openai/gpt-5", latencyMs: 91 },
        onOpenChat,
      }),
    );
    expect(text(container)).toContain("Connection verified");
    expect(text(container)).toContain("Verified in 91 ms");
    expect(
      container.querySelector('.model-setup-success [data-provider-icon="codex"]'),
    ).not.toBeNull();
    expect(container.querySelector(".model-setup-success__status-badge")).not.toBeNull();
    container.querySelector<HTMLButtonElement>(".model-setup-success .primary")?.click();
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(container.querySelector(".settings-section")).not.toBeNull();
  });

  it("keeps the success shield for providers without a bundled mark", () => {
    const container = mount(
      props({
        activation: { phase: "success", modelRef: "custom-provider/model" },
      }),
    );
    const successIcon = container.querySelector(".model-setup-success__icon");
    expect(successIcon?.classList.contains("model-setup-success__icon--provider")).toBe(false);
    expect(successIcon?.querySelector(":scope > svg")).not.toBeNull();
    expect(successIcon?.querySelector(".model-setup-success__status-badge")).toBeNull();
  });

  it("continues first-run setup after the model is ready", () => {
    const container = mount(
      props({
        activation: { phase: "success", modelRef: "openai/gpt-5" },
        firstRun: true,
      }),
    );
    expect(text(container)).toContain("Continue setup");
    expect(text(container)).not.toContain("Open Chat");
  });

  it("renders the selected model and verifies it", () => {
    const onVerify = vi.fn();
    const container = mount(
      props({
        page: { phase: "ready", result: { ...detected, configuredModel: "openai/gpt-5" } },
        onVerify,
      }),
    );
    const current = container.querySelector(".model-setup__current");
    expect(container.querySelector(".settings-section")).toBe(current);
    expect(text(current!)).toContain("Selected model OpenAI gpt-5 · Signed in locally");
    expect(text(current!)).toContain("Signed in locally");
    expect(text(current!)).toContain("Check model");
    expect(current?.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    current?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onVerify).toHaveBeenCalledOnce();
  });

  it("does not repeat the current route among detected candidates", () => {
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            configuredModel: "openai/gpt-5.6-sol",
            setupComplete: true,
            candidates: [
              {
                kind: "existing-model",
                brandId: "openai",
                label: "Current model",
                detail: "openai/gpt-5.6-sol — already configured",
                modelRef: "openai/gpt-5.6-sol",
                recommended: false,
                credentials: true,
              },
              {
                kind: "claude-cli",
                brandId: "claude",
                label: "Claude Code",
                detail: "logged in",
                modelRef: "claude-cli/claude-opus-5",
                recommended: false,
                credentials: true,
              },
            ],
          },
        },
      }),
    );

    expect(container.querySelector('[data-candidate-kind="existing-model"]')).toBeNull();
    expect(container.querySelector('[data-candidate-kind="claude-cli"]')).not.toBeNull();
    expect(text(container)).toContain("Selected model OpenAI gpt-5.6-sol");
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
    expect(text(container)).toContain("Ready · 1234 ms");
    const current = container.querySelector(".model-setup__current");
    expect(current?.textContent).toContain("Anthropic");
    expect(current?.textContent).toContain("claude-opus-4-8");
    expect(current?.textContent).not.toContain("openai/gpt-5");
    expect(current?.querySelector('[data-provider-icon="claude"]')).not.toBeNull();
  });

  it("renders failed connection verification", () => {
    const container = mount(
      props({
        page: { phase: "ready", result: { ...detected, configuredModel: "openai/gpt-5" } },
        verify: { phase: "failed", status: "billing", error: "No credits" },
      }),
    );
    expect(text(container)).toContain(
      "Billing problem. No credits Restore provider billing or quota, then retry.",
    );
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
    expect(text(nonAdmin)).toContain("Selected model OpenAI gpt-5");
    expect(nonAdmin.querySelector(".model-setup__current button")).toBeNull();

    const unsupportedGateway = mount(props({ page: { phase: "ready", result }, canVerify: false }));
    expect(text(unsupportedGateway)).toContain("Selected model OpenAI gpt-5");
    expect(unsupportedGateway.querySelector(".model-setup__current button")).toBeNull();
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

  it.each([true, false])("reports device-code fallback success: %s", async (copied) => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    vi.stubGlobal("navigator", copied ? {} : { clipboard: { writeText } });
    const execCommand = vi.fn().mockImplementation(() => {
      expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("ABCD-EFGH");
      return copied;
    });
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
    const container = wizardStep({
      id: "device",
      type: "note",
      deviceCode: { code: "ABCD-EFGH" },
    });

    const copy = container.querySelector<HTMLButtonElement>(".wizard-step__device-code button");
    copy?.click();

    const feedback = copied ? "Copied!" : "Copy failed";
    await vi.waitFor(() => expect(copy?.textContent?.trim()).toBe(feedback));
    expect(copy?.getAttribute("aria-label")).toBeNull();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).toHaveBeenCalledTimes(copied ? 0 : 1);
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

    const prepareConfirm = wizardStep(
      { id: "confirm", type: "confirm", message: "Set up this model?" },
      undefined,
      "prepare",
    );
    expect(text(prepareConfirm)).toContain("Continue");
    expect(text(prepareConfirm)).not.toContain("Yes");
  });

  it.each(["multiselect", "action"] as const)("renders the %s wizard step", (type) => {
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

  it("renders gateway progress without an answer control", () => {
    const container = wizardStep({
      id: "download",
      type: "progress",
      message: "Downloading Gemma 4 E4B… 42%",
      executor: "gateway",
    });

    expect(text(container)).toContain("Downloading Gemma 4 E4B… 42%");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector(".wizard-step__spinner")).not.toBeNull();
    expect(container.querySelector(".wizard-step__progress button")).toBeNull();
  });

  it("keeps a Continue action for client progress", () => {
    const container = wizardStep({
      id: "client-progress",
      type: "progress",
      message: "Waiting for the local client",
      executor: "client",
    });

    expect(text(container)).toContain("Waiting for the local client");
    expect(text(container)).toContain("Continue");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
