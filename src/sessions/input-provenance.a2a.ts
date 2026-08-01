import { normalizeInputProvenance } from "./input-provenance.js";

function isAgentToAgentSendInputProvenance(value: unknown): boolean {
  const provenance = normalizeInputProvenance(value);
  return (
    provenance?.kind === "inter_session" && provenance.sourceTool?.toLowerCase() === "sessions_send"
  );
}

// Returns the exact requester session that a sessions_send target turn must not
// send back to. Other destinations remain available for legitimate handoffs.
export function resolveAgentToAgentSendSourceSessionKey(value: unknown): string | undefined {
  if (!isAgentToAgentSendInputProvenance(value)) {
    return undefined;
  }
  return normalizeInputProvenance(value)?.sourceSessionKey;
}

// Both the target turn and a delivery-failure recovery turn are synthetic
// sessions_send handoffs and must inherit the destination session's external
// reply route instead of treating the internal channel as user-facing.
export function isSessionsSendHandoffInputProvenance(value: unknown): boolean {
  const provenance = normalizeInputProvenance(value);
  if (provenance?.kind !== "inter_session") {
    return false;
  }
  const sourceTool = provenance.sourceTool?.toLowerCase();
  return sourceTool === "sessions_send" || sourceTool === "sessions_send_delivery_failure";
}
