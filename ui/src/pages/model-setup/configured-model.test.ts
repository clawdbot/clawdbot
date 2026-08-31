/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { renderConfiguredModel } from "./configured-model.ts";
import type { ModelSetupVerifyState } from "./state.ts";

function mount(
  result: SystemAgentSetupDetectResult,
  onContinue?: () => void,
  verify: ModelSetupVerifyState = {
    phase: "failed",
    status: "unavailable",
    error: "connect ECONNREFUSED",
  },
) {
  const container = document.createElement("div");
  document.body.append(container);
  const onVerify = vi.fn();
  render(
    renderConfiguredModel({
      result,
      verify,
      canVerify: true,
      actionsDisabled: false,
      onVerify,
      onContinue,
    }),
    container,
  );
  return { container, onVerify };
}

function text(container: Element): string {
  return container.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

describe("renderConfiguredModel", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });

  it.each([
    {
      brandId: "ollama",
      detail: "qwen3:8b at http://127.0.0.1:11434",
      kind: "provider-auto:ollama",
      label: "Ollama",
      modelRef: "ollama/qwen3:8b",
    },
    {
      brandId: "llama-cpp",
      detail: "Ready locally",
      kind: "provider-auto:llama-cpp",
      label: "llama.cpp",
      modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
    },
    {
      brandId: "lmstudio",
      detail: "qwen3-8b-instruct at http://localhost:1234/v1",
      kind: "provider-auto:lmstudio",
      label: "LM Studio",
      modelRef: "lmstudio/qwen3-8b-instruct",
    },
  ] as const)("shows a quiet recovery state for $brandId", (fixture) => {
    const result: SystemAgentSetupDetectResult = {
      candidates: [
        {
          kind: fixture.kind,
          brandId: fixture.brandId,
          label: fixture.label,
          detail: fixture.detail,
          modelRef: fixture.modelRef,
          recommended: false,
          credentials: true,
        },
      ],
      manualProviders: [],
      prepareOptions: [],
      workspace: "/tmp/workspace",
      configuredModel: fixture.modelRef,
      setupComplete: true,
    };
    const { container, onVerify } = mount(result);

    expect(text(container)).toContain(`Selected model ${fixture.label}`);
    expect(text(container)).toContain(fixture.detail);
    expect(text(container)).toContain("connect ECONNREFUSED");
    expect(text(container)).not.toContain("isn’t responding");
    expect(text(container)).not.toContain("Change connection");
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent?.trim()).toBe("Try again");

    button?.click();
    expect(onVerify).toHaveBeenCalledOnce();
  });

  it("renders the optional continuation action in the configured card", () => {
    const onContinue = vi.fn();
    const { container } = mount(
      {
        candidates: [],
        manualProviders: [],
        prepareOptions: [],
        workspace: "/tmp/workspace",
        configuredModel: "openai/gpt-5",
        setupComplete: true,
      },
      onContinue,
    );
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Continue setup",
    );
    button?.click();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("explains a setup timeout without claiming the provider is unreachable", () => {
    const result: SystemAgentSetupDetectResult = {
      candidates: [],
      manualProviders: [],
      prepareOptions: [],
      workspace: "/tmp/workspace",
      configuredModel: "ollama/gemma4:latest",
      setupComplete: true,
    };
    const { container } = mount(result, undefined, {
      phase: "failed",
      status: "timeout",
      error: "LLM request timed out.",
    });

    expect(text(container)).toContain("Timed out. LLM request timed out.");
    expect(text(container)).toContain(
      "The model did not finish the setup test in time. Warm it or choose a faster model, then retry.",
    );
    expect(text(container)).not.toContain("isn’t responding");
    expect(text(container)).not.toContain("service is running and reachable");
  });
});
