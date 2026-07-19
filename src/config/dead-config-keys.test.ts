// Verifies schema-only config keys stay outside the canonical config contract.
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

function expectUnknownKey(params: { config: Record<string, unknown>; path: string; key: string }) {
  const result = validateConfigObjectRaw(params.config, { validateBundledChannels: true });
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  const issue = result.issues.find(
    (candidate) =>
      candidate.path === params.path &&
      (candidate.message.includes(`Unrecognized key: "${params.key}"`) ||
        candidate.message.includes(`must not have additional properties: "${params.key}"`)),
  );
  if (!issue) {
    throw new Error(`Expected unknown ${params.path}.${params.key} validation issue`);
  }
}

describe("dead config keys", () => {
  it.each([
    ["Discord root", "discord", { dm: { policy: "pairing" } }, "channels.discord.dm", "policy"],
    [
      "Discord account",
      "discord",
      { accounts: { work: { dm: { allowFrom: ["1"] } } } },
      "channels.discord.accounts.work.dm",
      "allowFrom",
    ],
    ["Slack root", "slack", { dm: { policy: "pairing" } }, "channels.slack.dm", "policy"],
    [
      "Slack account",
      "slack",
      { accounts: { work: { dm: { allowFrom: ["U1"] } } } },
      "channels.slack.accounts.work.dm",
      "allowFrom",
    ],
    [
      "Google Chat root",
      "googlechat",
      { dm: { policy: "pairing" } },
      "channels.googlechat.dm",
      "policy",
    ],
    [
      "Google Chat account",
      "googlechat",
      { accounts: { work: { dm: { allowFrom: ["users/1"] } } } },
      "channels.googlechat.accounts.work.dm",
      "allowFrom",
    ],
  ] as const)("rejects legacy nested DM aliases for %s", (_name, channel, entry, path, key) => {
    expectUnknownKey({ config: { channels: { [channel]: entry } }, path, key });
  });

  it("rejects retired audio.transcription", () => {
    expectUnknownKey({
      config: { audio: { transcription: { command: ["whisper"] } } },
      path: "",
      key: "audio",
    });
  });

  it("rejects legacy session.maintenance.rotateBytes", () => {
    expectUnknownKey({
      config: { session: { maintenance: { rotateBytes: "10mb" } } },
      path: "session.maintenance",
      key: "rotateBytes",
    });
  });

  it("rejects unused gateway.remote.enabled", () => {
    expectUnknownKey({
      config: { gateway: { remote: { enabled: false } } },
      path: "gateway.remote",
      key: "enabled",
    });
  });

  it.each([
    ["root canvasHost", { canvasHost: { enabled: true } }, "", "canvasHost"],
    ["root tui", { tui: { footer: { showRemoteHost: true } } }, "", "tui"],
    ["root defaultModel", { defaultModel: "openai/gpt-5.6" }, "", "defaultModel"],
    ["cron.webhook", { cron: { webhook: "https://example.com" } }, "cron", "webhook"],
    ["commands.modelsWrite", { commands: { modelsWrite: true } }, "commands", "modelsWrite"],
    ["messages.messagePrefix", { messages: { messagePrefix: "x" } }, "messages", "messagePrefix"],
    [
      "session reset dm",
      { session: { resetByType: { dm: { mode: "idle" } } } },
      "session.resetByType",
      "dm",
    ],
    [
      "session pruneDays",
      { session: { maintenance: { pruneDays: 7 } } },
      "session.maintenance",
      "pruneDays",
    ],
    ["Talk realtime voice", { talk: { realtime: { voice: "alloy" } } }, "talk.realtime", "voice"],
    [
      "media async direct send",
      { tools: { media: { asyncCompletion: { directSend: true } } } },
      "tools.media",
      "asyncCompletion",
    ],
    [
      "message cross-context alias",
      { tools: { message: { allowCrossContextSend: true } } },
      "tools.message",
      "allowCrossContextSend",
    ],
    [
      "media Deepgram alias",
      { tools: { media: { audio: { deepgram: { punctuate: true } } } } },
      "tools.media.audio",
      "deepgram",
    ],
    [
      "MCP connect timeout alias",
      { mcp: { servers: { docs: { command: "docs", connectTimeout: 2 } } } },
      "mcp.servers.docs",
      "connectTimeout",
    ],
    [
      "MCP request timeout alias",
      { mcp: { servers: { docs: { command: "docs", timeout: 2 } } } },
      "mcp.servers.docs",
      "timeout",
    ],
    [
      "node-host MCP timeout alias",
      { nodeHost: { mcp: { servers: { docs: { command: "docs", connect_timeout: 2 } } } } },
      "nodeHost.mcp.servers.docs",
      "connect_timeout",
    ],
    [
      "Discord realtime voice alias",
      { channels: { discord: { voice: { realtime: { voice: "alloy" } } } } },
      "channels.discord.voice.realtime",
      "voice",
    ],
    [
      "Discord thread spawn alias",
      { channels: { discord: { threadBindings: { spawnAcpSessions: true } } } },
      "channels.discord.threadBindings",
      "spawnAcpSessions",
    ],
    [
      "Telegram thread spawn alias",
      { channels: { telegram: { threadBindings: { spawnSubagentSessions: true } } } },
      "channels.telegram.threadBindings",
      "spawnSubagentSessions",
    ],
    [
      "Matrix thread spawn alias",
      { channels: { matrix: { threadBindings: { spawnAcpSessions: true } } } },
      "channels.matrix.threadBindings",
      "spawnAcpSessions",
    ],
    [
      "LINE thread spawn alias",
      { channels: { line: { threadBindings: { spawnSubagentSessions: true } } } },
      "channels.line.threadBindings",
      "spawnSubagentSessions",
    ],
    [
      "Slack DM reply alias",
      { channels: { slack: { dm: { replyToMode: "all" } } } },
      "channels.slack.dm",
      "replyToMode",
    ],
    [
      "WhatsApp no-op",
      { channels: { whatsapp: { exposeErrorText: true } } },
      "channels.whatsapp",
      "exposeErrorText",
    ],
    [
      "Google Chat no-op",
      { channels: { googlechat: { actions: { reactions: true } } } },
      "channels.googlechat",
      "actions",
    ],
    [
      "Telegram DM topic config",
      { channels: { telegram: { dm: { threadReplies: "always" } } } },
      "channels.telegram",
      "dm",
    ],
  ] as const)("rejects retired %s", (_name, config, path, key) => {
    expectUnknownKey({ config, path, key });
  });
});
