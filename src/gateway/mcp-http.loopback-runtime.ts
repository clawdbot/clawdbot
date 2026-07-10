// Process-local MCP loopback runtime state for owner/non-owner HTTP access.
type McpLoopbackRuntime = {
  port: number;
  ownerToken: string;
  nonOwnerToken: string;
};

export type McpLoopbackToolCallTerminalOutcome =
  | { outcome: "blocked"; deniedReason: string }
  | { outcome: "cancelled" | "failed" | "timed_out" | "unknown"; result?: unknown };

export type McpLoopbackToolCallOutcome =
  | { outcome: "completed"; result?: unknown }
  | McpLoopbackToolCallTerminalOutcome;

export type McpLoopbackToolCallResult = {
  toolName: string;
  args: Record<string, unknown>;
  correlationId?: string;
} & McpLoopbackToolCallOutcome;

export type McpLoopbackToolCallStart = Pick<McpLoopbackToolCallResult, "toolName" | "args">;

type McpLoopbackToolCallCapture = {
  generation: number;
  onYield?: (message: string) => Promise<void> | void;
  onRequestStart?: () => void;
  onRequestClassified?: () => void;
  onRequestFinish?: () => void;
  onToolCallStart?: (call: McpLoopbackToolCallStart) => string | void;
  onToolCallUpdate?: (calls: {
    previous: McpLoopbackToolCallStart;
    current: McpLoopbackToolCallStart;
  }) => void;
  onToolCallFinish?: (call: McpLoopbackToolCallStart, state: { prepared: boolean }) => void;
  onToolCallResult: (call: McpLoopbackToolCallResult) => void;
  inFlight: number;
  activityVersion: number;
  activityWaiters: Set<() => void>;
};

export type McpLoopbackRequestCaptureHandle = {
  capture: McpLoopbackToolCallCapture;
  classified: boolean;
  finished: boolean;
};

export type McpLoopbackToolCallCaptureHandle = {
  capture: McpLoopbackToolCallCapture;
  call: McpLoopbackToolCallStart;
  correlationId?: string;
  prepared: boolean;
  finished: boolean;
};

let activeRuntime: McpLoopbackRuntime | undefined;
let nextToolCallCaptureGeneration = 0;
const toolCallCaptures = new Map<string, McpLoopbackToolCallCapture>();

function deleteMcpLoopbackToolCallCapture(captureKey: string): void {
  const capture = toolCallCaptures.get(captureKey);
  if (!capture) {
    return;
  }
  toolCallCaptures.delete(captureKey);
  for (const resolve of capture.activityWaiters) {
    resolve();
  }
  capture.activityWaiters.clear();
}

function notifyMcpLoopbackToolCallCaptureActivity(capture: McpLoopbackToolCallCapture): void {
  capture.activityVersion += 1;
  for (const resolve of capture.activityWaiters) {
    resolve();
  }
  capture.activityWaiters.clear();
}

/** Start loopback tool-call result capture for one serialized CLI invocation. */
export function beginMcpLoopbackToolCallCapture(params: {
  captureKey: string;
  onYield?: (message: string) => Promise<void> | void;
  onRequestStart?: () => void;
  onRequestClassified?: () => void;
  onRequestFinish?: () => void;
  onToolCallStart?: (call: McpLoopbackToolCallStart) => string | void;
  onToolCallUpdate?: (calls: {
    previous: McpLoopbackToolCallStart;
    current: McpLoopbackToolCallStart;
  }) => void;
  onToolCallFinish?: (call: McpLoopbackToolCallStart, state: { prepared: boolean }) => void;
  onToolCallResult: (call: McpLoopbackToolCallResult) => void;
}): void {
  const captureKey = params.captureKey.trim();
  if (!captureKey) {
    return;
  }
  nextToolCallCaptureGeneration += 1;
  toolCallCaptures.set(captureKey, {
    generation: nextToolCallCaptureGeneration,
    onYield: params.onYield,
    onRequestStart: params.onRequestStart,
    onRequestClassified: params.onRequestClassified,
    onRequestFinish: params.onRequestFinish,
    onToolCallStart: params.onToolCallStart,
    onToolCallUpdate: params.onToolCallUpdate,
    onToolCallFinish: params.onToolCallFinish,
    onToolCallResult: params.onToolCallResult,
    inFlight: 0,
    activityVersion: 0,
    activityWaiters: new Set(),
  });
}

/** Resolve yield state bound to the request's admitted CLI capture generation. */
export function resolveMcpLoopbackYieldContext(
  captureHandle: McpLoopbackRequestCaptureHandle | undefined,
): { cacheKey: string; onYield: (message: string) => Promise<void> } | undefined {
  const capture = captureHandle?.capture;
  if (!capture?.onYield) {
    return undefined;
  }
  return {
    cacheKey: String(capture.generation),
    onYield: async (message: string) => {
      await capture.onYield?.(message);
    },
  };
}

/** Bind an authenticated HTTP request to the active capture generation before reading its body. */
export function markMcpLoopbackRequestStarted(
  captureKey: string | undefined,
): McpLoopbackRequestCaptureHandle | undefined {
  const normalizedKey = captureKey?.trim() ?? "";
  if (!normalizedKey) {
    return undefined;
  }
  const capture = toolCallCaptures.get(normalizedKey);
  if (!capture) {
    return undefined;
  }
  capture.inFlight += 1;
  notifyMcpLoopbackToolCallCaptureActivity(capture);
  try {
    capture.onRequestStart?.();
  } catch {
    // Delivery observation is diagnostic state; it must not alter request handling.
  }
  return { capture, classified: false, finished: false };
}

/** Mark a request body as parsed so it no longer represents an unknown possible send. */
export function markMcpLoopbackRequestClassified(
  captureHandle: McpLoopbackRequestCaptureHandle | undefined,
): void {
  if (!captureHandle || captureHandle.classified || captureHandle.finished) {
    return;
  }
  captureHandle.classified = true;
  try {
    captureHandle.capture.onRequestClassified?.();
  } catch {
    // Delivery observation is diagnostic state; it must not alter request handling.
  }
}

/** Mark an authenticated request as settled and wake capture drains. */
export function markMcpLoopbackRequestFinished(
  captureHandle: McpLoopbackRequestCaptureHandle | undefined,
): void {
  if (!captureHandle || captureHandle.finished) {
    return;
  }
  markMcpLoopbackRequestClassified(captureHandle);
  captureHandle.finished = true;
  const { capture } = captureHandle;
  try {
    capture.onRequestFinish?.();
  } catch {
    // Delivery observation is diagnostic state; it must not alter request handling.
  }
  capture.inFlight = Math.max(0, capture.inFlight - 1);
  notifyMcpLoopbackToolCallCaptureActivity(capture);
}

/** Mark a captured loopback tool call as in flight. */
export function markMcpLoopbackToolCallStarted(params: {
  captureKey?: string;
  requestCaptureHandle?: McpLoopbackRequestCaptureHandle;
  toolName: string;
  args: Record<string, unknown>;
}): McpLoopbackToolCallCaptureHandle | undefined {
  const toolName = params.toolName.trim();
  if (!toolName || params.requestCaptureHandle?.finished) {
    return undefined;
  }
  const captureKey = params.captureKey?.trim() ?? "";
  const capture = params.requestCaptureHandle?.capture ?? toolCallCaptures.get(captureKey);
  if (!capture) {
    return undefined;
  }
  const call = { toolName, args: params.args };
  capture.inFlight += 1;
  notifyMcpLoopbackToolCallCaptureActivity(capture);
  let correlationId: string | undefined;
  try {
    const observedCorrelationId = capture.onToolCallStart?.(call);
    correlationId = typeof observedCorrelationId === "string" ? observedCorrelationId : undefined;
  } catch {
    // Delivery observation is diagnostic state; it must not alter tool execution.
  }
  return { capture, call, correlationId, prepared: false, finished: false };
}

/** Update an admitted call with the final arguments produced by gateway hooks. */
export function updateMcpLoopbackToolCallCapture(
  captureHandle: McpLoopbackToolCallCaptureHandle | undefined,
  call: McpLoopbackToolCallStart,
): void {
  if (!captureHandle || captureHandle.finished) {
    return;
  }
  const previous = captureHandle.call;
  captureHandle.call = call;
  captureHandle.prepared = true;
  try {
    captureHandle.capture.onToolCallUpdate?.({ previous, current: call });
  } catch {
    // Delivery observation is diagnostic state; it must not alter tool execution.
  }
}

/** Report a completed call without letting observer failures alter tool execution. */
export function recordMcpLoopbackToolCallResult(
  params: {
    captureHandle: McpLoopbackToolCallCaptureHandle;
    toolName: string;
    args: Record<string, unknown>;
  } & McpLoopbackToolCallOutcome,
): void {
  const toolName = params.toolName.trim();
  if (!toolName) {
    return;
  }
  try {
    const outcome: McpLoopbackToolCallOutcome =
      params.outcome === "blocked"
        ? { outcome: "blocked", deniedReason: params.deniedReason }
        : { outcome: params.outcome, result: params.result };
    params.captureHandle.capture.onToolCallResult({
      toolName,
      args: params.args,
      ...outcome,
      ...(params.captureHandle.correlationId
        ? { correlationId: params.captureHandle.correlationId }
        : {}),
    });
  } catch {
    // Delivery observation is diagnostic state; it must not turn a successful tool call into error.
  }
}

/** Mark a captured loopback tool call as settled and wake idle drains. */
export function markMcpLoopbackToolCallFinished(
  captureHandle: McpLoopbackToolCallCaptureHandle | undefined,
): void {
  if (!captureHandle || captureHandle.finished) {
    return;
  }
  captureHandle.finished = true;
  const { capture } = captureHandle;
  try {
    capture.onToolCallFinish?.(captureHandle.call, { prepared: captureHandle.prepared });
  } catch {
    // Delivery observation is diagnostic state; it must not alter tool execution.
  }
  capture.inFlight = Math.max(0, capture.inFlight - 1);
  notifyMcpLoopbackToolCallCaptureActivity(capture);
}

async function waitForMcpLoopbackToolCallCaptureActivity(
  capture: McpLoopbackToolCallCapture,
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      capture.activityWaiters.delete(resolveActivity);
      resolve(active);
    };
    const resolveActivity = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    timer.unref?.();
    capture.activityWaiters.add(resolveActivity);
  });
}

/** Wait for admitted calls to settle and for a quiet request-admission grace. */
export async function waitForMcpLoopbackToolCallCaptureIdle(
  captureKey: string,
  options: {
    timeoutMs: number;
    admissionGraceMs: number;
  },
): Promise<boolean> {
  const normalizedKey = captureKey.trim();
  const capture = toolCallCaptures.get(normalizedKey);
  if (!capture) {
    return true;
  }
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  while (toolCallCaptures.get(normalizedKey) === capture) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    if (capture.inFlight > 0) {
      await waitForMcpLoopbackToolCallCaptureActivity(capture, remainingMs);
      continue;
    }
    const admissionGraceMs = Math.max(0, options.admissionGraceMs);
    if (admissionGraceMs === 0) {
      return true;
    }
    const activityVersion = capture.activityVersion;
    const quietWaitMs = Math.min(admissionGraceMs, remainingMs);
    const sawActivity = await waitForMcpLoopbackToolCallCaptureActivity(capture, quietWaitMs);
    if (
      !sawActivity &&
      quietWaitMs === admissionGraceMs &&
      capture.inFlight === 0 &&
      capture.activityVersion === activityVersion
    ) {
      return true;
    }
  }
  return true;
}

/** Clear an unfinished invocation capture. Attempt keys are unique per CLI execution. */
export function clearMcpLoopbackToolCallCapture(captureKey: string): void {
  deleteMcpLoopbackToolCallCapture(captureKey.trim());
}

/** Clear transient capture state between isolated tests. */
export function clearMcpLoopbackToolCallCapturesForTest(): void {
  for (const captureKey of toolCallCaptures.keys()) {
    deleteMcpLoopbackToolCallCapture(captureKey);
  }
  nextToolCallCaptureGeneration = 0;
}

/** Return a copy of the active loopback runtime, if one has been installed. */
export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  return activeRuntime ? { ...activeRuntime } : undefined;
}

/** Install the active loopback runtime used by in-process MCP callers. */
export function setActiveMcpLoopbackRuntime(runtime: McpLoopbackRuntime): void {
  activeRuntime = { ...runtime };
}

/** Clear loopback runtime only when the owning token matches the active runtime. */
export function clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken: string): void {
  if (activeRuntime?.ownerToken === ownerToken) {
    activeRuntime = undefined;
  }
}

const MCP_AUTH_HEADERS = {
  Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
} as const;

const MCP_CAPTURE_HEADERS = {
  "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
} as const;

function createMcpServerConfig(port: number, headers: Record<string, string>) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        alwaysLoad: true,
        headers,
      },
    },
  };
}

/** Build the MCP server config injected into agents for loopback tool access. */
export function createMcpLoopbackServerConfig(port: number) {
  return createMcpServerConfig(port, { ...MCP_AUTH_HEADERS, ...MCP_CAPTURE_HEADERS });
}

export function createMcpAttachGrantServerConfig(port: number) {
  return createMcpServerConfig(port, MCP_AUTH_HEADERS);
}
