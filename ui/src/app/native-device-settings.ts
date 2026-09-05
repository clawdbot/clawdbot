import { isRecord } from "@openclaw/normalization-core/record-coerce";

type PermissionId =
  | "notifications"
  | "accessibility"
  | "screenRecording"
  | "microphone"
  | "camera"
  | "speechRecognition"
  | "location"
  | "automation" // automation = Swift Capability.appleScript
  | "contacts"
  | "calendars"
  | "reminders"
  | "photos";
type PermissionStatus = "granted" | "denied" | "notDetermined" | "unavailable" | "limited";

export type NativeDeviceSettingsSnapshot = {
  contract: 1;
  device: {
    platform: "macos" | "ios";
    formFactor?: "phone" | "pad" | "desktop";
    modelName?: string;
    appVersion: string; // CFBundleShortVersionString
    appBuild: string; // CFBundleVersion
    profileName: string | null; // OPENCLAW_PROFILE name when active, else null
  };
  app?: {
    appearance?: "system" | "light" | "dark";
    notificationsEnabled?: boolean;
    showDockIcon?: boolean;
    iconStyle?: { selectedId: string; available: Array<{ id: string; name: string }> }; // advertised by hosts with Dock icon selection
    iconAnimationsEnabled?: boolean;
    launchAtLogin?: boolean;
    launchAtLoginAvailable?: boolean; // false when SMAppService cannot be used (named profile, unbundled)
    quickChatEnabled?: boolean;
    quickChatShortcut?: string | null; // human display string, e.g. "⌥Space"; null when unset
    debugPaneEnabled?: boolean;
  };
  capabilities?: {
    canvasEnabled?: boolean;
    cameraEnabled?: boolean;
    keepAwakeEnabled?: boolean;
    healthSummaryAvailable?: boolean;
    healthSummaryEnabled?: boolean;
    computerControlEnabled?: boolean;
    computerControlProvider?: "peekaboo" | "cua";
    cuaDriverBundled?: boolean;
    peekabooBridgeEnabled?: boolean;
    activeComputerPresenceEnabled?: boolean;
  };
  browser?: {
    importAvailable: boolean; // app in local mode and a Chrome-family profile with cookies exists
    cookieSync: {
      available: boolean; // false unless app is in remote mode with an external CLI
      enabled: boolean;
      domains: string[];
      targetProfile: string;
      state: "off" | "idle" | "running" | "error";
      detail: string | null; // human status line
    };
  };
  permissions: {
    entries: Array<{ id: PermissionId; status: PermissionStatus }>; // unique ids in host-published order
    location: {
      mode: "off" | "whileUsing" | "always";
      precise: boolean;
      preciseEditable?: boolean;
    };
  };
  voice: {
    supported: boolean; // voice wake runtime available on this device
    wakeEnabled: boolean; // AppState.swabbleEnabled
    wakeTriggersTalkMode?: boolean;
    pushToTalkEnabled?: boolean;
    talkPhaseSoundsEnabled?: boolean;
    talkShiftToStopEnabled?: boolean;
    realtimeRelayEnabled?: boolean;
    triggerChime?: boolean;
    sendChime?: boolean;
    talkEnabled?: boolean;
    talkButtonEnabled?: boolean;
    talkBackgroundEnabled?: boolean;
    speakerphoneEnabled?: boolean;
    microphone?: { selectedId: string | null; devices: Array<{ id: string; name: string }> }; // null = System Default
    locale?: {
      primary: string;
      additional: string[];
      available: Array<{ id: string; name: string }>;
    };
  };
  updates?: {
    available: boolean; // Sparkle updater present and usable
    automatic: boolean; // automaticallyChecksForUpdates (also drives automaticallyDownloadsUpdates, as today)
    unavailableReason: string | null;
  };
};

export type SettingKey =
  | "app.appearance"
  | "app.notificationsEnabled"
  | "app.showDockIcon"
  | "app.iconStyle"
  | "app.iconAnimationsEnabled"
  | "app.launchAtLogin"
  | "app.quickChatEnabled"
  | "app.debugPaneEnabled"
  | "capabilities.canvasEnabled"
  | "capabilities.cameraEnabled"
  | "capabilities.keepAwakeEnabled"
  | "capabilities.healthSummaryEnabled"
  | "capabilities.computerControlEnabled"
  | "capabilities.computerControlProvider"
  | "capabilities.peekabooBridgeEnabled"
  | "capabilities.activeComputerPresenceEnabled"
  | "browser.cookieSync.enabled"
  | "browser.cookieSync.domains"
  | "browser.cookieSync.targetProfile"
  | "permissions.location.mode"
  | "permissions.location.precise"
  | "voice.wakeEnabled"
  | "voice.wakeTriggersTalkMode"
  | "voice.pushToTalkEnabled"
  | "voice.talkPhaseSoundsEnabled"
  | "voice.talkShiftToStopEnabled"
  | "voice.realtimeRelayEnabled"
  | "voice.triggerChime"
  | "voice.sendChime"
  | "voice.talkEnabled"
  | "voice.talkButtonEnabled"
  | "voice.talkBackgroundEnabled"
  | "voice.speakerphoneEnabled"
  | "voice.microphone" // value: string id | null
  | "voice.locale.primary" // value: string
  | "voice.locale.additional" // value: string[]
  | "updates.automatic";

type NativePanel =
  | "quick-chat-shortcut"
  | "microphone-test"
  | "browser-import"
  | "connection"
  | "gateways"
  | "debug"
  | "diagnostics"
  | "licenses"
  | "about"
  | "watch";

type NativeDeviceSettingsMessage =
  | { type: "status" }
  | { type: "set"; key: SettingKey; value: boolean | string | string[] | null }
  | { type: "request-permission"; id: PermissionId }
  | { type: "open-system-settings"; id: PermissionId }
  | { type: "open"; panel: NativePanel }
  | { type: "check-for-updates" }
  | { type: "install-chrome-extension" };

export type NativeChromeExtensionSetupResult = {
  nativeHostRegistered: boolean;
  installRequested: boolean;
  discoveredProfiles: number;
};

export type NativeDeviceSettingsCapability = {
  readonly snapshot: NativeDeviceSettingsSnapshot | null;
  subscribe(listener: (snapshot: NativeDeviceSettingsSnapshot) => void): () => void;
  set(key: SettingKey, value: boolean | string | string[] | null, onSettled?: () => void): void;
  requestPermission(id: PermissionId): void;
  openSystemSettings(id: PermissionId): void;
  openPanel(panel: NativePanel): void;
  checkForUpdates(): void;
  installChromeExtension(): Promise<NativeChromeExtensionSetupResult>;
  refresh(): void;
  dispose(): void;
};

type NativeDeviceSettingsWindow = Window & {
  __OPENCLAW_NATIVE_DEVICE_SETTINGS__?: unknown;
  webkit?: {
    messageHandlers?: {
      openclawDeviceSettings?: {
        postMessage(message: NativeDeviceSettingsMessage): Promise<unknown>;
      };
    };
  };
};

const CHANGE_EVENT = "openclaw:native-device-settings-changed";
const PERMISSION_IDS = [
  "notifications",
  "accessibility",
  "screenRecording",
  "microphone",
  "camera",
  "speechRecognition",
  "location",
  "automation",
  "contacts",
  "calendars",
  "reminders",
  "photos",
] as const satisfies readonly PermissionId[];

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function stringList(value: unknown): boolean {
  return Array.isArray(value) && Array.from(value).every((entry) => typeof entry === "string");
}

function namedDevices(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    Array.from(value).every(
      (entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string",
    )
  );
}

function optionalBooleans(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === "boolean");
}

function permissionEntries(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const ids = new Set<string>();
  return Array.from(value).every((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !PERMISSION_IDS.some((id) => id === entry.id) ||
      ids.has(entry.id) ||
      typeof entry.status !== "string" ||
      !["granted", "denied", "notDetermined", "unavailable", "limited"].includes(entry.status)
    ) {
      return false;
    }
    ids.add(entry.id);
    return true;
  });
}

function isSnapshot(value: unknown): value is NativeDeviceSettingsSnapshot {
  if (!isRecord(value) || value.contract !== 1) {
    return false;
  }
  const { device, app, capabilities, browser, permissions, voice, updates } = value;
  if (
    !isRecord(device) ||
    (app !== undefined && !isRecord(app)) ||
    (capabilities !== undefined && !isRecord(capabilities)) ||
    (browser !== undefined && !isRecord(browser)) ||
    !isRecord(permissions) ||
    !isRecord(voice) ||
    (updates !== undefined && !isRecord(updates))
  ) {
    return false;
  }
  const cookieSync = browser?.cookieSync;
  const location = permissions.location;
  const microphone = voice.microphone;
  const locale = voice.locale;
  if (!isRecord(location)) {
    return false;
  }
  return (
    (device.platform === "macos" || device.platform === "ios") &&
    (device.formFactor === undefined ||
      (typeof device.formFactor === "string" &&
        ["phone", "pad", "desktop"].includes(device.formFactor))) &&
    (device.modelName === undefined || typeof device.modelName === "string") &&
    typeof device.appVersion === "string" &&
    typeof device.appBuild === "string" &&
    nullableString(device.profileName) &&
    (app === undefined ||
      (optionalBooleans(app, [
        "notificationsEnabled",
        "showDockIcon",
        "iconAnimationsEnabled",
        "launchAtLogin",
        "launchAtLoginAvailable",
        "quickChatEnabled",
        "debugPaneEnabled",
      ]) &&
        (app.appearance === undefined ||
          (typeof app.appearance === "string" &&
            ["system", "light", "dark"].includes(app.appearance))) &&
        (app.quickChatShortcut === undefined || nullableString(app.quickChatShortcut)) &&
        (app.iconStyle === undefined ||
          (isRecord(app.iconStyle) &&
            typeof app.iconStyle.selectedId === "string" &&
            namedDevices(app.iconStyle.available))))) &&
    (capabilities === undefined ||
      (optionalBooleans(capabilities, [
        "canvasEnabled",
        "cameraEnabled",
        "keepAwakeEnabled",
        "healthSummaryAvailable",
        "healthSummaryEnabled",
        "computerControlEnabled",
        "cuaDriverBundled",
        "peekabooBridgeEnabled",
        "activeComputerPresenceEnabled",
      ]) &&
        (capabilities.computerControlProvider === undefined ||
          capabilities.computerControlProvider === "peekaboo" ||
          capabilities.computerControlProvider === "cua"))) &&
    (browser === undefined ||
      (typeof browser.importAvailable === "boolean" &&
        isRecord(cookieSync) &&
        typeof cookieSync.available === "boolean" &&
        typeof cookieSync.enabled === "boolean" &&
        stringList(cookieSync.domains) &&
        typeof cookieSync.targetProfile === "string" &&
        typeof cookieSync.state === "string" &&
        ["off", "idle", "running", "error"].includes(cookieSync.state) &&
        nullableString(cookieSync.detail))) &&
    permissionEntries(permissions.entries) &&
    typeof location.mode === "string" &&
    ["off", "whileUsing", "always"].includes(location.mode) &&
    typeof location.precise === "boolean" &&
    optionalBooleans(location, ["preciseEditable"]) &&
    typeof voice.supported === "boolean" &&
    typeof voice.wakeEnabled === "boolean" &&
    optionalBooleans(voice, [
      "wakeTriggersTalkMode",
      "pushToTalkEnabled",
      "talkPhaseSoundsEnabled",
      "talkShiftToStopEnabled",
      "realtimeRelayEnabled",
      "triggerChime",
      "sendChime",
      "talkEnabled",
      "talkButtonEnabled",
      "talkBackgroundEnabled",
      "speakerphoneEnabled",
    ]) &&
    (microphone === undefined ||
      (isRecord(microphone) &&
        nullableString(microphone.selectedId) &&
        namedDevices(microphone.devices))) &&
    (locale === undefined ||
      (isRecord(locale) &&
        typeof locale.primary === "string" &&
        stringList(locale.additional) &&
        namedDevices(locale.available))) &&
    (updates === undefined ||
      (typeof updates.available === "boolean" &&
        typeof updates.automatic === "boolean" &&
        nullableString(updates.unavailableReason)))
  );
}

export function createNativeDeviceSettingsCapability(): NativeDeviceSettingsCapability | null {
  if (typeof window === "undefined") {
    return null;
  }
  // SAFETY: the host adds optional WebKit fields; the handler and snapshot are validated below.
  const nativeWindow = window as NativeDeviceSettingsWindow;
  const handler = nativeWindow.webkit?.messageHandlers?.openclawDeviceSettings;
  if (typeof handler?.postMessage !== "function") {
    return null;
  }
  const post = handler.postMessage.bind(handler);
  const initial = nativeWindow["__OPENCLAW_NATIVE_DEVICE_SETTINGS__"];
  let snapshot = isSnapshot(initial) ? initial : null;
  let disposed = false;
  const listeners = new Set<(snapshot: NativeDeviceSettingsSnapshot) => void>();
  const onChange = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const next: unknown = event.detail;
    if (!isSnapshot(next)) {
      return;
    }
    snapshot = next;
    listeners.forEach((listener) => listener(next));
  };
  const send = async (message: NativeDeviceSettingsMessage, onSettled?: () => void) => {
    try {
      const reply = await post(message);
      if (disposed) {
        return;
      }
      if (message.type === "set") {
        if (!isSnapshot(reply)) {
          throw new Error("Native settings returned an invalid edit result");
        }
        snapshot = reply;
      }
    } catch (error) {
      console.warn("Native device settings request failed", error);
    }
    if (!disposed && message.type === "set") {
      // Clear the originating draft before notifying whichever page is now mounted.
      onSettled?.();
      const current = snapshot;
      if (current) {
        listeners.forEach((listener) => listener(current));
      }
    }
  };
  // System Settings can change permissions while the app is backgrounded.
  const refresh = () => void send({ type: "status" });
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("focus", refresh);
  refresh();
  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (key, value, onSettled) => void send({ type: "set", key, value }, onSettled),
    requestPermission: (id) => void send({ type: "request-permission", id }),
    openSystemSettings: (id) => void send({ type: "open-system-settings", id }),
    openPanel: (panel) => void send({ type: "open", panel }),
    checkForUpdates: () => void send({ type: "check-for-updates" }),
    async installChromeExtension() {
      if (disposed) {
        throw new Error("Native device settings is unavailable");
      }
      const reply = await post({ type: "install-chrome-extension" });
      if (
        disposed ||
        !isRecord(reply) ||
        typeof reply.nativeHostRegistered !== "boolean" ||
        typeof reply.installRequested !== "boolean" ||
        typeof reply.discoveredProfiles !== "number" ||
        !Number.isSafeInteger(reply.discoveredProfiles) ||
        reply.discoveredProfiles < 0
      ) {
        throw new Error("Native Chrome setup returned an invalid result");
      }
      return {
        nativeHostRegistered: reply.nativeHostRegistered,
        installRequested: reply.installRequested,
        discoveredProfiles: reply.discoveredProfiles,
      };
    },
    refresh,
    dispose() {
      disposed = true;
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("focus", refresh);
      listeners.clear();
    },
  };
}
