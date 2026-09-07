import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { GatewayClient } from "../../gateway/client.js";
import { createConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";
import { READ_SCOPE } from "../../gateway/method-scopes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

/** Keep the authenticated, exact-boot transport alive while terminal publication
 * awaits package readback. A stored receipt alone never reconstitutes this owner.
 * Loss is permanent: reconnects cannot silently replace the observed lifetime.
 */
export async function withUpdateCommandServingConnection<T>(
  params: {
    env: NodeJS.ProcessEnv;
    port: number;
    gateway: { bootId: string; version: string; buildId: string | null };
    assertCurrent: () => void;
  },
  operation: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  params.assertCurrent();
  const context = await resolveGatewayRestartProbeContext(params.env);
  params.assertCurrent();
  const target = await createConfiguredGatewayLocalProbe(context.config).resolveWebSocketTarget(
    params.port,
  );
  params.assertCurrent();
  if (!target || !params.gateway.bootId || !params.gateway.version) {
    throw new UpdateCommandRecoveryPendingError(
      "Serving connection requires its exact local boot.",
    );
  }
  let active = true;
  let admitted = false;
  let sawSequencedEvent = false;
  let failure: Error | undefined;
  const connected = createDeferredCore();
  const assertCurrent = () => {
    params.assertCurrent();
    if (!active || !admitted || failure || !client.connected) {
      throw failure ?? new UpdateCommandRecoveryPendingError("Serving connection is not live.");
    }
  };
  // Reuse the first-party local probe's read-only shared-auth contract. The URL
  // is built from the loopback port, never a supplied remote override.
  const authNone = context.config.gateway?.auth?.mode === "none";
  if (authNone && context.config.gateway?.mode === "remote") {
    throw new UpdateCommandRecoveryPendingError(
      "Serving auth-none requires the configured local gateway.",
    );
  }
  const invalidate = (detail: string) => {
    failure ??= new UpdateCommandRecoveryPendingError(detail);
    admitted = false;
    connected.reject(failure);
    client.stop();
  };
  const client = new GatewayClient({
    url: target.url,
    tlsFingerprint: target.tlsFingerprint,
    token: context.auth?.token,
    password: context.auth?.password,
    deviceIdentity: null,
    sharedStateMode: "read-only",
    env: params.env,
    scopes: [READ_SCOPE],
    clientName: authNone ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
    mode: authNone ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI,
    requestTimeoutMs: 3_000,
    onHelloOk(hello) {
      if (
        !active ||
        failure ||
        admitted ||
        hello.server.bootId !== params.gateway.bootId ||
        hello.server.version !== params.gateway.version ||
        (hello.server.buildId ?? null) !== params.gateway.buildId
      ) {
        invalidate("Serving connection did not retain the verified gateway identity.");
        return;
      }
      admitted = true;
      connected.resolve();
    },
    onClose: () => invalidate("Serving connection closed before completion."),
    onConnectError: () => invalidate("Serving connection could not authenticate."),
    onGap: () => invalidate("Serving connection lost lifecycle events."),
    onReconnectPaused: () => invalidate("Serving connection cannot be renewed."),
    onEvent(event) {
      // The current server numbers delivered/dropped broadcasts per connection
      // starting at one. Its challenge is unsequenced; the general client only
      // detects subsequent gaps and cannot attest this initial boundary.
      if (typeof event.seq === "number" && !sawSequencedEvent) {
        sawSequencedEvent = true;
        if (event.seq !== 1) {
          invalidate("Serving connection missed its initial lifecycle events.");
          return;
        }
      }
      if (event.event === "shutdown") {
        invalidate("Serving gateway began shutdown before completion.");
      }
    },
  });
  const timer = setTimeout(() => invalidate("Serving connection timed out."), 3_000);
  try {
    client.start();
    await connected.promise;
    clearTimeout(timer);
    assertCurrent();
    // A successful correlated RPC is required; accepting an auth error or merely
    // opening the socket would not establish first-party serving authority.
    await client.request("health");
    assertCurrent();
    const result = await operation(assertCurrent);
    assertCurrent();
    return result;
  } finally {
    active = false;
    admitted = false;
    clearTimeout(timer);
    await client.stopAndWait({ timeoutMs: 3_000 });
  }
}
