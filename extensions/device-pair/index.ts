import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

type DevicePairApiModule = typeof import("./api.js");
type NotifyModule = typeof import("./notify.js");
type PairCommandApproveModule = typeof import("./pair-command-approve.js");
type PairCommandAuthModule = typeof import("./pair-command-auth.js");

let devicePairApiModulePromise: Promise<DevicePairApiModule> | undefined;
let notifyModulePromise: Promise<NotifyModule> | undefined;
let pairCommandApproveModulePromise: Promise<PairCommandApproveModule> | undefined;
let pairCommandAuthModulePromise: Promise<PairCommandAuthModule> | undefined;

function loadDevicePairApiModule(): Promise<DevicePairApiModule> {
  devicePairApiModulePromise ??= import("./api.js");
  return devicePairApiModulePromise;
}

function loadNotifyModule(): Promise<NotifyModule> {
  notifyModulePromise ??= import("./notify.js");
  return notifyModulePromise;
}

function loadPairCommandApproveModule(): Promise<PairCommandApproveModule> {
  pairCommandApproveModulePromise ??= import("./pair-command-approve.js");
  return pairCommandApproveModulePromise;
}

function loadPairCommandAuthModule(): Promise<PairCommandAuthModule> {
  pairCommandAuthModulePromise ??= import("./pair-command-auth.js");
  return pairCommandAuthModulePromise;
}

function formatDurationMinutes(expiresAtMs: number): string {
  const msRemaining = Math.max(0, expiresAtMs - Date.now());
  const minutes = Math.max(1, Math.ceil(msRemaining / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

type DevicePairPluginConfig = {
  publicUrl?: string;
};

type SetupPayload = {
  url: string;
  bootstrapToken: string;
  expiresAtMs: number;
};

type ResolveUrlResult = {
  url?: string;
  source?: string;
  error?: string;
};

type ResolveAuthLabelResult = {
  label?: "token" | "password";
  error?: string;
};

type QrCommandContext = {
  channel: string;
  senderId?: string;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string | number;
};

type QrChannelSender = {
  createOpts: (params: {
    ctx: QrCommandContext;
    qrFilePath: string;
    mediaLocalRoots: string[];
    accountId?: string;
  }) => Record<string, unknown>;
};

const QR_CHANNEL_SENDERS: Record<string, QrChannelSender> = {
  telegram: {
    createOpts: ({ ctx, qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(ctx.messageThreadId != null ? { threadId: ctx.messageThreadId } : {}),
      ...(accountId ? { accountId } : {}),
    }),
  },
  discord: {
    createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(accountId ? { accountId } : {}),
    }),
  },
  slack: {
    createOpts: ({ ctx, qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(ctx.messageThreadId != null ? { threadId: String(ctx.messageThreadId) } : {}),
      ...(accountId ? { accountId } : {}),
    }),
  },
  signal: {
    createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(accountId ? { accountId } : {}),
    }),
  },
  imessage: {
    createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(accountId ? { accountId } : {}),
    }),
  },
  whatsapp: {
    createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
      verbose: false,
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(accountId ? { accountId } : {}),
    }),
  },
};

const GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE = /^(?:https?|wss?):(?!\/\/)/i;
const SCHEME_LIKE_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\//;

function normalizeUrl(raw: string, schemeFallback: "ws" | "wss"): string | null {
  const candidate = normalizeOptionalString(raw);
  if (!candidate) {
    return null;
  }
  if (GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE.test(candidate)) {
    return null;
  }
  const parsedUrl = parseNormalizedGatewayUrl(candidate);
  if (parsedUrl) {
    return parsedUrl;
  }
  if (candidate.includes("://") || SCHEME_LIKE_PATH_RE.test(candidate)) {
    return null;
  }
  const hostPort = normalizeOptionalString(candidate.split("/", 1)[0]) ?? "";
  return hostPort ? parseNormalizedGatewayUrl(`${schemeFallback}://${hostPort}`) : null;
}

function parseNormalizedGatewayUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      return null;
    }
    const scheme = parsed.protocol.slice(0, -1);
    const normalizedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
    if (!(normalizedScheme === "ws" || normalizedScheme === "wss")) {
      return null;
    }
    if (!parsed.hostname) {
      return null;
    }
    return `${normalizedScheme}://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return null;
  }
}

function describeSecureMobilePairingFix(source?: string): string {
  const sourceNote = source ? ` Resolved source: ${source}.` : "";
  return (
    "Mobile pairing over non-loopback networks requires a secure gateway URL (wss://) or Tailscale Serve/Funnel." +
    sourceNote +
    " Fix: prefer gateway.tailscale.mode=serve, or set " +
    "gateway.remote.url / plugins.entries.device-pair.config.publicUrl to a wss:// URL. " +
    "ws:// setup codes are only valid for localhost/loopback or the Android emulator."
  );
}

function normalizeHostForIpCheck(host: string): string {
  let normalized = normalizeLowercaseStringOrEmpty(host);
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) {
    normalized = normalized.slice(0, zoneIndex);
  }
  return normalized;
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostForIpCheck(host);
  if (!normalized) {
    return false;
  }
  if (normalized === "localhost" || normalized === "0.0.0.0" || normalized === "::") {
    return true;
  }
  const octets = parseIPv4Octets(normalized);
  if (octets) {
    return octets[0] === 127;
  }
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

function resolveScheme(
  cfg: OpenClawPluginApi["config"],
  opts?: { forceSecure?: boolean },
): "ws" | "wss" {
  if (opts?.forceSecure) {
    return "wss";
  }
  return cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
}

function parseIPv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  if (parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function isPrivateIPv4(address: string): boolean {
  const octets = parseIPv4Octets(address);
  if (!octets) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return false;
}

function isTailnetIPv4(address: string): boolean {
  const octets = parseIPv4Octets(address);
  if (!octets) {
    return false;
  }
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

function isMobilePairingCleartextAllowedHost(host: string): boolean {
  const normalized = normalizeHostForIpCheck(host);
  return isLoopbackHost(normalized) || normalized === "10.0.2.2";
}

function validateMobilePairingUrl(url: string, source?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Resolved mobile pairing URL is invalid.";
  }
  const protocol =
    parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
  if (protocol === "wss:") {
    return null;
  }
  if (protocol !== "ws:" || isMobilePairingCleartextAllowedHost(parsed.hostname)) {
    return null;
  }
  return describeSecureMobilePairingFix(source);
}

function pickMatchingIPv4(predicate: (address: string) => boolean): string | null {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      const family = entry?.family;
      // Keep the numeric check for older Node runtimes that reported family as 4.
      const isIpv4 = family === "IPv4" || (family as unknown) === 4;
      if (!entry || entry.internal || !isIpv4) {
        continue;
      }
      const address = normalizeOptionalString(entry.address) ?? "";
      if (!address) {
        continue;
      }
      if (predicate(address)) {
        return address;
      }
    }
  }
  return null;
}

function pickLanIPv4(): string | null {
  return pickMatchingIPv4(isPrivateIPv4);
}

function pickTailnetIPv4(): string | null {
  return pickMatchingIPv4(isTailnetIPv4);
}

async function resolveTailnetHost(): Promise<string | null> {
  const { resolveTailnetHostWithRunner, runPluginCommandWithTimeout } =
    await loadDevicePairApiModule();
  return await resolveTailnetHostWithRunner((argv, opts) =>
    runPluginCommandWithTimeout({
      argv,
      timeoutMs: opts.timeoutMs,
    }),
  );
}

function resolveAuthLabel(cfg: OpenClawPluginApi["config"]): ResolveAuthLabelResult {
  const mode = cfg.gateway?.auth?.mode;
  const token =
    pickFirstDefined([process.env.OPENCLAW_GATEWAY_TOKEN, cfg.gateway?.auth?.token]) ?? undefined;
  const password =
    pickFirstDefined([process.env.OPENCLAW_GATEWAY_PASSWORD, cfg.gateway?.auth?.password]) ??
    undefined;

  if (mode === "token" || mode === "password") {
    return resolveRequiredAuthLabel(mode, { token, password });
  }
  if (token) {
    return { label: "token" };
  }
  if (password) {
    return { label: "password" };
  }
  return { error: "Gateway auth is not configured (no token or password)." };
}

function pickFirstDefined(candidates: Array<unknown>): string | null {
  for (const value of candidates) {
    const trimmed = normalizeOptionalString(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function resolveRequiredAuthLabel(
  mode: "token" | "password",
  values: { token?: string; password?: string },
): ResolveAuthLabelResult {
  if (mode === "token") {
    return values.token
      ? { label: "token" }
      : { error: "Gateway auth is set to token, but no token is configured." };
  }
  return values.password
    ? { label: "password" }
    : { error: "Gateway auth is set to password, but no password is configured." };
}

async function resolveGatewayUrl(api: OpenClawPluginApi): Promise<ResolveUrlResult> {
  const { resolveGatewayBindUrl, resolveGatewayPort } = await loadDevicePairApiModule();
  const cfg = api.config;
  const pluginCfg = (api.pluginConfig ?? {}) as DevicePairPluginConfig;
  const scheme = resolveScheme(cfg);
  const port = resolveGatewayPort(cfg);

  const configuredPublicUrl = normalizeOptionalString(pluginCfg.publicUrl);
  if (configuredPublicUrl) {
    const url = normalizeUrl(configuredPublicUrl, scheme);
    if (url) {
      return { url, source: "plugins.entries.device-pair.config.publicUrl" };
    }
    return { error: "Configured publicUrl is invalid." };
  }

  const configuredRemoteUrl = normalizeOptionalString(cfg.gateway?.remote?.url);
  const remoteUrl = configuredRemoteUrl ? normalizeUrl(configuredRemoteUrl, scheme) : null;
  if (configuredRemoteUrl && !remoteUrl) {
    return { error: "Configured gateway.remote.url is invalid." };
  }

  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
    const host = await resolveTailnetHost();
    if (!host) {
      return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
    }
    return { url: `wss://${host}`, source: `gateway.tailscale.mode=${tailscaleMode}` };
  }

  if (remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }

  const bindResult = resolveGatewayBindUrl({
    bind: cfg.gateway?.bind,
    customBindHost: cfg.gateway?.customBindHost,
    scheme,
    port,
    pickTailnetHost: pickTailnetIPv4,
    pickLanHost: pickLanIPv4,
  });
  if (bindResult) {
    return bindResult;
  }

  return {
    error:
      "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.",
  };
}

async function resolveMobilePairingGatewayUrl(api: OpenClawPluginApi): Promise<ResolveUrlResult> {
  const result = await resolveGatewayUrl(api);
  if (!result.url) {
    return result;
  }
  const mobilePairingUrlError = validateMobilePairingUrl(result.url, result.source);
  if (mobilePairingUrlError) {
    return { error: mobilePairingUrlError };
  }
  return result;
}

function encodeSetupCode(payload: SetupPayload): string {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildPairingFlowLines(stepTwo: string): string[] {
  return [
    "1) Open the iOS app → Settings → Gateway",
    `2) ${stepTwo}`,
    "3) Back here, run /pair approve",
    "4) If this code leaks or you are done, run /pair cleanup",
  ];
}

function buildSecurityNoticeLines(params: {
  kind: "setup code" | "QR code";
  expiresAtMs: number;
  markdown?: boolean;
}): string[] {
  const cleanupCommand = params.markdown ? "`/pair cleanup`" : "/pair cleanup";
  const securityPrefix = params.markdown ? "- " : "";
  const importantLine = params.markdown
    ? `**Important:** Run ${cleanupCommand} after pairing finishes.`
    : `IMPORTANT: After pairing finishes, run ${cleanupCommand}.`;
  return [
    `${securityPrefix}Security: single-use bootstrap token`,
    `${securityPrefix}Expires: ${formatDurationMinutes(params.expiresAtMs)}`,
    "",
    importantLine,
    `If this ${params.kind} leaks, run ${cleanupCommand} immediately.`,
  ];
}

function buildQrFollowUpLines(autoNotifyArmed: boolean): string[] {
  return autoNotifyArmed
    ? [
        "After scanning, wait here for the pairing request ping.",
        "I’ll auto-ping here when the pairing request arrives, then auto-disable.",
        "If the ping does not arrive, run `/pair approve latest` manually.",
      ]
    : ["After scanning, run `/pair approve` to complete pairing."];
}

function formatSetupReply(payload: SetupPayload, authLabel: string): string {
  const setupCode = encodeSetupCode(payload);
  return [
    "Pairing setup code generated.",
    "",
    ...buildPairingFlowLines("Paste the setup code below and tap Connect"),
    "",
    "Setup code:",
    setupCode,
    "",
    `Gateway: ${payload.url}`,
    `Auth: ${authLabel}`,
    ...buildSecurityNoticeLines({
      kind: "setup code",
      expiresAtMs: payload.expiresAtMs,
    }),
  ].join("\n");
}

function formatSetupInstructions(expiresAtMs: number): string {
  return [
    "Pairing setup code generated.",
    "",
    ...buildPairingFlowLines("Paste the setup code from my next message and tap Connect"),
    "",
    ...buildSecurityNoticeLines({
      kind: "setup code",
      expiresAtMs,
    }),
  ].join("\n");
}

function buildQrInfoLines(params: {
  payload: SetupPayload;
  authLabel: string;
  autoNotifyArmed: boolean;
  expiresAtMs: number;
}): string[] {
  return [
    `Gateway: ${params.payload.url}`,
    `Auth: ${params.authLabel}`,
    ...buildSecurityNoticeLines({
      kind: "QR code",
      expiresAtMs: params.expiresAtMs,
    }),
    "",
    ...buildQrFollowUpLines(params.autoNotifyArmed),
    "",
    "If your camera still won’t lock on, run `/pair` for a pasteable setup code.",
  ];
}

function formatQrInfoMarkdown(params: {
  payload: SetupPayload;
  authLabel: string;
  autoNotifyArmed: boolean;
  expiresAtMs: number;
}): string {
  return [
    `- Gateway: ${params.payload.url}`,
    `- Auth: ${params.authLabel}`,
    ...buildSecurityNoticeLines({
      kind: "QR code",
      expiresAtMs: params.expiresAtMs,
      markdown: true,
    }),
    "",
    ...buildQrFollowUpLines(params.autoNotifyArmed),
    "",
    "If your camera still won’t lock on, run `/pair` for a pasteable setup code.",
  ].join("\n");
}

function canSendQrPngToChannel(channel: string): boolean {
  return channel in QR_CHANNEL_SENDERS;
}

function resolveQrReplyTarget(ctx: QrCommandContext): string {
  if (ctx.channel === "discord") {
    const senderId = normalizeOptionalString(ctx.senderId) ?? "";
    if (senderId) {
      return senderId.startsWith("user:") || senderId.startsWith("channel:")
        ? senderId
        : `user:${senderId}`;
    }
  }
  return (
    normalizeOptionalString(ctx.senderId) ||
    normalizeOptionalString(ctx.from) ||
    normalizeOptionalString(ctx.to) ||
    ""
  );
}

async function issueSetupPayload(url: string): Promise<SetupPayload> {
  const { issueDeviceBootstrapToken, PAIRING_SETUP_BOOTSTRAP_PROFILE } =
    await loadDevicePairApiModule();
  const issuedBootstrap = await issueDeviceBootstrapToken({
    profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
  });
  return {
    url,
    bootstrapToken: issuedBootstrap.token,
    expiresAtMs: issuedBootstrap.expiresAtMs,
  };
}

async function sendQrPngToSupportedChannel(params: {
  api: OpenClawPluginApi;
  ctx: QrCommandContext;
  target: string;
  caption: string;
  qrFilePath: string;
}): Promise<boolean> {
  const mediaLocalRoots = [path.dirname(params.qrFilePath)];
  const accountId = normalizeOptionalString(params.ctx.accountId) || undefined;
  const sender = QR_CHANNEL_SENDERS[params.ctx.channel];
  if (!sender) {
    return false;
  }
  const adapter = await params.api.runtime.channel.outbound.loadAdapter(params.ctx.channel);
  const send = adapter?.sendMedia;
  if (!send) {
    return false;
  }
  await send({
    cfg: params.api.config,
    to: params.target,
    text: params.caption,
    ...sender.createOpts({
      ctx: params.ctx,
      qrFilePath: params.qrFilePath,
      mediaLocalRoots,
      accountId,
    }),
  });
  return true;
}

export default definePluginEntry({
  id: "device-pair",
  name: "Device Pair",
  description: "QR/bootstrap pairing helpers for OpenClaw devices",
  register(api: OpenClawPluginApi) {
    let notifierService: ReturnType<NotifyModule["createPairingNotifierService"]> | undefined;
    api.registerService({
      id: "device-pair-notifier",
      start: async (ctx) => {
        const { createPairingNotifierService } = await loadNotifyModule();
        notifierService = createPairingNotifierService(api);
        await notifierService.start(ctx);
      },
      stop: async (ctx) => {
        await notifierService?.stop?.(ctx);
        notifierService = undefined;
      },
    });

    api.registerCommand({
      name: "pair",
      description: "Generate setup codes and approve device pairing requests.",
      acceptsArgs: true,
      requiredScopes: ["operator.pairing"],
      handler: async (ctx) => {
        const args = normalizeOptionalString(ctx.args) ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const action = normalizeLowercaseStringOrEmpty(tokens[0]);
        const gatewayClientScopes = Array.isArray(ctx.gatewayClientScopes)
          ? ctx.gatewayClientScopes
          : undefined;
        const { buildMissingPairingScopeReply, resolvePairingCommandAuthState } =
          await loadPairCommandAuthModule();
        const authState = resolvePairingCommandAuthState({
          channel: ctx.channel,
          gatewayClientScopes,
          senderIsOwner: ctx.senderIsOwner,
        });
        api.logger.info?.(
          `device-pair: /pair invoked channel=${ctx.channel} sender=${ctx.senderId ?? "unknown"} action=${
            action || "new"
          }`,
        );

        if (authState.isMissingPairingPrivilege) {
          return buildMissingPairingScopeReply();
        }

        if (action === "status" || action === "pending") {
          const [{ listDevicePairing }, { formatPendingRequests }] = await Promise.all([
            loadDevicePairApiModule(),
            loadNotifyModule(),
          ]);
          const list = await listDevicePairing();
          return { text: formatPendingRequests(list.pending) };
        }

        if (action === "notify") {
          const notifyAction = normalizeLowercaseStringOrEmpty(tokens[1]) || "status";
          const { handleNotifyCommand } = await loadNotifyModule();
          return await handleNotifyCommand({
            api,
            ctx,
            action: notifyAction,
          });
        }

        if (action === "approve") {
          const [
            { listDevicePairing },
            { approvePendingPairingRequest, selectPendingApprovalRequest },
          ] = await Promise.all([loadDevicePairApiModule(), loadPairCommandApproveModule()]);
          const list = await listDevicePairing();
          const selected = selectPendingApprovalRequest({
            pending: list.pending,
            requested: normalizeOptionalString(tokens[1]),
          });
          if (selected.reply) {
            return selected.reply;
          }
          const pending = selected.pending;
          if (!pending) {
            return { text: "Pairing request not found." };
          }
          return await approvePendingPairingRequest({
            requestId: pending.requestId,
            callerScopes: authState.approvalCallerScopes,
          });
        }

        if (action === "cleanup" || action === "clear" || action === "revoke") {
          const { clearDeviceBootstrapTokens } = await loadDevicePairApiModule();
          const cleared = await clearDeviceBootstrapTokens();
          return {
            text:
              cleared.removed > 0
                ? `Invalidated ${cleared.removed} unused setup code${cleared.removed === 1 ? "" : "s"}.`
                : "No unused setup codes were active.",
          };
        }

        const authLabelResult = resolveAuthLabel(api.config);
        if (authLabelResult.error) {
          return { text: `Error: ${authLabelResult.error}` };
        }
        const urlResult = await resolveMobilePairingGatewayUrl(api);
        if (!urlResult.url) {
          return { text: `Error: ${urlResult.error ?? "Gateway URL unavailable."}` };
        }
        const authLabel = authLabelResult.label ?? "auth";

        if (action === "qr") {
          const channel = ctx.channel;
          const target = resolveQrReplyTarget(ctx);
          let autoNotifyArmed = false;

          if (channel === "telegram" && target) {
            try {
              const { armPairNotifyOnce } = await loadNotifyModule();
              autoNotifyArmed = await armPairNotifyOnce({ api, ctx });
            } catch (err) {
              api.logger.warn?.(
                `device-pair: failed to arm one-shot pairing notify (${(err as Error)?.message ?? err})`,
              );
            }
          }

          let payload = await issueSetupPayload(urlResult.url);
          let setupCode = encodeSetupCode(payload);

          const infoLines = buildQrInfoLines({
            payload,
            authLabel,
            autoNotifyArmed,
            expiresAtMs: payload.expiresAtMs,
          });

          if (target && canSendQrPngToChannel(channel)) {
            let qrFilePath: string | undefined;
            try {
              const { resolvePreferredOpenClawTmpDir, writeQrPngTempFile } =
                await loadDevicePairApiModule();
              qrFilePath = (
                await writeQrPngTempFile(setupCode, {
                  tmpRoot: resolvePreferredOpenClawTmpDir(),
                  dirPrefix: "device-pair-qr-",
                  fileName: "pair-qr.png",
                })
              ).filePath;
              const sent = await sendQrPngToSupportedChannel({
                api,
                ctx,
                target,
                caption: ["Scan this QR code with the OpenClaw iOS app:", "", ...infoLines].join(
                  "\n",
                ),
                qrFilePath,
              });
              if (sent) {
                return {
                  text:
                    `QR code sent above.\n` +
                    `Expires: ${formatDurationMinutes(payload.expiresAtMs)}\n` +
                    "IMPORTANT: Run /pair cleanup after pairing finishes.",
                };
              }
            } catch (err) {
              const { revokeDeviceBootstrapToken } = await loadDevicePairApiModule();
              api.logger.warn?.(
                `device-pair: QR image send failed channel=${channel}, falling back (${(err as Error)?.message ?? err})`,
              );
              await revokeDeviceBootstrapToken({ token: payload.bootstrapToken }).catch(() => {});
              payload = await issueSetupPayload(urlResult.url);
              setupCode = encodeSetupCode(payload);
            } finally {
              if (qrFilePath) {
                await rm(path.dirname(qrFilePath), { recursive: true, force: true }).catch(
                  () => {},
                );
              }
            }
          }

          api.logger.info?.(`device-pair: QR fallback channel=${channel} target=${target}`);
          if (channel === "webchat") {
            let qrDataUrl: string;
            try {
              const { renderQrPngDataUrl } = await loadDevicePairApiModule();
              qrDataUrl = await renderQrPngDataUrl(setupCode);
            } catch (err) {
              const { revokeDeviceBootstrapToken } = await loadDevicePairApiModule();
              api.logger.warn?.(
                `device-pair: webchat QR render failed, falling back (${(err as Error)?.message ?? err})`,
              );
              await revokeDeviceBootstrapToken({ token: payload.bootstrapToken }).catch(() => {});
              payload = await issueSetupPayload(urlResult.url);
              return {
                text:
                  "QR image delivery is not available on this channel right now, so I generated a pasteable setup code instead.\n\n" +
                  formatSetupReply(payload, authLabel),
              };
            }
            return {
              text: [
                "Scan this QR code with the OpenClaw iOS app:",
                "",
                formatQrInfoMarkdown({
                  payload,
                  authLabel,
                  autoNotifyArmed,
                  expiresAtMs: payload.expiresAtMs,
                }),
              ].join("\n"),
              mediaUrl: qrDataUrl,
              sensitiveMedia: true,
            };
          }

          return {
            text:
              "QR image delivery is not available on this channel, so I generated a pasteable setup code instead.\n\n" +
              formatSetupReply(payload, authLabel),
          };
        }
        const channel = ctx.channel;
        const target =
          normalizeOptionalString(ctx.senderId) ||
          normalizeOptionalString(ctx.from) ||
          normalizeOptionalString(ctx.to) ||
          "";
        const payload = await issueSetupPayload(urlResult.url);

        if (channel === "telegram" && target) {
          try {
            const runtimeKeys = Object.keys(api.runtime ?? {});
            const channelKeys = Object.keys(api.runtime?.channel ?? {});
            api.logger.debug?.(
              `device-pair: runtime keys=${runtimeKeys.join(",") || "none"} channel keys=${
                channelKeys.join(",") || "none"
              }`,
            );
            const adapter = await api.runtime.channel.outbound.loadAdapter("telegram");
            const send = adapter?.sendText;
            if (!send) {
              throw new Error(
                `telegram runtime unavailable (runtime keys: ${runtimeKeys.join(",")}; channel keys: ${channelKeys.join(
                  ",",
                )})`,
              );
            }
            await send({
              cfg: api.config,
              to: target,
              text: formatSetupInstructions(payload.expiresAtMs),
              ...(ctx.messageThreadId != null ? { threadId: ctx.messageThreadId } : {}),
              ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
            });
            api.logger.info?.(
              `device-pair: telegram split send ok target=${target} account=${ctx.accountId ?? "none"} thread=${
                ctx.messageThreadId ?? "none"
              }`,
            );
            return { text: encodeSetupCode(payload) };
          } catch (err) {
            api.logger.warn?.(
              `device-pair: telegram split send failed, falling back to single message (${(err as Error)?.message ?? err})`,
            );
          }
        }
        return {
          text: formatSetupReply(payload, authLabel),
        };
      },
    });
  },
});
