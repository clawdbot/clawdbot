import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../types.js";
import { asString, isRecord } from "./shared.js";

type BlueBubblesAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  running?: unknown;
  baseUrl?: unknown;
  lastError?: unknown;
  probe?: unknown;
};

type BlueBubblesProbeResult = {
  ok?: boolean;
  status?: number | null;
  error?: string | null;
};

function readBlueBubblesAccountStatus(
  value: ChannelAccountSnapshot,
): BlueBubblesAccountStatus | null {
  if (!isRecord(value)) return null;
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    running: value.running,
    baseUrl: value.baseUrl,
    lastError: value.lastError,
    probe: value.probe,
  };
}

function readBlueBubblesProbeResult(value: unknown): BlueBubblesProbeResult | null {
  if (!isRecord(value)) return null;
  return {
    ok: typeof value.ok === "boolean" ? value.ok : undefined,
    status: typeof value.status === "number" ? value.status : null,
    error: asString(value.error) ?? null,
  };
}

export function collectBlueBubblesStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readBlueBubblesAccountStatus(entry);
    if (!account) continue;
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) continue;

    const configured = account.configured === true;
    const running = account.running === true;
    const lastError = asString(account.lastError);
    const probe = readBlueBubblesProbeResult(account.probe);

    // Check for unconfigured accounts
    if (!configured) {
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "config",
        message: "Not configured (missing serverUrl or password).",
        fix: "Run: moltbot channels add bluebubbles --http-url <server-url> --password <password>",
      });
      continue;
    }

    // Check for probe failures
    if (probe && probe.ok === false) {
      const errorDetail = probe.error
        ? `: ${probe.error}`
        : probe.status
          ? ` (HTTP ${probe.status})`
          : "";
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "runtime",
        message: `BlueBubbles server unreachable${errorDetail}`,
        fix: "Check that the BlueBubbles server is running and accessible. Verify serverUrl and password in your config.",
      });
    }

    // Check for runtime errors
    if (running && lastError) {
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "runtime",
        message: `Channel error: ${lastError}`,
        fix: "Check gateway logs for details. If the webhook is failing, verify the webhook URL is configured in BlueBubbles server settings.",
      });
    }
  }
  return issues;
}
