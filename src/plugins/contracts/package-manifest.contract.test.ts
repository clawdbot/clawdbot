import { describePackageManifestContract } from "openclaw/plugin-sdk/plugin-test-contracts";

type PackageManifestContractParams = Parameters<typeof describePackageManifestContract>[0];

const packageManifestContractTests: PackageManifestContractParams[] = [
  { pluginId: "bluebubbles", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "discord",
    pluginLocalRuntimeDeps: ["@discordjs/voice", "discord-api-types", "opusscript"],
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
    pluginLocalRuntimeDeps: ["gaxios", "google-auth-library"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "irc", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "line", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "amazon-bedrock" },
  { pluginId: "amazon-bedrock-mantle" },
  {
    pluginId: "diffs",
    pluginLocalRuntimeDeps: ["@pierre/diffs", "@pierre/theme"],
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
    pluginLocalRuntimeDeps: ["@lancedb/lancedb"],
    minHostVersionBaseline: "2026.3.22",
  },
  {
    pluginId: "msteams",
    pluginLocalRuntimeDeps: [
      "@azure/identity",
      "@microsoft/teams.api",
      "@microsoft/teams.apps",
      "jsonwebtoken",
      "jwks-rsa",
    ],
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
  { pluginId: "twitch", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "voice-call", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "whatsapp",
    pluginLocalRuntimeDeps: ["@whiskeysockets/baileys", "jimp"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "zalo", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "zalouser", minHostVersionBaseline: "2026.3.22" },
];

for (const params of packageManifestContractTests) {
  describePackageManifestContract(params);
}
