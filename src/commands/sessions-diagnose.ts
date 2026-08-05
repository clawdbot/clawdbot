import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  type SessionsDiagnoseResult,
  validateSessionsDiagnoseResult,
} from "../../packages/gateway-protocol/src/index.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { getRuntimeConfig } from "../config/config.js";
import { callGateway, formatGatewayTransportErrorJson } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type SessionsDiagnoseOptions = {
  sessionKey?: string;
  sessionId?: string;
  label?: string;
  agent?: string;
  tail?: string;
  timeoutMs?: number;
  json?: boolean;
};

const DEFAULT_TAIL = 30;
const MAX_TAIL = 200;
const INVALID_TAIL_MESSAGE = "--tail must be an integer between 1 and 200.";

function countSelectors(opts: SessionsDiagnoseOptions): number {
  return [opts.sessionKey, opts.sessionId, opts.label].filter((value) => value !== undefined)
    .length;
}

function normalizeDiagnoseCliValue(
  value: string | undefined,
  flag: string,
): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true };
  }
  const trimmed = value.trim();
  return trimmed
    ? { ok: true, value: trimmed }
    : { ok: false, message: `${flag} cannot be empty.` };
}

function buildDiagnoseCliParams(
  opts: SessionsDiagnoseOptions,
  tail: number,
):
  | {
      ok: true;
      params: {
        key?: string;
        sessionId?: string;
        label?: string;
        agentId?: string;
        tail: number;
      };
    }
  | { ok: false; message: string } {
  const sessionKey = normalizeDiagnoseCliValue(opts.sessionKey, "--session-key");
  if (!sessionKey.ok) {
    return sessionKey;
  }
  const sessionId = normalizeDiagnoseCliValue(opts.sessionId, "--session-id");
  if (!sessionId.ok) {
    return sessionId;
  }
  const label = normalizeDiagnoseCliValue(opts.label, "--label");
  if (!label.ok) {
    return label;
  }
  const agent = normalizeDiagnoseCliValue(opts.agent, "--agent");
  if (!agent.ok) {
    return agent;
  }
  return {
    ok: true,
    params: {
      ...(sessionKey.value ? { key: sessionKey.value } : {}),
      ...(sessionId.value ? { sessionId: sessionId.value } : {}),
      ...(label.value ? { label: label.value } : {}),
      ...(agent.value ? { agentId: agent.value } : {}),
      tail,
    },
  };
}

function parseTail(value: string | undefined): { ok: true; value: number } | { ok: false } {
  if (value === undefined) {
    return { ok: true, value: DEFAULT_TAIL };
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false };
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TAIL) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function isUnsupportedDiagnoseMethodError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('does not support required method "sessions.diagnose"')
  );
}

function writeCommandError(params: {
  runtime: RuntimeEnv;
  json?: boolean;
  code: string;
  message: string;
  exitCode: number;
}): void {
  if (params.json) {
    writeRuntimeJson(params.runtime, {
      ok: false,
      error: {
        type: params.code,
        message: params.message,
      },
    });
  } else {
    params.runtime.error(params.message);
  }
  params.runtime.exit(params.exitCode);
}

const formatMs = (value: number | undefined): string => {
  if (value === undefined) {
    return "unknown";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  if (value < 60_000) {
    return `${Math.round(value / 1000)}s`;
  }
  return `${Math.round(value / 60_000)}m`;
};

function renderText(result: SessionsDiagnoseResult, runtime: RuntimeEnv): void {
  runtime.log(theme.heading("Session"));
  runtime.log(`Key: ${result.session.key ?? "none"}`);
  runtime.log(`Outcome: ${result.outcome}`);
  runtime.log(`State: ${result.summary.state} (${result.summary.confidence} confidence)`);
  if (result.chosenBecause) {
    runtime.log(`Chosen: ${result.chosenBecause}`);
  }
  if (result.session.sessionId) {
    runtime.log(`Session id: ${result.session.sessionId}`);
  }
  if (result.session.updatedAt !== undefined && result.session.updatedAt !== null) {
    runtime.log(`Updated: ${new Date(result.session.updatedAt).toISOString()}`);
  }

  runtime.log("");
  runtime.log(theme.heading("Live State"));
  const gateway = result.live.gatewayRun;
  runtime.log(`Gateway run: ${gateway?.hasActiveRun ? `${gateway.runs.length} visible` : "none"}`);
  const embedded = result.live.embeddedRun;
  runtime.log(
    `Embedded run: ${embedded?.active ? "active" : "none"}${
      embedded?.streaming ? " streaming" : ""
    }${embedded?.compacting ? " compacting" : ""}${
      embedded?.abandoned ? ` abandoned=${embedded.abandoned.reason}` : ""
    }`,
  );
  const diagnostic = result.live.diagnostic;
  runtime.log(
    `Diagnostic: ${diagnostic?.state ?? "none"} work=${diagnostic?.activeWorkKind ?? "none"} progress=${formatMs(
      diagnostic?.lastProgressAgeMs,
    )}`,
  );
  const lane = result.live.lane;
  runtime.log(
    `Lane: ${lane?.lane ?? "unknown"} active=${lane?.activeCount ?? 0} queued=${
      lane?.queuedCount ?? 0
    }`,
  );

  runtime.log("");
  runtime.log(theme.heading("Findings"));
  for (const finding of result.findings) {
    runtime.log(`- ${finding.severity}: ${finding.code} - ${finding.message}`);
  }

  runtime.log("");
  runtime.log(theme.heading("Evidence"));
  runtime.log(
    `Transcript: ${
      result.transcript ? (result.transcript.resolved ? "resolved" : "unresolved") : "not checked"
    }`,
  );
  if (result.transcript?.recentEventCount !== undefined) {
    runtime.log(`Recent transcript events: ${result.transcript.recentEventCount}`);
  }
  if (result.delivery) {
    runtime.log(`Delivery: ${result.delivery.uncertain ? "uncertain" : "metadata present"}`);
  }
  for (const finding of result.findings) {
    for (const evidence of finding.evidence) {
      runtime.log(`- ${evidence}`);
    }
  }

  runtime.log("");
  runtime.log(theme.heading("Next Checks"));
  for (const check of result.nextChecks) {
    runtime.log(`- ${check}`);
  }
}

export async function sessionsDiagnoseCommand(
  opts: SessionsDiagnoseOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (countSelectors(opts) > 1) {
    writeCommandError({
      runtime,
      json: opts.json,
      code: "ambiguous_session_selector",
      message: "Choose only one of --session-key, --session-id, or --label.",
      exitCode: 1,
    });
    return;
  }
  const tail = parseTail(opts.tail);
  if (!tail.ok) {
    writeCommandError({
      runtime,
      json: opts.json,
      code: "invalid_tail",
      message: INVALID_TAIL_MESSAGE,
      exitCode: 1,
    });
    return;
  }
  const requestParams = buildDiagnoseCliParams(opts, tail.value);
  if (!requestParams.ok) {
    writeCommandError({
      runtime,
      json: opts.json,
      code: "invalid_session_selector",
      message: requestParams.message,
      exitCode: 1,
    });
    return;
  }
  try {
    const result = await callGateway<SessionsDiagnoseResult>({
      method: "sessions.diagnose",
      params: requestParams.params,
      config: getRuntimeConfig(),
      timeoutMs: opts.timeoutMs,
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      requiredMethods: ["sessions.diagnose"],
    });
    if (!validateSessionsDiagnoseResult(result)) {
      writeCommandError({
        runtime,
        json: opts.json,
        code: "invalid_gateway_response",
        message: "Gateway returned an invalid sessions.diagnose response.",
        exitCode: 1,
      });
      return;
    }
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      renderText(result, runtime);
    }
    if (result.outcome !== "diagnosed") {
      runtime.exit(2);
    }
  } catch (error) {
    if (isUnsupportedDiagnoseMethodError(error)) {
      writeCommandError({
        runtime,
        json: opts.json,
        code: "unsupported_gateway_method",
        message:
          "The running Gateway does not support sessions.diagnose. Update or restart Gateway.",
        exitCode: 1,
      });
      return;
    }
    if (opts.json) {
      const payload = formatGatewayTransportErrorJson(error);
      if (payload) {
        writeRuntimeJson(runtime, payload);
        runtime.exit(1);
        return;
      }
    }
    writeCommandError({
      runtime,
      json: opts.json,
      code: "sessions_diagnose_failed",
      message: formatErrorMessage(error),
      exitCode: 1,
    });
  }
}
