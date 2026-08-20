import { Type } from "typebox";
import {
  GitHubPublicationBodySchema,
  GitHubPublicationTitleSchema,
  type SessionGitHubPublicationResult,
  type SessionGitHubPublishParams,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

export function createGitHubPublishTool(
  options: {
    callGateway?: InProcessGatewayCaller;
  } = {},
): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  return {
    label: "GitHub Publish",
    name: "github_publish",
    description:
      "Publish the current session-owned Git worktree through the Gateway. Call only after the work is complete. On cloud or remote-exec sessions this records a durable request; finish the turn so authoritative reconciliation can complete before the Gateway commits, pushes through an exact HTTPS path, and creates or reuses a draft pull request. Credentials never enter tool arguments or the worker.",
    parameters: Type.Object(
      {
        title: Type.Optional(GitHubPublicationTitleSchema),
        body: Type.Optional(GitHubPublicationBodySchema),
      },
      { additionalProperties: false },
    ),
    execute: async (toolCallId, rawArgs) => {
      // SAFETY: the tool runtime validates rawArgs against the closed schema above.
      const input = rawArgs as Omit<SessionGitHubPublishParams, "idempotencyKey" | "sessionKey">;
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.sessionKey) {
        throw new Error("GitHub publication requires the current Gateway session.");
      }
      const result = await callGateway<SessionGitHubPublicationResult>("sessions.github.publish", {
        sessionKey: caller.sessionKey,
        idempotencyKey: toolCallId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.body ? { body: input.body } : {}),
      });
      return jsonResult(result);
    },
  };
}
