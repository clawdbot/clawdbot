// Application-owned approval parsing and queue state.
import { normalizeOptionalString } from "../lib/string-coerce.ts";

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
  allowedDecisions?: readonly ExecApprovalDecision[];
};

export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ExecApprovalRequest = {
  id: string;
  kind: "exec" | "plugin" | "system-agent";
  request: ExecApprovalRequestPayload;
  pluginTitle?: string;
  pluginDescription?: string | null;
  pluginSeverity?: string | null;
  pluginId?: string | null;
  proposalHash?: string | null;
  createdAtMs: number;
  expiresAtMs: number;
};

type ExecApprovalResolved = {
  id: string;
  decision?: string | null;
  resolvedBy?: string | null;
  ts?: number | null;
};

export type ExecApprovalPromptState = {
  client: {
    request(method: string, params?: unknown): Promise<unknown>;
  } | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  execApprovalErrors: Map<string, string>;
  execApprovalNowMs?: number;
  execApprovalRefreshes?: Set<{ removedIds: Set<string> }>;
  execApprovalExpiryTimers?: Map<string, ReturnType<typeof globalThis.setTimeout>>;
  execApprovalCountdownTimer?: ReturnType<typeof globalThis.setTimeout>;
  execApprovalChanged?: () => void;
};

const APPROVAL_ALREADY_RESOLVED = "APPROVAL_ALREADY_RESOLVED";
const APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND";

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

function parseAllowedDecisions(value: unknown): ExecApprovalDecision[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const decisions = value.filter(
    (decision): decision is ExecApprovalDecision =>
      decision === "allow-once" || decision === "allow-always" || decision === "deny",
  );
  return decisions.length > 0 ? decisions : undefined;
}

function parseExecApprovalRequested(payload: unknown): ExecApprovalRequest | null {
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
      allowedDecisions: parseAllowedDecisions(request.allowedDecisions),
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

function parsePluginApprovalRequested(payload: unknown): ExecApprovalRequest | null {
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
      allowedDecisions: parseAllowedDecisions(request.allowedDecisions),
    },
    pluginTitle: title,
    pluginDescription: description,
    pluginSeverity: severity,
    pluginId,
    createdAtMs,
    expiresAtMs,
  };
}

function parseSystemAgentApprovalRequested(payload: unknown): ExecApprovalRequest | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = normalizeOptionalString(payload.id) ?? "";
  const request = isRecord(payload.request) ? payload.request : {};
  const title = normalizeOptionalString(request.title) ?? "";
  const description = normalizeOptionalString(request.description);
  const command = normalizeOptionalString(request.command);
  const proposalHash = normalizeOptionalString(request.proposalHash);
  const createdAtMs = typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!id || !title || !description || !command || !proposalHash || !createdAtMs || !expiresAtMs) {
    return null;
  }
  return {
    id,
    kind: "system-agent",
    request: {
      command,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
      allowedDecisions: ["allow-once", "deny"],
    },
    pluginTitle: title,
    pluginDescription: description,
    proposalHash,
    createdAtMs,
    expiresAtMs,
  };
}

export function parseApprovalRequestedEvent(
  event: string,
  payload: unknown,
): ExecApprovalRequest | null {
  if (event === "exec.approval.requested") {
    return parseExecApprovalRequested(payload);
  }
  if (event === "plugin.approval.requested") {
    return parsePluginApprovalRequested(payload);
  }
  return event === "openclaw.approval.requested"
    ? parseSystemAgentApprovalRequested(payload)
    : null;
}

export async function resolveApprovalRequest(
  client: NonNullable<ExecApprovalPromptState["client"]>,
  approval: ExecApprovalRequest,
  decision: ExecApprovalDecision,
): Promise<void> {
  if (approval.kind === "system-agent") {
    await client.request("approval.resolve", {
      id: approval.id,
      kind: "system-agent",
      decision,
    });
    return;
  }
  const method = approval.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
  await client.request(method, { id: approval.id, decision });
}

function pruneExecApprovalQueue(queue: ExecApprovalRequest[]): ExecApprovalRequest[] {
  const now = Date.now();
  return queue.filter((entry) => entry.expiresAtMs > now);
}

function addExecApproval(
  queue: ExecApprovalRequest[],
  entry: ExecApprovalRequest,
): ExecApprovalRequest[] {
  const next = pruneExecApprovalQueue(queue).filter((item) => item.id !== entry.id);
  next.push(entry);
  return sortApprovalsOldestFirst(next);
}

function removeExecApproval(queue: ExecApprovalRequest[], id: string): ExecApprovalRequest[] {
  return pruneExecApprovalQueue(queue).filter((entry) => entry.id !== id);
}

function readGatewayErrorCode(err: unknown): string | null {
  if (!isRecord(err)) {
    return null;
  }
  return normalizeOptionalString(err.gatewayCode) ?? null;
}

function readGatewayErrorReason(err: unknown): string | null {
  if (!isRecord(err)) {
    return null;
  }
  const { details } = err;
  if (!isRecord(details)) {
    return null;
  }
  return normalizeOptionalString(details.reason) ?? null;
}

export function isStaleApprovalResolutionError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readGatewayErrorCode(err);
  const reason = readGatewayErrorReason(err);
  if (reason === APPROVAL_ALREADY_RESOLVED || reason === APPROVAL_NOT_FOUND) {
    return true;
  }
  if (gatewayCode === APPROVAL_NOT_FOUND) {
    return true;
  }
  return /unknown or expired approval id/i.test(err.message);
}

function parseApprovalList(
  payload: unknown,
  parseEntry: (entry: unknown) => ExecApprovalRequest | null,
): ExecApprovalRequest[] | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  return payload.flatMap((entry) => {
    const parsed = parseEntry(entry);
    return parsed ? [parsed] : [];
  });
}

function sortApprovalsOldestFirst(queue: ExecApprovalRequest[]): ExecApprovalRequest[] {
  return queue.toSorted((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
}

function currentApprovalsForKind(
  queue: ExecApprovalRequest[],
  kind: ExecApprovalRequest["kind"],
): ExecApprovalRequest[] {
  return pruneExecApprovalQueue(queue).filter((entry) => entry.kind === kind);
}

function mergeRefreshedApprovalQueue(
  refreshed: ExecApprovalRequest[],
  refreshStartedWith: ExecApprovalRequest[],
  currentQueue: ExecApprovalRequest[],
  removedDuringRefresh: ReadonlySet<string>,
): ExecApprovalRequest[] {
  const refreshStartIds = new Set(refreshStartedWith.map((entry) => entry.id));
  const prunedCurrentQueue = pruneExecApprovalQueue(currentQueue);
  const currentQueueIds = new Set(prunedCurrentQueue.map((entry) => entry.id));
  const currentRefreshed = pruneExecApprovalQueue(refreshed).filter(
    (entry) =>
      !removedDuringRefresh.has(entry.id) &&
      (!refreshStartIds.has(entry.id) || currentQueueIds.has(entry.id)),
  );
  const refreshedIds = new Set(currentRefreshed.map((entry) => entry.id));
  const arrivedDuringRefresh = prunedCurrentQueue.filter(
    (entry) => !refreshStartIds.has(entry.id) && !refreshedIds.has(entry.id),
  );
  return sortApprovalsOldestFirst([...currentRefreshed, ...arrivedDuringRefresh]);
}

function clearApprovalCountdownTimer(state: ExecApprovalPromptState): void {
  if (state.execApprovalCountdownTimer === undefined) {
    return;
  }
  globalThis.clearTimeout(state.execApprovalCountdownTimer);
  state.execApprovalCountdownTimer = undefined;
}

function synchronizeApprovalCountdownTimer(state: ExecApprovalPromptState): void {
  if (state.execApprovalQueue.length === 0) {
    clearApprovalCountdownTimer(state);
    return;
  }
  state.execApprovalNowMs = Date.now();
  if (state.execApprovalCountdownTimer !== undefined) {
    return;
  }
  state.execApprovalCountdownTimer = globalThis.setTimeout(() => {
    state.execApprovalCountdownTimer = undefined;
    state.execApprovalNowMs = Date.now();
    state.execApprovalChanged?.();
    synchronizeApprovalCountdownTimer(state);
  }, 1_000);
}

function clearApprovalExpiryTimer(state: ExecApprovalPromptState, id: string): void {
  const timer = state.execApprovalExpiryTimers?.get(id);
  if (timer === undefined) {
    return;
  }
  globalThis.clearTimeout(timer);
  state.execApprovalExpiryTimers?.delete(id);
}

function scheduleApprovalExpiryPrune(
  state: ExecApprovalPromptState,
  entry: ExecApprovalRequest,
): void {
  clearApprovalExpiryTimer(state, entry.id);
  const timer = globalThis.setTimeout(
    () => {
      const trackedTimer = state.execApprovalExpiryTimers?.get(entry.id);
      if (trackedTimer !== undefined && trackedTimer !== timer) {
        return;
      }
      state.execApprovalExpiryTimers?.delete(entry.id);
      const hadEntry = state.execApprovalQueue.some((item) => item.id === entry.id);
      removeExecApprovalFromState(state, entry.id);
      if (hadEntry) {
        state.execApprovalChanged?.();
      }
    },
    Math.max(0, entry.expiresAtMs - Date.now() + 500),
  );
  state.execApprovalExpiryTimers?.set(entry.id, timer);
}

function removeExecApprovalFromState(state: ExecApprovalPromptState, id: string): void {
  clearApprovalExpiryTimer(state, id);
  state.execApprovalQueue = removeExecApproval(state.execApprovalQueue, id);
  state.execApprovalErrors.delete(id);
  synchronizeApprovalCountdownTimer(state);
}

function pruneExecApprovalErrors(state: ExecApprovalPromptState): void {
  const pendingIds = new Set(state.execApprovalQueue.map((entry) => entry.id));
  for (const id of state.execApprovalErrors.keys()) {
    if (!pendingIds.has(id)) {
      state.execApprovalErrors.delete(id);
    }
  }
}

export function clearExecApprovalTimers(state: ExecApprovalPromptState): void {
  for (const timer of state.execApprovalExpiryTimers?.values() ?? []) {
    globalThis.clearTimeout(timer);
  }
  state.execApprovalExpiryTimers?.clear();
  clearApprovalCountdownTimer(state);
}

export function enqueueExecApprovalPrompt(
  state: ExecApprovalPromptState,
  entry: ExecApprovalRequest,
): void {
  state.execApprovalQueue = addExecApproval(state.execApprovalQueue, entry);
  scheduleApprovalExpiryPrune(state, entry);
  synchronizeApprovalCountdownTimer(state);
}

export async function refreshPendingApprovalQueue(
  state: ExecApprovalPromptState,
  options?: {
    isCurrentClient?: (client: NonNullable<ExecApprovalPromptState["client"]>) => boolean;
  },
): Promise<boolean> {
  const client = state.client;
  if (!client) {
    return false;
  }
  if (options?.isCurrentClient && !options.isCurrentClient(client)) {
    return false;
  }
  const refresh = { removedIds: new Set<string>() };
  const refreshes = (state.execApprovalRefreshes ??= new Set());
  refreshes.add(refresh);
  const refreshStartedWith = pruneExecApprovalQueue(state.execApprovalQueue);
  try {
    const [execResult, pluginResult, systemAgentResult] = await Promise.allSettled([
      client.request("exec.approval.list", {}),
      client.request("plugin.approval.list", {}),
      client.request("openclaw.approval.list", {}),
    ]);
    const execApprovals =
      execResult.status === "fulfilled"
        ? (parseApprovalList(execResult.value, parseExecApprovalRequested) ?? [])
        : currentApprovalsForKind(state.execApprovalQueue, "exec");
    const pluginApprovals =
      pluginResult.status === "fulfilled"
        ? (parseApprovalList(pluginResult.value, parsePluginApprovalRequested) ?? [])
        : currentApprovalsForKind(state.execApprovalQueue, "plugin");
    const systemAgentApprovals =
      systemAgentResult.status === "fulfilled"
        ? (parseApprovalList(systemAgentResult.value, parseSystemAgentApprovalRequested) ?? [])
        : currentApprovalsForKind(state.execApprovalQueue, "system-agent");
    const refreshed = mergeRefreshedApprovalQueue(
      sortApprovalsOldestFirst([...execApprovals, ...pluginApprovals, ...systemAgentApprovals]),
      refreshStartedWith,
      state.execApprovalQueue,
      refresh.removedIds,
    );
    if (options?.isCurrentClient && !options.isCurrentClient(client)) {
      return false;
    }
    state.execApprovalQueue = refreshed;
    pruneExecApprovalErrors(state);
    const refreshedIds = new Set(refreshed.map((entry) => entry.id));
    for (const id of state.execApprovalExpiryTimers?.keys() ?? []) {
      if (!refreshedIds.has(id)) {
        clearApprovalExpiryTimer(state, id);
      }
    }
    for (const entry of refreshed) {
      scheduleApprovalExpiryPrune(state, entry);
    }
    synchronizeApprovalCountdownTimer(state);
    return true;
  } finally {
    refreshes.delete(refresh);
    if (refreshes.size === 0) {
      state.execApprovalRefreshes = undefined;
    }
  }
}

export function clearResolvedExecApprovalPrompt(state: ExecApprovalPromptState, id: string): void {
  removeExecApprovalFromState(state, id);
  for (const refresh of state.execApprovalRefreshes ?? []) {
    refresh.removedIds.add(id);
  }
}
