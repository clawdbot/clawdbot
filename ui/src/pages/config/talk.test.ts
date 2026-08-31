/* @vitest-environment jsdom */

import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import "./talk-page.ts";
import { isTalkGptLiveModel, resolveTalkRealtimeSelection } from "./talk-schema.ts";
import { renderTalk } from "./talk.ts";

type TalkSettingsPageTestElement = HTMLElement & {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  updateComplete: Promise<boolean>;
  changeModel: (model: string | null) => void;
  changeProvider: (providerId: string | null) => void;
};

type TalkMutationHarnessOptions = {
  activeProvider?: string | null;
  aliases?: string[];
  consultRouting?: string | null;
  defaultModel?: string;
  openAIProviderModel?: string;
  provider?: string | null;
  transport?: string | null;
  transports?: TalkCatalogResult["transports"];
  unavailable?: boolean;
};

function createTalkMutationHarness(options: TalkMutationHarnessOptions = {}) {
  const request = options.unavailable
    ? vi.fn(async () => {
        throw new Error("talk.catalog unavailable");
      })
    : vi.fn(async () => {
        return {
          modes: ["realtime"],
          transports: ["gateway-relay", "webrtc"],
          brains: ["agent-consult"],
          speech: { providers: [] },
          transcription: { providers: [] },
          realtime: {
            ready: true,
            activeProvider: options.activeProvider ?? "openai",
            providers: [
              {
                id: "openai",
                label: "OpenAI",
                configured: true,
                aliases: options.aliases ?? [],
                models: ["gpt-live-1-boulder-alpha"],
                voices: ["marin"],
                voicesByModel: { "gpt-live-1-codex": ["cove", "spruce"] },
                transports: options.transports ?? ["gateway-relay"],
                defaultModel: options.defaultModel ?? "gpt-live-1-boulder-alpha",
              },
              {
                id: "xai",
                label: "xAI",
                configured: true,
                aliases: [],
                models: ["grok-voice"],
                voices: ["ara"],
                transports: ["gateway-relay"],
                defaultModel: "grok-voice",
              },
            ],
          },
        } satisfies TalkCatalogResult;
      });
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  const configForm = {
    talk: {
      realtime: {
        provider: options.provider === undefined ? "openai" : options.provider,
        model: "gpt-realtime-2.1",
        transport: options.transport === undefined ? "gateway-relay" : options.transport,
        consultRouting: options.consultRouting,
        providers: options.openAIProviderModel
          ? { openai: { model: options.openAIProviderModel } }
          : undefined,
      },
    },
  };
  const runtimeConfig = {
    state: {
      configForm,
      configSnapshot: { hash: "hash" },
      configLoading: false,
      configSaving: false,
      configApplying: false,
    },
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    subscribe,
  };
  const context = {
    gateway: { snapshot, subscribe },
    runtimeConfig,
  } as unknown as ApplicationContext;
  const page = document.createElement("openclaw-talk-settings") as TalkSettingsPageTestElement;
  page.context = context;
  page.configObject = configForm;
  document.body.append(page);
  return { page, request, runtimeConfig };
}

async function selectModel(model: string, options: TalkMutationHarnessOptions = {}) {
  const harness = createTalkMutationHarness(options);
  await vi.waitFor(() => expect(harness.request).toHaveBeenCalledWith("talk.catalog", {}));
  await harness.page.updateComplete;
  harness.page.changeModel(model);
  expect(harness.runtimeConfig.patchForm).toHaveBeenCalledWith(
    ["talk", "realtime", "model"],
    model,
  );
  return harness.runtimeConfig.removeFormValue;
}

async function selectProvider(providerId: string, options: TalkMutationHarnessOptions = {}) {
  const harness = createTalkMutationHarness(options);
  await vi.waitFor(() => expect(harness.request).toHaveBeenCalledWith("talk.catalog", {}));
  await harness.page.updateComplete;
  harness.page.changeProvider(providerId);
  expect(harness.runtimeConfig.patchForm).toHaveBeenCalledWith(
    ["talk", "realtime", "provider"],
    providerId,
  );
  return harness.runtimeConfig.removeFormValue;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("isTalkGptLiveModel", () => {
  it.each(["gpt-live", "gpt-live-1-codex", " GPT-Live-1-Boulder-Alpha "])(
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
  it("locks every curated picker when config mutation is unavailable", () => {
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

  it.each([
    ["gpt-liveish", false],
    ["gpt-lively", false],
    ["gpt-live-1-codex", true],
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

describe("TalkSettingsPage realtime transport mutation", () => {
  it.each([
    ["gpt-live-1-codex", null, ["", "cove", "spruce"]],
    [null, null, ["", "cove", "spruce"]],
    ["gpt-realtime-2.1", null, ["", "marin"]],
    ["gpt-live-1-codex", "custom-voice", ["", "cove", "spruce", "custom-voice"]],
  ])("uses the draft model's voice catalog (%s, %s)", async (model, speakerVoice, expected) => {
    const { page, request } = createTalkMutationHarness({ defaultModel: "gpt-live-1-codex" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));
    await page.updateComplete;
    expect(
      [...page.querySelectorAll("select option")].map((option) => option.getAttribute("value")),
    ).toEqual(["", "marin"]);

    page.configObject = { talk: { realtime: { provider: "openai", model, speakerVoice } } };
    await page.updateComplete;

    expect(
      [...page.querySelectorAll("select option")].map((option) => option.getAttribute("value")),
    ).toEqual(expected);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("removes forced consult routing when OpenAI GPT-Live keeps gateway relay", async () => {
    const removeFormValue = await selectModel("gpt-live-1-boulder-alpha", {
      consultRouting: " Force-Agent-Consult ",
      transports: ["gateway-relay"],
    });

    expect(removeFormValue).toHaveBeenCalledTimes(1);
    expect(removeFormValue).toHaveBeenCalledWith(["talk", "realtime", "consultRouting"]);
    expect(removeFormValue).not.toHaveBeenCalledWith(["talk", "realtime", "transport"]);
  });

  it.each([
    [
      "provider-direct routing",
      "gpt-live-1-boulder-alpha",
      "provider-direct",
      "openai",
      "gateway-relay",
    ],
    ["another model", "gpt-realtime", "force-agent-consult", "openai", "gateway-relay"],
    ["another provider", "gpt-live-1-boulder-alpha", "force-agent-consult", "xai", "gateway-relay"],
    ["another transport", "gpt-live-1-boulder-alpha", "force-agent-consult", "openai", "webrtc"],
  ] as const)(
    "preserves consult routing for %s",
    async (_label, model, consultRouting, provider, transport) => {
      const removeFormValue = await selectModel(model, {
        consultRouting,
        provider,
        transport,
        transports: ["gateway-relay", "webrtc"],
      });

      expect(removeFormValue).not.toHaveBeenCalledWith(["talk", "realtime", "consultRouting"]);
    },
  );

  it("preserves transport when switching to a provider that advertises it", async () => {
    const removeFormValue = await selectProvider("openai", {
      provider: "xai",
      transports: ["gateway-relay", "webrtc"],
    });

    expect(removeFormValue).not.toHaveBeenCalledWith(["talk", "realtime", "transport"]);
  });

  it("removes provider websocket when switching to a GPT-Live provider", async () => {
    const removeFormValue = await selectProvider("openai", {
      provider: "xai",
      transport: "provider-websocket",
      transports: ["provider-websocket", "webrtc"],
    });

    expect(removeFormValue).toHaveBeenCalledWith(["talk", "realtime", "transport"]);
  });

  it.each([
    ["catalog default", "gpt-live-1-boulder-alpha", undefined],
    ["provider fallback", "gpt-realtime-2.1", "gpt-live-1-boulder-alpha"],
  ])(
    "removes forced consult when a provider switch activates a GPT-Live %s",
    async (_label, defaultModel, openAIProviderModel) => {
      const removeFormValue = await selectProvider("openai", {
        consultRouting: "force-agent-consult",
        defaultModel,
        openAIProviderModel,
        provider: "xai",
        transports: ["gateway-relay", "webrtc"],
      });

      expect(removeFormValue).toHaveBeenCalledWith(["talk", "realtime", "consultRouting"]);
      expect(removeFormValue).not.toHaveBeenCalledWith(["talk", "realtime", "transport"]);
    },
  );

  it("removes transport when switching to a provider that positively rejects it", async () => {
    const removeFormValue = await selectProvider("openai", {
      provider: "xai",
      transports: ["webrtc"],
    });

    expect(removeFormValue).toHaveBeenCalledWith(["talk", "realtime", "transport"]);
  });

  it("preserves transport when the catalog is unavailable", async () => {
    expect(
      await selectModel("gpt-live-1-boulder-alpha", { unavailable: true }),
    ).not.toHaveBeenCalled();
  });

  it("preserves transport when the provider advertises no transport capabilities", async () => {
    expect(
      await selectModel("gpt-live-1-boulder-alpha", { transports: [] }),
    ).not.toHaveBeenCalled();
  });

  it("removes provider websocket from a selected GPT-Live model", async () => {
    expect(
      await selectModel("gpt-live-1-boulder-alpha", {
        transport: "provider-websocket",
        transports: ["provider-websocket", "webrtc"],
      }),
    ).toHaveBeenCalledWith(["talk", "realtime", "transport"]);
  });

  it("preserves a transport advertised by the explicit provider", async () => {
    expect(
      await selectModel("gpt-live-1-boulder-alpha", { transports: ["gateway-relay"] }),
    ).not.toHaveBeenCalled();
  });

  it("resolves an explicit provider alias before preserving transport", async () => {
    expect(
      await selectModel("gpt-live-1-boulder-alpha", {
        aliases: ["openai-preview"],
        provider: "openai-preview",
        transports: ["gateway-relay"],
      }),
    ).not.toHaveBeenCalled();
  });

  it("uses the auto-selected provider before preserving transport", async () => {
    expect(
      await selectModel("gpt-live-1-boulder-alpha", {
        activeProvider: "openai",
        provider: null,
        transports: ["gateway-relay"],
      }),
    ).not.toHaveBeenCalled();
  });

  it("removes transport only when the resolved provider positively excludes it", async () => {
    expect(
      await selectModel("gpt-live-1-boulder-alpha", { transports: ["webrtc"] }),
    ).toHaveBeenCalledOnce();
  });

  it.each(["gpt-liveish", "gpt-lively"])(
    "preserves transport for GPT-Live lookalikes: %s",
    async (model) => {
      expect(await selectModel(model, { transports: ["webrtc"] })).not.toHaveBeenCalled();
    },
  );
});
