/* @vitest-environment jsdom */

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PopupMessage = {
  type: string;
  tabId?: number;
  pairingString?: string;
};

type PopupState = {
  paired?: boolean;
  shared?: boolean;
  statusHint?: string;
  failures: Partial<Record<"getStatus" | "pair" | "unpair" | "toggleShareTab", string>>;
  onFailure?: (message: PopupMessage) => void;
};

async function loadPopup(params: PopupState) {
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
      params.onFailure?.(message);
      return { ok: false, error: failure };
    }
    switch (message.type) {
      case "getStatus":
        return {
          paired: params.paired !== false,
          state: "on",
          sharedTabCount: params.shared ? 1 : 0,
          relayUrl: "ws://127.0.0.1:18797/extension",
          ...(params.statusHint ? { hint: params.statusHint } : {}),
        };
      case "prepareCopilotPanel":
        return { ok: true, path: "sidepanel.html?binding=fixture" };
      case "isTabShared":
        return { shared: params.shared === true };
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

async function expectVisibleErrorAfterStatusRefresh(
  error: string,
  sendMessage: Awaited<ReturnType<typeof loadPopup>>["sendMessage"],
) {
  const initialPollCount = sendMessage.mock.calls.filter(
    ([message]) => message.type === "getStatus",
  ).length;

  await vi.advanceTimersByTimeAsync(2_000);

  const refreshedPollCount = sendMessage.mock.calls.filter(
    ([message]) => message.type === "getStatus",
  ).length;
  expect(refreshedPollCount).toBeGreaterThan(initialPollCount);
  expect(popupElement("statusLine").textContent).toBe(error);
  expect(popupElement("statusLine").closest(".hidden")).toBeNull();
}

describe("Chrome extension popup action errors", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  it("shows persisted re-pair guidance after an unsupported pairing is cleared", async () => {
    const hint =
      "Stored proxy-prefixed browser relay pairing is no longer supported. Re-run openclaw browser extension pair with a Gateway URL that has no path prefix.";
    await loadPopup({ paired: false, statusHint: hint, failures: {} });

    expect(popupElement("statusLine").textContent).toBe(hint);
    expect(popupElement("pairSection").classList.contains("hidden")).toBe(false);
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
    const popup = {
      paired: true,
      failures: { unpair: error } as Partial<Record<"unpair", string>>,
    };
    const { sendMessage } = await loadPopup(popup);

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

    await expectVisibleErrorAfterStatusRefresh(error, sendMessage);
    expect(popupElement("settingsSection").classList.contains("hidden")).toBe(false);

    delete popup.failures.unpair;
    popup.paired = false;
    popupElement("unpairButton").click();

    await vi.waitFor(() => {
      expect(popupElement("statusLine").textContent).toBe("Not paired with a gateway");
      expect(popupElement("settingsSection").classList.contains("hidden")).toBe(true);
    });
  });

  it("shows a rejected share-toggle error in the visible connected popup", async () => {
    const error = "No tab with id: 44.";
    const failures: Partial<Record<"getStatus" | "toggleShareTab", string>> = {
      toggleShareTab: error,
    };
    const { sendMessage } = await loadPopup({ failures });

    popupElement("shareButton").click();

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ type: "toggleShareTab", tabId: 44 });
      expect(popupElement("statusLine").textContent).toBe(error);
      expect(popupElement("statusLine").closest(".hidden")).toBeNull();
      expect(popupElement("connectedSection").classList.contains("hidden")).toBe(false);
    });

    await expectVisibleErrorAfterStatusRefresh(error, sendMessage);
    expect(popupElement("connectedSection").classList.contains("hidden")).toBe(false);

    failures.getStatus = "Could not refresh browser status.";
    await expectVisibleErrorAfterStatusRefresh(error, sendMessage);
    expect(popupElement("connectedSection").classList.contains("hidden")).toBe(false);

    delete failures.getStatus;
    await expectVisibleErrorAfterStatusRefresh(error, sendMessage);

    delete failures.toggleShareTab;
    popupElement("shareButton").click();

    await vi.waitFor(() => {
      expect(popupElement("statusLine").textContent).toBe("Connected · 0 tabs shared");
      expect(popupElement("connectedSection").classList.contains("hidden")).toBe(false);
    });
  });

  it.each([
    { action: "share", initiallyShared: false, nextLabel: "Stop sharing this tab" },
    { action: "unshare", initiallyShared: true, nextLabel: "Share this tab with OpenClaw" },
  ])(
    "refreshes the actual tab controls immediately after a partially failed $action",
    async ({ initiallyShared, nextLabel }) => {
      const error = "Could not reconcile browser tab consent.";
      const popup: PopupState = {
        shared: initiallyShared,
        failures: { toggleShareTab: error },
      };
      popup.onFailure = () => {
        popup.shared = !popup.shared;
      };
      const { sendMessage } = await loadPopup(popup);
      const previousPollCount = sendMessage.mock.calls.filter(
        ([message]) => message.type === "getStatus",
      ).length;

      popupElement("shareButton").click();

      await vi.waitFor(() => {
        expect(popupElement("statusLine").textContent).toBe(error);
        expect(popupElement("shareButton").textContent).toBe(nextLabel);
        expect(popupElement("connectedSection").classList.contains("hidden")).toBe(false);
        expect(
          sendMessage.mock.calls.filter(([message]) => message.type === "getStatus").length,
        ).toBeGreaterThan(previousPollCount);
      });
    },
  );

  it("clears a partial-unpair error after successfully pairing again", async () => {
    const error = "Could not reconcile browser pairing.";
    const popup: PopupState = {
      paired: true,
      failures: { unpair: error },
    };
    popup.onFailure = () => {
      popup.paired = false;
    };
    const { sendMessage } = await loadPopup(popup);

    popupElement("settingsButton").click();
    await vi.waitFor(() => {
      expect(popupElement("settingsSection").classList.contains("hidden")).toBe(false);
    });
    popupElement("unpairButton").click();
    await vi.waitFor(() => {
      expect(popupElement("statusLine").textContent).toBe(error);
      expect(popupElement("settingsSection").classList.contains("hidden")).toBe(false);
      expect(popupElement("unpairButton").classList.contains("hidden")).toBe(true);
    });

    await expectVisibleErrorAfterStatusRefresh(error, sendMessage);
    popupElement("settingsButton").click();
    await vi.waitFor(() => {
      expect(popupElement("pairSection").classList.contains("hidden")).toBe(false);
      expect(popupElement("statusLine").textContent).toBe(error);
    });

    popup.paired = true;
    popupElement("pairButton").click();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ type: "pair", pairingString: "" });
      expect(popupElement("statusLine").textContent).toBe("Connected · 0 tabs shared");
      expect(popupElement("connectedSection").classList.contains("hidden")).toBe(false);
    });
  });

  it("keeps a partially persisted pairing failure visible after entering the connected view", async () => {
    const error = "Could not finish browser pairing.";
    const popup: PopupState = {
      paired: false,
      failures: { pair: error },
    };
    popup.onFailure = () => {
      popup.paired = true;
    };
    const { sendMessage } = await loadPopup(popup);
    const pairingInput = popupElement("pairingString") as HTMLTextAreaElement;
    pairingInput.value = "ws://127.0.0.1:18797/extension#fixture-token";

    popupElement("pairButton").click();

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "pair",
        pairingString: pairingInput.value,
      });
      expect(popupElement("error").textContent).toBe(error);
      expect(popupElement("pairSection").classList.contains("hidden")).toBe(true);
      expect(popupElement("connectedSection").classList.contains("hidden")).toBe(false);
      expect(popupElement("statusLine").textContent).toBe(error);
      expect(popupElement("statusLine").closest(".hidden")).toBeNull();
    });

    await expectVisibleErrorAfterStatusRefresh(error, sendMessage);
    popupElement("shareButton").click();

    await vi.waitFor(() => {
      expect(popupElement("statusLine").textContent).toBe("Connected · 0 tabs shared");
      expect(popupElement("connectedSection").classList.contains("hidden")).toBe(false);
    });
  });

  it.each([
    { view: "connected", section: "connectedSection", settings: false },
    { view: "settings", section: "settingsSection", settings: true },
  ])(
    "keeps the existing $view view when a status poll fails and recovers",
    async ({ section, settings }) => {
      const error = "Could not read browser pairing.";
      const failures: Partial<Record<"getStatus", string>> = {};
      const { sendMessage } = await loadPopup({ failures });
      if (settings) {
        popupElement("settingsButton").click();
        await vi.waitFor(() => {
          expect(popupElement("settingsSection").classList.contains("hidden")).toBe(false);
        });
      }
      const previousStatusClass = popupElement("statusDot").className;

      failures.getStatus = error;
      await expectVisibleErrorAfterStatusRefresh(error, sendMessage);
      expect(popupElement(section).classList.contains("hidden")).toBe(false);
      expect(popupElement("pairSection").classList.contains("hidden")).toBe(true);
      expect(popupElement("statusDot").className).toBe(previousStatusClass);

      delete failures.getStatus;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(popupElement("statusLine").textContent).toBe("Connected · 0 tabs shared");
      expect(popupElement(section).classList.contains("hidden")).toBe(false);
    },
  );

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
