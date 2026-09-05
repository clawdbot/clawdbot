// Diagnostic session context helpers capture session metadata for support bundles.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  loadSessionEntryReadOnly,
  readLatestTranscriptAssistantText,
} from "../config/sessions/session-accessor.js";
import { loadCronJobsStoreSync, resolveCronJobsStorePath } from "../cron/store.js";
import {
  isIncognitoSessionKey,
  isValidAgentId,
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";

const MAX_QUOTED_FIELD_CHARS = 140;

type SessionDiagnosticContext = {
  agentId?: string;
  cronJobId?: string;
  cronRunId?: string;
  cronJobName?: string;
  lastAssistant?: string;
};

function quoteLogField(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  const truncated =
    oneLine.length > MAX_QUOTED_FIELD_CHARS
      ? `${truncateUtf16Safe(oneLine, Math.max(0, MAX_QUOTED_FIELD_CHARS - 3))}...`
      : oneLine;
  return `"${truncated.replace(/["\\]/g, "\\$&")}"`;
}

function parseCronRunSessionKey(parsed: ParsedAgentSessionKey): {
  cronJobId?: string;
  cronRunId?: string;
} {
  const parts = parsed.rest.split(":");
  if (parts[0] !== "cron" || !parts[1]) {
    return {};
  }
  const runIndex = parts.indexOf("run", 2);
  return {
    cronJobId: parts[1],
    cronRunId: runIndex >= 0 ? parts[runIndex + 1] : undefined,
  };
}

function readCronJobName(cronJobId: string | undefined): string | undefined {
  if (!cronJobId) {
    return undefined;
  }
  try {
    const store = loadCronJobsStoreSync(resolveCronJobsStorePath());
    const job = store.jobs.find((entry) => entry.id === cronJobId);
    return typeof job?.name === "string" && job.name.trim() ? job.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCronSessionDiagnosticContext(params: {
  sessionKey?: string;
  activeSessionId?: string;
}): SessionDiagnosticContext {
  const sessionKey = params.sessionKey?.trim();
  // Incognito transcripts live only in memory; copying their replies into
  // durable operator logs would bypass both persistence and sharing boundaries.
  if (isIncognitoSessionKey(sessionKey)) {
    return {};
  }
  const parsedAgent = parseAgentSessionKey(sessionKey);
  if (!sessionKey || !parsedAgent || !isValidAgentId(parsedAgent.agentId)) {
    return {};
  }
  const cron = parseCronRunSessionKey(parsedAgent);
  const context: SessionDiagnosticContext = {
    agentId: parsedAgent.agentId,
    ...cron,
    ...(cron.cronJobId ? { cronJobName: readCronJobName(cron.cronJobId) } : {}),
  };
  const activeSessionId = params.activeSessionId?.trim();
  if (!activeSessionId) {
    return context;
  }

  try {
    const sessionScope = { agentId: parsedAgent.agentId, sessionKey };
    // The read-only owner proves both identity and existence before transcript
    // access, preventing rotated-session leaks and phantom agent databases.
    if (loadSessionEntryReadOnly(sessionScope)?.sessionId === activeSessionId) {
      context.lastAssistant = readLatestTranscriptAssistantText({
        ...sessionScope,
        sessionId: activeSessionId,
      })?.text;
    }
  } catch {
    // Session context is best-effort and must not interrupt diagnostics.
  }
  return context;
}

export function formatCronSessionDiagnosticFields(context: SessionDiagnosticContext): string {
  const fields: string[] = [];
  if (context.cronJobId) {
    fields.push(`cronJobId=${context.cronJobId}`);
  }
  if (context.cronRunId) {
    fields.push(`cronRunId=${context.cronRunId}`);
  }
  if (context.cronJobName) {
    fields.push(`cronJob=${quoteLogField(context.cronJobName)}`);
  }
  if (context.lastAssistant) {
    fields.push(`lastAssistant=${quoteLogField(context.lastAssistant)}`);
  }
  return fields.join(" ");
}

export function formatStoppedCronSessionDiagnosticFields(
  context: SessionDiagnosticContext,
): string {
  const fields: string[] = [];
  if (context.cronJobName) {
    fields.push(`stopped=${quoteLogField(context.cronJobName)}`);
  }
  const rest = formatCronSessionDiagnosticFields({
    cronJobId: context.cronJobId,
    cronRunId: context.cronRunId,
    lastAssistant: context.lastAssistant,
  });
  if (rest) {
    fields.push(rest);
  }
  return fields.join(" ");
}
