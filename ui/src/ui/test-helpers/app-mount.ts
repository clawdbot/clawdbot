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

const mountedApps = new Set<OpenClawApp>();

function collectMountedApps() {
  return new Set<OpenClawApp>([
    ...mountedApps,
    ...document.querySelectorAll<OpenClawApp>("openclaw-app"),
  ]);
}

function nextMicrotask() {
  return Promise.resolve();
}

function nextTimer() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    if (typeof window.requestAnimationFrame !== "function") {
      window.setTimeout(resolve, 0);
      return;
    }
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForAppUpdates(apps: Iterable<OpenClawApp>) {
  for (const app of apps) {
    await app.updateComplete;
  }
}

async function drainAppWork(apps: Iterable<OpenClawApp>) {
  const snapshot = [...apps];
  await nextMicrotask();
  await waitForAppUpdates(snapshot);
  await nextFrame();
  await nextMicrotask();
  await nextFrame();
  await nextMicrotask();
  await waitForAppUpdates(snapshot);
  await nextTimer();
  await nextMicrotask();
  await waitForAppUpdates(snapshot);
}

async function cleanupMountedApps() {
  const apps = collectMountedApps();
  await drainAppWork(apps);
  for (const app of apps) {
    app.remove();
  }
  document.body.replaceChildren();
  mountedApps.clear();
  await drainAppWork(apps);
}

export function mountApp(pathname: string) {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("openclaw-app") as OpenClawApp;
  mountedApps.add(app);
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
    await cleanupMountedApps();
    window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
    getSafeLocalStorage()?.clear();
    getSafeSessionStorage()?.clear();
    await i18n.setLocale("en");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await nextTimer();
    await nextMicrotask();
  });
}
