import type { OpenClawPluginApi } from "../api.js";
import { summarizeCloseoutRecord, type CloseoutTracker } from "./closeout-tracker.js";
import { respondError } from "./gateway-helpers.js";

const ADMIN_SCOPE = "operator.admin" as const;
const MAX_AGENT_ID_LENGTH = 128;
const MAX_CLOSEOUT_ID_LENGTH = 128;
const MAX_EVIDENCE_LENGTH = 2_000;

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function resolveConfirmer(
  client: {
    authenticatedUserId?: string;
    pairedClientId?: string;
  } | null,
): string {
  if (client?.authenticatedUserId?.trim()) {
    return `user:${client.authenticatedUserId.trim()}`;
  }
  if (client?.pairedClientId?.trim()) {
    return `device:${client.pairedClientId.trim()}`;
  }
  throw new Error("authenticated operator identity is required");
}

export function registerCloseoutGatewayMethod(params: {
  api: OpenClawPluginApi;
  tracker: CloseoutTracker;
}) {
  params.api.registerGatewayMethod(
    "workboard.closeouts.confirm",
    async ({ params: requestParams, client, respond }) => {
      try {
        const record = await params.tracker.confirm(
          requireText(requestParams.agentId, "agentId", MAX_AGENT_ID_LENGTH),
          requireText(requestParams.closeoutId, "closeoutId", MAX_CLOSEOUT_ID_LENGTH),
          requireText(requestParams.evidence, "evidence", MAX_EVIDENCE_LENGTH),
          resolveConfirmer(client),
        );
        respond(true, { closeout: summarizeCloseoutRecord(record) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: ADMIN_SCOPE },
  );
}
