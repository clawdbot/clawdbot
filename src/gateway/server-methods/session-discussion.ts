import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionDiscussionInfoParams,
  validateSessionDiscussionInfoResult,
  validateSessionDiscussionOpenParams,
  validateSessionDiscussionOpenResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { getSessionDiscussionProvider } from "../../plugins/session-discussion-registry.js";
import { hasExplicitSessionName, maybeGenerateSessionTitle } from "../dashboard-session-title.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { formatForLog } from "../ws-log.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { loadAccessorSessionEntryForGatewayTarget } from "./sessions-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DISCUSSION_TITLE_TIMEOUT_MS = 10_000;

async function maybeGenerateTitleBeforeDiscussionOpen(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  agentId?: string;
}): Promise<void> {
  try {
    const cfg = params.context.getRuntimeConfig();
    const resolved = loadAccessorSessionEntryForGatewayTarget({
      cfg,
      key: params.sessionKey,
      agentId: params.agentId,
    });
    const { entry } = resolved;
    const sessionId = entry?.sessionId;
    if (!entry || !sessionId || hasExplicitSessionName(entry)) {
      return;
    }

    // Owning attempts and joins of an in-flight dashboard request both settle
    // through this promise; joins report false so only the owner claims the
    // persistence (and the emit below stays single-shot per title).
    const titleRequest = maybeGenerateSessionTitle({
      cfg,
      agentId: resolved.target.agentId,
      entry,
      sessionId,
      // Canonical key keeps metadata writes and request dedup consistent when
      // the open request addresses the session through an alias key.
      sessionKey: resolved.canonicalKey,
      storePath: resolved.storePath,
      userMessage: "",
    }).then(async (attempt) => {
      if (attempt.kind === "in-flight") {
        await attempt.settled.catch(() => {});
        return false;
      }
      return attempt.kind === "persisted";
    });
    const observedTitleRequest = titleRequest.catch((error: unknown) => {
      params.context.logGateway.warn(
        `dashboard session title generation failed: ${formatForLog(error)}`,
      );
      return false;
    });
    let timeout: NodeJS.Timeout | undefined;
    let persisted = false;
    // Discussion open waits at most 10 seconds for best-effort titling.
    // If generation fails or finishes later, open proceeds; a later plugin reconcile
    // picks up any title that completes after the timeout.
    try {
      persisted = await Promise.race([
        observedTitleRequest,
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), DISCUSSION_TITLE_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
    if (persisted) {
      // Mirror the dashboard first-turn path so session lists learn the new
      // title immediately instead of on their next full refresh.
      emitSessionsChanged(params.context, {
        sessionKey: resolved.canonicalKey,
        agentId: resolved.target.agentId,
        reason: "chat.title",
      });
    }
  } catch (error) {
    // Titling is best-effort; provider open remains the authoritative operation.
    params.context.logGateway.warn(
      `dashboard session title generation failed: ${formatForLog(error)}`,
    );
  }
}

export const sessionDiscussionHandlers: GatewayRequestHandlers = {
  "session.discussion.info": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionDiscussionInfoParams,
        "session.discussion.info",
        respond,
      )
    ) {
      return;
    }
    const requestedAgent = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      params.sessionKey,
      params.agentId,
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const provider = getSessionDiscussionProvider();
    if (!provider) {
      respond(true, { state: "none" }, undefined);
      return;
    }
    try {
      const sessionKey = resolveStoredSessionKeyForAgentStore({
        cfg: context.getRuntimeConfig(),
        agentId: requestedAgent.agentId,
        sessionKey: params.sessionKey,
      });
      const result = await provider.info({ sessionKey, agentId: requestedAgent.agentId });
      if (!validateSessionDiscussionInfoResult(result)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `invalid session.discussion.info result: ${formatValidationErrors(validateSessionDiscussionInfoResult.errors)}`,
          ),
        );
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      // A throwing provider is a transient failure, not "no discussion":
      // returning none here would make the UI cache-hide the feature until
      // reconnect. Only an absent provider means none.
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : "session discussion provider failed",
        ),
      );
    }
  },
  "session.discussion.open": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionDiscussionOpenParams,
        "session.discussion.open",
        respond,
      )
    ) {
      return;
    }
    const requestedAgent = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      params.sessionKey,
      params.agentId,
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const provider = getSessionDiscussionProvider();
    if (!provider) {
      respond(true, { state: "none" }, undefined);
      return;
    }
    try {
      await maybeGenerateTitleBeforeDiscussionOpen({
        context,
        sessionKey: params.sessionKey,
        agentId: requestedAgent.agentId,
      });
      const sessionKey = resolveStoredSessionKeyForAgentStore({
        cfg: context.getRuntimeConfig(),
        agentId: requestedAgent.agentId,
        sessionKey: params.sessionKey,
      });
      const result = await provider.open({ sessionKey, agentId: requestedAgent.agentId });
      if (!validateSessionDiscussionOpenResult(result)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `invalid session.discussion.open result: ${formatValidationErrors(validateSessionDiscussionOpenResult.errors)}`,
          ),
        );
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      // A throwing provider is a transient failure, not "no discussion":
      // returning none here would make the UI cache-hide the feature until
      // reconnect. Only an absent provider means none.
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : "session discussion provider failed",
        ),
      );
    }
  },
};
