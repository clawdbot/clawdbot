/* @vitest-environment jsdom */

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PopupMessage = {
  type: string;
  tabId?: number;
  pairingString?: string;
};

async function loadPopup(params: {
  paired?: boolean;
  failures: Partial<Record<"pair" | "unpair" | "toggleShareTab", string>>;
}) {
  const markup = await fs.readFile(
    path.join(process.cwd(), "extensions/browser/chrome-extension/popup.html"),
    "utf8",
  );
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;

  const sendMessage = vi.fn(async (message: PopupMessage) => {
    const failure = params.failures[message.type as keyof typeof params.failures];
    if (failure) {
      return { ok: false, error: failure };
    }
    switch (message.type) {
      case "getStatus":
        return {
          paired: params.paired !== false,
          state: "on",
          sharedTabCount: 0,
          relayUrl: "ws://127.0.0.1:18797/extension",
        };
      case "prepareCopilotPanel":
        return { ok: true, path: "sidepanel.html?binding=fixture" };
      case "isTabShared":
        return { shared: false };
      default:
        return { ok: true };
    }
  });

  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: vi.fn(() => ({ version: "2.1.0" })),
      sendMessage,
    },
    tabs: { query: vi.fn(async () => [{ id: 44 }]) },
    sidePanel: {
      setOptions: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
    },
  });

  const popupModulePath = "./popup.js";
  await import(popupModulePath);
  await vi.waitFor(() => {
    if (params.paired === false) {
      expect(sendMessage).toHaveBeenCalledWith({ type: "getStatus" });
      return;
    }
    expect(sendMessage).toHaveBeenCalledWith({ type: "isTabShared", tabId: 44 });
  });

  return { sendMessage };
}

function popupElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Popup element ${id} is missing`);
  }
  return element;
}

describe("Chrome extension popup action errors", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("keeps a rejected unpair visible while preserving the open settings panel", async () => {
    const error = "Could not remove browser pairing.";
    const { sendMessage } = await loadPopup({ failures: { unpair: error } });

    popupElement("settingsButton").click();
    await vi.waitFor(() => {
      expect(popupElement("settingsSection").classList.contains("hidden")).toBe(false);
    });
    popupElement("unpairButton").click();

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ type: "unpair" });
      expect(popupElement("statusLine").textContent).toBe(error);
      expect(popupElement("statusLine").closest(".hidden")).toBeNull();
      expect(popupElement("settingsSection").classList.contains("hidden")).toBe(false);
    });
  });

  it("shows a rejected share-toggle error in the visible connected popup", async () => {
    const error = "No tab with id: 44.";
    const { sendMessage } = await loadPopup({ failures: { toggleShareTab: error } });

    popupElement("shareButton").click();

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ type: "toggleShareTab", tabId: 44 });
      expect(popupElement("statusLine").textContent).toBe(error);
      expect(popupElement("statusLine").closest(".hidden")).toBeNull();
      expect(popupElement("connectedSection").classList.contains("hidden")).toBe(false);
    });
  });

  it("preserves the existing visible pairing failure", async () => {
    const error = "Could not save browser pairing.";
    const { sendMessage } = await loadPopup({ paired: false, failures: { pair: error } });
    const pairingInput = popupElement("pairingString") as HTMLTextAreaElement;
    pairingInput.value = "ws://127.0.0.1:18797/extension#fixture-token";

    popupElement("pairButton").click();

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "pair",
        pairingString: pairingInput.value,
      });
      expect(popupElement("error").textContent).toBe(error);
      expect(popupElement("error").closest(".hidden")).toBeNull();
    });
  });
});
