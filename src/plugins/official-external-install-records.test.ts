import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  isTrustedOfficialPluginInstallRecord,
  resolveTrustedSourceLinkedOfficialClawHubInstall,
  resolveTrustedSourceLinkedOfficialNpmInstall,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";

describe("official plugin install trust", () => {
  const packageName = "@openclaw/fish-audio-speech";
  const npmRecord: PluginInstallRecord = {
    source: "npm",
    spec: `${packageName}@2026.7.2`,
    resolvedName: packageName,
    resolvedSpec: `${packageName}@2026.7.2`,
  };

  it.each(["fish-audio-speech", "fish-audio"])(
    "binds canonical and declared legacy id %s to the actual official package",
    (pluginId) => {
      expect(
        isTrustedOfficialPluginInstallRecord({ pluginId, packageName, record: npmRecord }),
      ).toBe(true);
    },
  );

  it.each([
    { pluginId: "fish-audio-speech", packageName: undefined },
    { pluginId: "unrelated-plugin", packageName },
    { pluginId: "fish-audio-speech", packageName: "@vendor/fish-audio-speech" },
    { pluginId: "unlisted", packageName: "@openclaw/unlisted" },
  ])("rejects an unbound catalog identity $pluginId / $packageName", (identity) => {
    expect(isTrustedOfficialPluginInstallRecord({ ...identity, record: npmRecord })).toBe(false);
  });

  it.each([
    { spec: "@vendor/fish-audio-speech" },
    { resolvedName: "@vendor/fish-audio-speech" },
    { resolvedSpec: "@vendor/fish-audio-speech@1.0.0" },
    { clawhubPackage: "@vendor/fish-audio-speech" },
    { spec: "file:/tmp/official.tgz" },
    { resolvedName: `${packageName}@2026.7.2` },
    { spec: undefined, resolvedName: undefined, resolvedSpec: undefined },
    { artifactKind: "npm-pack" },
    { sourcePath: "/tmp/official" },
    { source: "path" },
  ] satisfies Partial<PluginInstallRecord>[])(
    "rejects unsupported npm provenance %j",
    (override) => {
      expect(
        isTrustedOfficialPluginInstallRecord({
          pluginId: "fish-audio-speech",
          packageName,
          record: { ...npmRecord, ...override },
        }),
      ).toBe(false);
    },
  );

  it.each([
    { spec: undefined, resolvedSpec: undefined },
    { spec: undefined, resolvedName: undefined },
  ])("accepts consistent legacy npm resolution evidence %j", (override) => {
    expect(
      isTrustedOfficialPluginInstallRecord({
        pluginId: "fish-audio-speech",
        packageName,
        record: { ...npmRecord, ...override },
      }),
    ).toBe(true);
  });

  it.each([
    { name: "default official host", overrides: {}, trusted: true },
    { name: "missing authority", overrides: { clawhubUrl: undefined }, trusted: false },
    { name: "custom host", overrides: { clawhubUrl: "https://example.invalid" }, trusted: false },
    { name: "community channel", overrides: { clawhubChannel: "community" }, trusted: false },
    { name: "conflicting resolution", overrides: { resolvedName: "@vendor/acpx" }, trusted: false },
    {
      name: "resolved identity alone",
      overrides: { spec: undefined, clawhubPackage: undefined },
      trusted: false,
    },
  ] satisfies Array<{
    name: string;
    overrides: Partial<PluginInstallRecord>;
    trusted: boolean;
  }>)("requires current ClawHub authority: $name", ({ overrides, trusted }) => {
    expect(
      isTrustedOfficialPluginInstallRecord({
        pluginId: "acpx",
        packageName: "@openclaw/acpx",
        record: {
          source: "clawhub",
          spec: "clawhub:@openclaw/acpx",
          clawhubPackage: "@openclaw/acpx",
          clawhubUrl: "https://clawhub.ai",
          clawhubChannel: "official",
          resolvedName: "@openclaw/acpx",
          ...overrides,
        },
      }),
    ).toBe(trusted);
  });
});

describe("trusted official npm install records", () => {
  it("resolves an exact canonical catalog package", () => {
    const record = {
      source: "npm" as const,
      spec: "@openclaw/acpx@2026.7.2",
      resolvedName: "@openclaw/acpx",
      resolvedSpec: "@openclaw/acpx@2026.7.2",
    };

    expect(resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId: "acpx", record })).toBe(
      "@openclaw/acpx",
    );
    expect(resolveTrustedSourceLinkedOfficialNpmInstall({ pluginId: "acpx", record })).toEqual({
      npmSpec: "@openclaw/acpx",
      pluginId: "acpx",
    });
  });

  it.each([
    {
      name: "missing requested spec",
      record: {
        source: "npm" as const,
        resolvedName: "@openclaw/acpx",
      },
    },
    {
      name: "resolved-spec-only evidence",
      record: {
        source: "npm" as const,
        resolvedSpec: "@openclaw/acpx@2026.7.2",
      },
    },
    {
      name: "resolved-name evidence with unrelated stale fields",
      record: {
        source: "npm" as const,
        spec: "@vendor/acpx@1.0.0",
        resolvedName: "@openclaw/acpx",
        resolvedSpec: "@vendor/acpx@1.0.0",
      },
    },
  ])("preserves canonical official updates for $name", ({ record }) => {
    expect(resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId: "acpx", record })).toBe(
      "@openclaw/acpx",
    );
  });

  it("returns a replacement only for a catalog-declared legacy id", () => {
    const record = {
      source: "npm" as const,
      spec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
      resolvedName: "@openclaw/fish-audio-speech",
      resolvedSpec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
    };

    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "fish-audio",
        record,
      }),
    ).toEqual({
      npmSpec: "@openclaw/fish-audio-speech",
      pluginId: "fish-audio-speech",
      replacementPluginId: "fish-audio-speech",
    });
    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "unrelated-plugin",
        record,
      }),
    ).toBeUndefined();
  });

  it("fails closed when recorded npm identities disagree", () => {
    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "fish-audio",
        record: {
          source: "npm",
          spec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
          resolvedName: "@vendor/fish-audio-speech",
          resolvedSpec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
        },
      }),
    ).toBeUndefined();
  });

  it("never accepts the legacy Fish Audio id through ClawHub", () => {
    expect(
      resolveTrustedSourceLinkedOfficialClawHubInstall({
        pluginId: "fish-audio",
        record: {
          source: "clawhub",
          spec: "clawhub:@openclaw/fish-audio-speech",
          clawhubPackage: "@openclaw/fish-audio-speech",
          clawhubChannel: "official",
          clawhubUrl: "https://clawhub.ai",
        },
      }),
    ).toBeUndefined();
  });
});
