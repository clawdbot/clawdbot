// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { loadSettings, normalizeAssistantMessageSurface, saveSettings } from "./settings.ts";

function setTestLocation(params: { protocol: string; host: string; pathname: string }) {
  vi.stubGlobal("location", {
    protocol: params.protocol,
    host: params.host,
    hostname: params.host.replace(/:\d+$/, ""),
    pathname: params.pathname,
  } as Location);
}

describe("assistant message surface settings", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    setTestLocation({ protocol: "https:", host: "gateway.example:8443", pathname: "/" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults, normalizes, persists, and resets the preference", () => {
    const gatewayUrl = "wss://gateway.example:8443";
    const scopedKey = `openclaw.control.settings.v1:${gatewayUrl}`;

    expect(loadSettings().assistantMessageSurface).toBe("theme-default");
    expect(normalizeAssistantMessageSurface("white")).toBe("white");
    expect(normalizeAssistantMessageSurface("invalid")).toBe("theme-default");

    saveSettings({ ...loadSettings(), assistantMessageSurface: "white" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").assistantMessageSurface).toBe(
      "white",
    );
    expect(loadSettings().assistantMessageSurface).toBe("white");

    saveSettings({ ...loadSettings(), assistantMessageSurface: "theme-default" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "assistantMessageSurface",
    );
  });
});
