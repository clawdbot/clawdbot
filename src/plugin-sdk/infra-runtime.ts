import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  drainPendingDeliveries as coreDrainPendingDeliveries,
  type DeliverFn,
  type RecoveryLogger,
} from "../infra/outbound/delivery-queue.js";

// Public runtime/transport helpers for plugins that need shared infra behavior.

function normalizeWhatsAppReconnectAccountId(accountId?: string): string {
  return (accountId ?? "").trim() || "default";
}

const WHATSAPP_NO_LISTENER_ERROR_RE = /No active WhatsApp Web listener/i;

type OutboundDeliverRuntimeModule = typeof import("../infra/outbound/deliver-runtime.js");
type DrainPendingDeliveriesOptions = Omit<
  Parameters<typeof coreDrainPendingDeliveries>[0],
  "deliver"
> & {
  deliver?: DeliverFn;
};

let outboundDeliverRuntimePromise: Promise<OutboundDeliverRuntimeModule> | null = null;

async function loadOutboundDeliverRuntime(): Promise<OutboundDeliverRuntimeModule> {
  outboundDeliverRuntimePromise ??= import("../infra/outbound/deliver-runtime.js");
  return await outboundDeliverRuntimePromise;
}

export async function drainPendingDeliveries(opts: DrainPendingDeliveriesOptions): Promise<void> {
  const deliver = opts.deliver ?? (await loadOutboundDeliverRuntime()).deliverOutboundPayloads;
  await coreDrainPendingDeliveries({
    ...opts,
    deliver,
  });
}

/**
 * @deprecated Prefer plugin-owned reconnect policy wired through
 * `drainPendingDeliveries(...)`. This compatibility shim preserves the
 * historical public SDK symbol for existing plugin callers.
 */
export async function drainReconnectQueue(opts: {
  accountId: string;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  deliver?: DeliverFn;
}): Promise<void> {
  const normalizedAccountId = normalizeWhatsAppReconnectAccountId(opts.accountId);
  await drainPendingDeliveries({
    drainKey: `whatsapp:${normalizedAccountId}`,
    logLabel: "WhatsApp reconnect drain",
    cfg: opts.cfg,
    log: opts.log,
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({
      match:
        entry.channel === "whatsapp" &&
        normalizeWhatsAppReconnectAccountId(entry.accountId) === normalizedAccountId &&
        typeof entry.lastError === "string" &&
        WHATSAPP_NO_LISTENER_ERROR_RE.test(entry.lastError),
      bypassBackoff: true,
    }),
  });
}

export * from "../infra/backoff.js";
export * from "../infra/channel-activity.js";
export * from "../infra/dedupe.js";
export * from "../infra/diagnostic-events.js";
export * from "../infra/diagnostic-flags.js";
export * from "../infra/env.js";
export * from "../infra/errors.js";
export * from "../infra/exec-approval-command-display.ts";
export * from "../infra/exec-approval-channel-runtime.ts";
export * from "../infra/exec-approval-reply.ts";
export * from "../infra/exec-approval-session-target.ts";
export * from "../infra/exec-approvals.ts";
export * from "../infra/approval-native-delivery.ts";
export * from "../infra/approval-native-runtime.ts";
export * from "../infra/plugin-approvals.ts";
export * from "../infra/fetch.js";
export * from "../infra/file-lock.js";
export * from "../infra/format-time/format-duration.ts";
export * from "../infra/fs-safe.ts";
export * from "../infra/heartbeat-events.ts";
export * from "../infra/heartbeat-visibility.ts";
export * from "../infra/home-dir.js";
export * from "../infra/http-body.js";
export * from "../infra/json-files.js";
export * from "../infra/local-file-access.js";
export * from "../infra/map-size.js";
export * from "../infra/net/hostname.ts";
export * from "../infra/net/fetch-guard.js";
export * from "../infra/net/proxy-env.js";
export * from "../infra/net/proxy-fetch.js";
export * from "../infra/net/undici-global-dispatcher.js";
export * from "../infra/net/ssrf.js";
export * from "../infra/outbound/identity.js";
export * from "../infra/outbound/sanitize-text.js";
export * from "../infra/parse-finite-number.js";
export * from "../infra/outbound/send-deps.js";
export * from "../infra/retry.js";
export * from "../infra/retry-policy.js";
export * from "../infra/scp-host.ts";
export * from "../infra/secret-file.js";
export * from "../infra/secure-random.js";
export * from "../infra/system-events.js";
export * from "../infra/system-message.ts";
export * from "../infra/tmp-openclaw-dir.js";
export * from "../infra/transport-ready.js";
export * from "../infra/wsl.ts";
export * from "../utils/fetch-timeout.js";
export { createRuntimeOutboundDelegates } from "../channels/plugins/runtime-forwarders.js";
export * from "./ssrf-policy.js";
