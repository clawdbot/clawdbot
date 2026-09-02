import { render } from "lit";
import { vi } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../../api/types.ts";
import { renderModelSetup } from "../view.ts";

export type ModelSetupViewProps = Parameters<typeof renderModelSetup>[0];

export const detected: SystemAgentSetupDetectResult = {
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
      id: "pi-cli",
      label: "Pi",
      detail: "installed; no setup route available",
      reason: "This local runtime must be configured outside OpenClaw.",
    },
  ],
  manualProviders: [
    {
      id: "gemini-api-key",
      brandId: "google",
      groupLabel: "Google",
      label: "Google AI Studio API key",
      hint: "Supported API-key access from aistudio.google.com/apikey",
    },
    {
      id: "openai",
      brandId: "openai",
      groupLabel: "OpenAI",
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
  prepareOptions: [
    {
      id: "ollama",
      brandId: "ollama",
      label: "Ollama",
      hint: "Connect to an Ollama server and select a cloud or local model",
      actionLabel: "Choose connection",
      icon: "https://cdn.simpleicons.org/ollama",
      website: "https://ollama.com/download",
    },
    {
      id: "lmstudio",
      brandId: "lmstudio",
      label: "LM Studio",
      hint: "Connect to a running LM Studio server and use an already loaded model",
      actionLabel: "Connect server",
      icon: "https://cdn.simpleicons.org/lmstudio",
      website: "https://lmstudio.ai/download",
    },
    {
      id: "llama-cpp",
      brandId: "llama-cpp",
      label: "llama.cpp",
      hint: "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
      actionLabel: "Set up model",
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

export function props(overrides: Partial<ModelSetupViewProps> = {}): ModelSetupViewProps {
  return {
    page: { phase: "ready", result: detected },
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
    prepareMessage: null,
    actionsDisabled: false,
    manualProviderId: "openai",
    manualApiKey: "",
    manualError: null,
    moreSignInOpen: false,
    firstRun: false,
    embedded: false,
    iconUrls: {
      "https://cdn.example.com/codex.png": "blob:codex",
      "https://cdn.example.com/openai.png": "blob:openai",
      "https://cdn.simpleicons.org/ollama": "blob:ollama",
    },
    onDetect: vi.fn(),
    onVerify: vi.fn(),
    onActivateCandidate: vi.fn(),
    onStartAuth: vi.fn(),
    onStartPrepare: vi.fn(),
    onManualProviderChange: vi.fn(),
    onUseManualProvider: vi.fn(),
    onManualApiKeyChange: vi.fn(),
    onManualConnect: vi.fn(),
    onMoreSignInToggle: vi.fn(),
    onIconError: vi.fn(),
    onOpenChat: vi.fn(),
    onSuccessClose: vi.fn(),
    onWizardValueChange: vi.fn(),
    onWizardAnswer: vi.fn(),
    onWizardCancel: vi.fn(),
    onWizardClose: vi.fn(),
    ...overrides,
  };
}

export function mount(viewProps: ModelSetupViewProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderModelSetup(viewProps), container);
  return container;
}

export function text(container: Element): string {
  return container.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}
