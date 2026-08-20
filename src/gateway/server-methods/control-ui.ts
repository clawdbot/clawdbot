import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { isTrustedSecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { ControlUiSessionPreview } from "../control-ui-contract.js";
import {
  CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
  ControlUiGitHubError,
} from "../control-ui-github-api.js";
import {
  loadControlUiGitHubPreview,
  parseControlUiGitHubPreviewTarget,
  type ControlUiGitHubPreviewTarget,
} from "../control-ui-github-preview.js";
import { parseControlUiSessionPullRequestsSubscribeParams } from "../control-ui-session-pr-subscriptions.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { buildGatewaySessionRow } from "../session-utils.js";
import { loadSessionEntriesForTarget } from "./sessions-shared.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type LoadGitHubPreview = (
  target: ControlUiGitHubPreviewTarget,
) => ReturnType<typeof loadControlUiGitHubPreview>;

type SessionPreviewSource = {
  sessionKey: string;
  title?: string;
  derivedTitle?: string;
  agentId: string;
  kind?: string;
  channel?: string;
  updatedAt?: number | null;
  lastMessagePreview?: string;
  archived?: boolean;
};

type LoadSessionPreview = (
  sessionKey: string,
  context: GatewayRequestContext,
  client: GatewayClient | null,
) => SessionPreviewSource | null | Promise<SessionPreviewSource | null>;

const SESSION_PREVIEW_TEXT_MAX_CHARS = 200;

function boundedPreviewText(value: string | undefined, maxChars = SESSION_PREVIEW_TEXT_MAX_CHARS) {
  const trimmed = value?.trim();
  return trimmed ? truncateUtf16Safe(trimmed, maxChars) : undefined;
}

function parseSessionPreviewKey(params: unknown): string | null {
  if (!isRecord(params) || Object.keys(params).some((key) => key !== "sessionKey")) {
    return null;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  return sessionKey && sessionKey.length <= 512 ? sessionKey : null;
}

function projectSessionPreview(source: SessionPreviewSource | null): ControlUiSessionPreview {
  if (!source) {
    return { status: "unavailable" };
  }
  const lastMessagePreview = boundedPreviewText(
    source.lastMessagePreview ? redactToolPayloadText(source.lastMessagePreview) : undefined,
  );
  const title = boundedPreviewText(source.title);
  const derivedTitle = boundedPreviewText(source.derivedTitle);
  const kind = boundedPreviewText(source.kind, 64);
  const channel = boundedPreviewText(source.channel, 80);
  return {
    status: "ok",
    sessionKey: source.sessionKey,
    agentId: source.agentId,
    ...(title ? { title } : {}),
    ...(derivedTitle ? { derivedTitle } : {}),
    ...(kind ? { kind } : {}),
    ...(channel ? { channel } : {}),
    ...(typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
      ? { updatedAt: source.updatedAt }
      : {}),
    ...(lastMessagePreview ? { lastMessagePreview } : {}),
    ...(typeof source.archived === "boolean" ? { archived: source.archived } : {}),
  };
}

function loadControlUiSessionPreview(
  sessionKey: string,
  context: GatewayRequestContext,
  client: GatewayClient | null,
): SessionPreviewSource | null {
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, sessionKey);
  if (!requestedAgent.ok) {
    return null;
  }
  const { target, storePath, store, entry } = loadSessionEntriesForTarget({
    key: sessionKey,
    cfg,
    ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
  });
  if (!entry) {
    return null;
  }
  // Hover previews must not reveal more than sessions.list: apply the same
  // incognito/draft sharing predicate so a member cannot preview-by-key a
  // session the sidebar hides from them.
  const entryFilter = createSessionListEntryFilter({ client });
  if (entryFilter && !entryFilter(target.canonicalKey, entry)) {
    return null;
  }
  const row = buildGatewaySessionRow({
    cfg,
    storePath,
    store,
    key: target.canonicalKey,
    entry,
    includeDerivedTitles: true,
    includeLastMessage: true,
    transcriptUsageMaxBytes: 64 * 1024,
  });
  return {
    sessionKey: row.key,
    agentId: row.agentId ?? target.agentId,
    title: row.displayName,
    derivedTitle: row.derivedTitle,
    kind: row.kind,
    channel: row.channel,
    updatedAt: row.updatedAt,
    lastMessagePreview: row.lastMessagePreview,
    archived: row.archived,
  };
}

export function createControlUiHandlers(
  loadGitHubPreview: LoadGitHubPreview = loadControlUiGitHubPreview,
  loadSessionPreview: LoadSessionPreview = loadControlUiSessionPreview,
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
        const credentialUnavailable = isTrustedSecretSurfaceUnavailableError(error);
        const message = credentialUnavailable
          ? CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE
          : "GitHub preview unavailable";
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, message, {
            retryable: !credentialUnavailable && (statusCode === 429 || statusCode === 502),
          }),
        );
      }
    },
    "controlUi.sessionPreview": async ({ params, client, context, respond }) => {
      const sessionKey = parseSessionPreviewKey(params);
      if (!sessionKey) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.sessionPreview params"),
        );
        return;
      }
      try {
        respond(
          true,
          projectSessionPreview(await loadSessionPreview(sessionKey, context, client)),
          undefined,
        );
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Session preview unavailable"),
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
