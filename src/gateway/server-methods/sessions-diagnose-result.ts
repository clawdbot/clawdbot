import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsDiagnoseResult } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { getEmbeddedRunDiagnosticSnapshot } from "../../agents/embedded-agent-runner/run-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { getDiagnosticSessionStateSnapshot } from "../../logging/diagnostic-session-state.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { readRecentSessionMessagesWithStatsAsync } from "../session-transcript-readers.js";
import { collectTrackedActiveSessionRunSnapshot } from "./session-active-runs.js";
import {
  clampDiagnoseTail,
  formatDiagnoseNextCheckCommand,
  FRESH_PROGRESS_MAX_AGE_MS,
  isDiagnoseRowTerminal,
  selectorFromDiagnoseParams,
  STALE_PROGRESS_MIN_AGE_MS,
  type DiagnoseDiagnostic,
  type DiagnoseEmbeddedRun,
  type DiagnoseFinding,
  type DiagnoseGatewayRun,
  type DiagnoseLane,
  type DiagnoseParams,
  type DiagnoseRow,
  type DiagnoseSummary,
  type DiagnoseTarget,
} from "./sessions-diagnose-shared.js";
import type { GatewayRequestContext } from "./types.js";

type DiagnoseTranscriptEvidence = {
  resolved: boolean;
  source: "sessionFile" | "store";
  recentEventCount: number;
};

function addFinding(findings: DiagnoseFinding[], finding: DiagnoseFinding): void {
  if (!findings.some((entry) => entry.code === finding.code)) {
    findings.push(finding);
  }
}

function buildDiagnoseFindings(params: {
  row: DiagnoseRow;
  gatewayRun: DiagnoseGatewayRun;
  embeddedRun: DiagnoseEmbeddedRun;
  diagnostic: DiagnoseDiagnostic;
  lane: DiagnoseLane;
  transcriptResolved: boolean;
  deliveryUncertain: boolean;
}): DiagnoseFinding[] {
  const findings: DiagnoseFinding[] = [];
  const activeVisible = params.gatewayRun.hasActiveRun || params.embeddedRun.active;
  const activeWork = activeVisible || Boolean(params.diagnostic.activeWorkKind);
  const terminalStore = isDiagnoseRowTerminal(params.row);

  if (activeVisible) {
    addFinding(findings, {
      code: "active_run_visible",
      severity: "info",
      message: "A live Gateway or embedded run is visible for this session.",
      evidence: ["gateway or embedded run projection is active"],
    });
  }
  if (
    activeWork &&
    params.diagnostic.lastProgressAgeMs !== undefined &&
    params.diagnostic.lastProgressAgeMs <= FRESH_PROGRESS_MAX_AGE_MS
  ) {
    addFinding(findings, {
      code: "active_progress_fresh",
      severity: "info",
      message:
        "Recent diagnostic progress is fresh, so the session should not be treated as stale.",
      evidence: [`lastProgressAgeMs=${params.diagnostic.lastProgressAgeMs}`],
    });
  }
  if (
    activeWork &&
    params.diagnostic.lastProgressAgeMs !== undefined &&
    params.diagnostic.lastProgressAgeMs >= STALE_PROGRESS_MIN_AGE_MS
  ) {
    addFinding(findings, {
      code: "last_progress_stale",
      severity: "warn",
      message: "Active work exists, but diagnostic progress has not advanced recently.",
      evidence: [`lastProgressAgeMs=${params.diagnostic.lastProgressAgeMs}`],
    });
  }
  if (!activeVisible && ((params.diagnostic.queueDepth ?? 0) > 0 || params.lane.queuedCount > 0)) {
    addFinding(findings, {
      code: "queued_without_active_run",
      severity: "warn",
      message: "Queued work exists, but no visible active run owns the session.",
      evidence: [
        `queueDepth=${params.diagnostic.queueDepth ?? 0}`,
        `laneQueued=${params.lane.queuedCount}`,
      ],
    });
  }
  if (
    !activeVisible &&
    params.lane.activeCount === 0 &&
    (params.diagnostic.activeWorkKind === "tool_call" ||
      params.diagnostic.activeWorkKind === "model_call")
  ) {
    addFinding(findings, {
      code: "stale_diagnostic_tool",
      severity: "warn",
      message:
        "Diagnostic activity reports active tool or model work, but live run and lane state disagree.",
      evidence: [`activeWorkKind=${params.diagnostic.activeWorkKind}`],
    });
  }
  if (!activeVisible && params.embeddedRun.abandoned?.reason === "timeout") {
    addFinding(findings, {
      code: "embedded_run_abandoned_timeout",
      severity: "warn",
      message: "The embedded run was abandoned after timing out.",
      evidence: [
        `embeddedSessionId=${params.embeddedRun.abandoned.sessionId}`,
        `abandonedAtMs=${params.embeddedRun.abandoned.abandonedAtMs}`,
        `reason=${params.embeddedRun.abandoned.reason}`,
      ],
    });
  }
  if (terminalStore && (activeVisible || params.diagnostic.state === "processing")) {
    addFinding(findings, {
      code: "store_terminal_but_live_processing",
      severity: "warn",
      message: "The stored session looks terminal, but live state still reports processing.",
      evidence: [
        `status=${params.row.status ?? "unset"}`,
        `diagnosticState=${params.diagnostic.state ?? "unset"}`,
      ],
    });
  }
  if (!activeVisible && (params.lane.activeCount > 0 || params.lane.queuedCount > 0)) {
    addFinding(findings, {
      code: "lane_blocked",
      severity: "warn",
      message: "The session lane has active or queued work without a visible active run.",
      evidence: [`laneActive=${params.lane.activeCount}`, `laneQueued=${params.lane.queuedCount}`],
    });
  }
  if (!params.transcriptResolved) {
    addFinding(findings, {
      code: "transcript_unresolved",
      severity: "warn",
      message: "The session row does not resolve to a readable transcript tail.",
      evidence: ["transcript metadata could not be read"],
    });
  }
  if (params.deliveryUncertain) {
    addFinding(findings, {
      code: "delivery_uncertain",
      severity: "info",
      message: "The stored run is terminal, but route delivery metadata is incomplete.",
      evidence: ["terminal store row lacks lastChannel or lastTo"],
    });
  }
  if (findings.length === 0) {
    addFinding(findings, {
      code: "unknown_low_confidence",
      severity: "info",
      message: "No dominant stuck-session signal was found from the available evidence.",
      evidence: [
        "store, live run, diagnostic, and lane evidence did not produce a stronger finding",
      ],
    });
  }
  return findings;
}

function summarizeDiagnose(params: {
  findings: DiagnoseFinding[];
  row: DiagnoseRow;
}): DiagnoseSummary {
  const hasError = params.findings.some((finding) => finding.severity === "error");
  const hasWarn = params.findings.some((finding) => finding.severity === "warn");
  const hasQueued = params.findings.some((finding) => finding.code === "queued_without_active_run");
  const hasStall = params.findings.some((finding) => isDiagnoseStallFindingCode(finding.code));
  const hasLowConfidence = params.findings.some(
    (finding) => finding.code === "unknown_low_confidence",
  );
  const hasActive = params.findings.some(
    (finding) => finding.code === "active_run_visible" || finding.code === "active_progress_fresh",
  );
  const state = hasError
    ? "unknown"
    : hasQueued
      ? "queued"
      : hasStall
        ? "stalled"
        : hasActive
          ? "active"
          : isDiagnoseRowTerminal(params.row)
            ? "done"
            : "unknown";
  const headlineFinding = selectDiagnoseSummaryHeadlineFinding({
    findings: params.findings,
    state,
  });
  return {
    state,
    confidence: hasLowConfidence ? "low" : hasWarn || hasError ? "medium" : "high",
    headline:
      headlineFinding?.message ??
      "No dominant stuck-session signal was found from the available evidence.",
  };
}

function selectDiagnoseSummaryHeadlineFinding(params: {
  findings: DiagnoseFinding[];
  state: DiagnoseSummary["state"];
}): DiagnoseFinding | undefined {
  if (params.state === "queued") {
    return (
      params.findings.find((finding) => finding.code === "queued_without_active_run") ??
      params.findings.find((finding) => finding.severity === "warn")
    );
  }
  if (params.state === "stalled") {
    return params.findings.find((finding) => isDiagnoseStallFindingCode(finding.code));
  }
  if (params.state === "active") {
    return params.findings.find(
      (finding) =>
        finding.code === "active_progress_fresh" || finding.code === "active_run_visible",
    );
  }
  if (params.state === "unknown") {
    return (
      params.findings.find((finding) => finding.severity === "error") ??
      params.findings.find((finding) => finding.code === "unknown_low_confidence")
    );
  }
  return params.findings[0];
}

function isDiagnoseStallFindingCode(code: DiagnoseFinding["code"]): boolean {
  return (
    code === "last_progress_stale" ||
    code === "stale_diagnostic_tool" ||
    code === "embedded_run_abandoned_timeout" ||
    code === "store_terminal_but_live_processing" ||
    code === "lane_blocked"
  );
}

async function readDiagnoseTranscriptEvidence(params: {
  target: DiagnoseTarget;
  maxLines: number;
}): Promise<DiagnoseTranscriptEvidence | null> {
  if (!params.target.entry.sessionId) {
    return null;
  }
  try {
    const result = await readRecentSessionMessagesWithStatsAsync(
      {
        sessionId: params.target.entry.sessionId,
        sessionKey: params.target.key,
        storePath: params.target.storePath,
        sessionEntry: params.target.entry,
        ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
      },
      {
        maxMessages: params.maxLines,
        maxLines: params.maxLines * 20 + 20,
        maxBytes: 64 * 1024,
        allowResetArchiveFallback: true,
      },
    );
    return {
      resolved:
        Boolean(result.transcriptPath) || result.totalMessages > 0 || result.messages.length > 0,
      source: params.target.entry.sessionFile ? "sessionFile" : "store",
      recentEventCount: result.messages.length,
    };
  } catch {
    return null;
  }
}

export async function buildDiagnoseResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  p: DiagnoseParams;
  target: DiagnoseTarget;
}): Promise<SessionsDiagnoseResult> {
  const { cfg, context, p, target } = params;
  const now = Date.now();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const gatewayRun = collectTrackedActiveSessionRunSnapshot({
    context,
    requestedKey: p.key ?? target.key,
    canonicalKey: target.key,
    sessionId: target.entry.sessionId,
    ...(target.agentId ? { agentId: target.agentId } : {}),
    defaultAgentId,
    scopeUnknownByAgent: true,
    now,
  });
  const embeddedRun = getEmbeddedRunDiagnosticSnapshot({
    sessionId: target.entry.sessionId,
    sessionKey: target.key,
    sessionFile: target.entry.sessionFile,
    ...(target.agentId ? { agentId: target.agentId } : {}),
  });
  const stateSnapshot = getDiagnosticSessionStateSnapshot(
    {
      sessionId: target.entry.sessionId,
      sessionKey: target.key,
      sessionFile: target.entry.sessionFile,
    },
    now,
  );
  const activity = getDiagnosticSessionActivitySnapshot(
    {
      sessionId: target.entry.sessionId,
      sessionKey: target.key,
    },
    now,
  );
  const diagnostic = {
    present: stateSnapshot.present,
    ...(stateSnapshot.state ? { state: stateSnapshot.state } : {}),
    ...(stateSnapshot.queueDepth !== undefined ? { queueDepth: stateSnapshot.queueDepth } : {}),
    ...(stateSnapshot.activeQueuedTurn !== undefined
      ? { activeQueuedTurn: stateSnapshot.activeQueuedTurn }
      : {}),
    ...(stateSnapshot.generation !== undefined ? { generation: stateSnapshot.generation } : {}),
    ...(activity.activeWorkKind ? { activeWorkKind: activity.activeWorkKind } : {}),
    ...(activity.activeToolName ? { activeToolName: activity.activeToolName } : {}),
    ...(activity.activeToolAgeMs !== undefined
      ? { activeToolAgeMs: activity.activeToolAgeMs }
      : {}),
    ...(stateSnapshot.lastActivityAgeMs !== undefined
      ? { lastActivityAgeMs: stateSnapshot.lastActivityAgeMs }
      : {}),
    ...(activity.lastProgressAgeMs !== undefined
      ? { lastProgressAgeMs: activity.lastProgressAgeMs }
      : {}),
    ...(activity.lastProgressReason ? { lastProgressReason: activity.lastProgressReason } : {}),
    ...(stateSnapshot.recentToolCalls !== undefined
      ? { recentToolCalls: stateSnapshot.recentToolCalls }
      : {}),
    ...(stateSnapshot.repeatedToolPattern
      ? { repeatedToolPattern: stateSnapshot.repeatedToolPattern }
      : {}),
  };
  const lane = getCommandLaneSnapshot(resolveSessionLane(target.key));
  const transcript = await readDiagnoseTranscriptEvidence({
    target,
    maxLines: clampDiagnoseTail(p.tail),
  });
  const transcriptResolved = transcript?.resolved === true;
  const lastChannel = normalizeOptionalString(target.row.lastChannel);
  const lastTo = normalizeOptionalString(target.row.lastTo);
  const lastThreadId = normalizeOptionalString(target.row.lastThreadId);
  const deliveryUncertain = isDiagnoseRowTerminal(target.row) && (!lastChannel || !lastTo);
  const findings = buildDiagnoseFindings({
    row: target.row,
    gatewayRun,
    embeddedRun,
    diagnostic,
    lane,
    transcriptResolved,
    deliveryUncertain,
  });
  return {
    ok: true,
    ts: now,
    outcome: "diagnosed",
    selector: selectorFromDiagnoseParams(p),
    chosenBecause: target.chosenBecause,
    summary: summarizeDiagnose({ findings, row: target.row }),
    session: {
      found: true,
      key: target.key,
      ...(target.agentId ? { agentId: target.agentId } : {}),
      ...(target.entry.sessionId ? { sessionId: target.entry.sessionId } : {}),
      kind: target.row.kind,
      ...(target.row.label ? { label: target.row.label } : {}),
      ...(target.row.status ? { status: target.row.status } : {}),
      updatedAt: target.row.updatedAt,
      ...(target.row.startedAt ? { startedAt: target.row.startedAt } : {}),
      ...(target.row.endedAt ? { endedAt: target.row.endedAt } : {}),
      ...(target.row.runtimeMs ? { runtimeMs: target.row.runtimeMs } : {}),
      hasActiveRun: gatewayRun.hasActiveRun || embeddedRun.active,
    },
    live: {
      gatewayRun,
      embeddedRun,
      diagnostic,
      lane,
    },
    transcript: {
      resolved: transcriptResolved,
      ...(transcript
        ? { source: transcript.source, recentEventCount: transcript.recentEventCount }
        : {}),
    },
    ...(deliveryUncertain || lastChannel || lastTo || lastThreadId
      ? {
          delivery: {
            uncertain: deliveryUncertain,
            ...(lastChannel ? { lastChannel } : {}),
            ...(lastTo ? { lastTo } : {}),
            ...(lastThreadId ? { lastThreadId } : {}),
          },
        }
      : {}),
    findings,
    nextChecks: [
      formatDiagnoseNextCheckCommand({ subcommand: "tail", target }),
      formatDiagnoseNextCheckCommand({ subcommand: "export-trajectory", target }),
      "openclaw health --verbose",
    ],
  };
}
