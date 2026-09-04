import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Viewer copy loads with Desktop; shell and setup labels stay in the startup catalog.
const enDesktop = {
  desktop: {
    title: en.desktop.title,
    openWindow: en.desktop.openWindow,
    unavailable: en.desktop.unavailable,
    toggle: en.desktop.toggle,
    hide: "Hide desktop panel",
    resize: "Resize desktop panel",
    dockBottom: "Dock to bottom",
    dockRight: "Dock to right",
    enterFullscreen: "Enter fullscreen",
    exitFullscreen: "Exit fullscreen",
    fullscreenUnavailable: "Fullscreen is unavailable in this browser",
    pickerTitle: "Desktop sources",
    thisMachine: "This machine",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    loading: "Loading desktop sources…",
    empty: "No desktop-capable sources are available.",
    sourceUnavailable: "The requested desktop source is unavailable. Choose another source.",
    connect: "Connect",
    connecting: "Connecting to desktop…",
    takeControl: "Take control",
    switchToViewOnly: "Switch to view only",
    viewOnly: "View only",
    control: "Control",
    keyboard: "Keyboard",
    keyboardInput: "Remote desktop keyboard input",
    touchControls: "Remote desktop controls",
    fit: "Fit",
    fitScreen: "Fit screen",
    actualSize: "Use actual size",
    back: "Back",
    disconnect: "Disconnect",
    reconnect: en.desktop.reconnect,
    passwordPrompt: "Enter the VNC password for this machine.",
    passwordLabel: "VNC password",
    accountPrompt: "Enter a macOS account to authenticate Screen Sharing.",
    usernameLabel: "macOS username",
    accountPasswordLabel: "macOS password",
    controlTaken: "Another operator took control",
    disconnected: "Desktop disconnected: {reason}",
    closeCode: "connection closed with code {code}",
    unknownReason: "unknown reason",
    errors: {
      listFailed: "Could not load desktop sources: {error}",
      fullscreenFailed: "Could not change fullscreen mode: {error}",
      securityFailed: "Desktop security negotiation failed: {reason}",
      connectionFailed:
        "Reconnect. If it fails again, check the browser console and desktop service logs.",
    },
  },
} satisfies TranslationMap;

export const registerDesktopEnglish = Object.assign(
  () => Object.assign(en.desktop, enDesktop.desktop),
  { catalog: enDesktop },
);
