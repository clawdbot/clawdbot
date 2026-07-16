// Msteams plugin module implements request deadline behavior.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  createProviderOperationDeadline,
  resolveProviderOperationTimeoutMs,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";

export const MSTEAMS_REQUEST_TIMEOUT_MS = 30_000;
// File-consent PUTs are data-plane transfers: keep a base stall bound, then
// add slow-transfer budget so valid large uploads do not hit a fixed cutoff.
const MSTEAMS_SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS = 5 * 60_000;
const MSTEAMS_SHAREPOINT_UPLOAD_MIN_BYTES_PER_SECOND = 256 * 1024;

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

export function resolveMSTeamsSharePointUploadTimeoutMs(sizeInBytes: number): number {
  const bytes = Number.isFinite(sizeInBytes) && sizeInBytes > 0 ? Math.ceil(sizeInBytes) : 0;
  const transferBudgetMs = Math.ceil(
    (bytes / MSTEAMS_SHAREPOINT_UPLOAD_MIN_BYTES_PER_SECOND) * 1000,
  );
  return resolveTimerTimeoutMs(
    MSTEAMS_SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS + transferBudgetMs,
    MSTEAMS_SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS,
    1,
  );
}
