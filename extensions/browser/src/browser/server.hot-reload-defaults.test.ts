import { describe, expect, it } from "vitest";
import {
  getBrowserControlServerBaseUrl,
  getBrowserControlServerTestState,
  installBrowserControlServerHooks,
  setBrowserControlServerProfiles,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

describe("browser control server default profile reload", () => {
  installBrowserControlServerHooks();

  it("uses a changed default on the first request through the same HTTP server", async () => {
    const state = getBrowserControlServerTestState();
    const profiles = {
      ...state.cfgProfiles,
      work: { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC" },
    };
    setBrowserControlServerProfiles(profiles, "openclaw");
    const server = await startBrowserControlServerFromConfig();
    const fetch = getBrowserTestFetch();
    const base = getBrowserControlServerBaseUrl();

    for (const defaultProfile of ["openclaw", "work", "openclaw"]) {
      setBrowserControlServerProfiles(profiles, defaultProfile);
      const response = await fetch(`${base}/`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ profile: defaultProfile });
      expect(await startBrowserControlServerFromConfig()).toBe(server);
    }
  });
});
