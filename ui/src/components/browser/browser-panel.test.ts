import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./browser-panel.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

describe("normalizeBrowserUrlDraft", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
  it("prefixes bare hosts with https", () => {
    expect(normalizeBrowserUrlDraft("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrlDraft("  github.com/openclaw/openclaw ")).toBe(
      "https://github.com/openclaw/openclaw",
    );
  });

  it("keeps explicit http(s) schemes", () => {
    expect(normalizeBrowserUrlDraft("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
    expect(normalizeBrowserUrlDraft("HTTPS://example.com")).toBe("https://example.com/");
  });

  it("accepts host:port entries instead of treating the host as a scheme", () => {
    expect(normalizeBrowserUrlDraft("localhost:3000")).toBe("https://localhost:3000/");
    expect(normalizeBrowserUrlDraft("example.com:8080/path")).toBe("https://example.com:8080/path");
  });

  it("rejects empty and non-http(s) inputs", () => {
    expect(normalizeBrowserUrlDraft("   ")).toBeNull();
    expect(normalizeBrowserUrlDraft("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrlDraft("file:///etc/passwd")).toBeNull();
  });

  it("restores persisted open state when a mounted tag upgrades lazily", async () => {
    localStorage.setItem(
      "openclaw.browser.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const tagName = `test-lazy-browser-panel-${crypto.randomUUID()}`;
    const element = document.createElement(tagName) as HTMLElement & { available: boolean };
    element.available = true;
    document.body.append(element);

    const BrowserPanel = customElements.get("openclaw-browser-panel");
    if (!BrowserPanel) {
      throw new Error("expected browser panel registration");
    }
    class LazyUpgradeBrowserPanel extends BrowserPanel {}
    customElements.define(tagName, LazyUpgradeBrowserPanel);
    const panel = element as unknown as HTMLElement & {
      browserPanelIsOpen(): boolean;
      updateComplete: Promise<unknown>;
    };
    await panel.updateComplete;
    expect(panel.browserPanelIsOpen()).toBe(true);
  });

  it("mounts when ResizeObserver is unavailable", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      available: boolean;
      embedded: boolean;
      renderRoot: ShadowRoot;
      updateComplete: Promise<unknown>;
    };
    panel.available = true;
    panel.embedded = true;
    document.body.append(panel);
    await panel.updateComplete;

    expect(panel.renderRoot.querySelector(".bp")).not.toBeNull();
  });

  it("uses the shared surface empty state when the embedded browser has no tabs", async () => {
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      available: boolean;
      embedded: boolean;
      renderRoot: ShadowRoot;
      updateComplete: Promise<unknown>;
    };
    panel.available = true;
    panel.embedded = true;
    document.body.append(panel);
    await panel.updateComplete;

    const empty = panel.renderRoot.querySelector("openclaw-panel-empty-state");
    await empty?.updateComplete;
    expect(empty?.shadowRoot?.querySelector(".empty-state__title")?.textContent).toBe("Browser");
    expect(empty?.querySelector("svg")).not.toBeNull();
  });

  it("suppresses an open dock without overwriting its persisted preference", async () => {
    localStorage.setItem(
      "openclaw.browser.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      available: boolean;
      suppressed: boolean;
      renderRoot: ShadowRoot;
      updateComplete: Promise<unknown>;
    };
    panel.available = true;
    document.body.append(panel);
    await panel.updateComplete;

    expect(panel.renderRoot.querySelector(".bp")).not.toBeNull();
    panel.suppressed = true;
    await waitForFast(() => expect(panel.renderRoot.querySelector(".bp")).toBeNull());

    expect(document.documentElement.style.getPropertyValue("--oc-browser-reserve-right")).toBe(
      "0px",
    );
    expect(JSON.parse(localStorage.getItem("openclaw.browser.panel.v1") ?? "{}")).toMatchObject({
      open: true,
    });

    panel.suppressed = false;
    await waitForFast(() => expect(panel.renderRoot.querySelector(".bp")).not.toBeNull());

    expect(panel.renderRoot.querySelector(".bp")).not.toBeNull();
  });

  it("waits for availability before restoring after suppression", async () => {
    localStorage.setItem(
      "openclaw.browser.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      available: boolean;
      suppressed: boolean;
      browserPanelIsOpen(): boolean;
      updateComplete: Promise<unknown>;
    };
    panel.suppressed = true;
    document.body.append(panel);
    await panel.updateComplete;

    panel.suppressed = false;
    await panel.updateComplete;
    expect(panel.browserPanelIsOpen()).toBe(false);

    panel.available = true;
    await waitForFast(() => expect(panel.browserPanelIsOpen()).toBe(true));
  });

  it("mounts closed inside a takeover instead of refreshing a hidden dock", async () => {
    localStorage.setItem(
      "openclaw.browser.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const requests: string[] = [];
    const client = {
      request: async <T>(method: string) => {
        requests.push(method);
        return {} as T;
      },
    } as GatewayBrowserClient;
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      client: GatewayBrowserClient | null;
      available: boolean;
      suppressed: boolean;
      browserPanelIsOpen(): boolean;
      updateComplete: Promise<unknown>;
    };
    panel.client = client;
    panel.available = true;
    panel.suppressed = true;
    document.body.append(panel);
    await panel.updateComplete;
    await Promise.resolve();

    expect(panel.browserPanelIsOpen()).toBe(false);
    expect(requests).toEqual([]);

    panel.suppressed = false;
    await waitForFast(() => expect(panel.browserPanelIsOpen()).toBe(true));
  });

  it("keeps an already closed panel closed for an explicit close request", () => {
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      available: boolean;
      browserPanelIsOpen: () => boolean;
      handleToggleRequest: (event: Event) => void;
    };
    panel.available = true;
    document.body.append(panel);

    panel.handleToggleRequest(
      new CustomEvent("openclaw:browser-toggle", { detail: { open: false } }),
    );

    expect(panel.browserPanelIsOpen()).toBe(false);
  });

  it("treats an embedded panel as open only while it is presented", async () => {
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      embedded: boolean;
      presented: boolean;
      browserPanelIsOpen: () => boolean;
      updateComplete: Promise<unknown>;
    };
    panel.embedded = true;
    document.body.append(panel);
    await panel.updateComplete;

    expect(panel.browserPanelIsOpen()).toBe(false);
    panel.presented = true;
    await panel.updateComplete;
    expect(panel.browserPanelIsOpen()).toBe(true);
    panel.presented = false;
    await panel.updateComplete;
    expect(panel.browserPanelIsOpen()).toBe(false);
  });

  it("starts a fresh browser tab draft when an embedded panel receives a new-tab request", async () => {
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      available: boolean;
      embedded: boolean;
      presented: boolean;
      handleToggleRequest: (event: Event) => void;
      renderRoot: ShadowRoot;
      updateComplete: Promise<unknown>;
    };
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    document.body.append(panel);
    await panel.updateComplete;

    panel.handleToggleRequest(
      new CustomEvent("openclaw:browser-toggle", { detail: { open: true, newTab: true } }),
    );
    await panel.updateComplete;
    await Promise.resolve();

    expect(panel.renderRoot.activeElement).toBe(panel.renderRoot.querySelector(".bp-url"));
  });
});
