/* @vitest-environment jsdom */

import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { t } from "../../i18n/index.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import "./talk-page.ts";

const ACTIVE_VOICES = ["", "cove", "spruce", "custom-voice"];
const DEFAULT_VOICES = ["", "marin", "custom-voice"];

type TalkPageElement = HTMLElement & {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  updateComplete: Promise<boolean>;
  changeModel: (model: string | null) => void;
  changeProvider: (providerId: string | null) => void;
};

type TalkMutationHarnessOptions = {
  nativeDeviceSettings?: NativeDeviceSettingsCapability;
  voiceWakeRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ triggers: string[] }>;
  catalogRequest?: (
    requestIndex: number,
    catalog: TalkCatalogResult,
  ) => Promise<TalkCatalogResult> | TalkCatalogResult;
  configSnapshot?: { hash?: string | null; configRevisionHash?: string | null };
  activeProvider?: string | null;
  activeVoiceSelectionPolicy?: "allowlist-default";
  aliases?: string[];
  consultRouting?: string | null;
  defaultModel?: string;
  model?: string | null;
  openAIProviderModel?: string;
  provider?: string | null;
  transport?: string | null;
  transports?: TalkCatalogResult["transports"];
  unavailable?: boolean;
  voicesByModel?: Record<string, string[]>;
};

function createTalkMutationHarness(options: TalkMutationHarnessOptions = {}) {
  const catalog = {
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
          models: [options.defaultModel ?? "gpt-live-test-canary"],
          voices: ["marin"],
          activeVoices: ["cove", "spruce"],
          activeVoiceSelectionPolicy: options.activeVoiceSelectionPolicy,
          voicesByModel: options.voicesByModel,
          transports: options.transports ?? ["gateway-relay"],
          defaultModel: options.defaultModel ?? "gpt-live-test-canary",
        },
        {
          id: "xai",
          label: "xAI",
          configured: true,
          aliases: [],
          models: ["grok-voice"],
          voices: ["ara"],
          activeVoices: ["xai-active"],
          transports: ["gateway-relay"],
          defaultModel: "grok-voice",
        },
      ],
    },
  } satisfies TalkCatalogResult;
  let catalogRequestIndex = 0;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method.startsWith("voicewake.") && options.voiceWakeRequest) {
      return options.voiceWakeRequest(method, params);
    }
    if (options.unavailable) {
      throw new Error("talk.catalog unavailable");
    }
    catalogRequestIndex += 1;
    return await (options.catalogRequest?.(catalogRequestIndex, catalog) ?? catalog);
  });
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: options.voiceWakeRequest
      ? {
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes: ["operator.admin"] },
          features: { methods: ["voicewake.get", "voicewake.set"] },
        }
      : null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gatewayListeners = new Set<() => void>();
  const gatewayConnection = { gatewayUrl: "wss://gateway.example.test" };
  const hello = snapshot.hello;
  const configForm = {
    talk: {
      realtime: {
        provider: options.provider === undefined ? "openai" : options.provider,
        ...(options.model === null
          ? {}
          : { model: options.model === undefined ? "gpt-realtime-2.1" : options.model }),
        transport: options.transport === undefined ? "gateway-relay" : options.transport,
        consultRouting: options.consultRouting,
        providers: options.openAIProviderModel
          ? { openai: { model: options.openAIProviderModel } }
          : undefined,
      },
    },
  };
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configForm,
      configSnapshot: options.configSnapshot ?? { hash: "hash" },
      configLoading: false,
      configSaving: false,
      configApplying: false,
    },
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  const context = {
    nativeDeviceSettings: options.nativeDeviceSettings ?? null,
    gateway: {
      snapshot,
      connection: gatewayConnection,
      subscribe: (listener: () => void) => {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
    },
    runtimeConfig,
  } as unknown as ApplicationContext;
  const page = document.createElement("openclaw-talk-settings") as TalkPageElement;
  page.context = context;
  page.configObject = configForm;
  document.body.append(page);
  return {
    page,
    request,
    runtimeConfig,
    setConfigHash: (hash: string | null) => {
      runtimeConfig.state.configSnapshot.hash = hash;
      runtimeConfigListeners.forEach((notify) => notify());
    },
    setGatewayConnection: (connected: boolean, gatewayUrl = gatewayConnection.gatewayUrl) => {
      gatewayConnection.gatewayUrl = gatewayUrl;
      snapshot.phase = connected ? "connected" : "reconnecting";
      snapshot.hello = connected ? hello : null;
      gatewayListeners.forEach((notify) => notify());
    },
  };
}

function readVoiceOptions(page: HTMLElement): string[] {
  return [...page.querySelectorAll("select option")].map(
    (option) => option.getAttribute("value") ?? "",
  );
}

function setTalkRealtimeConfig(page: TalkPageElement, realtime: Record<string, unknown>) {
  page.configObject = { talk: { realtime } };
}

function expectVoiceState(page: TalkPageElement, options: string[], unsupported: boolean) {
  expect(readVoiceOptions(page)).toEqual(options);
  expect(page.textContent?.includes(t("talkPage.voice.unsupportedDefault"))).toBe(unsupported);
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
  vi.useRealTimers();
});

describe("Talk device and voice wake settings", () => {
  it.each([false, true])(
    "renders only published iOS voice controls and routes edits to native owners (minimal: %s)",
    async (minimal) => {
      const snapshot = createIosNativeDeviceSettingsSnapshot();
      if (minimal) {
        snapshot.voice = { supported: true, wakeEnabled: false };
      }
      const nativeDeviceSettings = {
        snapshot,
        subscribe: () => () => undefined,
        set: vi.fn(),
        requestPermission: vi.fn(),
        openSystemSettings: vi.fn(),
        openPanel: vi.fn(),
        checkForUpdates: vi.fn(),
        installChromeExtension: vi.fn(),
        refresh: vi.fn(),
        dispose: vi.fn(),
      } satisfies NativeDeviceSettingsCapability;
      const { page, request } = createTalkMutationHarness({ nativeDeviceSettings });
      await vi.waitFor(() => expect(request).toHaveBeenCalled());
      await page.updateComplete;
      const section = [...page.querySelectorAll<HTMLElement>(".settings-section")].find(
        (element) =>
          element.querySelector(".settings-section__heading")?.textContent?.trim() ===
          "This iPhone",
      )!;
      expect(section).toBeDefined();
      const rows = [...section.querySelectorAll<HTMLElement>(".settings-row")];
      const controls = minimal
        ? ([["Voice Wake", "voice.wakeEnabled"]] as const)
        : ([
            ["Voice Wake", "voice.wakeEnabled"],
            ["Talk mode", "voice.talkEnabled"],
            ["Show Talk button", "voice.talkButtonEnabled"],
            ["Talk in the background", "voice.talkBackgroundEnabled"],
            ["Use speakerphone", "voice.speakerphoneEnabled"],
          ] as const);
      expect(
        rows.map((row) => row.querySelector(".settings-row__title")?.textContent?.trim()),
      ).toEqual(controls.map(([title]) => title));
      for (const [index, [, key]] of controls.entries()) {
        const row = rows[index];
        if (!row) {
          throw new Error(`Missing device voice control: ${key}`);
        }
        const toggle = row.querySelector<HTMLElement & { checked: boolean }>("wa-switch")!;
        const next = !toggle.checked;
        row.click();
        expect(nativeDeviceSettings.set).toHaveBeenLastCalledWith(key, next);
      }
      expect(nativeDeviceSettings.set).toHaveBeenCalledTimes(controls.length);
      expect(section.querySelector("select, button")).toBeNull();
    },
  );

  it("keeps device controls out of browsers while saving Gateway trigger words after a debounce", async () => {
    const voiceWakeRequest = vi.fn(async (method: string) => ({
      triggers: method === "voicewake.get" ? ["openclaw"] : ["hello computer"],
    }));
    const { page } = createTalkMutationHarness({ voiceWakeRequest });
    await vi.waitFor(() => expect(page.querySelector("textarea")?.value).toBe("openclaw"));
    expect(page.textContent).not.toContain("This Mac");
    vi.useFakeTimers();
    const input = page.querySelector("textarea")!;
    input.value = " hello computer \n";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(399);
    expect(voiceWakeRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await page.updateComplete;
    expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", {
      triggers: [" hello computer ", ""],
    });
    expect(input.value).toBe("hello computer");
  });

  it("retains rejected trigger edits and gives a visible retry action", async () => {
    const voiceWakeRequest = vi.fn(async (method: string) => {
      if (method === "voicewake.set") {
        throw new Error("Permission denied");
      }
      return { triggers: ["openclaw"] };
    });
    const { page } = createTalkMutationHarness({ voiceWakeRequest });
    await vi.waitFor(() => expect(page.querySelector("textarea")?.value).toBe("openclaw"));
    vi.useFakeTimers();
    const input = page.querySelector("textarea")!;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    await page.updateComplete;
    expect(page.querySelector("[role='alert']")?.textContent).toContain("Permission denied");
    expect(input.value).toBe("hello");
    expect(input.disabled).toBe(false);
    page.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
    expect(voiceWakeRequest).toHaveBeenCalledTimes(3);
  });

  it("keeps trigger typing focused while serializing saves and ignoring older acknowledgments", async () => {
    const first = createDeferred<{ triggers: string[] }>();
    const second = createDeferred<{ triggers: string[] }>();
    let writes = 0;
    const voiceWakeRequest = vi.fn(async (method: string) => {
      if (method === "voicewake.get") {
        return { triggers: ["openclaw"] };
      }
      writes += 1;
      return writes === 1 ? first.promise : second.promise;
    });
    const { page } = createTalkMutationHarness({ voiceWakeRequest });
    await vi.waitFor(() => expect(page.querySelector("textarea")?.value).toBe("openclaw"));
    vi.useFakeTimers();
    const input = page.querySelector("textarea")!;
    input.focus();
    input.value = "first phrase";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    await page.updateComplete;
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    input.value = "second phrase";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toBe(1);
    first.resolve({ triggers: ["first phrase"] });
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(input.value).toBe("second phrase");
    expect(document.activeElement).toBe(input);
    expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", {
      triggers: ["second phrase"],
    });
    second.resolve({ triggers: ["second phrase"] });
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(input.value).toBe("second phrase");
    expect(page.querySelector("[role='status']")?.textContent).toBe("Saved");
  });

  it("saves the last trigger edit when navigating away inside the debounce window", async () => {
    const voiceWakeRequest = vi.fn(async () => ({ triggers: ["openclaw"] }));
    const { page } = createTalkMutationHarness({ voiceWakeRequest });
    await vi.waitFor(() => expect(page.querySelector("textarea")?.value).toBe("openclaw"));
    vi.useFakeTimers();
    const input = page.querySelector("textarea")!;
    input.value = "computer";
    input.dispatchEvent(new Event("input"));
    page.remove();
    expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", { triggers: ["computer"] });
    await vi.advanceTimersByTimeAsync(400);
    expect(voiceWakeRequest).toHaveBeenCalledTimes(2);
  });

  it.each(["latest phrase", "first phrase"])(
    "flushes the latest queued trigger draft on navigation: %s",
    async (latest) => {
      const first = createDeferred<{ triggers: string[] }>();
      let writes = 0;
      const voiceWakeRequest = vi.fn(async (method: string) => {
        if (method === "voicewake.get") {
          return { triggers: ["openclaw"] };
        }
        writes += 1;
        return writes === 1 ? first.promise : { triggers: [latest] };
      });
      const { page } = createTalkMutationHarness({ voiceWakeRequest });
      await vi.waitFor(() => expect(page.querySelector("textarea")?.value).toBe("openclaw"));
      vi.useFakeTimers();
      const input = page.querySelector("textarea")!;
      for (const text of ["first phrase", "intermediate phrase"]) {
        input.value = text;
        input.dispatchEvent(new Event("input"));
        await vi.advanceTimersByTimeAsync(400);
      }
      expect(writes).toBe(1);
      input.value = latest;
      input.dispatchEvent(new Event("input"));
      page.remove();
      first.resolve({ triggers: ["first phrase"] });
      await vi.advanceTimersByTimeAsync(400);
      expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", { triggers: [latest] });
      expect(writes).toBe(latest === "first phrase" ? 1 : 2);
    },
  );

  it.each(["debounce", "in-flight"])(
    "preserves the unsaved trigger draft across a same-Gateway %s disconnect",
    async (timing) => {
      const interrupted = createDeferred<{ triggers: string[] }>();
      let writes = 0;
      const voiceWakeRequest = vi.fn(async (method: string) => {
        if (method === "voicewake.get") {
          return { triggers: ["openclaw"] };
        }
        writes += 1;
        return timing === "in-flight" && writes === 1
          ? interrupted.promise
          : { triggers: ["hello computer"] };
      });
      const { page, setGatewayConnection } = createTalkMutationHarness({ voiceWakeRequest });
      await vi.waitFor(() => expect(page.querySelector("textarea")?.value).toBe("openclaw"));
      vi.useFakeTimers();
      const input = page.querySelector("textarea")!;
      input.value = "hello computer";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(timing === "in-flight" ? 400 : 100);
      setGatewayConnection(false);
      if (timing === "in-flight") {
        interrupted.reject(new Error("Connection closed"));
      }
      await page.updateComplete;
      expect(page.querySelector("textarea")?.value).toBe("hello computer");
      expect(page.querySelector("[role='alert']")?.textContent).toContain("Reconnect");
      await vi.advanceTimersByTimeAsync(400);
      const priorCalls = voiceWakeRequest.mock.calls.length;
      page.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
      expect(voiceWakeRequest).toHaveBeenCalledTimes(priorCalls);
      setGatewayConnection(true);
      await page.updateComplete;
      expect(page.querySelector("textarea")?.value).toBe("hello computer");
      page.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", {
        triggers: ["hello computer"],
      });
      expect(page.querySelector("[role='alert']")).toBeNull();
      expect(page.querySelector("textarea")?.value).toBe("hello computer");
    },
  );

  it("does not carry an unsaved trigger draft into another Gateway", async () => {
    let gatewayWords = ["openclaw"];
    const voiceWakeRequest = vi.fn(async () => ({ triggers: gatewayWords }));
    const { page, setGatewayConnection } = createTalkMutationHarness({ voiceWakeRequest });
    await vi.waitFor(() => expect(page.querySelector("textarea")?.value).toBe("openclaw"));
    vi.useFakeTimers();
    const input = page.querySelector("textarea")!;
    input.value = "old gateway words";
    input.dispatchEvent(new Event("input"));
    setGatewayConnection(false);
    gatewayWords = ["new gateway words"];
    setGatewayConnection(true, "wss://other-gateway.example.test");
    await vi.advanceTimersByTimeAsync(400);
    await page.updateComplete;
    expect(page.querySelector("textarea")?.value).toBe("new gateway words");
    expect(voiceWakeRequest.mock.calls).toEqual([
      ["voicewake.get", {}],
      ["voicewake.get", {}],
    ]);
  });

  it.each([false, true])(
    "restores an offline trigger draft after reopening Talk only for its Gateway (switch: %s)",
    async (switchGateway) => {
      let gatewayWords = ["openclaw"];
      const voiceWakeRequest = vi.fn(async (method: string) => ({
        triggers: method === "voicewake.get" ? gatewayWords : ["retained phrase"],
      }));
      const { page, setGatewayConnection } = createTalkMutationHarness({ voiceWakeRequest });
      await vi.waitFor(() => expect(page.querySelector("textarea")?.value).toBe("openclaw"));
      vi.useFakeTimers();
      const input = page.querySelector("textarea")!;
      input.value = "initial phrase";
      input.dispatchEvent(new Event("input"));
      setGatewayConnection(false);
      await page.updateComplete;
      input.value = "retained phrase";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(400);
      page.remove();
      gatewayWords = ["other gateway phrase"];
      setGatewayConnection(true, switchGateway ? "wss://other-gateway.example.test" : undefined);
      const reopened = document.createElement("openclaw-talk-settings") as TalkPageElement;
      reopened.context = page.context;
      reopened.configObject = page.configObject;
      document.body.append(reopened);
      await vi.advanceTimersByTimeAsync(0);
      await reopened.updateComplete;
      expect(reopened.querySelector("textarea")?.value).toBe(
        switchGateway ? "other gateway phrase" : "retained phrase",
      );
      if (switchGateway) {
        expect(reopened.querySelector("[role='alert']")).toBeNull();
        expect(voiceWakeRequest).toHaveBeenCalledTimes(2);
      } else {
        expect(reopened.querySelector("[role='alert']")?.textContent).toContain("not been saved");
        reopened.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
        await vi.advanceTimersByTimeAsync(0);
        await reopened.updateComplete;
        expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", {
          triggers: ["retained phrase"],
        });
        expect(reopened.querySelector("[role='alert']")).toBeNull();
      }
    },
  );

  it("routes device voice changes to native owners and excludes the primary language from additions", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.voice.supported = false;
    snapshot.voice.locale.additional = ["de-DE"];
    const listeners = new Set<() => void>();
    const nativeDeviceSettings = {
      snapshot,
      subscribe: (listener) => {
        const notify = () => listener(snapshot);
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
      set: vi.fn(),
      requestPermission: vi.fn(),
      openSystemSettings: vi.fn(),
      openPanel: vi.fn(),
      checkForUpdates: vi.fn(),
      installChromeExtension: vi.fn(),
      refresh: vi.fn(),
      dispose: vi.fn(),
    } satisfies NativeDeviceSettingsCapability;
    const { page, request } = createTalkMutationHarness({ nativeDeviceSettings });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    await page.updateComplete;
    const publishSnapshot = async () => {
      for (const notify of listeners) {
        notify();
      }
      await page.updateComplete;
    };
    const rows = [...page.querySelectorAll<HTMLElement>(".settings-row")];
    const row = (title: string) =>
      rows.find(
        (element) => element.querySelector(".settings-row__title")?.textContent?.trim() === title,
      )!;
    expect(page.textContent).toContain("This Mac");
    expect(row("Voice Wake").querySelector("wa-switch")?.hasAttribute("disabled")).toBe(true);
    expect(row("Voice Wake").textContent).toContain("macOS 26");
    row("Hold Right Option to talk").click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("voice.pushToTalkEnabled", false);
    const microphone = row("Microphone").querySelector("select")!;
    microphone.value = "builtin";
    microphone.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("voice.microphone", "builtin");
    expect(
      [...row("Additional languages").querySelectorAll("option")].map((option) => option.value),
    ).toEqual([""]);
    const primary = row("Primary language").querySelector("select")!;
    primary.value = "de-DE";
    primary.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("voice.locale.additional", []);
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("voice.locale.primary", "de-DE");
    row("Test microphone…").querySelector("button")?.click();
    expect(nativeDeviceSettings.openPanel).toHaveBeenCalledWith("microphone-test");
    snapshot.voice.wakeEnabled = true;
    await publishSnapshot();
    expect(row("Voice Wake").querySelector("wa-switch")?.hasAttribute("disabled")).toBe(false);
    row("Voice Wake").click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("voice.wakeEnabled", false);
    snapshot.voice.wakeEnabled = false;
    await publishSnapshot();
    expect(row("Voice Wake").querySelector("wa-switch")?.hasAttribute("disabled")).toBe(true);
    snapshot.voice.supported = true;
    await publishSnapshot();
    expect(row("Voice Wake").querySelector("wa-switch")?.hasAttribute("disabled")).toBe(false);
  });

  it("preserves pending language additions across an older native acknowledgment and the next edit", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.voice.locale.available.push(
      { id: "fr-FR", name: "French" },
      { id: "es-ES", name: "Spanish" },
      { id: "it-IT", name: "Italian" },
    );
    const listeners = new Set<() => void>();
    const nativeDeviceSettings = {
      snapshot,
      subscribe: (listener) => {
        const notify = () => listener(snapshot);
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
      set: vi.fn(),
      requestPermission: vi.fn(),
      openSystemSettings: vi.fn(),
      openPanel: vi.fn(),
      checkForUpdates: vi.fn(),
      installChromeExtension: vi.fn(),
      refresh: vi.fn(),
      dispose: vi.fn(),
    } satisfies NativeDeviceSettingsCapability;
    const { page } = createTalkMutationHarness({ nativeDeviceSettings });
    await page.updateComplete;
    const add = (id: string) => {
      const select = page.querySelector<HTMLSelectElement>('select[aria-label="Add language…"]')!;
      select.value = id;
      select.dispatchEvent(new Event("change"));
    };
    add("de-DE");
    add("fr-FR");
    expect(nativeDeviceSettings.set).toHaveBeenLastCalledWith("voice.locale.additional", [
      "de-DE",
      "fr-FR",
    ]);
    snapshot.voice.locale.additional = ["de-DE"];
    for (const notify of listeners) {
      notify();
    }
    await page.updateComplete;
    add("es-ES");
    expect(nativeDeviceSettings.set).toHaveBeenLastCalledWith("voice.locale.additional", [
      "de-DE",
      "fr-FR",
      "es-ES",
    ]);
    const primary = page.querySelector<HTMLSelectElement>('select[aria-label="Primary language"]')!;
    primary.value = "fr-FR";
    primary.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("voice.locale.additional", [
      "de-DE",
      "es-ES",
    ]);
    snapshot.voice.locale.additional = ["de-DE", "fr-FR"];
    for (const notify of listeners) {
      notify();
    }
    await page.updateComplete;
    expect(primary.value).toBe("fr-FR");
    add("it-IT");
    expect(nativeDeviceSettings.set).toHaveBeenLastCalledWith("voice.locale.additional", [
      "de-DE",
      "es-ES",
      "it-IT",
    ]);
  });
});

describe("TalkSettingsPage realtime transport mutation", () => {
  it.each([
    ["allowlist-default", true],
    [undefined, false],
  ] as const)(
    "marks absent saved voices unsupported only for authoritative catalogs: %s",
    async (activeVoiceSelectionPolicy, expectedWarning) => {
      const { page, request } = createTalkMutationHarness({
        activeVoiceSelectionPolicy,
        model: null,
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));
      setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
      await page.updateComplete;

      const savedOption = page.querySelector<HTMLOptionElement>('option[value="custom-voice"]');
      const text = page.textContent ?? "";
      expect(savedOption?.textContent?.includes(t("talkPage.voice.unsupported"))).toBe(
        expectedWarning,
      );
      expect(text.includes(t("talkPage.voice.unsupportedDefault"))).toBe(expectedWarning);
    },
  );

  it("acknowledges a model reset from the canonical config revision", async () => {
    const hashCatalog = createDeferred();
    const { page, request, runtimeConfig, setConfigHash } = createTalkMutationHarness({
      activeVoiceSelectionPolicy: "allowlist-default",
      configSnapshot: { hash: null, configRevisionHash: "revision-1" },
      defaultModel: "gpt-realtime-2.1",
      model: null,
      catalogRequest: (requestIndex, catalog) =>
        requestIndex === 3 ? hashCatalog.promise.then(() => catalog) : catalog,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    await page.updateComplete.then(() => expectVoiceState(page, ACTIVE_VOICES, true));

    setTalkRealtimeConfig(page, {
      provider: "openai",
      model: "gpt-realtime-2.1",
      speakerVoice: "custom-voice",
    });
    await page.updateComplete.then(() => expectVoiceState(page, DEFAULT_VOICES, false));

    page.changeModel(null);
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    await page.updateComplete.then(() => expectVoiceState(page, DEFAULT_VOICES, false));

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete.then(() => expectVoiceState(page, DEFAULT_VOICES, false));

    Object.assign(runtimeConfig.state.configSnapshot, { configRevisionHash: "revision-2" });
    setConfigHash(null);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expectVoiceState(page, ACTIVE_VOICES, true));
    hashCatalog.resolve();
    await request.mock.results[2]?.value;
    expectVoiceState(page, ACTIVE_VOICES, true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("retains a reset without revisions across stale reads, then clears it on reconnect", async () => {
    const [staleCatalog, failedCatalog] = [createDeferred(), createDeferred()];
    const { page, request, setConfigHash, setGatewayConnection } = createTalkMutationHarness({
      activeVoiceSelectionPolicy: "allowlist-default",
      configSnapshot: { hash: null, configRevisionHash: null },
      defaultModel: "gpt-realtime-2.1",
      model: null,
      catalogRequest: (requestIndex, catalog) =>
        requestIndex === 3
          ? staleCatalog.promise.then(() => catalog)
          : requestIndex === 4
            ? failedCatalog.promise.then(() => expect.fail("catalog refresh failed"))
            : catalog,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    page.changeModel(null);
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    await page.updateComplete;

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expectVoiceState(page, DEFAULT_VOICES, false);
    setConfigHash("hash-2");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    staleCatalog.resolve();
    await page.updateComplete.then(() => expectVoiceState(page, DEFAULT_VOICES, false));

    setGatewayConnection(false);
    setConfigHash("hash-3");
    expectVoiceState(page, DEFAULT_VOICES, false);
    failedCatalog.resolve();
    setGatewayConnection(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expectVoiceState(page, ACTIVE_VOICES, true));
  });

  it("clears model reset intent on explicit model, provider, and Gateway changes", async () => {
    const { page, request, setGatewayConnection } = createTalkMutationHarness({
      defaultModel: "gpt-realtime-2.1",
      model: null,
      voicesByModel: {
        "gpt-realtime-2.1": ["marin"],
        "gpt-realtime-alt": ["verse"],
      },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    page.changeModel(null);
    page.changeModel("gpt-realtime-alt");
    setTalkRealtimeConfig(page, { provider: "openai", model: "gpt-realtime-alt" });
    await page.updateComplete;
    expect(readVoiceOptions(page)).toEqual(["", "verse"]);

    page.changeModel(null);
    page.changeProvider("xai");
    setTalkRealtimeConfig(page, { provider: "xai" });
    await page.updateComplete;
    expect(readVoiceOptions(page)).toEqual(["", "xai-active"]);

    page.changeModel(null);
    await page.updateComplete;
    expect(readVoiceOptions(page)).toEqual(["", "ara"]);
    setGatewayConnection(true, "wss://replacement.example.test");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(readVoiceOptions(page)).toEqual(["", "xai-active"]));
  });

  it("removes forced consult routing when OpenAI GPT-Live keeps gateway relay", async () => {
    const removeFormValue = await selectModel("gpt-live-test-canary", {
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
      "gpt-live-test-canary",
      "provider-direct",
      "openai",
      "gateway-relay",
    ],
    ["another model", "gpt-realtime", "force-agent-consult", "openai", "gateway-relay"],
    ["another provider", "gpt-live-test-canary", "force-agent-consult", "xai", "gateway-relay"],
    ["another transport", "gpt-live-test-canary", "force-agent-consult", "openai", "webrtc"],
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
    ["catalog default", "gpt-live-test-canary", undefined],
    ["provider fallback", "gpt-realtime-2.1", "gpt-live-test-canary"],
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
    expect(await selectModel("gpt-live-test-canary", { unavailable: true })).not.toHaveBeenCalled();
  });

  it("preserves transport when the provider advertises no transport capabilities", async () => {
    expect(await selectModel("gpt-live-test-canary", { transports: [] })).not.toHaveBeenCalled();
  });

  it("removes provider websocket from a selected GPT-Live model", async () => {
    expect(
      await selectModel("gpt-live-test-canary", {
        transport: "provider-websocket",
        transports: ["provider-websocket", "webrtc"],
      }),
    ).toHaveBeenCalledWith(["talk", "realtime", "transport"]);
  });

  it("preserves a transport advertised by the explicit provider", async () => {
    expect(
      await selectModel("gpt-live-test-canary", { transports: ["gateway-relay"] }),
    ).not.toHaveBeenCalled();
  });

  it("resolves an explicit provider alias before preserving transport", async () => {
    expect(
      await selectModel("gpt-live-test-canary", {
        aliases: ["openai-preview"],
        provider: "openai-preview",
        transports: ["gateway-relay"],
      }),
    ).not.toHaveBeenCalled();
  });

  it("uses the auto-selected provider before preserving transport", async () => {
    expect(
      await selectModel("gpt-live-test-canary", {
        activeProvider: "openai",
        provider: null,
        transports: ["gateway-relay"],
      }),
    ).not.toHaveBeenCalled();
  });

  it("removes transport only when the resolved provider positively excludes it", async () => {
    expect(
      await selectModel("gpt-live-test-canary", { transports: ["webrtc"] }),
    ).toHaveBeenCalledOnce();
  });

  it.each(["gpt-liveish", "gpt-lively"])(
    "preserves transport for GPT-Live lookalikes: %s",
    async (model) => {
      expect(await selectModel(model, { transports: ["webrtc"] })).not.toHaveBeenCalled();
    },
  );
});
