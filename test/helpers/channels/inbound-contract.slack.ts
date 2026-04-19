import { expect, it } from "vitest";
import type { MsgContext } from "../../../src/auto-reply/templating.js";
import { expectChannelInboundContextContract } from "../../../src/channels/plugins/contracts/test-helpers.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { withTempHome } from "../temp-home.js";

type ResolvedSlackAccount = {
  accountId: string;
  enabled: boolean;
  botTokenSource: string;
  appTokenSource: string;
  userTokenSource: string;
  config: {
    replyToMode?: unknown;
    replyToModeByChatType?: unknown;
    dm?: unknown;
  };
  replyToMode?: unknown;
  replyToModeByChatType?: unknown;
  dm?: unknown;
};

type SlackMessageEvent = {
  channel: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
};

type SlackPrepareResult = { ctxPayload: MsgContext } | null | undefined;

type SlackTestApi = {
  createInboundSlackTestContext: (params: { cfg: OpenClawConfig }) => {
    resolveUserName?: () => Promise<unknown>;
  };
  prepareSlackMessage: (params: {
    ctx: {
      resolveUserName?: () => Promise<unknown>;
    };
    account: ResolvedSlackAccount;
    message: SlackMessageEvent;
    opts: { source: string };
  }) => Promise<SlackPrepareResult>;
};

const slackPrepareTestApiModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "slack",
  artifactBasename: "inbound-contract-test-api.js",
});

let slackTestApiPromise: Promise<SlackTestApi> | undefined;

async function loadSlackTestApi(): Promise<SlackTestApi> {
  slackTestApiPromise ??= import(slackPrepareTestApiModuleId) as Promise<SlackTestApi>;
  return await slackTestApiPromise;
}

function createSlackAccount(config: ResolvedSlackAccount["config"] = {}): ResolvedSlackAccount {
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

function createSlackMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "D123",
    channel_type: "im",
    user: "U1",
    text: "hi",
    ts: "1.000",
    ...overrides,
  } as SlackMessageEvent;
}

export function installSlackInboundContractSuite() {
  it("keeps inbound context finalized", async () => {
    await withTempHome(async () => {
      const { createInboundSlackTestContext, prepareSlackMessage } = await loadSlackTestApi();
      const ctx = createInboundSlackTestContext({
        cfg: {
          channels: { slack: { enabled: true } },
        } as OpenClawConfig,
      });
      ctx.resolveUserName = async () => ({ name: "Alice" }) as never;

      const prepared = await prepareSlackMessage({
        ctx,
        account: createSlackAccount(),
        message: createSlackMessage({}),
        opts: { source: "message" },
      });

      expect(prepared).toBeTruthy();
      expectChannelInboundContextContract(prepared!.ctxPayload);
    });
  });
}
