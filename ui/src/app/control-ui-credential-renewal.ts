// Control UI module keeps the Gateway-minted HTTP credential from expiring
// under a live dashboard.
//
// The credential hello-ok hands a Tailscale Serve browser carries a fixed TTL
// (see src/gateway/control-ui-device-credential.ts) and there is no refresh
// frame: the only thing that mints a replacement is another authenticated
// connect. A dashboard that holds one websocket open past the deadline would
// keep presenting an expired bearer and lose its assistant-media reads, so this
// schedules that reconnect *before* the deadline, while the credential still
// works. Lanes that carry no `httpCredential` schedule nothing and keep the
// connection lifecycle they already had.
import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";
import { resolveControlUiCredentialExpiryMs, type ControlUiAuthSource } from "./control-ui-auth.ts";

/** Renew once most of the lifetime is spent, leaving slack for the reconnect. */
const RENEWAL_LIFETIME_FRACTION = 0.85;
/**
 * Floor on the wait. A hello whose credential is already at or past its deadline
 * still waits this long, so a Gateway issuing stale deadlines costs one
 * reconnect per interval rather than a reconnect loop.
 */
const MIN_RENEWAL_DELAY_MS = 30_000;

type ControlUiCredentialRenewal = {
  /** Re-arm from a fresh hello. Idempotent: replaces any pending renewal. */
  arm: (source: ControlUiAuthSource) => void;
  /** Drop the pending renewal on disconnect, reconnect, or teardown. */
  stop: () => void;
};

export function createControlUiCredentialRenewal(deps: {
  /** Reconnect the live session; its hello-ok is what mints the replacement. */
  renew: () => void;
}): ControlUiCredentialRenewal {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const stop = () => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };
  return {
    arm: (source) => {
      // Clearing first is what keeps repeated hellos from stacking timers, and
      // what makes a session that stops carrying the credential go inert.
      stop();
      const expiresAtMs = resolveControlUiCredentialExpiryMs(source);
      if (expiresAtMs === null) {
        return;
      }
      const remainingMs = expiresAtMs - Date.now();
      timer = globalThis.setTimeout(
        () => {
          timer = null;
          // One reconnect per hello. A failed reconnect is left to the client's
          // own retry and the store's existing close reporting; re-arming only
          // happens when a new hello actually lands, so a Gateway that never
          // answers cannot be retried into a storm from here.
          deps.renew();
        },
        // Ceiling as well as floor. `httpCredentialExpiresAtMs` is an unbounded
        // protocol integer, and a delay past the 32-bit timer range coerces to an
        // immediate fire — which from here is renew, reconnect, fresh hello,
        // immediate fire again. The floor keeps a stale deadline from looping;
        // this keeps an oversized one from doing the same.
        resolveSafeTimeoutDelayMs(Math.floor(remainingMs * RENEWAL_LIFETIME_FRACTION), {
          minMs: MIN_RENEWAL_DELAY_MS,
        }),
      );
    },
    stop,
  };
}
