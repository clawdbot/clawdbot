import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionPermissionMode } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { prepareEmbeddedRunPermissionChange } from "../../agents/embedded-agent-runner/run-permissions.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { beginSessionPermissionChange } from "../session-permission-change.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

export type ActiveSessionPermissionChange = {
  apply: (mode: SessionPermissionMode | null) => Promise<ErrorShape | undefined>;
  finish: () => void;
};

/** Prepare before persistence; apply and finish under the same session mutation owner. */
export function prepareSessionPatchPermissionChange(params: {
  context: GatewayRequestContext;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent: () => ErrorShape | undefined;
}): { ok: false; error: ErrorShape } | { ok: true; change?: ActiveSessionPermissionChange } {
  const change = prepareEmbeddedRunPermissionChange(params.sessionId);
  if (change.kind === "idle") {
    return { ok: true };
  }
  if (change.kind === "unsupported") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "This run cannot apply permissions while active. Stop the run, then change permissions.",
      ),
    };
  }
  const finish = beginSessionPermissionChange(params.sessionId);
  const publish = () =>
    emitSessionsChanged(params.context, {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      reason: "patch",
    });
  return {
    ok: true,
    change: {
      apply: async (mode) => {
        publish();
        try {
          const authorizationFailure = params.assertCurrent();
          if (authorizationFailure) {
            throw new Error(authorizationFailure.message);
          }
          const applied = await change.apply(mode, (authority) =>
            params.context.cancelRunBoundApprovals?.(authority),
          );
          if (!applied) {
            throw new Error("The active run ended or was replaced before applying permissions.");
          }
          return undefined;
        } catch (error) {
          // A saved mode must not leave an older, broader generation running.
          // Stop only the captured owner, never an unrelated replacement run.
          try {
            change.stop();
          } catch (stopError) {
            params.context.logGateway?.warn(
              `Permission change stop failed: ${formatErrorMessage(stopError)}`,
            );
          }
          params.context.logGateway?.warn(`Permission change failed: ${formatErrorMessage(error)}`);
          return errorShape(
            ErrorCodes.UNAVAILABLE,
            "Permissions were saved, but could not be applied to the active run. Stop the run and continue to use the saved permissions.",
          );
        }
      },
      finish: () => {
        finish();
        publish();
      },
    },
  };
}
