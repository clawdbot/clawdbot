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

  it("targets the exact core version for a stable version-bound plugin", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/codex",
        updateChannel: "stable",
        officialPackageName: "@openclaw/codex",
        coreVersion: "2026.8.1",
        versionBoundToCore: true,
      }),
    ).toEqual({
      installSpec: "@openclaw/codex@2026.8.1",
      recordSpec: "@openclaw/codex",
    });
  });

  it.each([
    { channel: "stable" as const, expectedVersion: "2026.7.1" },
    { channel: "extended-stable" as const, expectedVersion: "2026.7.1" },
  ])("preserves the $channel release-cohort contract", ({ channel, expectedVersion }) => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/codex",
        updateChannel: channel,
        officialPackageName: "@openclaw/codex",
        coreVersion: "2026.7.1-2",
        versionBoundToCore: true,
      }),
    ).toEqual({
      installSpec: `@openclaw/codex@${expectedVersion}`,
      recordSpec: "@openclaw/codex",
    });
  });

  it.each([false, true])(
    "targets the installed beta core (version-bound=%s)",
    (versionBoundToCore) => {
      expect(
        resolveNpmInstallSpecsForUpdateChannel({
          spec: "@openclaw/codex@latest",
          updateChannel: "beta",
          officialPackageName: "@openclaw/codex",
          coreVersion: "2026.8.1-beta.3",
          versionBoundToCore,
        }),
      ).toEqual({
        installSpec: "@openclaw/codex@2026.8.1-beta.3",
        recordSpec: "@openclaw/codex@latest",
        fallbackSpec: "@openclaw/codex@latest",
        fallbackLabel: "@openclaw/codex@2026.8.1-beta.3",
      });
    },
  );

  it.each([
    { spec: "@openclaw/discord", channel: "stable" as const, target: "@openclaw/discord" },
    { spec: "@openclaw/discord", channel: "dev" as const, target: "@openclaw/discord" },
    { spec: "@openclaw/discord@next", channel: "beta" as const, target: "@openclaw/discord@next" },
    { spec: "@openclaw/discord@beta", channel: "beta" as const, target: "@openclaw/discord@beta" },
    {
      spec: "@openclaw/discord@2026.7.1",
      channel: "beta" as const,
      target: "@openclaw/discord@2026.7.1",
    },
  ])("preserves $channel selection for $spec on a beta core", ({ spec, channel, target }) => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec,
        updateChannel: channel,
        officialPackageName: "@openclaw/discord",
        coreVersion: "2026.8.1-beta.3",
      }),
    ).toEqual({ installSpec: target, recordSpec: spec });
  });

  it.each([
    { spec: "@acme/discord", coreVersion: "2026.8.1-beta.3" },
    { spec: "@openclaw/discord", coreVersion: "2026.8.1" },
    { spec: "@openclaw/discord", coreVersion: undefined },
  ])("keeps moving beta selection for $spec with core $coreVersion", ({ spec, coreVersion }) => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec,
        updateChannel: "beta",
        officialPackageName: "@openclaw/discord",
        coreVersion,
      }),
    ).toEqual({
      installSpec: `${spec}@beta`,
      recordSpec: spec,
      fallbackSpec: spec,
      fallbackLabel: `${spec}@beta`,
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
