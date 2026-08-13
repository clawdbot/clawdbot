/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderTalk } from "./talk.ts";

describe("renderTalk", () => {
  it("locks every curated picker when config mutation is unavailable", () => {
    const container = document.createElement("div");
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
              configured: true,
              aliases: [],
              models: ["gpt-live"],
              voices: ["marin"],
              transports: ["webrtc"],
              defaultModel: "gpt-live",
            },
          ],
        },
        configBusy: true,
        onProviderChange: vi.fn(),
        onModelChange: vi.fn(),
        onVoiceChange: vi.fn(),
        editor: html``,
      }),
      container,
    );

    const provider = container.querySelector<HTMLElement & { disabled?: boolean }>(
      "wa-radio-group",
    );
    expect(provider?.disabled).toBe(true);
    const voice = [...container.querySelectorAll<HTMLSelectElement>("select")];
    expect(voice).toHaveLength(1);
    expect(voice.every((select) => select.disabled)).toBe(true);
    expect(
      container.querySelector("wa-select.model-picker__select")?.hasAttribute("disabled"),
    ).toBe(true);
  });

  it("commits provider-local model ids without qualifying them", () => {
    const container = document.createElement("div");
    const onModelChange = vi.fn();
    render(
      renderTalk({
        selection: {
          provider: "openai",
          model: "gpt-live",
          speakerVoice: null,
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
              configured: true,
              aliases: [],
              models: ["gpt-live", "gpt-realtime"],
              voices: [],
              transports: ["webrtc"],
              defaultModel: "gpt-live",
            },
          ],
        },
        configBusy: false,
        onProviderChange: vi.fn(),
        onModelChange,
        onVoiceChange: vi.fn(),
        editor: html``,
      }),
      container,
    );

    const picker = container.querySelector<HTMLElement & { value: string }>(
      "wa-select.model-picker__select",
    );
    expect(picker?.querySelector('wa-option[value="gpt-realtime"]')).not.toBeNull();
    if (picker) {
      Object.defineProperty(picker, "value", { configurable: true, value: "gpt-realtime" });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      Reflect.deleteProperty(picker, "value");
    }
    expect(onModelChange).toHaveBeenCalledWith("gpt-realtime");
  });
});
