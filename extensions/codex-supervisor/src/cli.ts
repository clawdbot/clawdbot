// Codex Supervisor CLI lists Codex sessions exposed by the Gateway session catalog.
import type { Command } from "commander";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
  CODEX_SESSION_CATALOG_METHOD,
  parseCodexSessionCatalogResult,
} from "./session-catalog.js";
import type {
  CodexSessionCatalogHost,
  CodexSessionCatalogParams,
  CodexSessionCatalogResult,
  CodexSessionCatalogSession,
} from "./types.js";

type CodexSessionsCliOptions = GatewayRpcOpts & {
  json?: boolean;
  search?: string;
  archived?: boolean;
  host?: string;
  limit?: string;
  cursor?: string;
};

function writeLine(value = ""): void {
  process.stdout.write(`${value}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parsePageLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `--limit must be an integer between 1 and ${CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT}`,
    );
  }
  const parsed = Number(trimmed);
  if (
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
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function singleLineTerminalText(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${truncateUtf16Safe(value, maxLength - 1)}\u2026`;
}

function sessionTitle(session: CodexSessionCatalogSession): string {
  const name = typeof session.name === "string" ? singleLineTerminalText(session.name) : "";
  return truncate(name || singleLineTerminalText(session.threadId) || "(untitled)", 72);
}

function sessionStatus(session: CodexSessionCatalogSession): string {
  const status = singleLineTerminalText(session.status) || "unknown";
  const details = [
    ...(session.activeFlags ?? [])
      .filter((entry) => entry !== session.status)
      .map(singleLineTerminalText),
    ...(session.archived ? ["archived"] : []),
  ].filter(Boolean);
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
  if (host.sessions.length === 0) {
    if (!host.error) {
      writeLine("  No sessions.");
    }
  } else {
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
  }
  if (host.nextCursor) {
    writeLine(
      `  More sessions: repeat the same filters with --host ${quoteShellArgument(host.hostId)} --cursor ${quoteShellArgument(host.nextCursor)}`,
    );
  }
}

function hostMatches(host: CodexSessionCatalogHost, selector: string): boolean {
  return host.hostId === selector;
}

function filterHosts(
  result: CodexSessionCatalogResult,
  selector: string | undefined,
): CodexSessionCatalogResult {
  if (!selector) {
    return result;
  }
  return {
    ...result,
    hosts: result.hosts.filter((host) => hostMatches(host, selector)),
  };
}

function gatewayOptions(options: CodexSessionsCliOptions): GatewayRpcOpts {
  return {
    ...(options.url ? { url: options.url } : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    json: options.json === true,
  };
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
    ...(options.archived === true ? { archived: true } : {}),
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

/** Registers the plugin-owned Codex session catalog CLI. */
export function registerCodexSupervisorCli(program: Command): void {
  const codex = program
    .command("codex")
    .description("Inspect Codex sessions across the Gateway and paired nodes");

  addGatewayClientOptions(
    codex
      .command("sessions")
      .description("List Codex app-server sessions across connected hosts")
      .option("--search <text>", "Search session titles (case-sensitive)")
      .option("--archived", "List archived sessions", false)
      .option("--host <id>", "Filter by stable host id")
      .option("--limit <count>", "Maximum sessions returned per host")
      .option("--cursor <cursor>", "Continue one host page (requires --host)")
      .option("--json", "Print the structured catalog response", false),
  ).action(async (options: CodexSessionsCliOptions) => {
    await listCodexSessions(options);
  });
}
