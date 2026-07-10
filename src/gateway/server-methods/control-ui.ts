import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { ControlUiGitHubError } from "../control-ui-github-api.js";
import {
  loadControlUiGitHubPreview,
  parseControlUiGitHubPreviewTarget,
  type ControlUiGitHubPreviewTarget,
} from "../control-ui-github-preview.js";
import {
  loadControlUiSessionPullRequests,
  parseControlUiSessionPullRequestsParams,
  type ControlUiSessionPullRequestsParams,
} from "../control-ui-session-prs.js";
import type { GatewayRequestHandlers } from "./types.js";

type LoadGitHubPreview = (
  target: ControlUiGitHubPreviewTarget,
) => ReturnType<typeof loadControlUiGitHubPreview>;

type LoadSessionPullRequests = (
  params: ControlUiSessionPullRequestsParams,
) => ReturnType<typeof loadControlUiSessionPullRequests>;

export function createControlUiHandlers(
  loadGitHubPreview: LoadGitHubPreview = loadControlUiGitHubPreview,
  loadSessionPullRequests: LoadSessionPullRequests = loadControlUiSessionPullRequests,
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
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "GitHub preview unavailable", {
            retryable: statusCode === 429 || statusCode === 502,
          }),
        );
      }
    },
    "controlUi.sessionPullRequests": async ({ params, respond }) => {
      const parsed = parseControlUiSessionPullRequestsParams(params);
      if (!parsed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.sessionPullRequests params"),
        );
        return;
      }
      try {
        respond(true, await loadSessionPullRequests(parsed), undefined);
      } catch (error) {
        const statusCode = error instanceof ControlUiGitHubError ? error.statusCode : undefined;
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "session pull requests unavailable", {
            retryable: statusCode === 429 || statusCode === 502,
          }),
        );
      }
    },
  };
}

export const controlUiHandlers = createControlUiHandlers();
