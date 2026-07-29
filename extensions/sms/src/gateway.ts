// Sms plugin module implements gateway behavior.
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { createSmsIngressSpool, type SmsIngressLog } from "./ingress-spool.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler, type SmsWebhookHandlerParams } from "./webhook.js";

const CHANNEL_ID = "sms";

type SmsActiveRoute = {
  accountId: string;
  ingress: ReturnType<typeof createSmsIngressSpool>;
  unregisterRoute: () => void;
  ready: Promise<void>;
  stopTask?: Promise<void>;
};

const activeRoutePaths = new Map<string, SmsActiveRoute>();
const pendingRouteStops = new Map<string, Promise<void>>();

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function stopSmsWebhookRoute(webhookPath: string, route: SmsActiveRoute): Promise<void> {
  if (route.stopTask) {
    return route.stopTask;
  }
  const pauseTask = route.ingress.pause();
  route.unregisterRoute();
  if (activeRoutePaths.get(webhookPath) === route) {
    activeRoutePaths.delete(webhookPath);
  }
  const previousStop = pendingRouteStops.get(webhookPath) ?? Promise.resolve();
  // Pause wins synchronously before a replacement route can admit into the shared queue.
  const stopTask = Promise.all([previousStop, route.ready, pauseTask]).then(
    () => route.ingress.stop(),
    async (error: unknown) => {
      await Promise.allSettled([route.ingress.stop()]);
      throw error;
    },
  );
  route.stopTask = stopTask;
  pendingRouteStops.set(webhookPath, stopTask);
  const clear = () => {
    if (pendingRouteStops.get(webhookPath) === stopTask) {
      pendingRouteStops.delete(webhookPath);
    }
  };
  void stopTask.then(clear, clear);
  return stopTask;
}

export function collectSmsStartupWarnings(account: ResolvedSmsAccount): string[] {
  const warnings: string[] = [];
  if (
    !account.accountSid ||
    !account.authToken ||
    (!account.fromNumber && !account.messagingServiceSid)
  ) {
    warnings.push(
      "- SMS: accountSid, authToken, and fromNumber or messagingServiceSid are required.",
    );
  }
  if (!account.publicWebhookUrl && !account.dangerouslyDisableSignatureValidation) {
    warnings.push(
      "- SMS: publicWebhookUrl is required for Twilio signature validation. Set dangerouslyDisableSignatureValidation=true only for local testing.",
    );
  }
  if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
    warnings.push("- SMS: dmPolicy=allowlist with empty allowFrom rejects every sender.");
  }
  if (account.dmPolicy === "open" && !account.allowFrom.includes("*")) {
    warnings.push('- SMS: dmPolicy=open should set allowFrom=["*"] or explicit sender numbers.');
  }
  return warnings;
}

async function registerSmsWebhookRoute(params: {
  cfg: SmsWebhookHandlerParams["cfg"];
  account: ResolvedSmsAccount;
  channelRuntime: Parameters<typeof createSmsIngressSpool>[0]["channelRuntime"];
  abortSignal: AbortSignal;
  log?: SmsIngressLog;
}): Promise<{ lifecycle: Promise<void>; isActive: () => boolean }> {
  const webhookPath = normalizeWebhookPath(params.account.webhookPath);
  const currentRoute = activeRoutePaths.get(webhookPath);
  if (currentRoute && currentRoute.accountId !== params.account.accountId) {
    throw new Error(
      `SMS webhook path ${webhookPath} is already registered by account ${currentRoute.accountId}; configure a distinct webhookPath for account ${params.account.accountId}.`,
    );
  }
  const predecessorStop = currentRoute
    ? stopSmsWebhookRoute(webhookPath, currentRoute)
    : (pendingRouteStops.get(webhookPath) ?? Promise.resolve());
  const ingress = createSmsIngressSpool({
    cfg: params.cfg,
    account: params.account,
    channelRuntime: params.channelRuntime,
    ...(params.log ? { log: params.log } : {}),
  });
  let unregisterRoute: () => void;
  try {
    unregisterRoute = registerPluginHttpRoute({
      path: webhookPath,
      auth: "plugin",
      pluginId: CHANNEL_ID,
      accountId: params.account.accountId,
      log: (msg) => params.log?.info?.(msg),
      handler: createSmsWebhookHandler({ ...params, ingress }),
    });
  } catch (error) {
    await Promise.allSettled([predecessorStop, ingress.stop()]);
    throw error;
  }
  const route: SmsActiveRoute = {
    accountId: params.account.accountId,
    ingress,
    unregisterRoute,
    ready: Promise.resolve(),
  };
  activeRoutePaths.set(webhookPath, route);
  route.ready = predecessorStop.then(() => {
    // The replacement admits durably while paused, then pumps only after its predecessor stops.
    if (activeRoutePaths.get(webhookPath) === route && !route.stopTask) {
      ingress.start();
    }
  });
  const unregister = () => stopSmsWebhookRoute(webhookPath, route);
  const readinessAbort = new AbortController();
  const lifecycle = waitUntilAbort(
    AbortSignal.any([params.abortSignal, readinessAbort.signal]),
    unregister,
  );
  try {
    await route.ready;
  } catch (error) {
    // A failed replacement must release the abort waiter and observe its stop-task rejection.
    readinessAbort.abort();
    await Promise.allSettled([lifecycle]);
    throw error;
  }
  return {
    lifecycle,
    isActive: () => activeRoutePaths.get(webhookPath) === route,
  };
}

export async function startSmsGatewayAccount(params: {
  cfg: SmsWebhookHandlerParams["cfg"];
  account: ResolvedSmsAccount;
  channelRuntime: Parameters<typeof createSmsIngressSpool>[0]["channelRuntime"];
  abortSignal: AbortSignal;
  log?: SmsIngressLog;
}) {
  if (!params.account.enabled) {
    params.log?.info?.(`SMS account ${params.account.accountId} is disabled`);
    return waitUntilAbort(params.abortSignal);
  }
  const warnings = collectSmsStartupWarnings(params.account);
  if (warnings.some((warning) => warning.includes("required"))) {
    for (const warning of warnings) {
      params.log?.warn?.(warning);
    }
    return waitUntilAbort(params.abortSignal);
  }
  for (const warning of warnings) {
    params.log?.warn?.(warning);
  }
  const registration = await registerSmsWebhookRoute(params);
  if (registration.isActive()) {
    params.log?.info?.(
      `Registered SMS webhook route ${params.account.webhookPath} for account ${params.account.accountId}`,
    );
  }
  return registration.lifecycle;
}
