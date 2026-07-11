// Codex CLI lists native sessions and adopts or archives idle local threads.
import type { Command } from "commander";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type {
  CodexSessionCatalogHost,
  CodexSessionCatalogParams,
  CodexSessionCatalogResult,
  CodexSessionCatalogSession,
} from "./session-catalog-types.js";
import {
  CODEX_LOCAL_SESSION_HOST_ID,
  CODEX_SESSION_ARCHIVE_METHOD,
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
  CODEX_SESSION_CATALOG_METHOD,
  CODEX_SESSION_CONTINUE_METHOD,
  parseCodexSessionCatalogResult,
} from "./session-catalog.js";

type CodexGatewayOptions = GatewayRpcOpts & {
  json?: boolean;
};

type CodexSessionsCliOptions = CodexGatewayOptions & {
  search?: string;
  host?: string;
  limit?: string;
  cursor?: string;
};

type CodexArchiveCliOptions = CodexGatewayOptions & {
  confirmNoOtherRunner?: boolean;
};

function writeLine(value = ""): void {
  process.stdout.write(`${value}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function gatewayOptions(options: CodexGatewayOptions): GatewayRpcOpts {
  return {
    ...(options.url ? { url: options.url } : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    json: options.json === true,
  };
}

function parsePageLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (
    !/^\d+$/.test(trimmed) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT
  ) {
    throw new Error(
      `--limit must be an integer between 1 and ${CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT}`,
    );
  }
  return parsed;
}

function normalizeTimestampMs(value: number): number {
  return Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
}

function formatTimestamp(session: CodexSessionCatalogSession): string {
  const value = session.recencyAt ?? session.updatedAt ?? session.createdAt;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  const date = new Date(normalizeTimestampMs(value));
  return Number.isNaN(date.getTime())
    ? "-"
    : `${date.toISOString().replace("T", " ").slice(0, 16)}Z`;
}

function singleLineTerminalText(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${truncateUtf16Safe(value, maxLength - 1)}\u2026`;
}

function sessionTitle(session: CodexSessionCatalogSession): string {
  const name = typeof session.name === "string" ? singleLineTerminalText(session.name) : "";
  return truncate(name || singleLineTerminalText(session.threadId) || "(untitled)", 72);
}

function sessionStatus(session: CodexSessionCatalogSession): string {
  const status =
    session.status === "notLoaded"
      ? "stored / activity unknown"
      : singleLineTerminalText(session.status) || "unknown";
  const details = (session.activeFlags ?? [])
    .filter((entry) => entry !== session.status)
    .map(singleLineTerminalText)
    .filter(Boolean);
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
}

function quoteShellArgument(value: string): string {
  return `'${singleLineTerminalText(value).replaceAll("'", `'"'"'`)}'`;
}

function formatHostIdentity(host: CodexSessionCatalogHost): string {
  const identifiers = [host.kind, singleLineTerminalText(host.hostId)];
  if (host.nodeId && host.nodeId !== host.hostId) {
    identifiers.push(singleLineTerminalText(host.nodeId));
  }
  return identifiers.join(" · ");
}

function writeHost(host: CodexSessionCatalogHost): void {
  const connection = host.connected ? "connected" : "offline";
  const count = `${host.sessions.length} session${host.sessions.length === 1 ? "" : "s"}`;
  writeLine(
    `${singleLineTerminalText(host.label)} (${formatHostIdentity(host)}) — ${connection} — ${count}`,
  );
  if (host.error) {
    writeLine(
      `  Error [${singleLineTerminalText(host.error.code)}]: ${singleLineTerminalText(host.error.message)}`,
    );
  }
  if (host.sessions.length === 0 && !host.error) {
    writeLine("  No sessions.");
  }
  for (const session of host.sessions) {
    writeLine(
      `  ${formatTimestamp(session)}  ${sessionStatus(session)}  ${singleLineTerminalText(session.threadId)}  ${sessionTitle(session)}`,
    );
    const details = [
      session.cwd ? singleLineTerminalText(session.cwd) : undefined,
      session.gitBranch ? `branch ${singleLineTerminalText(session.gitBranch)}` : undefined,
      session.source ? `source ${singleLineTerminalText(session.source)}` : undefined,
      session.modelProvider
        ? `provider ${singleLineTerminalText(session.modelProvider)}`
        : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    if (details.length > 0) {
      writeLine(`    ${details.join(" · ")}`);
    }
  }
  if (host.nextCursor) {
    writeLine(
      `  More sessions: repeat the same filters with --host ${quoteShellArgument(host.hostId)} --cursor ${quoteShellArgument(host.nextCursor)}`,
    );
  }
}

function filterHosts(
  result: CodexSessionCatalogResult,
  selector: string | undefined,
): CodexSessionCatalogResult {
  return selector
    ? { ...result, hosts: result.hosts.filter((host) => host.hostId === selector) }
    : result;
}

async function listCodexSessions(options: CodexSessionsCliOptions): Promise<void> {
  const host = options.host?.trim() || undefined;
  const cursor = options.cursor?.trim() || undefined;
  if (cursor && !host) {
    throw new Error("--cursor requires --host so the cursor is routed to one Codex host");
  }
  const search = options.search?.trim() || undefined;
  const limitPerHost = parsePageLimit(options.limit);
  const params: CodexSessionCatalogParams = {
    ...(search ? { search } : {}),
    ...(limitPerHost !== undefined ? { limitPerHost } : {}),
    ...(host ? { hostIds: [host] } : {}),
    ...(cursor && host ? { cursors: { [host]: cursor } } : {}),
  };
  const raw = await callGatewayFromCli(
    CODEX_SESSION_CATALOG_METHOD,
    gatewayOptions(options),
    params,
    {
      mode: "cli",
      // Federation invokes paired nodes, so this inherits node.invoke's write scope.
      scopes: ["operator.write"],
    },
  );
  const result = filterHosts(parseCodexSessionCatalogResult(raw), host);
  if (options.json) {
    writeJson(result);
    return;
  }
  if (result.hosts.length === 0) {
    writeLine(
      host
        ? `No Codex session host matched "${singleLineTerminalText(host)}".`
        : "No Codex session hosts found.",
    );
    return;
  }
  result.hosts.forEach((catalogHost, index) => {
    if (index > 0) {
      writeLine();
    }
    writeHost(catalogHost);
  });
}

function readThreadId(value: string): string {
  const threadId = value.trim();
  if (!threadId) {
    throw new Error("Codex thread id must not be empty");
  }
  return threadId;
}

async function continueCodexSession(
  threadIdValue: string,
  options: CodexGatewayOptions,
): Promise<void> {
  const threadId = readThreadId(threadIdValue);
  const raw = await callGatewayFromCli(
    CODEX_SESSION_CONTINUE_METHOD,
    gatewayOptions(options),
    { hostId: CODEX_LOCAL_SESSION_HOST_ID, threadId },
    { mode: "cli", scopes: ["operator.write"] },
  );
  if (!isRecord(raw) || typeof raw.sessionKey !== "string" || !raw.sessionKey.trim()) {
    throw new Error("Codex session continue returned an invalid session key");
  }
  if (raw.disposition !== "existing" && raw.disposition !== "forked") {
    throw new Error("Codex session continue returned an invalid disposition");
  }
  const result = { sessionKey: raw.sessionKey, disposition: raw.disposition };
  if (options.json) {
    writeJson(result);
    return;
  }
  const dispositionLabel = result.disposition === "forked" ? "branch created" : "existing";
  writeLine(`OpenClaw session (${dispositionLabel}): ${singleLineTerminalText(result.sessionKey)}`);
}

async function archiveCodexSession(
  threadIdValue: string,
  options: CodexArchiveCliOptions,
): Promise<void> {
  const threadId = readThreadId(threadIdValue);
  if (options.confirmNoOtherRunner !== true) {
    throw new Error(
      "--confirm-no-other-runner is required because Codex client and runner activity is process-local",
    );
  }
  const raw = await callGatewayFromCli(
    CODEX_SESSION_ARCHIVE_METHOD,
    gatewayOptions(options),
    { hostId: CODEX_LOCAL_SESSION_HOST_ID, threadId, confirmNoOtherRunner: true },
    { mode: "cli", scopes: ["operator.write"] },
  );
  if (!isRecord(raw) || raw.archived !== true) {
    throw new Error("Codex session archive returned an invalid result");
  }
  const result = { archived: true as const };
  if (options.json) {
    writeJson(result);
    return;
  }
  writeLine(`Archived Codex thread ${singleLineTerminalText(threadId)}.`);
}

/** Registers the plugin-owned Codex session supervision CLI. */
export function registerCodexSessionCli(program: Command): void {
  const codex = program
    .command("codex")
    .description("Inspect and branch from Codex sessions through the Gateway");

  addGatewayClientOptions(
    codex
      .command("sessions")
      .description("List non-archived Codex app-server sessions across connected hosts")
      .option("--search <text>", "Search session titles (case-insensitive)")
      .option("--host <id>", "Filter by stable host id")
      .option("--limit <count>", "Maximum sessions returned per host")
      .option("--cursor <cursor>", "Continue one host page (requires --host)")
      .option("--json", "Print the structured catalog response", false),
  ).action(async (options: CodexSessionsCliOptions) => {
    await listCodexSessions(options);
  });

  addGatewayClientOptions(
    codex
      .command("continue <thread-id>")
      .description("Continue a Gateway-local Codex thread as an OpenClaw branch")
      .option("--json", "Print the structured response", false),
  ).action(async (threadId: string, options: CodexGatewayOptions) => {
    await continueCodexSession(threadId, options);
  });

  addGatewayClientOptions(
    codex
      .command("archive <thread-id>")
      .description("Archive a stored or idle Gateway-local Codex thread")
      .option(
        "--confirm-no-other-runner",
        "Confirm no other Codex client or OpenClaw runner is using this thread",
        false,
      )
      .option("--json", "Print the structured response", false),
  ).action(async (threadId: string, options: CodexArchiveCliOptions) => {
    await archiveCodexSession(threadId, options);
  });
}
