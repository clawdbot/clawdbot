// Slack helper module supports prepare helpers behavior.
import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackChannelConfigEntries } from "../channel-config.js";
import { createSlackMonitorContext } from "../context.js";

export function createInboundSlackTestContext(params: {
  app?: App;
  cfg: OpenClawConfig;
  appClient?: App["client"];
  defaultRequireMention?: boolean;
  replyToMode?: "off" | "all" | "first" | "batched";
  channelsConfig?: SlackChannelConfigEntries;
  threadRequireExplicitMention?: boolean;
  dmHistoryLimit?: number;
  groupDmEnabled?: boolean;
  channelRuntime?: ChannelRuntimeSurface;
}) {
  return createSlackMonitorContext({
    cfg: params.cfg,
    accountId: "default",
    botToken: "token",
    app: params.app ?? ({ client: params.appClient ?? {} } as App),
    runtime: {} as RuntimeEnv,
    channelRuntime: params.channelRuntime ?? createPluginRuntimeMock().channel,
    botUserId: "B1",
    botId: "B1",
    teamId: "T1",
    apiAppId: "A1",
    historyLimit: 0,
    dmHistoryLimit: params.dmHistoryLimit,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: ["*"],
    allowNameMatching: false,
    groupDmEnabled: params.groupDmEnabled ?? true,
    groupDmChannels: [],
    defaultRequireMention: params.defaultRequireMention ?? true,
    channelsConfig: params.channelsConfig,
    groupPolicy: "open",
    useAccessGroups: false,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: params.replyToMode ?? "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    threadRequireExplicitMention: params.threadRequireExplicitMention ?? false,
    slashCommand: {
      enabled: false,
      name: "openclaw",
      sessionPrefix: "slack:slash",
      ephemeral: true,
    },
    textLimit: 4000,
    ackReactionScope: "group-mentions",
    typingReaction: "",
    mediaMaxBytes: 1024,
    removeAckAfterReply: false,
  });
}

export function createSlackTestAccount(
  config: ResolvedSlackAccount["config"] = {},
): ResolvedSlackAccount {
  return {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config,
    replyToMode: config.replyToMode,
    replyToModeByChatType: config.replyToModeByChatType,
    dm: config.dm,
  };
}

export function createSlackSessionStoreFixture(prefix: string) {
  let fixtureRoot = "";
  let caseId = 0;

  return {
    setup() {
      fixtureRoot = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), prefix));
    },
    cleanup() {
      if (!fixtureRoot) {
        return;
      }
      fs.rmSync(fixtureRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      fixtureRoot = "";
    },
    makeTmpStorePath() {
      if (!fixtureRoot) {
        throw new Error("fixtureRoot missing");
      }
      const dir = path.join(fixtureRoot, `case-${caseId++}`);
      fs.mkdirSync(dir);
      return { dir, storePath: path.join(dir, "sessions.json") };
    },
  };
}
