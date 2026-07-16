import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export type QaCronRunLogEntry = {
  ts?: number;
  status?: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
  deliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
};

type QaCronRunsPage = {
  entries?: QaCronRunLogEntry[];
};

export async function waitForCronRunCompletion(params: {
  callGateway: (
    method: string,
    rpcParams?: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<unknown>;
  jobId: string;
  afterTs: number;
  timeoutMs?: number;
  intervalMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 90_000;
  const intervalMs = params.intervalMs ?? 1_000;
  const startedAt = Date.now();
  let lastEntries: QaCronRunLogEntry[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    const page = (await params.callGateway(
      "cron.runs",
      {
        id: params.jobId,
        limit: 20,
        sortDir: "desc",
      },
      { timeoutMs: Math.min(timeoutMs, 30_000) },
    )) as QaCronRunsPage;
    const entries = Array.isArray(page.entries) ? page.entries : [];
    lastEntries = entries;
    const completed = entries.find(
      (entry) =>
        typeof entry.ts === "number" &&
        entry.ts >= params.afterTs &&
        (entry.status === "ok" || entry.status === "error" || entry.status === "skipped"),
    );
    if (completed) {
      return completed;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out waiting for cron run completion for ${params.jobId}: ${formatErrorMessage(lastEntries)}`,
  );
}
