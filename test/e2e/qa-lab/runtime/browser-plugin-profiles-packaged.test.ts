import { describe, expect, it } from "vitest";
import {
  classifyBrowserPluginProfilesOutcome,
  parseBrowserPluginProfilesOptions,
} from "./browser-plugin-profiles-packaged.js";

describe("packaged browser plugin profiles evidence producer", () => {
  it("parses the scenario artifact directory", () => {
    expect(
      parseBrowserPluginProfilesOptions(["--artifact-base", ".artifacts/browser"]).artifactBase,
    ).toMatch(/\.artifacts\/browser$/u);
    expect(() => parseBrowserPluginProfilesOptions([])).toThrow(
      "usage: --artifact-base <output-directory>",
    );
  });

  it("requires a clean Docker exit and the real success marker", () => {
    expect(
      classifyBrowserPluginProfilesOutcome({
        code: 0,
        markerSeen: true,
        signal: null,
      }),
    ).toEqual({ status: "pass" });
    expect(
      classifyBrowserPluginProfilesOutcome({
        code: 0,
        markerSeen: false,
        signal: null,
      }),
    ).toEqual({
      details: "Docker producer omitted BROWSER_PLUGIN_PROFILES_PACKAGED_OK",
      status: "fail",
    });
  });

  it("records process failures", () => {
    expect(
      classifyBrowserPluginProfilesOutcome({
        code: null,
        markerSeen: false,
        signal: "SIGTERM",
      }),
    ).toEqual({
      details: "Docker producer terminated by signal SIGTERM",
      status: "fail",
    });
    expect(
      classifyBrowserPluginProfilesOutcome({
        code: 3,
        markerSeen: false,
        signal: null,
      }),
    ).toEqual({
      details: "Docker producer exited with code 3",
      status: "fail",
    });
  });
});
