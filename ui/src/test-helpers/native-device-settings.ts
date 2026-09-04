import type { NativeDeviceSettingsSnapshot } from "../app/native-device-settings.ts";

export function createNativeDeviceSettingsSnapshot(): NativeDeviceSettingsSnapshot {
  return {
    contract: 1,
    device: { platform: "macos", appVersion: "2026.9.3", appBuild: "42", profileName: null },
    app: {
      showDockIcon: true,
      iconAnimationsEnabled: true,
      launchAtLogin: false,
      launchAtLoginAvailable: true,
      quickChatEnabled: true,
      quickChatShortcut: "⌥Space",
      debugPaneEnabled: false,
    },
    capabilities: {
      canvasEnabled: true,
      cameraEnabled: true,
      computerControlEnabled: true,
      computerControlProvider: "peekaboo",
      cuaDriverBundled: false,
      peekabooBridgeEnabled: true,
      activeComputerPresenceEnabled: false,
    },
    browser: {
      importAvailable: true,
      cookieSync: {
        available: true,
        enabled: false,
        domains: ["example.com"],
        targetProfile: "default",
        state: "off",
        detail: null,
      },
    },
    permissions: {
      entries: [
        { id: "notifications", status: "notDetermined" },
        { id: "accessibility", status: "denied" },
        { id: "screenRecording", status: "granted" },
        { id: "microphone", status: "notDetermined" },
        { id: "camera", status: "notDetermined" },
        { id: "speechRecognition", status: "granted" },
        { id: "location", status: "denied" },
        { id: "automation", status: "unavailable" },
      ],
      location: { mode: "off", precise: false },
    },
    voice: {
      supported: true,
      wakeEnabled: false,
      wakeTriggersTalkMode: true,
      pushToTalkEnabled: true,
      talkPhaseSoundsEnabled: true,
      talkShiftToStopEnabled: true,
      realtimeRelayEnabled: false,
      triggerChime: true,
      sendChime: true,
      microphone: { selectedId: null, devices: [{ id: "builtin", name: "Built-in Microphone" }] },
      locale: {
        primary: "en-US",
        additional: [],
        available: [
          { id: "en-US", name: "English (US)" },
          { id: "de-DE", name: "German" },
        ],
      },
    },
    updates: { available: true, automatic: true, unavailableReason: null },
  };
}
