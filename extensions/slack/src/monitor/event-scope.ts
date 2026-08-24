// Slack plugin module validates non-serializable per-event Enterprise Grid scope.
import type { WebClient, WebClientOptions } from "@slack/web-api";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getSlackListenerUploadCompletionClient } from "../client.js";
import type { SlackInstallationIdentity } from "./enterprise-install.js";

export type SlackEventScope = Readonly<{
  teamId: string;
  // Keep Bolt's exact listener client for ordinary reads and writes.
  client: WebClient;
  // Completion is one-shot, so uploads finalize through a team-scoped client
  // that cannot inherit Bolt's normal request retries.
  uploadCompletionClient?: WebClient;
}>;

type SlackEventScopeResolution =
  | { ok: true; scope?: SlackEventScope }
  | {
      ok: false;
      reason:
        | "enterprise_event_for_workspace_account"
        | "wrong_app"
        | "not_enterprise_install"
        | "missing_enterprise_id"
        | "wrong_enterprise"
        | "missing_team_id"
        | "missing_listener_client";
    };

export function resolveSlackListenerEventScope(
  params: Parameters<typeof resolveSlackEventScope>[0] & {
    onDrop?: (reason: Extract<SlackEventScopeResolution, { ok: false }>["reason"]) => void;
  },
): SlackEventScope | null | undefined {
  const resolved = resolveSlackEventScope(params);
  if (!resolved.ok) {
    params.onDrop?.(resolved.reason);
    return null;
  }
  return resolved.scope;
}

export function resolveSlackEventScope(params: {
  identity: SlackInstallationIdentity;
  body: unknown;
  context?: {
    isEnterpriseInstall?: unknown;
    enterpriseId?: unknown;
    teamId?: unknown;
  };
  client?: WebClient;
  clientOptions?: WebClientOptions;
}): SlackEventScopeResolution {
  const context = params.context ?? {};
  if (params.identity.kind !== "enterprise") {
    return context.isEnterpriseInstall === true
      ? { ok: false, reason: "enterprise_event_for_workspace_account" }
      : { ok: true };
  }
  const body =
    params.body && typeof params.body === "object" ? (params.body as { api_app_id?: unknown }) : {};
  const apiAppId = normalizeOptionalString(body.api_app_id);
  if (apiAppId && params.identity.apiAppId && apiAppId !== params.identity.apiAppId) {
    return { ok: false, reason: "wrong_app" };
  }
  if (context.isEnterpriseInstall !== true) {
    return { ok: false, reason: "not_enterprise_install" };
  }
  const enterpriseId = normalizeOptionalString(context.enterpriseId);
  if (!enterpriseId) {
    return { ok: false, reason: "missing_enterprise_id" };
  }
  if (enterpriseId !== params.identity.enterpriseId) {
    return { ok: false, reason: "wrong_enterprise" };
  }
  const teamId = normalizeOptionalString(context.teamId);
  if (!teamId) {
    return { ok: false, reason: "missing_team_id" };
  }
  if (!params.client) {
    return { ok: false, reason: "missing_listener_client" };
  }
  const uploadCompletionClient = getSlackListenerUploadCompletionClient({
    listenerClient: params.client,
    teamId,
    clientOptions: params.clientOptions,
  });
  return {
    ok: true,
    scope: {
      teamId,
      client: params.client,
      ...(uploadCompletionClient ? { uploadCompletionClient } : {}),
    },
  };
}
