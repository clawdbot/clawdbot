import type {
  SessionsDiagnoseParams,
  SessionsDiagnoseResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { isTerminalSessionStatus, type SessionEntry } from "../../config/sessions.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { isUnscopedSessionKeySentinel } from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";

const DEFAULT_DIAGNOSE_TAIL = 30;
export const DEFAULT_DIAGNOSE_SCAN_LIMIT = 100;
export const FRESH_PROGRESS_MAX_AGE_MS = 60_000;
export const STALE_PROGRESS_MIN_AGE_MS = 120_000;

export type DiagnoseParams = SessionsDiagnoseParams;
export type DiagnoseFinding = SessionsDiagnoseResult["findings"][number];
export type DiagnoseSummary = SessionsDiagnoseResult["summary"];
export type DiagnoseGatewayRun = NonNullable<SessionsDiagnoseResult["live"]["gatewayRun"]>;
export type DiagnoseEmbeddedRun = NonNullable<SessionsDiagnoseResult["live"]["embeddedRun"]>;
export type DiagnoseDiagnostic = NonNullable<SessionsDiagnoseResult["live"]["diagnostic"]>;
export type DiagnoseLane = NonNullable<SessionsDiagnoseResult["live"]["lane"]>;

export type DiagnoseRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  status?: string;
  updatedAt: number | null;
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  lastChannel?: string;
  lastTo?: string;
  lastThreadId?: string | number;
};

export type DiagnoseTarget = {
  key: string;
  chosenBecause: string;
  row: DiagnoseRow;
  entry: SessionEntry;
  storePath: string;
  agentId?: string;
};

export type DiagnoseCandidate = Omit<DiagnoseTarget, "chosenBecause">;

export function countDiagnoseSelectors(p: DiagnoseParams): number {
  return [p.key, p.sessionId, p.label].filter((value) => Boolean(value)).length;
}

export function isDiagnoseSharedRuntimeEvidenceUnambiguous(
  key: string,
  configuredAgentCount: number,
): boolean {
  return !isUnscopedSessionKeySentinel(key) || configuredAgentCount <= 1;
}

export function getDiagnoseLaneSnapshot(key: string): DiagnoseLane {
  const snapshot = getCommandLaneSnapshot(resolveSessionLane(key));
  return {
    lane: snapshot.lane,
    queuedCount: snapshot.queuedCount,
    activeCount: snapshot.activeCount,
    maxConcurrent: snapshot.maxConcurrent,
    draining: snapshot.draining,
    generation: snapshot.generation,
  };
}

export function clampDiagnoseTail(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(200, Math.max(1, Math.trunc(value)))
    : DEFAULT_DIAGNOSE_TAIL;
}

export function selectorFromDiagnoseParams(p: DiagnoseParams): SessionsDiagnoseResult["selector"] {
  return {
    ...(p.key ? { key: p.key } : {}),
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
    ...(p.label ? { label: p.label } : {}),
    ...(p.agentId ? { agentId: p.agentId } : {}),
  };
}

function quoteDiagnoseCliArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function formatDiagnoseNextCheckCommand(params: {
  subcommand: string;
  target: Pick<DiagnoseTarget, "agentId" | "key">;
}): string {
  const { agentId, key } = params.target;
  const agentScope =
    agentId && (key === "global" || key === "unknown")
      ? ` --agent ${quoteDiagnoseCliArg(agentId)}`
      : "";
  return `openclaw sessions${agentScope} ${params.subcommand} --session-key ${quoteDiagnoseCliArg(key)}`;
}

function classifyDiagnoseSessionKind(key: string): DiagnoseRow["kind"] {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (key.includes(":group:")) {
    return "group";
  }
  return "direct";
}

export function buildDiagnoseRow(key: string, entry: SessionEntry): DiagnoseRow {
  const delivery = deliveryContextFromSession(entry);
  return {
    key,
    kind: classifyDiagnoseSessionKind(key),
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
    ...(entry.runtimeMs ? { runtimeMs: entry.runtimeMs } : {}),
    ...(delivery?.channel ? { lastChannel: delivery.channel } : {}),
    ...(delivery?.to ? { lastTo: delivery.to } : {}),
    ...(delivery?.threadId ? { lastThreadId: delivery.threadId } : {}),
  };
}

export function isDiagnoseRowTerminal(row: DiagnoseRow): boolean {
  return Boolean(row.endedAt || isTerminalSessionStatus(row.status));
}

export function buildNotFoundDiagnosis(
  p: DiagnoseParams,
  outcome: "not_found" | "no_sessions",
  headline: string,
): SessionsDiagnoseResult {
  return {
    ok: true,
    ts: Date.now(),
    outcome,
    selector: selectorFromDiagnoseParams(p),
    summary: {
      state: outcome === "not_found" ? "not_found" : "unknown",
      confidence: "high",
      headline,
    },
    session: { found: false },
    live: {},
    findings:
      outcome === "not_found"
        ? [
            {
              code: "session_not_found",
              severity: "error",
              message: "No stored session matched the requested selector.",
              evidence: ["session store lookup returned no matching row"],
            },
          ]
        : [],
    nextChecks: ["openclaw sessions", "openclaw health --verbose"],
  };
}
