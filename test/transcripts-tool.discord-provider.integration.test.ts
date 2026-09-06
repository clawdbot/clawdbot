import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "../extensions/discord/test-api.js";
import { createTranscriptsTool } from "../src/agents/tools/transcripts-tool.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { activeSessions } from "../src/transcripts/capture.js";
import { TranscriptsStore } from "../src/transcripts/store.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

type DiscordTranscriptsVoiceManager = NonNullable<
  Parameters<typeof setDiscordTranscriptsVoiceManager>[0]["manager"]
>;

const tempDirs = createTempDirTracker();

const resolveAccessTarget = async (channelId: string) => ({
  channelName: channelId,
  channelSlug: channelId,
  scope: "channel" as const,
});

function createTool(params: {
  accountId: string;
  caller:
    | { kind: "operator"; source: "channel-owner" | "local" | "scheduled" }
    | {
        kind: "channel";
        channel: string;
        accountId?: string;
        senderId: string;
        groupSpace?: string;
        roleIds: readonly string[];
      };
  config: OpenClawConfig;
  stateDir: string;
}) {
  return createTranscriptsTool({
    agentId: "main",
    agentAccountId: params.accountId,
    agentChannel: "discord",
    caller: params.caller,
    config: params.config,
    stateDir: params.stateDir,
  });
}

function storeFor(stateDir: string): TranscriptsStore {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

describe("transcripts tool with the registered Discord provider", () => {
  beforeEach(() => {
    const registry = createEmptyPluginRegistry();
    registry.transcriptSourceProviders.push({
      pluginId: "discord",
      provider: discordVoiceTranscriptsSourceProvider,
      source: "extensions/discord/index.ts",
    });
    setActivePluginRegistry(registry, "discord-transcripts-tool-test");
  });

  const managers = new Map<string, DiscordTranscriptsVoiceManager>();
  function registerManager(params: { accountId: string; manager: DiscordTranscriptsVoiceManager }) {
    managers.set(params.accountId, params.manager);
    setDiscordTranscriptsVoiceManager(params);
  }
  afterEach(async () => {
    for (const entry of activeSessions.values()) {
      await discordVoiceTranscriptsSourceProvider.stop!({
        sessionId: entry.session.sessionId,
        source: entry.session.source,
      });
    }
    activeSessions.clear();
    for (const [accountId, manager] of managers) {
      setDiscordTranscriptsVoiceManager({ accountId, manager: null, expectedManager: manager });
    }
    managers.clear();
    setActivePluginRegistry(createEmptyPluginRegistry(), "discord-transcripts-tool-test-cleanup");
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });

  it("keeps a model-requested account switch on the trusted Discord account", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-discord-provider-");
    const accountAJoin = vi.fn(async () => ({ ok: true, message: "joined account-a" }));
    const accountALeave = vi.fn(async () => {});
    const accountBJoin = vi.fn(async () => ({ ok: true, message: "joined account-b" }));
    const accountBLeave = vi.fn(async () => {});
    registerManager({
      accountId: "account-a",
      manager: {
        hasRealtimeCapture: () => false,
        startTranscriptsCapture: accountAJoin,
        stopTranscriptsCapture: accountALeave,
        watchChannelOccupancy: () => () => {},
        resolveAccessTarget: ({ channelId }) => resolveAccessTarget(channelId),
      },
    });
    registerManager({
      accountId: "account-b",
      manager: {
        hasRealtimeCapture: () => false,
        startTranscriptsCapture: accountBJoin,
        stopTranscriptsCapture: accountBLeave,
        watchChannelOccupancy: () => () => {},
        resolveAccessTarget: ({ channelId }) => resolveAccessTarget(channelId),
      },
    });
    const config = {
      channels: {
        discord: {
          accounts: {
            "account-a": {
              token: "token-a",
              allowFrom: ["discord:allowed"],
              voice: { enabled: true },
            },
            "account-b": { token: "token-b", voice: { enabled: true } },
          },
        },
      },
      transcripts: { enabled: true },
    } satisfies OpenClawConfig;
    const ownerTool = createTool({
      accountId: "account-a",
      caller: {
        kind: "channel",
        channel: "discord",
        accountId: "account-a",
        senderId: "allowed",
        groupSpace: "guild-a",
        roleIds: [],
      },
      config,
      stateDir,
    });
    const otherAccountTool = createTool({
      accountId: "account-b",
      caller: {
        kind: "channel",
        channel: "discord",
        accountId: "account-b",
        senderId: "allowed",
        groupSpace: "guild-a",
        roleIds: [],
      },
      config,
      stateDir,
    });
    const deniedSameAccountTool = createTool({
      accountId: "account-a",
      caller: {
        kind: "channel",
        channel: "discord",
        accountId: "account-a",
        senderId: "blocked",
        groupSpace: "guild-a",
        roleIds: [],
      },
      config,
      stateDir,
    });

    const startResult = await ownerTool.execute("start-account-bound", {
      action: "start",
      providerId: "discord-voice",
      accountId: "account-b",
      guildId: "guild-a",
      channelId: "voice-a",
      sessionId: "account-bound",
    });

    expect(startResult.details).toMatchObject({
      accountId: "account-a",
      sessionId: "account-bound",
    });
    expect(accountAJoin).toHaveBeenCalledOnce();
    expect(accountBJoin).not.toHaveBeenCalled();
    await expect(storeFor(stateDir).readSession("account-bound")).resolves.toMatchObject({
      source: { accountId: "account-a" },
      metadata: { agentId: "main" },
    });

    await expect(
      otherAccountTool.execute("status-other-account", { action: "status" }),
    ).resolves.toMatchObject({ details: { active: [] } });
    await expect(
      otherAccountTool.execute("stop-other-account", {
        action: "stop",
        sessionId: "account-bound",
      }),
    ).rejects.toThrow("transcripts session not found: account-bound");
    expect(accountBLeave).not.toHaveBeenCalled();

    await expect(
      deniedSameAccountTool.execute("status-denied-sender", { action: "status" }),
    ).resolves.toMatchObject({ details: { active: [] } });
    await expect(
      deniedSameAccountTool.execute("summarize-denied-sender", {
        action: "summarize",
        sessionId: "account-bound",
      }),
    ).rejects.toThrow("transcripts session not found: account-bound");
    await expect(
      deniedSameAccountTool.execute("stop-denied-sender", {
        action: "stop",
        sessionId: "account-bound",
      }),
    ).rejects.toThrow("transcripts session not found: account-bound");
    expect(accountALeave).not.toHaveBeenCalled();

    await expect(
      ownerTool.execute("stop-owner-account", {
        action: "stop",
        sessionId: "account-bound",
      }),
    ).resolves.toMatchObject({ details: { sessionId: "account-bound" } });
    expect(accountALeave).toHaveBeenCalledOnce();
  });

  it("rejects a Discord sender that the voice command policy denies", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-discord-provider-denied-");
    const join = vi.fn(async () => ({ ok: true, message: "joined" }));
    registerManager({
      accountId: "account-a",
      manager: {
        hasRealtimeCapture: () => false,
        startTranscriptsCapture: join,
        stopTranscriptsCapture: async () => {},
        watchChannelOccupancy: () => () => {},
        resolveAccessTarget: ({ channelId }) => resolveAccessTarget(channelId),
      },
    });
    const config = {
      channels: {
        discord: {
          accounts: {
            "account-a": {
              token: "token-a",
              allowFrom: ["discord:allowed"],
              voice: { enabled: true },
            },
          },
        },
      },
      transcripts: { enabled: true },
    } satisfies OpenClawConfig;
    const deniedTool = createTool({
      accountId: "account-a",
      caller: {
        kind: "channel",
        channel: "discord",
        accountId: "account-a",
        senderId: "blocked",
        groupSpace: "guild-a",
        roleIds: [],
      },
      config,
      stateDir,
    });

    await expect(
      deniedTool.execute("denied-sender", {
        action: "start",
        providerId: "discord-voice",
        guildId: "guild-a",
        channelId: "voice-a",
        sessionId: "denied-sender",
      }),
    ).rejects.toThrow("not authorized");
    expect(join).not.toHaveBeenCalled();
    await expect(storeFor(stateDir).readSession("denied-sender")).resolves.toBeUndefined();
  });
});
