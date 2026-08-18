// Slack plugin module settles delivery-gated thread parent forks.
import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { settleProvisionalParentFork } from "openclaw/plugin-sdk/session-store-runtime";
import { formatSlackError } from "../../errors.js";

export async function settleSlackProvisionalParentFork(params: {
  agentId: string;
  confirmedReplyDelivered: boolean;
  fork: { id: string; sessionKey: string };
  runtime: RuntimeEnv;
  storePath: string;
}): Promise<void> {
  const outcome = params.confirmedReplyDelivered ? "confirm" : "retire";
  try {
    // Queue counts describe attempted dispatcher work, not transport
    // success. Keep copied parent context only after Slack acknowledges a
    // normal, preview, streaming, or fallback delivery.
    const settlement = await settleProvisionalParentFork({
      agentId: params.agentId,
      id: params.fork.id,
      outcome,
      sessionKey: params.fork.sessionKey,
      storePath: params.storePath,
    });
    if (settlement === "mismatch" || settlement === "stale") {
      params.runtime.error?.(
        danger(
          `slack: provisional parent fork ${outcome} did not settle for ${params.fork.sessionKey} (${settlement})`,
        ),
      );
    }
  } catch (error) {
    // A concurrent thread turn can hold the session admission fence. Its
    // initializer sees the still-provisional marker and rolls over to an
    // isolated generation, so cleanup failure must not duplicate a visible
    // Slack reply or fail the already-settled delivery.
    params.runtime.error?.(
      danger(
        `slack: provisional parent fork settlement failed for ${params.fork.sessionKey}: ${formatSlackError(error)}`,
      ),
    );
  }
}
