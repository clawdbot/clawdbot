// Line plugin module implements bot behavior.
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import {
  getRuntimeConfig,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  createNonExitingRuntime,
  logVerbose,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { resolveLineAccount } from "./accounts.js";
import { handleLineWebhookEvents } from "./bot-handlers.js";
import type { LineInboundContext } from "./bot-message-context.js";
import type { ResolvedLineAccount } from "./types.js";
import { createLineWebhookSpool, type LineWebhookTurnAdoptionLifecycle } from "./webhook-spool.js";

const DEFAULT_MEDIA_MAX_MB = 10;
type BuildChannelInboundContext =
  typeof import("openclaw/plugin-sdk/channel-inbound").buildChannelInboundEventContext;

interface LineBotOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  buildContext?: BuildChannelInboundContext;
  config?: OpenClawConfig;
  mediaMaxMb?: number;
  onMessage?: (
    ctx: LineInboundContext,
    control: {
      cfg: OpenClawConfig;
      turnAdoptionLifecycle?: LineWebhookTurnAdoptionLifecycle;
    },
  ) => Promise<void>;
}

interface LineBot {
  handleWebhook: (body: webhook.CallbackRequest) => Promise<void>;
  account: ResolvedLineAccount;
  stop: () => Promise<void>;
}

export function createLineBot(opts: LineBotOptions): LineBot {
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const startupConfig = opts.config ?? getRuntimeConfig();
  // A channel monitor outlives config reloads. Everything read here from outside
  // `channels.line` — mention patterns, the group-chat history limit, routing
  // bindings, the shared group-policy default — is hot-applied without restarting
  // the channel, so each delivered event runs on the config live at that moment.
  //
  // Ownership is decided once, against the snapshot that was current at startup:
  // a later reload replaces both the runtime config and its source, so asking
  // again after one would always answer "not mine" and pin the monitor forever.
  const startupRuntimeConfig = getRuntimeConfigSnapshot();
  const startupRuntimeSourceConfig = getRuntimeConfigSourceSnapshot();
  // Without a source snapshot there is nothing to compare a distinct supplied
  // config against, and the selector answers with the runtime config for any
  // input. Taking that as ownership would hand a monitor started with its own
  // config to unrelated process-global config on the next reload, so a scoped
  // monitor stays with what it was started with.
  const followsRuntimeConfig =
    !startupRuntimeConfig ||
    startupRuntimeConfig === startupConfig ||
    (startupRuntimeSourceConfig !== null &&
      selectApplicableRuntimeConfig({
        inputConfig: startupConfig,
        runtimeConfig: startupRuntimeConfig,
        runtimeSourceConfig: startupRuntimeSourceConfig,
      }) === startupRuntimeConfig);
  const resolveTurnConfig = (): OpenClawConfig =>
    (followsRuntimeConfig ? getRuntimeConfigSnapshot() : undefined) ?? startupConfig;
  // Credentials and the account's own settings live under `channels.line`, whose
  // changes restart the channel, so the account stays a prepared fact rather than
  // a per-event re-read of its secret files.
  const account = resolveLineAccount({
    cfg: startupConfig,
    accountId: opts.accountId,
  });

  // A non-positive cap cannot bound a transfer, so treat it as unset at every
  // link. `??` alone keeps a configured 0 or negative and turns every inbound
  // media download into a 0-byte budget the media core rejects, which degrades
  // the attachment to an unavailable notice without naming the setting.
  const effectiveMediaMaxMb =
    [opts.mediaMaxMb, account.config.mediaMaxMb].find(
      (value) => typeof value === "number" && value > 0,
    ) ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = effectiveMediaMaxMb * 1024 * 1024;

  const processMessage =
    opts.onMessage ??
    (async () => {
      logVerbose("line: no message handler configured");
    });
  const groupHistories = new Map<string, HistoryEntry[]>();
  const spool = createLineWebhookSpool({
    accountId: account.accountId,
    runtime,
    deliver: async (event, _destination, control) => {
      const cfg = resolveTurnConfig();
      await handleLineWebhookEvents([event], {
        cfg,
        account,
        runtime,
        buildContext: opts.buildContext,
        mediaMaxBytes,
        processMessage,
        ...(control.turnAdoptionLifecycle
          ? { turnAdoptionLifecycle: control.turnAdoptionLifecycle }
          : {}),
        groupHistories,
        historyLimit:
          account.config.historyLimit ??
          cfg.messages?.groupChat?.historyLimit ??
          DEFAULT_GROUP_HISTORY_LIMIT,
      });
    },
  });
  spool.start();

  return {
    handleWebhook: spool.accept,
    account,
    stop: spool.stop,
  };
}
