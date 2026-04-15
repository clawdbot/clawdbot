import type { Server } from "node:http";

const MSTEAMS_WEBHOOK_INACTIVITY_TIMEOUT_MS = 30_000;
const MSTEAMS_WEBHOOK_REQUEST_TIMEOUT_MS = 30_000;
const MSTEAMS_WEBHOOK_HEADERS_TIMEOUT_MS = 15_000;

export type ApplyMSTeamsWebhookTimeoutsOpts = {
  inactivityTimeoutMs?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
};

export function applyMSTeamsWebhookTimeouts(
  httpServer: Server,
  opts?: ApplyMSTeamsWebhookTimeoutsOpts,
): void {
  const inactivityTimeoutMs = opts?.inactivityTimeoutMs ?? MSTEAMS_WEBHOOK_INACTIVITY_TIMEOUT_MS;
  const requestTimeoutMs = opts?.requestTimeoutMs ?? MSTEAMS_WEBHOOK_REQUEST_TIMEOUT_MS;
  const headersTimeoutMs = Math.min(
    opts?.headersTimeoutMs ?? MSTEAMS_WEBHOOK_HEADERS_TIMEOUT_MS,
    requestTimeoutMs,
  );

  httpServer.setTimeout(inactivityTimeoutMs);
  httpServer.requestTimeout = requestTimeoutMs;
  httpServer.headersTimeout = headersTimeoutMs;
}
