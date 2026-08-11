/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderTalk } from "./talk.ts";

function renderOpenAiGptLiveTalk(
  container: HTMLElement,
  options: { configBusy?: boolean; configured?: boolean } = {},
) {
  render(
    renderTalk({
      selection: {
        provider: "openai",
        model: "gpt-live",
        speakerVoice: "marin",
        transport: "webrtc",
        providerEntries: {},
      },
      catalog: {
        kind: "ready",
        ready: true,
        activeProvider: "openai",
        providers: [
          {
            id: "openai",
            label: "OpenAI",
            configured: options.configured ?? true,
            aliases: [],
            models: ["gpt-live"],
            voices: ["marin"],
            transports: ["webrtc"],
            defaultModel: "gpt-live",
          },
        ],
      },
      configBusy: options.configBusy ?? false,
      onProviderChange: vi.fn(),
      onModelChange: vi.fn(),
      onVoiceChange: vi.fn(),
      editor: html``,
    }),
    container,
  );
}

describe("renderTalk", () => {
  it("locks every curated picker when config mutation is unavailable", () => {
    const container = document.createElement("div");
    renderOpenAiGptLiveTalk(container, { configBusy: true });

    const provider = container.querySelector<HTMLElement & { disabled?: boolean }>(
      "wa-radio-group",
    );
    expect(provider?.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLSelectElement>("select")]).toHaveLength(2);
    expect(
      [...container.querySelectorAll<HTMLSelectElement>("select")].every(
        (select) => select.disabled,
      ),
    ).toBe(true);
  });

  it("renders Platform API-key guidance for configured GPT-Live models", () => {
    const container = document.createElement("div");
    renderOpenAiGptLiveTalk(container, { configured: false });

    expect(container.textContent).toContain(
      "GPT-Live requires an enrolled OpenAI Platform API key with /v1/live access.",
    );
    expect(container.textContent).toContain("ChatGPT/Codex OAuth does not enable GPT-Live.");
    expect(container.textContent).not.toContain("No Platform API key needed");
  });
});
