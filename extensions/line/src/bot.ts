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
  // LINE monitors outlive reloads outside `channels.line`. Bind snapshot ownership
  // once at startup; checking after reload would compare against the replaced source
  // and pin a process-owned monitor to stale config.
  const startupRuntimeConfig = getRuntimeConfigSnapshot();
  const startupRuntimeSourceConfig = getRuntimeConfigSourceSnapshot();
  // A snapshot without its source cannot prove that a distinct supplied config is
  // process-owned, so keep scoped monitors pinned through later global reloads.
  const followsRuntimeConfig =
    opts.config === undefined ||
    startupRuntimeConfig === startupConfig ||
    (startupRuntimeSourceConfig !== null &&
      selectApplicableRuntimeConfig({
        inputConfig: startupConfig,
        runtimeConfig: startupRuntimeConfig,
        runtimeSourceConfig: startupRuntimeSourceConfig,
      }) === startupRuntimeConfig);
  const resolveTurnConfig = (): OpenClawConfig =>
    (followsRuntimeConfig ? getRuntimeConfigSnapshot() : undefined) ?? startupConfig;
  // `channels.line` changes restart the monitor, so account credentials and settings
  // remain startup-prepared facts.
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
