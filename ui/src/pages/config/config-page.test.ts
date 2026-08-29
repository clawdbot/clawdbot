/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  changedServerUiPrefs,
  refreshProfileAppearancePrefs,
  resetServerUiPrefsSync,
} from "../../app/server-prefs.ts";
import { loadSettings } from "../../app/settings.ts";
import * as modelCatalogStore from "../../lib/model-catalog-store.ts";
import {
  installDialogPolyfill,
  nextFrame,
  waitForRenderedModalDialog,
} from "../../test-helpers/modal-dialog.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as realtimeTalk from "../chat/realtime-talk.ts";
import {
  ConfigPage,
  configSelectionFromSearch,
  extractQuickSettingsSecurity,
} from "./config-page.ts";
import { serverUiPrefProvenanceHint } from "./view-appearance-preferences.ts";
import type { ConfigViewState } from "./view.ts";

const switchActiveRealtimeTalkCameras =
  vi.fn<typeof realtimeTalk.switchActiveRealtimeTalkCameras>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let localStorageMock: Storage;

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.spyOn(realtimeTalk, "switchActiveRealtimeTalkCameras").mockImplementation(
    switchActiveRealtimeTalkCameras,
  );
  localStorageMock = createStorageMock();
  vi.stubGlobal("localStorage", localStorageMock);
  resetServerUiPrefsSync();
  switchActiveRealtimeTalkCameras.mockReset();
  switchActiveRealtimeTalkCameras.mockResolvedValue(undefined);
});

afterEach(() => {
  resetServerUiPrefsSync();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("configSelectionFromSearch", () => {
  it("opens a valid linked Settings section", () => {
    expect(configSelectionFromSearch("communications", "?section=tts")).toEqual({
      activeSection: "tts",
      activeSubsection: null,
    });
  });

  it("falls back when a linked section does not belong to the page", () => {
    expect(configSelectionFromSearch("communications", "?section=gateway")).toEqual({
      activeSection: "messages",
      activeSubsection: null,
    });
  });

  it("keeps MCP separate from Infrastructure", () => {
    expect(configSelectionFromSearch("mcp", "?section=browser")).toEqual({
      activeSection: "mcp",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("infrastructure", "?section=mcp")).toEqual({
      activeSection: "gateway",
      activeSubsection: null,
    });
  });

  it("keeps the Updates section off Advanced", () => {
    expect(configSelectionFromSearch("advanced", "?section=update")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
  });
});

describe("extractQuickSettingsSecurity", () => {
  it("preserves provenance for inherited security defaults", () => {
    expect(extractQuickSettingsSecurity({})).toMatchObject({
      browserEnabled: true,
      browserEnabledOverridden: false,
      toolProfile: "full",
      toolProfileOverridden: false,
    });
  });

  it("distinguishes explicit values that equal the defaults", () => {
    expect(
      extractQuickSettingsSecurity({
        browser: { enabled: true },
        tools: { profile: "full" },
      }),
    ).toMatchObject({
      browserEnabled: true,
      browserEnabledOverridden: true,
      toolProfile: "full",
      toolProfileOverridden: true,
    });
  });
});

describe("ConfigPage synced preference provenance", () => {
  it.each([
    {
      label: "lets a profile-bound operator write appearance without config admin access",
      selfUser: { id: "profile-owner" },
      scopes: ["operator.write"],
      canPatch: false,
      appearanceCanSync: true,
      localeCanSync: false,
    },
    {
      label: "keeps read-only profile appearance device-local even when config patching is exposed",
      selfUser: { id: "profile-viewer" },
      scopes: ["operator.read"],
      canPatch: true,
      appearanceCanSync: false,
      localeCanSync: true,
    },
    {
      label: "preserves config-patch authorization when no profile is bound",
      selfUser: null,
      scopes: ["operator.write"],
      canPatch: false,
      appearanceCanSync: false,
      localeCanSync: false,
    },
  ])("$label", ({ selfUser, scopes, canPatch, appearanceCanSync, localeCanSync }) => {
    const page = new ConfigPage() as unknown as {
      context: ApplicationContext;
      serverUiPrefsCanSync: (
        key?: "theme" | "themeMode" | "accent" | "fontUi" | "fontChat",
      ) => boolean | null;
    };
    page.context = {
      gateway: {
        snapshot: { selfUser, hello: { auth: { role: "operator", scopes } } },
      },
      runtimeConfig: { state: { connected: true }, canPatch },
    } as unknown as ApplicationContext;

    expect(page.serverUiPrefsCanSync("theme")).toBe(appearanceCanSync);
    expect(page.serverUiPrefsCanSync("themeMode")).toBe(appearanceCanSync);
    expect(page.serverUiPrefsCanSync("accent")).toBe(appearanceCanSync);
    expect(page.serverUiPrefsCanSync("fontUi")).toBe(Boolean(selfUser) && appearanceCanSync);
    expect(page.serverUiPrefsCanSync("fontChat")).toBe(Boolean(selfUser) && appearanceCanSync);
    expect(page.serverUiPrefsCanSync()).toBe(localeCanSync);
  });

  it("describes profile-owned appearance without changing gateway or device-local hints", () => {
    expect(serverUiPrefProvenanceHint("profile")).toBe(
      "Saved to your profile — follows you on every device.",
    );
    expect(serverUiPrefProvenanceHint("synced")).toBe(
      "Synced across your devices through the gateway.",
    );
    expect(serverUiPrefProvenanceHint("device-local")).toBe("Stored in this browser only.");
  });

  it("restores the gateway appearance default while queuing deletion of the profile override", async () => {
    const configObject = { ui: { prefs: { theme: "dash" } } };
    const client = {
      request: vi.fn(async () => ({ status: "ok", entries: { "ui.theme": "knot" } })),
    } as unknown as GatewayBrowserClient;
    await refreshProfileAppearancePrefs({
      client,
      profileId: "profile-owner",
      configObject,
      scope: "ws://profile.test",
      onApplied: vi.fn(),
    });
    const page = new ConfigPage() as unknown as {
      context: ApplicationContext;
      settings: ReturnType<typeof loadSettings>;
      resetSyncedAppearancePref: (key: "theme") => void;
    };
    page.context = {
      gateway: {
        connection: { gatewayUrl: "ws://profile.test" },
        snapshot: {
          selfUser: { id: "profile-owner" },
          hello: { auth: { role: "operator", scopes: ["operator.write"] } },
        },
      },
      runtimeConfig: {
        state: { connected: true, configSnapshot: { config: configObject } },
        canPatch: false,
      },
      theme: { refresh: vi.fn() },
    } as unknown as ApplicationContext;
    const beforeReset = loadSettings();
    page.settings = beforeReset;

    page.resetSyncedAppearancePref("theme");

    expect(page.settings.theme).toBe("dash");
    expect(changedServerUiPrefs(beforeReset, page.settings)).toEqual({ theme: null });
  });

  it.each(["fontUi", "fontChat"] as const)(
    "resets the %s profile override when its picker sentinel is selected",
    async (key) => {
      const gatewayUrl = "ws://font-profile.test";
      const configObject = {};
      const client = {
        request: vi.fn(async () => ({ status: "ok", entries: { [`ui.${key}`]: "lora" } })),
      } as unknown as GatewayBrowserClient;
      await refreshProfileAppearancePrefs({
        client,
        profileId: "font-owner",
        configObject,
        scope: gatewayUrl,
        onApplied: vi.fn(),
      });
      const page = new ConfigPage() as unknown as {
        context: ApplicationContext;
        settings: ReturnType<typeof loadSettings>;
        setFont: (key: "fontUi" | "fontChat", font: undefined) => void;
      };
      page.context = {
        gateway: {
          connection: { gatewayUrl },
          snapshot: {
            selfUser: { id: "font-owner" },
            hello: { auth: { role: "operator", scopes: ["operator.write"] } },
          },
        },
        runtimeConfig: {
          state: { connected: true, configSnapshot: { config: configObject } },
          canPatch: false,
        },
        theme: { refresh: vi.fn() },
      } as unknown as ApplicationContext;
      const previous = loadSettings();
      page.settings = previous;
      page.setFont(key, undefined);
      expect(page.settings[key]).toBeUndefined();
      expect(changedServerUiPrefs(previous, page.settings)).toEqual({ [key]: null });
      expect(page.context.theme.refresh).toHaveBeenCalledOnce();
    },
  );

  it("uses the committed snapshot for both display and reset while the form draft differs", () => {
    const page = new ConfigPage();
    const committedConfig = { ui: { prefs: { theme: "claw" } } };
    const draftConfig = { ui: { prefs: { theme: "knot" } } };
    const runtimeConfig = {
      state: {
        client: null,
        connected: true,
        configLoading: false,
        configRaw: JSON.stringify(draftConfig),
        configRawOriginal: JSON.stringify(committedConfig),
        configValid: true,
        configIssues: [],
        configSaving: false,
        configApplying: false,
        configNeedsApply: false,
        configSnapshot: {
          config: committedConfig,
          hash: "committed-hash",
          issues: [],
          raw: JSON.stringify(committedConfig),
          runtimeConfig: {},
          valid: true,
        },
        configSchema: { type: "object", properties: {} },
        configSchemaLoading: false,
        configUiHints: {},
        configForm: draftConfig,
        configFormOriginal: committedConfig,
        configFormDirty: true,
        configFormMode: "form",
      },
      patchForm: vi.fn(),
      removeFormValue: vi.fn(),
      setRaw: vi.fn(),
      save: vi.fn(),
      discardDraft: vi.fn(),
      openFile: vi.fn(),
    } as unknown as ApplicationContext["runtimeConfig"];
    const context = {
      basePath: "",
      config: {
        current: {
          assistantIdentity: { name: "OpenClaw" },
          serverVersion: "2026.7.1",
        },
      },
      gateway: {
        connection: { gatewayUrl: "ws://committed.test" },
        snapshot: {
          hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
          phase: "connected",
        },
      },
      navigate: vi.fn(),
      overlays: {
        snapshot: {
          updateReconciliationPending: false,
          updateRunning: false,
        },
      },
      runtimeConfig,
      theme: { refresh: vi.fn() },
      webPush: { snapshot: {} },
    } as unknown as ApplicationContext;
    const state = page as unknown as {
      context: ApplicationContext;
      pageId: "appearance";
      settings: ReturnType<typeof loadSettings>;
    };
    state.context = context;
    state.pageId = "appearance";
    const beforeReset = loadSettings();
    const container = document.createElement("div");

    render(page.render(), container);

    const themeSection = container.querySelector<HTMLElement>("#settings-appearance-theme");
    expect(themeSection?.textContent).toContain("Default: Claw");
    expect(themeSection?.textContent).toContain("Synced across your devices");
    expect(themeSection?.textContent).not.toContain("Default: Knot");
    expect(themeSection?.textContent).not.toContain("Stored in this browser only");

    themeSection?.querySelector<HTMLButtonElement>(".settings-theme-card--claw")?.click();

    expect(changedServerUiPrefs(beforeReset, state.settings)).toEqual({ theme: null });
  });
});

describe("ConfigPage header", () => {
  it("renders the route subtitle for Communications", () => {
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      pageId: "communications";
      renderAdvancedConfig: () => undefined;
    };
    state.context = { runtimeConfig: { state: {} } } as unknown as ApplicationContext;
    state.pageId = "communications";
    state.renderAdvancedConfig = () => undefined;
    const container = document.createElement("div");

    render(page.render(), container);

    expect(container.querySelector(".page-subtitle")?.textContent?.trim()).toBe(
      "Messages and text-to-speech settings.",
    );
  });
});

describe("ConfigPage moved section routes", () => {
  it.each([
    ["channels", "channels", ""],
    ["broadcast", "advanced", "?section=broadcast"],
    ["talk", "talk", "?section=talk"],
  ])("redirects the former Communications %s section", (section, routeId, search) => {
    const navigate = vi.fn();
    const page = new ConfigPage();
    const state = page as unknown as {
      context: { navigate: typeof navigate };
      pageId: "communications";
      routeData: {
        pathname: string;
        search: string;
        hash: string;
        section: string;
        advanced: boolean;
        tab: string | null;
        targetBlockId: string | null;
      };
      syncRouteData: () => void;
    };
    state.context = { navigate };
    state.pageId = "communications";
    state.routeData = {
      pathname: "/settings/communications",
      search: `?section=${section}`,
      hash: "",
      section,
      advanced: false,
      tab: null,
      targetBlockId: null,
    };

    state.syncRouteData();

    expect(navigate).toHaveBeenCalledWith(routeId, { search, hash: "" });
  });

  it("redirects the former Agent Defaults models section", () => {
    const navigate = vi.fn();
    const page = new ConfigPage();
    const state = page as unknown as {
      context: { navigate: typeof navigate };
      pageId: "ai-agents";
      routeData: {
        pathname: string;
        search: string;
        hash: string;
        section: string;
        advanced: boolean;
        tab: string | null;
        targetBlockId: string | null;
      };
      syncRouteData: () => void;
    };
    state.context = { navigate };
    state.pageId = "ai-agents";
    state.routeData = {
      pathname: "/settings/ai-agents",
      search: "?section=models",
      hash: "",
      section: "models",
      advanced: false,
      tab: null,
      targetBlockId: null,
    };

    state.syncRouteData();

    expect(navigate).toHaveBeenCalledWith("model-providers", { search: "", hash: "" });
  });
});

describe("ConfigPage advanced selection guard", () => {
  it("keeps curated sections off the Advanced page", () => {
    expect(configSelectionFromSearch("advanced", "?section=messages")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=env")).toEqual({
      activeSection: "env",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=mcp")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=tts")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=broadcast")).toEqual({
      activeSection: "broadcast",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=models")).toEqual({
      activeSection: "models",
      activeSubsection: null,
    });
  });
});

describe("ConfigPage media discovery", () => {
  it("coalesces refreshes while discovery is in flight", async () => {
    for (const method of ["refreshMicrophones", "refreshCameras"] as const) {
      const discovery = deferred<MediaDeviceInfo[]>();
      const enumerateDevices = vi.fn(() => discovery.promise);
      vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });
      const page = new ConfigPage();
      const state = page as unknown as Record<
        typeof method,
        (requestPermission: boolean) => Promise<void>
      >;

      const first = state[method](true);
      await state[method](true);
      expect(enumerateDevices).toHaveBeenCalledOnce();

      discovery.resolve([]);
      await first;
    }
  });

  it("upgrades passive discovery when the user requests permission", async () => {
    for (const method of ["refreshMicrophones", "refreshCameras"] as const) {
      const passiveDiscovery = deferred<MediaDeviceInfo[]>();
      const enumerateDevices = vi
        .fn()
        .mockImplementationOnce(() => passiveDiscovery.promise)
        .mockResolvedValueOnce([]);
      vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });
      const page = new ConfigPage();
      const state = page as unknown as Record<
        typeof method,
        (requestPermission: boolean) => Promise<void>
      >;

      const passive = state[method](false);
      await state[method](true);
      expect(enumerateDevices).toHaveBeenCalledOnce();

      passiveDiscovery.resolve([]);
      await passive;
      expect(enumerateDevices).toHaveBeenCalledTimes(2);
    }
  });
});

describe("ConfigPage camera selection", () => {
  it("persists only confirmed camera selections and ignores superseded failures", async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    switchActiveRealtimeTalkCameras
      .mockRejectedValueOnce(new Error("The selected camera is unavailable"))
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const page = new ConfigPage();
    const state = page as unknown as {
      cameraError: string | null;
      selectCamera: (deviceId: string) => Promise<void>;
      applySettings: ReturnType<typeof vi.fn>;
    };
    state.applySettings = vi.fn();

    await state.selectCamera("missing-camera");
    expect(state.cameraError).toBe("The selected camera is unavailable");
    expect(state.applySettings).not.toHaveBeenCalled();

    const staleSelection = state.selectCamera("slow-camera");
    expect(state.cameraError).toBeNull();
    await state.selectCamera("back-camera");
    expect(state.applySettings).toHaveBeenCalledOnce();
    expect(state.applySettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ realtimeTalkVideoDeviceId: "back-camera" }),
    );
    rejectFirst(new Error("The selected camera is unavailable"));
    await staleSelection;
    expect(state.cameraError).toBeNull();
    expect(state.applySettings).toHaveBeenCalledOnce();

    state.cameraError = "Another camera error";
    await state.selectCamera("");
    expect(state.cameraError).toBeNull();
    expect(state.applySettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ realtimeTalkVideoDeviceId: undefined }),
    );
  });
});

describe("ConfigPage session observer models", () => {
  it("lets a replacement Gateway load while the stale client is still pending", async () => {
    const first = deferred<ModelCatalogResult>();
    const second = deferred<ModelCatalogResult>();
    vi.spyOn(modelCatalogStore, "loadModelCatalog")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const firstClient = {} as GatewayBrowserClient;
    const secondClient = {} as GatewayBrowserClient;
    const gateway = {
      snapshot: { client: firstClient, phase: "connected" },
    } as unknown as ApplicationGateway;
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      systemInfoGatewaySource: ApplicationGateway;
      sessionObserverModels: ModelCatalogEntry[];
      sessionObserverModelsUnavailable: boolean;
      sessionObserverModelsClient: GatewayBrowserClient | null;
      ensureSessionObserverModels: (
        client: GatewayBrowserClient,
        agentId: string | null,
      ) => Promise<void>;
    };
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    state.context = {
      gateway,
      agentSelection: { state: { selectedId: "main" } },
    } as ApplicationContext;
    state.systemInfoGatewaySource = gateway;

    const firstLoad = state.ensureSessionObserverModels(firstClient, "main");
    (gateway as { snapshot: ApplicationGatewaySnapshot }).snapshot = {
      client: secondClient,
      phase: "connected",
    } as ApplicationGatewaySnapshot;
    const secondLoad = state.ensureSessionObserverModels(secondClient, "main");
    const currentModels = [{ id: "small", name: "Small", provider: "openai" }];
    second.resolve({ models: currentModels });
    await secondLoad;
    expect(state.sessionObserverModels).toEqual(currentModels);
    expect(state.sessionObserverModelsClient).toBe(secondClient);

    first.resolve({ models: [{ id: "stale", name: "Stale", provider: "old" }] });
    await firstLoad;
    expect(state.sessionObserverModels).toEqual(currentModels);
    expect(modelCatalogStore.loadModelCatalog).toHaveBeenCalledTimes(2);
    expect(modelCatalogStore.loadModelCatalog).toHaveBeenNthCalledWith(1, firstClient, {
      agentId: "main",
      preparedOnly: true,
    });
    expect(modelCatalogStore.loadModelCatalog).toHaveBeenNthCalledWith(2, secondClient, {
      agentId: "main",
      preparedOnly: true,
    });
  });

  it("retries a transient catalog failure on the next status refresh", async () => {
    const recoveredModels = [{ id: "small", name: "Small", provider: "openai" }];
    vi.spyOn(modelCatalogStore, "loadModelCatalog")
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce({ models: recoveredModels });
    const client = {} as GatewayBrowserClient;
    const gateway = {
      snapshot: { client, phase: "connected" },
    } as unknown as ApplicationGateway;
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      systemInfoGatewaySource: ApplicationGateway;
      sessionObserverModels: ModelCatalogEntry[];
      sessionObserverModelsUnavailable: boolean;
      ensureSessionObserverModels: (
        client: GatewayBrowserClient,
        agentId: string | null,
      ) => Promise<void>;
    };
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    state.context = {
      gateway,
      agentSelection: { state: { selectedId: "main" } },
    } as ApplicationContext;
    state.systemInfoGatewaySource = gateway;

    await state.ensureSessionObserverModels(client, "main");
    expect(state.sessionObserverModels).toEqual([]);
    expect(state.sessionObserverModelsUnavailable).toBe(true);

    await state.ensureSessionObserverModels(client, "main");

    expect(state.sessionObserverModels).toEqual(recoveredModels);
    expect(state.sessionObserverModelsUnavailable).toBe(false);
    expect(modelCatalogStore.loadModelCatalog).toHaveBeenCalledTimes(2);
    expect(modelCatalogStore.loadModelCatalog).toHaveBeenLastCalledWith(client, {
      agentId: "main",
      preparedOnly: true,
    });
  });

  it("keeps a same-client agent switch from restoring stale observer models", async () => {
    const main = deferred<ModelCatalogResult>();
    const writer = deferred<ModelCatalogResult>();
    vi.spyOn(modelCatalogStore, "loadModelCatalog").mockImplementation((_client, options) =>
      options.agentId === "writer" ? writer.promise : main.promise,
    );
    const client = {} as GatewayBrowserClient;
    const gateway = {
      snapshot: { client, phase: "connected" },
    } as unknown as ApplicationGateway;
    const selectionState = { selectedId: "main" as string | null };
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      systemInfoGatewaySource: ApplicationGateway;
      sessionObserverModels: ModelCatalogEntry[];
      sessionObserverModelsUnavailable: boolean;
      ensureSessionObserverModels: (
        client: GatewayBrowserClient,
        agentId: string | null,
      ) => Promise<void>;
    };
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    state.context = {
      gateway,
      agentSelection: { state: selectionState },
    } as ApplicationContext;
    state.systemInfoGatewaySource = gateway;

    const mainLoad = state.ensureSessionObserverModels(client, "main");
    selectionState.selectedId = "writer";
    const writerLoad = state.ensureSessionObserverModels(client, "writer");
    const writerModels = [{ id: "writer-model", name: "Writer Model", provider: "openai" }];
    writer.resolve({ models: writerModels });
    await writerLoad;
    main.resolve({ models: [{ id: "main-model", name: "Main Model", provider: "openai" }] });
    await mainLoad;

    expect(state.sessionObserverModels).toEqual(writerModels);
    expect(modelCatalogStore.loadModelCatalog).toHaveBeenNthCalledWith(1, client, {
      agentId: "main",
      preparedOnly: true,
    });
    expect(modelCatalogStore.loadModelCatalog).toHaveBeenNthCalledWith(2, client, {
      agentId: "writer",
      preparedOnly: true,
    });

    selectionState.selectedId = null;
    await state.ensureSessionObserverModels(client, null);
    expect(state.sessionObserverModels).toEqual([]);
    expect(state.sessionObserverModelsUnavailable).toBe(true);
    expect(modelCatalogStore.loadModelCatalog).toHaveBeenCalledTimes(2);
  });
});

describe("ConfigPage curated mutation eligibility", () => {
  it.each([
    ["offline", { connected: false }, ["operator.admin"], false, true],
    ["read-only operator", { connected: true }, ["operator.read"], false, true],
    ["config.set absent", { connected: true }, ["operator.admin"], false, false],
    ["config save", { connected: true, configSaving: true }, ["operator.admin"], false, true],
    ["app update", { connected: true }, ["operator.admin"], true, true],
    ["idle administrator", { connected: true }, ["operator.admin"], false, true],
  ])("locks server-backed controls for %s", (_name, statePatch, scopes, updateRunning, canSet) => {
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      isCuratedConfigMutationDisabled: () => boolean;
    };
    state.context = {
      runtimeConfig: {
        canSet,
        state: {
          configLoading: false,
          configSaving: false,
          configApplying: false,
          ...statePatch,
        },
      },
      gateway: {
        snapshot: { hello: { auth: { role: "operator", scopes } } },
      },
      overlays: {
        snapshot: { updateRunning, updateReconciliationPending: false },
      },
    } as unknown as ApplicationContext;

    const expectedUnlocked = _name === "idle administrator";
    expect(state.isCuratedConfigMutationDisabled()).toBe(!expectedUnlocked);
  });
});

describe("ConfigPage Updates integration", () => {
  it("refreshes update status once when the page becomes active", () => {
    const refreshUpdateStatus = vi.fn(async () => {});
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      syncUpdateStatusRefresh: () => void;
    };
    state.context = {
      gateway: {
        snapshot: {
          client: {},
          phase: "connected",
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["update.status"] },
          },
        },
      },
      overlays: { refreshUpdateStatus },
    } as unknown as ApplicationContext;

    page.pageId = "updates";
    state.syncUpdateStatusRefresh();
    state.syncUpdateStatusRefresh();
    expect(refreshUpdateStatus).toHaveBeenCalledOnce();

    page.pageId = "advanced";
    state.syncUpdateStatusRefresh();
    page.pageId = "updates";
    state.syncUpdateStatusRefresh();
    expect(refreshUpdateStatus).toHaveBeenCalledTimes(2);
  });

  it("stages policy changes through patchForm and confirms Update now before overlays", async () => {
    const patchForm = vi.fn();
    const runUpdate = vi.fn();
    const page = new ConfigPage();
    const state = page as unknown as { context: ApplicationContext };
    page.pageId = "updates";
    state.context = {
      config: {
        current: { assistantIdentity: { name: "OpenClaw" }, serverVersion: "2026.8.1" },
      },
      runtimeConfig: {
        canSet: true,
        state: {
          connected: true,
          configLoading: false,
          configSaving: false,
          configApplying: false,
          configForm: { update: { channel: "stable", auto: { enabled: false } } },
          configSnapshot: null,
        },
        patchForm,
      },
      gateway: {
        snapshot: {
          client: {},
          phase: "connected",
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["update.run"] },
          },
        },
        // The update dialog watches both stores for the life of the install.
        subscribe: () => () => undefined,
      },
      overlays: {
        snapshot: {
          updateAvailable: null,
          updateSchedule: { channel: "stable", autoEnabled: false },
          updateRunning: false,
          updateReconciliationPending: false,
          updateStatusBanner: null,
        },
        subscribe: () => () => undefined,
        runUpdate,
      },
    } as unknown as ApplicationContext;
    const container = document.createElement("div");
    document.body.append(container);
    const restoreDialogPolyfill = installDialogPolyfill();

    render(page.render(), container);

    const channel = container.querySelector<HTMLElement & { value: string }>("wa-radio-group");
    if (!channel) {
      throw new Error("Missing update channel control");
    }
    channel.value = "beta";
    channel.dispatchEvent(new Event("change"));
    const automatic = container.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    if (!automatic) {
      throw new Error("Missing automatic update control");
    }
    automatic.checked = true;
    automatic.dispatchEvent(new Event("change"));
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Update now"))
      ?.click();
    await nextFrame();

    expect(patchForm).toHaveBeenCalledWith(["update", "channel"], "beta");
    expect(patchForm).toHaveBeenCalledWith(["update", "auto", "enabled"], true);
    // Settings shares the sidebar card's confirmation gate: nothing runs on the click itself.
    expect(runUpdate).not.toHaveBeenCalled();

    const { modal } = await waitForRenderedModalDialog(document.body);
    [...modal.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Update and restart")
      ?.click();
    await nextFrame();

    expect(runUpdate).toHaveBeenCalledOnce();
    restoreDialogPolyfill();
    container.remove();
  });
});

describe("ConfigPage runtime config lifecycle", () => {
  it("loads Updates without requesting the admin-only config schema", async () => {
    const page = new ConfigPage();
    page.pageId = "updates";
    const state = page as unknown as {
      synchronizeRuntimeConfig: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
    };
    const runtimeConfig = {
      state: {
        configSnapshot: null,
        configLoading: false,
        configSchema: null,
        configSchemaLoading: false,
      },
      ensureLoaded: vi.fn(() => Promise.resolve()),
      ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];

    state.synchronizeRuntimeConfig(runtimeConfig);
    await Promise.resolve();

    expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(runtimeConfig.ensureSchemaLoaded).not.toHaveBeenCalled();
  });

  it("loads replacement sources and clears sensitive reveal state", async () => {
    const page = new ConfigPage();
    const state = page as unknown as {
      configViewState: ConfigViewState;
      synchronizeRuntimeConfig: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
    };
    const createRuntimeConfig = () =>
      ({
        state: {
          configSnapshot: null,
          configLoading: false,
          configSchema: null,
          configSchemaLoading: false,
        },
        ensureLoaded: vi.fn(() => Promise.resolve()),
        ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
      }) as unknown as ApplicationContext["runtimeConfig"];
    const first = createRuntimeConfig();
    const second = createRuntimeConfig();

    state.synchronizeRuntimeConfig(first);
    await Promise.resolve();
    state.configViewState.rawRevealed = true;
    state.configViewState.envRevealed = true;
    state.configViewState.revealedSensitivePaths.add("gateway.auth.token");
    state.synchronizeRuntimeConfig(second);
    await Promise.resolve();

    expect(first.ensureLoaded).toHaveBeenCalledOnce();
    expect(first.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(second.ensureLoaded).toHaveBeenCalledOnce();
    expect(second.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(state.configViewState.rawRevealed).toBe(false);
    expect(state.configViewState.envRevealed).toBe(false);
    expect(state.configViewState.revealedSensitivePaths.size).toBe(0);
  });
});
