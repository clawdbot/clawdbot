/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { updatePickers, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { isTalkGptLiveModel, resolveTalkRealtimeSelection } from "./talk-schema.ts";
import { renderTalk } from "./talk.ts";

describe("isTalkGptLiveModel", () => {
  it.each(["gpt-live", "gpt-live-test-canary", " Gpt-Live-1-Codex "])(
    "accepts the GPT-Live family: %s",
    (model) => {
      expect(isTalkGptLiveModel(model)).toBe(true);
    },
  );

  it.each([null, "", "gpt-liveish", "gpt-lively", "gpt-realtime"])(
    "rejects GPT-Live lookalikes: %s",
    (model) => {
      expect(isTalkGptLiveModel(model)).toBe(false);
    },
  );
});

describe("resolveTalkRealtimeSelection", () => {
  it.each([
    [" force-agent-consult ", "force-agent-consult"],
    [" Provider-Direct ", "provider-direct"],
    [" ", null],
    [null, null],
  ])("normalizes consult routing: %s", (consultRouting, expected) => {
    expect(
      resolveTalkRealtimeSelection({
        talk: { realtime: { consultRouting } },
      }).consultRouting,
    ).toBe(expected);
  });
});

describe("renderTalk", () => {
  it("locks every curated picker when config mutation is unavailable", async () => {
    const container = document.createElement("div");
    render(
      renderTalk({
        selection: {
          provider: "openai",
          model: "gpt-live",
          speakerVoice: "marin",
          transport: "webrtc",
          consultRouting: null,
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
    await updatePickers(container);

    const provider = container.querySelector<HTMLElement & { disabled?: boolean }>(
      "wa-radio-group",
    );
    expect(provider?.disabled).toBe(true);
    const voice = [...container.querySelectorAll<HTMLSelectElement>("select")];
    expect(voice).toHaveLength(1);
    expect(voice.every((select) => select.disabled)).toBe(true);
    expect(
      container
        .querySelector("openclaw-select-picker.model-picker__select")
        ?.querySelector<HTMLButtonElement>("button")?.disabled,
    ).toBe(true);
  });

  it("commits provider-local model ids without qualifying them", async () => {
    const container = document.createElement("div");
    const onModelChange = vi.fn();
    render(
      renderTalk({
        selection: {
          provider: "openai",
          model: "gpt-live",
          speakerVoice: null,
          transport: "webrtc",
          consultRouting: null,
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
    await updatePickers(container);

    const picker = container.querySelector<SelectPicker>(
      "openclaw-select-picker.model-picker__select",
    );
    expect(picker?.querySelector('[role="option"][data-value="gpt-realtime"]')).not.toBeNull();
    if (picker) {
      await choosePickerValue(picker, "gpt-realtime");
    }
    expect(onModelChange).toHaveBeenCalledWith("gpt-realtime");
  });

  it("renders the released realtime route voice family from the catalog", () => {
    const container = document.createElement("div");
    const voices = [
      "arbor",
      "breeze",
      "cove",
      "ember",
      "juniper",
      "maple",
      "sol",
      "spruce",
      "vale",
    ];
    render(
      renderTalk({
        selection: {
          provider: "openai",
          model: "gpt-live-1-codex",
          speakerVoice: "spruce",
          transport: "webrtc",
          consultRouting: null,
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
              models: ["gpt-live-1-codex"],
              voices: [],
              voicesByModel: { "gpt-live-1-codex": voices },
              transports: ["webrtc"],
              defaultModel: "gpt-live-1-codex",
            },
          ],
        },
        configBusy: false,
        onProviderChange: vi.fn(),
        onModelChange: vi.fn(),
        onVoiceChange: vi.fn(),
        editor: html``,
      }),
      container,
    );

    expect(
      [...container.querySelectorAll("select option")].map(
        (option) => option.getAttribute("value") ?? "",
      ),
    ).toEqual(["", ...voices]);
  });

  it.each([
    ["gpt-liveish", false],
    ["gpt-lively", false],
    ["gpt-live-test-canary", true],
  ] as const)("renders the GPT-Live hint only for the exact family: %s", (model, showsHint) => {
    const container = document.createElement("div");
    render(
      renderTalk({
        selection: {
          provider: "openai",
          model,
          speakerVoice: null,
          transport: "gateway-relay",
          consultRouting: null,
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
              models: [model],
              voices: [],
              transports: ["gateway-relay"],
              defaultModel: model,
            },
          ],
        },
        configBusy: false,
        onProviderChange: vi.fn(),
        onModelChange: vi.fn(),
        onVoiceChange: vi.fn(),
        editor: html``,
      }),
      container,
    );

    expect(container.textContent?.includes(t("talkPage.gptLive.hint"))).toBe(showsHint);
  });
});
