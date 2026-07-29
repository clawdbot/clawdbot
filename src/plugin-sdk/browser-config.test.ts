// Browser config tests cover plugin browser configuration defaults and overrides.
import { describe, expect, it } from "vitest";
import type { BrowserControlAuth } from "./browser-config.js";
import {
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  parseBrowserHttpUrl,
} from "./browser-config.js";

describe("plugin-sdk browser-config", () => {
  it("keeps legacy browser-config exports available", () => {
    const auth: BrowserControlAuth = { token: "test-token" };
    const parsed = parseBrowserHttpUrl("http://127.0.0.1:9222/", "browser.cdpUrl");

    expect(DEFAULT_OPENCLAW_BROWSER_ENABLED).toBe(true);
    expect(DEFAULT_BROWSER_DEFAULT_PROFILE_NAME).toBe("openclaw");
    expect(auth.token).toBe("test-token");
    expect(parsed.port).toBe(9222);
    expect(parsed.normalized).toBe("http://127.0.0.1:9222");
  });
});
