import { describe, expect, it } from "vitest";
import {
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";

describe("resolveNpmInstallSpecsForUpdateChannel", () => {
  it.each(["@openclaw/discord", "@openclaw/discord@latest"])(
    "targets the exact core version for official extended-stable intent %s",
    (spec) => {
      expect(
        resolveNpmInstallSpecsForUpdateChannel({
          spec,
          updateChannel: "extended-stable",
          officialPackageName: "@openclaw/discord",
          coreVersion: "2026.7.33",
        }),
      ).toEqual({
        installSpec: "@openclaw/discord@2026.7.33",
        recordSpec: spec,
      });
    },
  );

  it.each([
    "@openclaw/discord@2026.6.33",
    "@openclaw/discord@next",
    "@openclaw/discord@beta",
    "@openclaw/discord@^2026.6.0",
    "https://registry.example.test/discord.tgz",
  ])("preserves explicit extended-stable intent %s", (spec) => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec,
        updateChannel: "extended-stable",
        officialPackageName: "@openclaw/discord",
        coreVersion: "2026.7.33",
      }),
    ).toEqual({ installSpec: spec, recordSpec: spec });
  });

  it("does not rewrite a third-party package", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@acme/discord",
        updateChannel: "extended-stable",
        officialPackageName: "@openclaw/discord",
        coreVersion: "2026.7.33",
      }),
    ).toEqual({ installSpec: "@acme/discord", recordSpec: "@acme/discord" });
  });

  it("fails closed without an authoritative extended-stable core version", () => {
    expect(() =>
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/discord",
        updateChannel: "extended-stable",
        officialPackageName: "@openclaw/discord",
      }),
    ).toThrow("requires an exact core version");
  });

  it("preserves beta behavior", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/discord@latest",
        updateChannel: "beta",
        officialPackageName: "@openclaw/discord",
        coreVersion: "2026.7.33",
      }),
    ).toEqual({
      installSpec: "@openclaw/discord@beta",
      recordSpec: "@openclaw/discord@latest",
      fallbackSpec: "@openclaw/discord@latest",
      fallbackLabel: "@openclaw/discord@beta",
    });
  });
});

describe("resolveClawHubInstallSpecsForUpdateChannel", () => {
  it("does not rewrite ClawHub on extended-stable", () => {
    expect(
      resolveClawHubInstallSpecsForUpdateChannel({
        spec: "clawhub:@openclaw/discord",
        updateChannel: "extended-stable",
      }),
    ).toEqual({
      installSpec: "clawhub:@openclaw/discord",
      recordSpec: "clawhub:@openclaw/discord",
    });
  });
});
