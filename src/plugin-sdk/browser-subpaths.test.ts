// Browser subpath tests cover plugin SDK browser subpath exports and lazy boundaries.
import { describe, expect, it } from "vitest";
import { parseBrowserHttpUrl, redactCdpUrl } from "./browser-cdp.js";
import { resolveBrowserControlAuth } from "./browser-control-auth.js";
import {
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  resolveBrowserConfig,
} from "./browser-profiles.js";

describe("plugin-sdk browser subpaths", () => {
  it("keeps browser profile helpers available on the narrow subpath", () => {
    expect(DEFAULT_OPENCLAW_BROWSER_ENABLED).toBe(true);
    expect(DEFAULT_BROWSER_DEFAULT_PROFILE_NAME).toBe("openclaw");
    expect(resolveBrowserConfig).toBeTypeOf("function");
  });

  it("parses and redacts CDP urls on the dedicated CDP subpath", () => {
    const parsed = parseBrowserHttpUrl("http://user:pass@127.0.0.1:9222/", "browser.cdpUrl");
    expect(parsed.port).toBe(9222);
    expect(redactCdpUrl(parsed.normalized)).toBe("http://127.0.0.1:9222");
    expect(redactCdpUrl("wss://browser.example/cdp?token=browser-token&view=full")).toBe(
      "wss://browser.example/cdp?token=***&view=full",
    );
  });

  it("preserves explicit default ports and rejects explicit port zero", () => {
    const parsed = parseBrowserHttpUrl("http://127.0.0.1:80/json/version", "browser.cdpUrl");
    expect(parsed.hasExplicitPort).toBe(true);
    expect(parsed.normalizedWithPort).toBe("http://127.0.0.1:80/json/version");
    expect(() => parseBrowserHttpUrl("http://127.0.0.1:0", "browser.cdpUrl")).toThrow(
      /invalid port/,
    );
  });

  it("resolves browser control auth on the dedicated auth subpath", () => {
    expect(resolveBrowserControlAuth).toBeTypeOf("function");
  });
});
