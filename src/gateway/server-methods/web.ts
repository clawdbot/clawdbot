// Web login methods delegate QR-login start/wait requests to the active channel
// plugin that owns web login gateway methods.
import {
  ErrorCodes,
  errorShape,
  validateWebLoginStartParams,
  validateWebLoginWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { resolveMissingOfficialExternalChannelPluginRepairHint } from "../../plugins/official-external-plugin-repair-hints.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const WEB_LOGIN_METHODS = new Set(["web.login.start", "web.login.wait"]);

/** Resolves the channel plugin that currently owns web QR-login methods. */
const resolveWebLoginProvider = () =>
  listChannelPlugins().find((plugin) =>
    [
      ...(plugin.gatewayMethods ?? []),
      ...(plugin.gatewayMethodDescriptors ?? []).map((descriptor) => descriptor.name),
    ].some((method) => WEB_LOGIN_METHODS.has(method)),
  ) ?? null;

type WebLoginProvider = NonNullable<ReturnType<typeof resolveWebLoginProvider>>;
type WebLoginGateway = NonNullable<WebLoginProvider["gateway"]>;
type WebLoginGatewayMethod = "loginWithQrStart" | "loginWithQrWait";

function resolveAccountId(params: unknown): string | undefined {
  return typeof (params as { accountId?: unknown }).accountId === "string"
    ? (params as { accountId?: string }).accountId
    : undefined;
}

function resolveMissingWebLoginPluginHint(context: GatewayRequestContext): string | null {
  const cfg = context.getRuntimeConfig();
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return null;
  }
  const hints = Object.keys(channels)
    .map((channelId) =>
      resolveMissingOfficialExternalChannelPluginRepairHint({
        config: cfg,
        channelId,
      }),
    )
    .filter((hint): hint is NonNullable<typeof hint> => Boolean(hint));
  if (hints.length === 0) {
    return null;
  }
  if (hints.length === 1) {
    return hints[0].repairHint;
  }
  const labels = [...new Set(hints.map((hint) => hint.label))];
  const installCommands = [...new Set(hints.map((hint) => hint.installCommand))];
  const doctorFixCommand = hints[0].doctorFixCommand;
  return `Configured official external channel plugins are missing for ${labels.join(", ")}. Install them with: ${installCommands.join("; ")}, or run: ${doctorFixCommand}.`;
}

function respondProviderUnavailable(params: {
  respond: RespondFn;
  context: GatewayRequestContext;
}) {
  const repairHint = resolveMissingWebLoginPluginHint(params.context);
  const message = repairHint
    ? `web login provider is not available. ${repairHint}`
    : "web login provider is not available";
  params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function respondProviderUnsupported(respond: RespondFn, providerId: string) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `web login is not supported by provider ${providerId}`),
  );
}

function respondWebLoginUnavailable(respond: RespondFn, err: unknown) {
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
}

/** Resolves a concrete provider gateway login method or sends the public error. */
function resolveWebLoginRequest<TMethod extends WebLoginGatewayMethod>(params: {
  rawParams: unknown;
  respond: RespondFn;
  context: GatewayRequestContext;
  gatewayMethod: TMethod;
}): {
  accountId?: string;
  provider: WebLoginProvider;
  run: NonNullable<WebLoginGateway[TMethod]>;
} | null {
  const accountId = resolveAccountId(params.rawParams);
  const provider = resolveWebLoginProvider();
  if (!provider) {
    respondProviderUnavailable({
      respond: params.respond,
      context: params.context,
    });
    return null;
  }
  const gateway = provider.gateway;
  const run = gateway?.[params.gatewayMethod];
  if (!run) {
    respondProviderUnsupported(params.respond, provider.id);
    return null;
  }
  return { accountId, provider, run: run.bind(gateway) as NonNullable<WebLoginGateway[TMethod]> };
}

/** Checks whether the matching channel/account should be restored after login start. */
function wasChannelRunning(params: {
  context: Parameters<GatewayRequestHandlers["web.login.start"]>[0]["context"];
  channelId: ChannelId;
  accountId?: string;
}): boolean {
  const runtime = params.context.getRuntimeSnapshot();
  if (params.accountId) {
    const accountRuntime = runtime.channelAccounts[params.channelId]?.[params.accountId];
    if (accountRuntime) {
      return accountRuntime.running === true;
    }
  }
  if (!params.accountId) {
    return runtime.channels[params.channelId]?.running === true;
  }
  const defaultRuntime = runtime.channels[params.channelId];
  return defaultRuntime?.accountId === params.accountId && defaultRuntime.running === true;
}

/** Gateway handlers for plugin-owned web QR-login flows. */
export const webHandlers: GatewayRequestHandlers = {
  "web.login.start": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWebLoginStartParams, "web.login.start", respond)) {
      return;
    }
    try {
      const request = resolveWebLoginRequest({
        rawParams: params,
        respond,
        context,
        gatewayMethod: "loginWithQrStart",
      });
      if (!request) {
        return;
      }
      const { accountId, provider, run } = request;
      const wasRunning = wasChannelRunning({
        context,
        channelId: provider.id,
        accountId,
      });
      const forceLogin = Boolean(params.force);
      const stoppedBeforeLogin = forceLogin || !wasRunning;
      if (stoppedBeforeLogin) {
        await context.stopChannel(provider.id, accountId);
      }
      const result = await run({
        force: forceLogin,
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
        verbose: Boolean(params.verbose),
        accountId,
      });
      const stoppedAfterQrTakeover = !stoppedBeforeLogin && Boolean(result.qrDataUrl);
      if (stoppedAfterQrTakeover) {
        await context.stopChannel(provider.id, accountId);
      }
      const stoppedForLogin = stoppedBeforeLogin || stoppedAfterQrTakeover;
      if (result.connected && stoppedForLogin) {
        await context.startChannel(provider.id, accountId);
      } else if (wasRunning && stoppedForLogin && !result.qrDataUrl) {
        // When start fails before producing a QR code, restore the previously
        // running channel/account so a transient login failure does not stop it.
        await context.startChannel(provider.id, accountId);
      }
      respond(true, result, undefined);
    } catch (err) {
      respondWebLoginUnavailable(respond, err);
    }
  },
  "web.login.wait": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWebLoginWaitParams, "web.login.wait", respond)) {
      return;
    }
    try {
      const request = resolveWebLoginRequest({
        rawParams: params,
        respond,
        context,
        gatewayMethod: "loginWithQrWait",
      });
      if (!request) {
        return;
      }
      const { accountId, provider, run } = request;
      const result = await run({
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
        accountId,
        currentQrDataUrl:
          typeof params.currentQrDataUrl === "string" ? params.currentQrDataUrl : undefined,
      });
      if (result.connected) {
        await context.startChannel(provider.id, accountId);
      }
      respond(true, result, undefined);
    } catch (err) {
      respondWebLoginUnavailable(respond, err);
    }
  },
};
