import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { isTrustedSecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import { ControlUiGitHubError } from "../control-ui-github-api.js";
import {
  loadControlUiGitHubPreview,
  parseControlUiGitHubPreviewTarget,
  type ControlUiGitHubPreviewTarget,
} from "../control-ui-github-preview.js";
import { parseControlUiSessionPullRequestsSubscribeParams } from "../control-ui-session-pr-subscriptions.js";
import type { GatewayRequestHandlers } from "./types.js";

type LoadGitHubPreview = (
  target: ControlUiGitHubPreviewTarget,
) => ReturnType<typeof loadControlUiGitHubPreview>;

export function createControlUiHandlers(
  loadGitHubPreview: LoadGitHubPreview = loadControlUiGitHubPreview,
): GatewayRequestHandlers {
  return {
    "controlUi.githubPreview": async ({ params, respond }) => {
      const target = parseControlUiGitHubPreviewTarget(params);
      if (!target) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.githubPreview params"),
        );
        return;
      }
      try {
        respond(true, await loadGitHubPreview(target), undefined);
      } catch (error) {
        const statusCode = error instanceof ControlUiGitHubError ? error.statusCode : undefined;
        const message = isTrustedSecretSurfaceUnavailableError(error)
          ? error.message
          : "GitHub preview unavailable";
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, message, {
            retryable: statusCode === 429 || statusCode === 502,
          }),
        );
      }
    },
    "controlUi.sessionPullRequests.subscribe": async ({ params, client, context, respond }) => {
      const parsed = parseControlUiSessionPullRequestsSubscribeParams(params);
      if (!parsed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid controlUi.sessionPullRequests.subscribe params",
          ),
        );
        return;
      }
      const connId = client?.connId?.trim();
      const subscriptions = context.controlUiSessionPullRequests;
      if (!connId || !subscriptions) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "session pull request subscriptions unavailable"),
        );
        return;
      }
      if (parsed.refreshSessionKeys.length > 0) {
        await subscriptions.replace(connId, parsed.sessionKeys, new Set(parsed.refreshSessionKeys));
      } else {
        await subscriptions.replace(connId, parsed.sessionKeys);
      }
      respond(true, { subscribed: parsed.sessionKeys.length > 0 }, undefined);
    },
  };
}

export const controlUiHandlers = createControlUiHandlers();
