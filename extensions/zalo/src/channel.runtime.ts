import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import { probeZalo } from "./probe.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import {
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
  type OpenClawConfig,
} from "./runtime-api.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { sendMessageZalo } from "./send.js";
import type { ResolvedZaloAccount } from "./types.js";

export async function notifyZaloPairingApproval(params: { cfg: OpenClawConfig; id: string }) {
  const { resolveZaloAccount } = await import("./accounts.js");
  const account = resolveZaloAccount({ cfg: params.cfg });
  if (!account.token) {
    throw new Error("Zalo token not configured");
  }
  await sendMessageZalo(params.id, PAIRING_APPROVED_MESSAGE, {
    token: account.token,
  });
}

export async function sendZaloText(
  params: Parameters<typeof sendMessageZalo>[2] & {
    to: string;
    text: string;
  },
) {
  return await sendMessageZalo(params.to, params.text, params);
}

export async function probeZaloAccount(params: {
  account: import("./accounts.js").ResolvedZaloAccount;
  timeoutMs?: number;
}) {
  return await probeZalo(
    params.account.token,
    params.timeoutMs,
    resolveZaloProxyFetch(params.account.config.proxy),
  );
}

export async function startZaloGatewayAccount(
  ctx: Parameters<
    NonNullable<NonNullable<ChannelPlugin<ResolvedZaloAccount>["gateway"]>["startAccount"]>
  >[0],
) {
  const account = ctx.account;
  const token = account.token.trim();
  const mode = account.config.webhookUrl ? "webhook" : "polling";
  let zaloBotLabel = "";
  const fetcher = resolveZaloProxyFetch(account.config.proxy);
  try {
    const probe = await probeZalo(token, 2500, fetcher);
    const name = probe.ok ? probe.bot?.name?.trim() : null;
    if (name) {
      zaloBotLabel = ` (${name})`;
    }
    if (!probe.ok) {
      ctx.log?.warn?.(
        `[${account.accountId}] Zalo probe failed before provider start (${String(probe.elapsedMs)}ms): ${probe.error}`,
      );
    }
    ctx.setStatus({
      accountId: account.accountId,
      bot: probe.bot,
    });
  } catch (err) {
    ctx.log?.warn?.(
      `[${account.accountId}] Zalo probe threw before provider start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });
  ctx.log?.info(`[${account.accountId}] starting provider${zaloBotLabel} mode=${mode}`);
  const { monitorZaloProvider } = await import("./monitor.js");
  return monitorZaloProvider({
    token,
    account,
    config: ctx.cfg,
    runtime: ctx.runtime,
    abortSignal: ctx.abortSignal,
    useWebhook: Boolean(account.config.webhookUrl),
    webhookUrl: account.config.webhookUrl,
    webhookSecret: normalizeSecretInputString(account.config.webhookSecret),
    webhookPath: account.config.webhookPath,
    fetcher,
    statusSink,
  });
}
