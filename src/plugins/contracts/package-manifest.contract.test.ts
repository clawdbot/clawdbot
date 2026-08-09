import { describePackageManifestContract } from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { validatePackageExtensionEntriesForInstall } from "../package-entry-resolution.js";
import {
  getPackageManifestMetadata,
  resolvePackageExtensionEntries,
  type PackageManifest,
} from "../package-manifest.js";

// Package manifest contract tests cover plugin package manifest requirements.
type PackageManifestContractParams = Parameters<typeof describePackageManifestContract>[0];

const packageManifestContractTests: PackageManifestContractParams[] = [
  {
    pluginId: "buzz",
    pluginLocalRuntimeDeps: ["nostr-tools"],
    minHostVersionBaseline: "2026.7.2",
  },
  {
    pluginId: "discord",
    pluginLocalRuntimeDeps: ["@discordjs/voice", "discord-api-types", "libopus-wasm"],
    minHostVersionBaseline: "2026.3.22",
  },
  {
    pluginId: "feishu",
    pluginLocalRuntimeDeps: ["@larksuiteoapi/node-sdk"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "google" },
  { pluginId: "google-meet" },
  {
    pluginId: "googlechat",
    pluginLocalRuntimeDeps: ["google-auth-library"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "irc", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "line", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "amazon-bedrock" },
  { pluginId: "amazon-bedrock-mantle" },
  {
    pluginId: "diffs",
    pluginLocalRuntimeDeps: ["@pierre/diffs"],
  },
  { pluginId: "file-transfer" },
  {
    pluginId: "matrix",
    pluginLocalRuntimeDeps: [
      "@matrix-org/matrix-sdk-crypto-nodejs",
      "@matrix-org/matrix-sdk-crypto-wasm",
      "fake-indexeddb",
      "matrix-js-sdk",
      "music-metadata",
    ],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "mattermost", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "memory-lancedb",
    pluginLocalRuntimeDeps: ["@lancedb/lancedb", "apache-arrow"],
    minHostVersionBaseline: "2026.3.22",
  },
  {
    pluginId: "msteams",
    pluginLocalRuntimeDeps: ["@azure/identity", "@microsoft/teams.apps"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "nextcloud-talk", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "nostr",
    pluginLocalRuntimeDeps: ["nostr-tools"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "openshell" },
  {
    pluginId: "qqbot",
    pluginLocalRuntimeDeps: ["@tencent-connect/qqbot-connector", "mpg123-decoder", "silk-wasm"],
  },
  { pluginId: "slack" },
  { pluginId: "synology-chat", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "telegram" },
  { pluginId: "tlon", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "tokenjuice", pluginLocalRuntimeDeps: ["tokenjuice"] },
  { pluginId: "twitch", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "voice-call", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "whatsapp",
    pluginLocalRuntimeDeps: ["audio-decode", "baileys"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "xiaomi", minHostVersionBaseline: "2026.7.2" },
  { pluginId: "zalo", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "zalouser", minHostVersionBaseline: "2026.3.22" },
];

for (const params of packageManifestContractTests) {
  describePackageManifestContract(params);
}

describe("plugin package authoring metadata", () => {
  it("exposes the declared discovery and release entrypoints", () => {
    const manifest: PackageManifest = {
      name: "@openclaw/example",
      version: "1.2.3",
      openclaw: {
        extensions: ["./src/index.ts"],
        runtimeExtensions: ["./dist/index.js"],
        setupEntry: "./src/setup.ts",
        runtimeSetupEntry: "./dist/setup.js",
        plugin: {
          id: "example",
          label: "Example",
        },
        compat: {
          pluginApi: ">=1",
          minGatewayVersion: "2026.8.1",
        },
        install: {
          npmSpec: "@openclaw/example",
          minHostVersion: "2026.8.1",
        },
      },
    };

    expect(getPackageManifestMetadata(manifest)).toEqual(manifest.openclaw);
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "ok",
      entries: ["./src/index.ts"],
    });
  });

  it.each([
    {
      name: "non-object openclaw metadata",
      manifest: { openclaw: "invalid" } as unknown as PackageManifest,
      error: "package.json openclaw must be an object",
    },
    {
      name: "non-array extension metadata",
      manifest: { openclaw: { extensions: "./index.js" } } as unknown as PackageManifest,
      error: "package.json openclaw.extensions must be an array",
    },
    {
      name: "blank extension metadata",
      manifest: { openclaw: { extensions: [" "] } } as PackageManifest,
      error: "package.json openclaw.extensions[0] must be a non-empty string",
    },
  ])("fails fast on $name", ({ manifest, error }) => {
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "invalid",
      entries: [],
      error,
    });
  });

  it("rejects inconsistent source and runtime extension metadata", async () => {
    const result = await validatePackageExtensionEntriesForInstall({
      packageDir: process.cwd(),
      extensions: ["./src/one.ts", "./src/two.ts"],
      manifest: {
        openclaw: {
          extensions: ["./src/one.ts", "./src/two.ts"],
          runtimeExtensions: ["./dist/one.js"],
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error:
        "package.json openclaw.runtimeExtensions length (1) must match openclaw.extensions length (2)",
    });
  });

  it("rejects a runtime setup entry without a source setup entry", async () => {
    const result = await validatePackageExtensionEntriesForInstall({
      packageDir: process.cwd(),
      extensions: [],
      manifest: {
        openclaw: {
          extensions: [],
          runtimeSetupEntry: "./dist/setup.js",
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "package.json openclaw.runtimeSetupEntry requires openclaw.setupEntry",
    });
  });
});
