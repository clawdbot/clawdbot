import { normalizeOptionalString } from "../string-coerce.ts";

export type ExecApprovalRequestPayload = {
  command: string;
  cwd?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  commandSpans?: readonly {
    startIndex: number;
    endIndex: number;
  }[];
};

export type ExecApprovalRequest = {
  id: string;
  kind: "exec" | "plugin";
  request: ExecApprovalRequestPayload;
  pluginTitle?: string;
  pluginDescription?: string | null;
  pluginSeverity?: string | null;
  pluginId?: string | null;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision?: string | null;
  resolvedBy?: string | null;
  ts?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCommandSpans(
  value: unknown,
  commandLength: number,
):
  | {
      startIndex: number;
      endIndex: number;
    }[]
  | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const spans = value.filter(
    (
      item,
    ): item is {
      startIndex: number;
      endIndex: number;
    } => {
      if (!isRecord(item)) {
        return false;
      }
      const { startIndex, endIndex } = item;
      return (
        Number.isSafeInteger(startIndex) &&
        Number.isSafeInteger(endIndex) &&
        typeof startIndex === "number" &&
        typeof endIndex === "number" &&
        startIndex >= 0 &&
        endIndex > startIndex &&
        endIndex <= commandLength
      );
    },
  );
  return spans.length > 0 ? spans : undefined;
}

export function parseExecApprovalRequested(payload: unknown): ExecApprovalRequest | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = normalizeOptionalString(payload.id) ?? "";
  const request = payload.request;
  if (!id || !isRecord(request)) {
    return null;
  }
  const command = typeof request.command === "string" ? request.command : "";
  if (command.trim().length === 0) {
    return null;
  }
  const createdAtMs = typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!createdAtMs || !expiresAtMs) {
    return null;
  }
  return {
    id,
    kind: "exec",
    request: {
      command,
      cwd: typeof request.cwd === "string" ? request.cwd : null,
      host: typeof request.host === "string" ? request.host : null,
      security: typeof request.security === "string" ? request.security : null,
      ask: typeof request.ask === "string" ? request.ask : null,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      resolvedPath: typeof request.resolvedPath === "string" ? request.resolvedPath : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
      commandSpans: parseCommandSpans(request.commandSpans, command.length),
    },
    createdAtMs,
    expiresAtMs,
  };
}

export function parseExecApprovalResolved(payload: unknown): ExecApprovalResolved | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = normalizeOptionalString(payload.id) ?? "";
  if (!id) {
    return null;
  }
  return {
    id,
    decision: typeof payload.decision === "string" ? payload.decision : null,
    resolvedBy: typeof payload.resolvedBy === "string" ? payload.resolvedBy : null,
    ts: typeof payload.ts === "number" ? payload.ts : null,
  };
}

export function parsePluginApprovalRequested(payload: unknown): ExecApprovalRequest | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = normalizeOptionalString(payload.id) ?? "";
  if (!id) {
    return null;
  }
  const createdAtMs = typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!createdAtMs || !expiresAtMs) {
    return null;
  }
  // title, description, severity, pluginId, agentId, sessionKey live inside payload.request
  const request = isRecord(payload.request) ? payload.request : {};
  const title = normalizeOptionalString(request.title) ?? "";
  if (!title) {
    return null;
  }
  const description = typeof request.description === "string" ? request.description : null;
  const severity = typeof request.severity === "string" ? request.severity : null;
  const pluginId = typeof request.pluginId === "string" ? request.pluginId : null;

  return {
    id,
    kind: "plugin",
    request: {
      command: title,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
    },
    pluginTitle: title,
    pluginDescription: description,
    pluginSeverity: severity,
    pluginId,
    createdAtMs,
    expiresAtMs,
  };
}

export function pruneExecApprovalQueue(queue: ExecApprovalRequest[]): ExecApprovalRequest[] {
  const now = Date.now();
  return queue.filter((entry) => entry.expiresAtMs > now);
}

export function addExecApproval(
  queue: ExecApprovalRequest[],
  entry: ExecApprovalRequest,
): ExecApprovalRequest[] {
  const next = pruneExecApprovalQueue(queue).filter((item) => item.id !== entry.id);
  next.unshift(entry);
  return next;
}

export function removeExecApproval(
  queue: ExecApprovalRequest[],
  id: string,
): ExecApprovalRequest[] {
  return pruneExecApprovalQueue(queue).filter((entry) => entry.id !== id);
}
