import { afterEach, beforeEach, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getSafeLocalStorage, getSafeSessionStorage } from "../../local-storage.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "../app.ts";
import type { OpenClawApp } from "../app.ts";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;

  addEventListener() {}

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  send() {}
}

function createMatchMediaMock(width: number) {
  return vi.fn((query: string) => {
    const maxWidthMatch = query.match(/\(max-width:\s*(\d+)px\)/);
    const minWidthMatch = query.match(/\(min-width:\s*(\d+)px\)/);
    const matches =
      (maxWidthMatch ? width <= Number.parseInt(maxWidthMatch[1] ?? "0", 10) : true) &&
      (minWidthMatch ? width >= Number.parseInt(minWidthMatch[1] ?? "0", 10) : true);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}
export function mountApp(pathname: string) {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("openclaw-app") as OpenClawApp;
  document.body.append(app);
  app.connected = true;
  app.requestUpdate();
  return app;
}

export function registerAppMountHooks() {
  beforeEach(async () => {
    const localStorage = createStorageMock();
    const sessionStorage = createStorageMock();
    const matchMedia = createMatchMediaMock(390);
    window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("sessionStorage", sessionStorage);
    vi.stubGlobal("matchMedia", matchMedia);
    Object.defineProperty(window, "localStorage", {
      value: localStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "sessionStorage", {
      value: sessionStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "matchMedia", {
      value: matchMedia,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerWidth", {
      value: 390,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 844,
      writable: true,
      configurable: true,
    });
    getSafeLocalStorage()?.clear();
    getSafeSessionStorage()?.clear();
    document.body.innerHTML = "";
    await i18n.setLocale("en");
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    );
  });

  afterEach(async () => {
    window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
    getSafeLocalStorage()?.clear();
    getSafeSessionStorage()?.clear();
    document.body.innerHTML = "";
    await i18n.setLocale("en");
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
