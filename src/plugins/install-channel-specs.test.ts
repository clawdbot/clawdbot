import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNpmSpecMetadata } from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import {
  installWithSourceFallback,
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";

vi.mock("../infra/install-source-utils.js", () => ({ resolveNpmSpecMetadata: vi.fn() }));

beforeEach(() => {
  vi.mocked(resolveNpmSpecMetadata).mockReset();
});

describe("installWithSourceFallback", () => {
  it.each(["notarget", "etarget"])(
    "keeps an integrity refusal terminal for package %s",
    async (name) => {
      const spec = `@synthetic/${name}@1.0.0`;
      const refusal = await resolveNpmIntegrityDriftWithDefaultMessage({
        spec,
        expectedIntegrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        resolution: {
          resolvedSpec: spec,
          integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
        },
        onIntegrityDrift: () => false,
      });
      expect(refusal.error).toContain("aborted: npm package integrity drift");
      const attempted: string[] = [];
      const result = await installWithSourceFallback({
        sources: [
          { source: "npm", spec },
          { source: "clawhub", spec: `clawhub:${name}@1.0.0` },
        ],
        install: async ({ source }) => {
          attempted.push(source);
          return source === "npm" ? { ok: false, error: refusal.error } : { ok: true };
        },
        result: (attempt) => attempt,
        onFallback: () => {},
      });
      expect(result.attempt).toEqual({ ok: false, error: refusal.error });
      expect(attempted).toEqual(["npm"]);
    },
  );
});

describe("resolveNpmInstallSpecsForUpdateChannel", () => {
  it.each([
    {
      channel: "extended-stable" as const,
      versionBoundToCore: false,
      coreVersion: "2026.7.33",
      expectedVersion: "2026.7.33",
    },
    {
      channel: "stable" as const,
      versionBoundToCore: true,
      coreVersion: "2026.8.1",
      expectedVersion: "2026.8.1",
    },
    {
      channel: "stable" as const,
      versionBoundToCore: true,
      coreVersion: "2026.7.1-2",
      expectedVersion: "2026.7.1",
    },
    {
      channel: "extended-stable" as const,
      versionBoundToCore: true,
      coreVersion: "2026.7.1-2",
      expectedVersion: "2026.7.1",
    },
  ])(
    "preserves the $channel release-cohort contract for $coreVersion",
    async ({ channel, versionBoundToCore, coreVersion, expectedVersion }) => {
      for (const spec of ["@openclaw/codex", "@openclaw/codex@latest"]) {
        expect(
          await resolveNpmInstallSpecsForUpdateChannel({
            spec,
            updateChannel: channel,
            officialPackageName: "@openclaw/codex",
            coreVersion,
            versionBoundToCore,
          }),
        ).toEqual({ installSpec: `@openclaw/codex@${expectedVersion}`, recordSpec: spec });
      }
      expect(resolveNpmSpecMetadata).not.toHaveBeenCalled();
    },
  );

  it.each(["2026.6.33", "next", "^2026.6.0"])(
    "preserves an explicit selector %s on beta",
    async (selector) => {
      const spec = `@openclaw/codex@${selector}`;
      expect(
        await resolveNpmInstallSpecsForUpdateChannel({
          spec,
          updateChannel: "beta",
          officialPackageName: "@openclaw/codex",
          coreVersion: "2026.8.1-beta.3",
        }),
      ).toEqual({ installSpec: spec, recordSpec: spec });
      expect(resolveNpmSpecMetadata).not.toHaveBeenCalled();
    },
  );

  it.each(["stable", "dev", "extended-stable"] as const)(
    "preserves explicit beta on %s",
    async (updateChannel) => {
      const spec = "@openclaw/codex@beta";
      expect(
        await resolveNpmInstallSpecsForUpdateChannel({
          spec,
          updateChannel,
          officialPackageName: "@openclaw/codex",
          coreVersion: "2026.8.1-beta.3",
        }),
      ).toEqual({ installSpec: spec, recordSpec: spec });
    },
  );

  it("does not rewrite a third-party extended-stable package", async () => {
    expect(
      await resolveNpmInstallSpecsForUpdateChannel({
        spec: "@acme/discord",
        updateChannel: "extended-stable",
        officialPackageName: "@openclaw/discord",
        coreVersion: "2026.7.33",
      }),
    ).toEqual({ installSpec: "@acme/discord", recordSpec: "@acme/discord" });
  });

  it("fails closed without an authoritative extended-stable core version", async () => {
    await expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/codex",
        updateChannel: "extended-stable",
        officialPackageName: "@openclaw/codex",
      }),
    ).rejects.toThrow("requires an exact core version");
  });

  it.each([
    {
      beta: "2026.9.1-beta.1",
      latest: "2026.9.2",
      expected: "2026.9.2",
      tag: "latest",
      reason: "tag-behind-latest",
    },
    { beta: "2026.9.3-beta.1", latest: "2026.9.2", expected: "2026.9.3-beta.1", tag: "beta" },
    { beta: "2026.9.2", latest: "2026.9.2", expected: "2026.9.2", tag: "beta" },
    { beta: null, latest: "2026.9.2", expected: "2026.9.2", tag: "latest" },
    { beta: "2026.9.3-beta.1", latest: null, expected: "2026.9.3-beta.1", tag: "beta" },
  ])(
    "selects $expected from beta=$beta latest=$latest before installation",
    async ({ beta, latest, expected, tag, reason }) => {
      vi.mocked(resolveNpmSpecMetadata).mockImplementation(async ({ spec }) => {
        const version = spec.endsWith("@beta") ? beta : latest;
        return version
          ? {
              ok: true,
              metadata: {
                name: "@openclaw/codex",
                version,
                resolvedSpec: `@openclaw/codex@${version}`,
                integrity: `sha512-${version}`,
              },
            }
          : { ok: false, error: "Package not found on npm" };
      });
      for (const spec of ["@openclaw/codex", "@openclaw/codex@latest", "@openclaw/codex@beta"]) {
        const result = await resolveNpmInstallSpecsForUpdateChannel({
          spec,
          updateChannel: "beta",
          officialPackageName: "@openclaw/codex",
          coreVersion: "2026.9.1-beta.1",
          versionBoundToCore: true,
        });
        expect(result).toEqual({
          installSpec: `@openclaw/codex@${expected}`,
          recordSpec: spec,
          npmResolution: {
            name: "@openclaw/codex",
            version: expected,
            resolvedSpec: `@openclaw/codex@${expected}`,
            integrity: `sha512-${expected}`,
          },
          channelTag: tag,
          ...(reason ? { channelReason: reason } : {}),
        });
      }
    },
  );

  it("leaves missing packages to the install owner's declared-source fallback", async () => {
    vi.mocked(resolveNpmSpecMetadata).mockResolvedValue({
      ok: false,
      error: "Package not found on npm",
    });
    expect(
      await resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/codex@beta",
        updateChannel: "beta",
      }),
    ).toEqual({ installSpec: "@openclaw/codex@latest", recordSpec: "@openclaw/codex@beta" });
  });

  it.each(["beta", "latest"] as const)(
    "does not install the other tag when %s metadata fails",
    async (failedTag) => {
      vi.mocked(resolveNpmSpecMetadata).mockImplementation(async ({ spec }) =>
        spec.endsWith(`@${failedTag}`)
          ? { ok: false, category: "metadata-env", error: "Registry unavailable" }
          : { ok: true, metadata: { name: "@openclaw/codex", version: "2026.9.1-beta.1" } },
      );
      await expect(
        resolveNpmInstallSpecsForUpdateChannel({ spec: "@openclaw/codex", updateChannel: "beta" }),
      ).rejects.toThrow("Registry unavailable");
    },
  );
});

describe("resolveClawHubInstallSpecsForUpdateChannel", () => {
  it.each([
    ["stable", false, "2026.7.33", undefined],
    ["stable", true, "2026.7.33", "2026.7.33"],
    ["beta", false, "2026.7.33", "beta"],
    ["beta", false, "2026.8.1-beta.3", "beta"],
    ["beta", true, "2026.8.1-beta.3", "beta"],
    ["extended-stable", false, "2026.7.33", "2026.7.33"],
  ] as const)(
    "resolves declared ClawHub defaults on %s (bound: %s, core: %s)",
    (updateChannel, versionBoundToCore, coreVersion, selector) => {
      for (const spec of ["clawhub:@openclaw/discord", "clawhub:@openclaw/discord@latest"]) {
        const installSpec = selector ? `clawhub:@openclaw/discord@${selector}` : spec;
        expect(
          resolveClawHubInstallSpecsForUpdateChannel({
            spec,
            updateChannel,
            officialPackageName: "@openclaw/discord",
            coreVersion,
            versionBoundToCore,
          }),
        ).toEqual({
          installSpec,
          recordSpec: spec,
          ...(updateChannel === "beta" ? { fallbackSpec: spec, fallbackLabel: installSpec } : {}),
        });
      }
    },
  );

  it.each(["stable", "beta", "extended-stable"] as const)(
    "preserves exact and non-latest ClawHub selectors on %s",
    (updateChannel) => {
      for (const selector of ["2026.6.33", "next", "beta"]) {
        const spec = `clawhub:@openclaw/discord@${selector}`;
        expect(
          resolveClawHubInstallSpecsForUpdateChannel({
            spec,
            updateChannel,
            officialPackageName: "@openclaw/discord",
            coreVersion: updateChannel === "beta" ? "2026.8.1-beta.3" : "2026.7.33",
            versionBoundToCore: true,
          }),
        ).toEqual({ installSpec: spec, recordSpec: spec });
      }
    },
  );

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
