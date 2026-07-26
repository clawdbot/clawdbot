import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { truncateUtf16Safe } from "../../../packages/normalization-core/src/utf16-slice.ts";
import type { GatewayHandle, LaneState } from "./config.ts";
import {
  CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS,
  CROSS_OS_DISCORD_FETCH_TIMEOUT_MS,
  CROSS_OS_FETCH_BODY_MAX_CHARS,
  shouldUseManagedGatewayService,
} from "./config.ts";
import {
  ensureManagedGatewayReady,
  runInstalledCli,
  startManualGatewayFromInstalledCli,
  waitForInstalledGateway,
} from "./installed.ts";
import { stopGateway } from "./process.ts";
import { formatError, sleep } from "./shared.ts";

export function buildCrossOsDiscordRoundtripNonces() {
  return {
    outboundNonce: `native-cross-os-outbound-${randomUUID()}`,
    inboundNonce: `native-cross-os-inbound-${randomUUID()}`,
  };
}

export function buildDiscordSmokeGuildsConfig(guildId: string, channelId: string) {
  return {
    [guildId]: {
      channels: {
        [channelId]: {
          enabled: true,
          requireMention: false,
        },
      },
    },
  };
}

async function configureDiscordSmoke(params: {
  lane: LaneState;
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  gatewayHolder?: { current: GatewayHandle | null };
  logPath: string;
  token: string;
  guildId: string;
  channelId: string;
}) {
  const guildsJson = JSON.stringify(
    buildDiscordSmokeGuildsConfig(params.guildId, params.channelId),
  );
  await runInstalledCli({
    cliPath: params.cliPath,
    args: [
      "config",
      "set",
      "channels.discord.token",
      "--ref-provider",
      "default",
      "--ref-source",
      "env",
      "--ref-id",
      "DISCORD_BOT_TOKEN",
    ],
    cwd: params.cwd,
    env: { ...params.env, DISCORD_BOT_TOKEN: params.token },
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "channels.discord.enabled", "true"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "channels.discord.groupPolicy", "allowlist"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "channels.discord.guilds", guildsJson, "--strict-json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  if (!shouldUseManagedGatewayService()) {
    const gatewayEnv = { ...params.env, DISCORD_BOT_TOKEN: params.token };
    if (params.gatewayHolder?.current) {
      await stopGateway(params.gatewayHolder.current);
      params.gatewayHolder.current = null;
    }
    const gateway = await startManualGatewayFromInstalledCli({
      lane: params.lane,
      cliPath: params.cliPath,
      env: gatewayEnv,
      logPath: join(params.cwd, `.openclaw/logs/${params.lane.name}-discord-gateway.log`),
    });
    if (params.gatewayHolder) {
      params.gatewayHolder.current = gateway;
    }
    await waitForInstalledGateway({
      lane: params.lane,
      cliPath: params.cliPath,
      env: gatewayEnv,
      logPath: params.logPath,
    });
    return;
  }
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "restart"],
    cwd: params.cwd,
    env: { ...params.env, DISCORD_BOT_TOKEN: params.token },
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
    check: false,
  });
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: { ...params.env, DISCORD_BOT_TOKEN: params.token },
    logPath: params.logPath,
  });
}

export async function readBoundedCrossOsResponseText(
  response: Response,
  maxChars = CROSS_OS_FETCH_BODY_MAX_CHARS,
  options: { signal?: AbortSignal | null } = {},
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  let aborted = false;

  try {
    while (text.length <= maxChars) {
      const { done, value } = await readCrossOsResponseChunk(reader, options.signal);
      if (done) {
        text += decoder.decode();
        break;
      }

      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        text = truncateUtf16Safe(text, maxChars);
        truncated = true;
        break;
      }
    }
  } catch (error) {
    aborted = options.signal?.aborted === true;
    throw error;
  } finally {
    if (truncated || aborted) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }

  return truncated ? `${text}\n[truncated]` : text;
}

function readCrossOsResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal | null,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }
  if (signal.aborted) {
    throw crossOsAbortReason(signal);
  }
  return new Promise((resolveRead, rejectRead) => {
    const onAbort = () => rejectRead(crossOsAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    reader
      .read()
      .then(resolveRead, rejectRead)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function crossOsAbortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : "The operation was aborted.");
}

export function dashboardHtmlMarkerStatus(html: string): {
  app: boolean;
  ready: boolean;
  title: boolean;
} {
  const title = html.includes("<title>OpenClaw Control</title>");
  const app = html.includes("<openclaw-app></openclaw-app>");
  return { app, ready: title && app, title };
}

export function resolveDashboardAssetUrls(dashboardUrl: string, html: string): string[] {
  const baseUrl = new URL(dashboardUrl);
  const assetUrls = new Set<string>();
  const assetAttributePattern = /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*(["'])([^"']+)\1/giu;
  for (const match of html.matchAll(assetAttributePattern)) {
    const rawUrl = match[2]?.trim();
    if (!rawUrl) {
      continue;
    }
    const assetUrl = new URL(rawUrl, baseUrl);
    if (assetUrl.origin === baseUrl.origin && assetUrl.pathname.includes("/assets/")) {
      assetUrls.add(assetUrl.href);
    }
  }
  return [...assetUrls].toSorted();
}

export async function verifyDashboardAssetUrls(
  assetUrls: string[],
  fetchAsset: typeof fetch = fetch,
): Promise<{ failures: string[]; ok: boolean }> {
  if (assetUrls.length === 0) {
    return { failures: ["no dashboard asset URLs found"], ok: false };
  }
  const failures: string[] = [];
  for (const assetUrl of assetUrls) {
    try {
      const response = await fetchAsset(assetUrl, {
        signal: AbortSignal.timeout(CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        failures.push(`${assetUrl} status=${response.status}`);
      }
    } catch (error) {
      failures.push(`${assetUrl} ${formatError(error)}`);
    }
  }
  return { failures, ok: failures.length === 0 };
}

async function waitForDiscordMessage(params: { token: string; channelId: string; needle: string }) {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    let response;
    let text;
    try {
      const init = buildDiscordFetchInit(params.token);
      response = await fetch(
        `https://discord.com/api/v10/channels/${params.channelId}/messages?limit=20`,
        init,
      );
      text = await readBoundedCrossOsResponseText(response, undefined, { signal: init.signal });
    } catch {
      await sleep(2_000);
      continue;
    }
    if (!response.ok) {
      await sleep(2_000);
      continue;
    }
    if (text.includes(params.needle)) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Discord host-side visibility check timed out for ${params.needle}.`);
}

export function buildDiscordFetchInit(
  token: string,
  init: RequestInit = {},
): RequestInit & { signal: AbortSignal } {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${token}`);
  return {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(CROSS_OS_DISCORD_FETCH_TIMEOUT_MS),
    headers,
  };
}

async function postDiscordMessage(params: {
  token: string;
  channelId: string;
  content: string;
}): Promise<string | null> {
  const init = buildDiscordFetchInit(params.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: params.content,
      flags: 4096,
    }),
  });
  const response = await fetch(
    `https://discord.com/api/v10/channels/${params.channelId}/messages`,
    init,
  );
  const text = await readBoundedCrossOsResponseText(response, undefined, { signal: init.signal });
  if (!response.ok) {
    throw new Error(`Failed to post Discord smoke message: ${text}`);
  }
  try {
    const payload = JSON.parse(text) as { id?: string };
    return payload.id ?? null;
  } catch {
    return null;
  }
}

export async function deleteDiscordMessage(params: {
  token: string;
  channelId: string;
  messageId: string | null;
}) {
  if (!params.messageId) {
    return;
  }
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${params.channelId}/messages/${params.messageId}`,
      buildDiscordFetchInit(params.token, {
        method: "DELETE",
      }),
    );
    await response.body?.cancel?.().catch(() => undefined);
  } catch {
    // Cleanup is best-effort; the smoke result should not fail after readback succeeds.
  }
}

async function waitForInstalledDiscordReadback(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  channelId: string;
  needle: string;
}) {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "message",
        "read",
        "--channel",
        "discord",
        "--target",
        `channel:${params.channelId}`,
        "--limit",
        "20",
        "--json",
      ],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 60_000,
      check: false,
    });
    if (response.exitCode === 0 && response.stdout.includes(params.needle)) {
      return;
    }
    await sleep(3_000);
  }
  throw new Error(`Discord guest readback timed out for ${params.needle}.`);
}

export async function maybeRunDiscordRoundtrip(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  gatewayHolder: { current: GatewayHandle | null };
  logPath: string;
}) {
  const token =
    process.env.OPENCLAW_DISCORD_SMOKE_BOT_TOKEN?.trim() ||
    process.env.DISCORD_BOT_TOKEN?.trim() ||
    "";
  const guildId = process.env.OPENCLAW_DISCORD_SMOKE_GUILD_ID?.trim() || "";
  const channelId = process.env.OPENCLAW_DISCORD_SMOKE_CHANNEL_ID?.trim() || "";
  if (!token || !guildId || !channelId) {
    return "skipped-missing-config";
  }

  const { outboundNonce, inboundNonce } = buildCrossOsDiscordRoundtripNonces();
  let sentMessageId: string | null = null;
  let hostMessageId: string | null = null;
  try {
    await configureDiscordSmoke({
      lane: params.lane,
      cliPath: params.cliPath,
      cwd: params.lane.homeDir,
      env: params.env,
      gatewayHolder: params.gatewayHolder,
      logPath: params.logPath,
      token,
      guildId,
      channelId,
    });

    const sendResult = await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "message",
        "send",
        "--channel",
        "discord",
        "--target",
        `channel:${channelId}`,
        "--message",
        outboundNonce,
        "--silent",
        "--json",
      ],
      cwd: params.lane.homeDir,
      env: { ...params.env, DISCORD_BOT_TOKEN: token },
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
    let parsedSendResult: {
      payload?: { messageId?: string; result?: { messageId?: string } };
    } | null;
    try {
      parsedSendResult = JSON.parse(sendResult.stdout) as {
        payload?: { messageId?: string; result?: { messageId?: string } };
      };
    } catch {
      parsedSendResult = null;
    }
    sentMessageId =
      parsedSendResult?.payload?.messageId ?? parsedSendResult?.payload?.result?.messageId ?? null;
    await waitForDiscordMessage({
      token,
      channelId,
      needle: outboundNonce,
    });
    hostMessageId = await postDiscordMessage({
      token,
      channelId,
      content: inboundNonce,
    });
    await waitForInstalledDiscordReadback({
      cliPath: params.cliPath,
      cwd: params.lane.homeDir,
      env: { ...params.env, DISCORD_BOT_TOKEN: token },
      logPath: params.logPath,
      channelId,
      needle: inboundNonce,
    });
    return "pass";
  } finally {
    await deleteDiscordMessage({ token, channelId, messageId: sentMessageId });
    await deleteDiscordMessage({ token, channelId, messageId: hostMessageId });
  }
}
