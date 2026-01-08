import { withProgress } from "../../cli/progress.js";
import {
  type ClawdbotConfig,
  readConfigFileSnapshot,
} from "../../config/config.js";
import {
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../../discord/accounts.js";
import { callGateway } from "../../gateway/call.js";
import {
  listIMessageAccountIds,
  resolveIMessageAccount,
} from "../../imessage/accounts.js";
import { formatAge } from "../../infra/provider-summary.js";
import { listChatProviders } from "../../providers/registry.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  listSignalAccountIds,
  resolveSignalAccount,
} from "../../signal/accounts.js";
import {
  listSlackAccountIds,
  resolveSlackAccount,
} from "../../slack/accounts.js";
import {
  listTelegramAccountIds,
  resolveTelegramAccount,
} from "../../telegram/accounts.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { normalizeE164 } from "../../utils.js";
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
} from "../../web/accounts.js";
import {
  getWebAuthAgeMs,
  readWebSelfId,
  webAuthExists,
} from "../../web/session.js";
import {
  type ChatProvider,
  formatProviderAccountLabel,
  requireValidConfig,
} from "./shared.js";

export type ProvidersStatusOptions = {
  json?: boolean;
  probe?: boolean;
  timeout?: string;
};

export function formatGatewayProvidersStatusLines(
  payload: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  lines.push(theme.success("Gateway reachable."));
  const accountLines = (
    provider: ChatProvider,
    accounts: Array<Record<string, unknown>>,
  ) =>
    accounts.map((account) => {
      const bits: string[] = [];
      if (typeof account.enabled === "boolean") {
        bits.push(account.enabled ? "enabled" : "disabled");
      }
      if (typeof account.configured === "boolean") {
        bits.push(account.configured ? "configured" : "not configured");
      }
      if (typeof account.linked === "boolean") {
        bits.push(account.linked ? "linked" : "not linked");
      }
      if (typeof account.running === "boolean") {
        bits.push(account.running ? "running" : "stopped");
      }
      if (typeof account.mode === "string" && account.mode.length > 0) {
        bits.push(`mode:${account.mode}`);
      }
      if (typeof account.dmPolicy === "string" && account.dmPolicy.length > 0) {
        bits.push(`dm:${account.dmPolicy}`);
      }
      if (Array.isArray(account.allowFrom) && account.allowFrom.length > 0) {
        bits.push(`allow:${account.allowFrom.slice(0, 2).join(",")}`);
      }
      if (typeof account.tokenSource === "string" && account.tokenSource) {
        bits.push(`token:${account.tokenSource}`);
      }
      if (
        typeof account.botTokenSource === "string" &&
        account.botTokenSource
      ) {
        bits.push(`bot:${account.botTokenSource}`);
      }
      if (
        typeof account.appTokenSource === "string" &&
        account.appTokenSource
      ) {
        bits.push(`app:${account.appTokenSource}`);
      }
      if (typeof account.baseUrl === "string" && account.baseUrl) {
        bits.push(`url:${account.baseUrl}`);
      }
      const probe = account.probe as { ok?: boolean } | undefined;
      if (probe && typeof probe.ok === "boolean") {
        bits.push(probe.ok ? "works" : "probe failed");
      }
      if (typeof account.lastError === "string" && account.lastError) {
        bits.push(`error:${account.lastError}`);
      }
      const accountId =
        typeof account.accountId === "string" ? account.accountId : "default";
      const name = typeof account.name === "string" ? account.name.trim() : "";
      const labelText = formatProviderAccountLabel({
        provider,
        accountId,
        name: name || undefined,
      });
      return `- ${labelText}: ${bits.join(", ")}`;
    });

  const accountPayloads: Partial<
    Record<ChatProvider, Array<Record<string, unknown>>>
  > = {
    whatsapp: Array.isArray(payload.whatsappAccounts)
      ? (payload.whatsappAccounts as Array<Record<string, unknown>>)
      : undefined,
    telegram: Array.isArray(payload.telegramAccounts)
      ? (payload.telegramAccounts as Array<Record<string, unknown>>)
      : undefined,
    discord: Array.isArray(payload.discordAccounts)
      ? (payload.discordAccounts as Array<Record<string, unknown>>)
      : undefined,
    slack: Array.isArray(payload.slackAccounts)
      ? (payload.slackAccounts as Array<Record<string, unknown>>)
      : undefined,
    signal: Array.isArray(payload.signalAccounts)
      ? (payload.signalAccounts as Array<Record<string, unknown>>)
      : undefined,
    imessage: Array.isArray(payload.imessageAccounts)
      ? (payload.imessageAccounts as Array<Record<string, unknown>>)
      : undefined,
  };

  for (const meta of listChatProviders()) {
    const accounts = accountPayloads[meta.id];
    if (accounts && accounts.length > 0) {
      lines.push(...accountLines(meta.id, accounts));
    }
  }

  lines.push("");
  lines.push(
    `Tip: ${formatDocsLink("/cli#status", "status --deep")} runs local probes without a gateway.`,
  );
  return lines;
}

async function formatConfigProvidersStatusLines(
  cfg: ClawdbotConfig,
  meta: { path?: string; mode?: "local" | "remote" },
): Promise<string[]> {
  const lines: string[] = [];
  lines.push(theme.warn("Gateway not reachable; showing config-only status."));
  if (meta.path) {
    lines.push(`Config: ${meta.path}`);
  }
  if (meta.mode) {
    lines.push(`Mode: ${meta.mode}`);
  }
  if (meta.path || meta.mode) lines.push("");

  const accountLines = (
    provider: ChatProvider,
    accounts: Array<Record<string, unknown>>,
  ) =>
    accounts.map((account) => {
      const bits: string[] = [];
      if (typeof account.enabled === "boolean") {
        bits.push(account.enabled ? "enabled" : "disabled");
      }
      if (typeof account.configured === "boolean") {
        bits.push(account.configured ? "configured" : "not configured");
      }
      if (typeof account.linked === "boolean") {
        bits.push(account.linked ? "linked" : "not linked");
      }
      if (typeof account.mode === "string" && account.mode.length > 0) {
        bits.push(`mode:${account.mode}`);
      }
      if (typeof account.tokenSource === "string" && account.tokenSource) {
        bits.push(`token:${account.tokenSource}`);
      }
      if (
        typeof account.botTokenSource === "string" &&
        account.botTokenSource
      ) {
        bits.push(`bot:${account.botTokenSource}`);
      }
      if (
        typeof account.appTokenSource === "string" &&
        account.appTokenSource
      ) {
        bits.push(`app:${account.appTokenSource}`);
      }
      if (typeof account.baseUrl === "string" && account.baseUrl) {
        bits.push(`url:${account.baseUrl}`);
      }
      const accountId =
        typeof account.accountId === "string" ? account.accountId : "default";
      const name = typeof account.name === "string" ? account.name.trim() : "";
      const labelText = formatProviderAccountLabel({
        provider,
        accountId,
        name: name || undefined,
      });
      return `- ${labelText}: ${bits.join(", ")}`;
    });

  const accounts = {
    whatsapp: listWhatsAppAccountIds(cfg).map((accountId) => {
      const account = resolveWhatsAppAccount({ cfg, accountId });
      const dmPolicy = account.dmPolicy ?? cfg.whatsapp?.dmPolicy ?? "pairing";
      const allowFrom = (account.allowFrom ?? cfg.whatsapp?.allowFrom ?? [])
        .map(normalizeE164)
        .filter(Boolean)
        .slice(0, 2);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: true,
        linked: undefined,
        dmPolicy,
        allowFrom,
      };
    }),
    telegram: listTelegramAccountIds(cfg).map((accountId) => {
      const account = resolveTelegramAccount({ cfg, accountId });
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.token?.trim()),
        tokenSource: account.tokenSource,
        mode: account.config.webhookUrl ? "webhook" : "polling",
      };
    }),
    discord: listDiscordAccountIds(cfg).map((accountId) => {
      const account = resolveDiscordAccount({ cfg, accountId });
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.token?.trim()),
        tokenSource: account.tokenSource,
      };
    }),
    slack: listSlackAccountIds(cfg).map((accountId) => {
      const account = resolveSlackAccount({ cfg, accountId });
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured:
          Boolean(account.botToken?.trim()) &&
          Boolean(account.appToken?.trim()),
        botTokenSource: account.botTokenSource,
        appTokenSource: account.appTokenSource,
      };
    }),
    signal: listSignalAccountIds(cfg).map((accountId) => {
      const account = resolveSignalAccount({ cfg, accountId });
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.baseUrl,
      };
    }),
    imessage: listIMessageAccountIds(cfg).map((accountId) => {
      const account = resolveIMessageAccount({ cfg, accountId });
      const imsgConfigured = Boolean(
        account.config.cliPath ||
          account.config.dbPath ||
          account.config.allowFrom ||
          account.config.service ||
          account.config.region,
      );
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: imsgConfigured,
      };
    }),
  } satisfies Partial<Record<ChatProvider, Array<Record<string, unknown>>>>;

  // WhatsApp linked info (config-only best-effort).
  try {
    const webLinked = await webAuthExists();
    const authAgeMs = getWebAuthAgeMs();
    const authAge = authAgeMs === null ? "" : ` auth ${formatAge(authAgeMs)}`;
    const { e164 } = readWebSelfId();
    lines.push(
      `WhatsApp: ${webLinked ? "linked" : "not linked"}${e164 ? ` ${e164}` : ""}${webLinked ? authAge : ""}`,
    );
  } catch {
    // ignore
  }

  for (const meta of listChatProviders()) {
    const providerAccounts = accounts[meta.id];
    if (providerAccounts && providerAccounts.length > 0) {
      lines.push(...accountLines(meta.id, providerAccounts));
    }
  }

  lines.push("");
  lines.push(
    `Tip: ${formatDocsLink("/cli#status", "status --deep")} runs local probes without a gateway.`,
  );
  return lines;
}

export async function providersStatusCommand(
  opts: ProvidersStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const timeoutMs = Number(opts.timeout ?? 10_000);
  try {
    const payload = await withProgress(
      {
        label: "Checking provider status…",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          method: "providers.status",
          params: { probe: Boolean(opts.probe), timeoutMs },
          timeoutMs,
        }),
    );
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
      return;
    }
    runtime.log(
      formatGatewayProvidersStatusLines(
        payload as Record<string, unknown>,
      ).join("\n"),
    );
  } catch (err) {
    runtime.error(`Gateway not reachable: ${String(err)}`);
    const cfg = await requireValidConfig(runtime);
    if (!cfg) return;
    const snapshot = await readConfigFileSnapshot();
    const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
    runtime.log(
      (
        await formatConfigProvidersStatusLines(cfg, {
          path: snapshot.path,
          mode,
        })
      ).join("\n"),
    );
  }
}
