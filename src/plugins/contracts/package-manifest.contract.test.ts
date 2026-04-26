import { describePackageManifestContract } from "../../../test/helpers/plugins/package-manifest-contract.js";

type PackageManifestContractParams = Parameters<typeof describePackageManifestContract>[0];

const packageManifestContractTests: PackageManifestContractParams[] = [
  { pluginId: "bluebubbles", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "discord",
    pluginLocalRuntimeDeps: [
      "@buape/carbon",
      "@discordjs/voice",
      "discord-api-types",
      "opusscript",
    ],
    mirroredRootRuntimeDeps: ["https-proxy-agent"],
    minHostVersionBaseline: "2026.3.22",
  },
  {
    pluginId: "feishu",
    pluginLocalRuntimeDeps: ["@larksuiteoapi/node-sdk"],
    mirroredRootRuntimeDeps: ["typebox"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "google", pluginLocalRuntimeDeps: ["@google/genai"] },
  {
    pluginId: "google-meet",
    mirroredRootRuntimeDeps: ["commander", "typebox"],
  },
  {
    pluginId: "googlechat",
    pluginLocalRuntimeDeps: ["gaxios", "google-auth-library"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "irc", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "line", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "amazon-bedrock",
    pluginLocalRuntimeDeps: [
      "@aws-sdk/client-bedrock",
      "@aws-sdk/client-bedrock-runtime",
      "@aws-sdk/credential-provider-node",
    ],
  },
  {
    pluginId: "amazon-bedrock-mantle",
    pluginLocalRuntimeDeps: ["@aws/bedrock-token-generator"],
  },
  {
    pluginId: "diffs",
    pluginLocalRuntimeDeps: ["@pierre/diffs", "@pierre/theme", "playwright-core"],
    mirroredRootRuntimeDeps: ["typebox"],
  },
  {
    pluginId: "matrix",
    pluginLocalRuntimeDeps: [
      "@matrix-org/matrix-sdk-crypto-nodejs",
      "@matrix-org/matrix-sdk-crypto-wasm",
      "fake-indexeddb",
      "matrix-js-sdk",
      "music-metadata",
    ],
    mirroredRootRuntimeDeps: ["markdown-it"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "mattermost", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "memory-lancedb",
    pluginLocalRuntimeDeps: ["@lancedb/lancedb"],
    mirroredRootRuntimeDeps: ["typebox", "openai"],
    minHostVersionBaseline: "2026.3.22",
  },
  {
    pluginId: "msteams",
    pluginLocalRuntimeDeps: [
      "@azure/identity",
      "@microsoft/teams.api",
      "@microsoft/teams.apps",
      "express",
      "jsonwebtoken",
      "jwks-rsa",
    ],
    mirroredRootRuntimeDeps: ["typebox"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "nextcloud-talk", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "nostr",
    pluginLocalRuntimeDeps: ["nostr-tools"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "openshell", pluginLocalRuntimeDeps: ["openshell"] },
  {
    pluginId: "qqbot",
    pluginLocalRuntimeDeps: ["@tencent-connect/qqbot-connector", "mpg123-decoder", "silk-wasm"],
    mirroredRootRuntimeDeps: ["ws"],
  },
  {
    pluginId: "slack",
    pluginLocalRuntimeDeps: ["@slack/bolt", "@slack/web-api"],
    mirroredRootRuntimeDeps: ["https-proxy-agent"],
  },
  { pluginId: "synology-chat", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "telegram",
    pluginLocalRuntimeDeps: ["@grammyjs/runner", "@grammyjs/transformer-throttler", "grammy"],
  },
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
