import { GatewayClient, type GatewayClientOptions } from "../../src/gateway/client.js";

/** A failed stop cannot be treated as a retryable connection failure. */
export class GatewayTestClientCleanupError extends AggregateError {}

/** Own acquisition until hello-ok, without imposing identity or protocol defaults. */
export async function acquireGatewayTestClient(
  options: Omit<GatewayClientOptions, "onConnectError" | "onClose">,
  wait: {
    timeoutMs: number;
    timeoutMessage: string;
    closeMessage: string;
    unrefTimeout?: boolean;
  },
): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: { client: GatewayClient } | { error: unknown }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if ("error" in outcome) {
        // Join the client's bounded stop contract before rejecting acquisition.
        // Its 250ms terminate fallback is not a guarantee of a raw WS close event.
        void (async () => {
          try {
            await client.stopAndWait({ timeoutMs: 1_000 });
          } catch (cleanupError) {
            throw new GatewayTestClientCleanupError(
              [outcome.error, cleanupError],
              "QA gateway fixture failed",
            );
          }
          throw outcome.error;
        })().catch(reject);
      } else {
        resolve(outcome.client);
      }
    };
    const client = new GatewayClient({
      ...options,
      onHelloOk: (hello) => {
        options.onHelloOk?.(hello);
        settle({ client });
      },
      onConnectError: (error) => settle({ error }),
      onClose: (code, reason) =>
        settle({ error: new Error(`${wait.closeMessage} (${code}): ${reason}`) }),
    });
    const timer = setTimeout(
      () => settle({ error: new Error(wait.timeoutMessage) }),
      wait.timeoutMs,
    );
    if (wait.unrefTimeout) {
      timer.unref();
    }
    try {
      client.start();
    } catch (error) {
      settle({ error });
    }
  });
}
