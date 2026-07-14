import { afterEach, describe, expect, it } from "vitest";
import "./browser-panel.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

describe("normalizeBrowserUrlDraft", () => {
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
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
    const panel = element as unknown as HTMLElement & { updateComplete: Promise<unknown> };
    await panel.updateComplete;
    expect((panel as unknown as { open: boolean }).open).toBe(true);
  });
});
