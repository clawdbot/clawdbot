// Msteams plugin module implements request deadline behavior.
import {
  createProviderOperationDeadline,
  resolveProviderOperationTimeoutMs,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";

export const MSTEAMS_REQUEST_TIMEOUT_MS = 30_000;

// Cap optional enrichment before agent dispatch. The Teams SDK still holds the
// webhook open for the agent turn, so this budget alone cannot prevent retries.
const MSTEAMS_INBOUND_PREPROCESS_TIMEOUT_MS = 10_000;

export type MSTeamsRequestDeadline = ProviderOperationDeadline;

export function createMSTeamsInboundDeadline(): MSTeamsRequestDeadline {
  return createProviderOperationDeadline({
    label: "MS Teams inbound preprocessing",
    timeoutMs: MSTEAMS_INBOUND_PREPROCESS_TIMEOUT_MS,
  });
}

export function resolveMSTeamsRequestTimeoutMs(deadline?: MSTeamsRequestDeadline): number {
  return deadline
    ? resolveProviderOperationTimeoutMs({
        deadline,
        defaultTimeoutMs: MSTEAMS_REQUEST_TIMEOUT_MS,
      })
    : MSTEAMS_REQUEST_TIMEOUT_MS;
}

/** Bound non-abortable SDK and credential work to the same operation deadline as fetches. */
export async function withMSTeamsRequestDeadline<T>(params: {
  deadline?: MSTeamsRequestDeadline;
  label: string;
  work: () => Promise<T>;
}): Promise<T> {
  const timeoutMs = resolveMSTeamsRequestTimeoutMs(params.deadline);
  return await withTimeout(params.work(), timeoutMs, params.label);
}
