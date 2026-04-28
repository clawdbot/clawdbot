import type { GatewayClient, GatewayReconnectPausedInfo } from "../gateway/client.js";
import { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import { readConnectErrorDetailCode } from "../gateway/protocol/connect-error-details.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import type {
  ExecApprovalChannelRuntime,
  ExecApprovalChannelRuntimeAdapter,
  ExecApprovalChannelRuntimeEventKind,
} from "./exec-approval-channel-runtime.types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";
export type {
  ExecApprovalChannelRuntime,
  ExecApprovalChannelRuntimeAdapter,
  ExecApprovalChannelRuntimeEventKind,
} from "./exec-approval-channel-runtime.types.js";

type ApprovalRequestEvent = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolvedEvent = ExecApprovalResolved | PluginApprovalResolved;

export class ExecApprovalChannelRuntimeTerminalStartError extends Error {
  readonly detailCode: string | null;

  constructor(info: GatewayReconnectPausedInfo, cause?: unknown) {
    super(
      `native approval gateway client paused reconnect after startup auth failure` +
        ` (${info.detailCode ?? "unknown"}): gateway closed (${info.code}): ${info.reason}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ExecApprovalChannelRuntimeTerminalStartError";
    this.detailCode = info.detailCode;
  }
}

export function isExecApprovalChannelRuntimeTerminalStartError(
  error: unknown,
): error is ExecApprovalChannelRuntimeTerminalStartError {
  return error instanceof ExecApprovalChannelRuntimeTerminalStartError;
}

type PendingApprovalEntry<
  TPending,
  TRequest extends ApprovalRequestEvent,
  TResolved extends ApprovalResolvedEvent,
> = {
  request: TRequest;
  entries: TPending[];
  timeoutId: NodeJS.Timeout | null;
  delivering: boolean;
  pendingResolution: TResolved | null;
};

function resolveApprovalReplayMethods(
  eventKinds: ReadonlySet<ExecApprovalChannelRuntimeEventKind>,
): string[] {
  const methods: string[] = [];
  if (eventKinds.has("exec")) {
    methods.push("exec.approval.list");
  }
  if (eventKinds.has("plugin")) {
    methods.push("plugin.approval.list");
  }
  return methods;
}

function readGatewayConnectErrorDetailCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  return readConnectErrorDetailCode((error as { details?: unknown }).details);
}

export function createExecApprovalChannelRuntime<
  TPending,
  TRequest extends ApprovalRequestEvent = ExecApprovalRequest,
  TResolved extends ApprovalResolvedEvent = ExecApprovalResolved,
>(
  adapter: ExecApprovalChannelRuntimeAdapter<TPending, TRequest, TResolved>,
): ExecApprovalChannelRuntime<TRequest, TResolved> {
  const log = createSubsystemLogger(adapter.label);
  const nowMs = adapter.nowMs ?? Date.now;
  const eventKinds = new Set<ExecApprovalChannelRuntimeEventKind>(adapter.eventKinds ?? ["exec"]);
  const pending = new Map<string, PendingApprovalEntry<TPending, TRequest, TResolved>>();
  let gatewayClient: GatewayClient | null = null;
  let started = false;
  let shouldRun = false;
  let startPromise: Promise<void> | null = null;
  let replayPromise: Promise<void> | null = null;

  const shouldKeepRunning = (): boolean => shouldRun;

  const spawn = (label: string, promise: Promise<void>): void => {
    void promise.catch((err: unknown) => {
      const message = formatErrorMessage(err);
      log.error(`${label}: ${message}`);
    });
  };

  const stopClientIfInactive = (client: GatewayClient): boolean => {
    if (shouldKeepRunning()) {
      return false;
    }
    gatewayClient = null;
    client.stop();
    return true;
  };

  const clearPendingEntry = (
    approvalId: string,
  ): PendingApprovalEntry<TPending, TRequest, TResolved> | null => {
    const entry = pending.get(approvalId);
    if (!entry) {
      return null;
    }
    pending.delete(approvalId);
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    return entry;
  };

  const handleExpired = async (approvalId: string): Promise<void> => {
    const entry = clearPendingEntry(approvalId);
    if (!entry) {
      return;
    }
    log.debug(`expired ${approvalId}`);
    await adapter.finalizeExpired?.({
      request: entry.request,
      entries: entry.entries,
    });
  };

  const handleRequested = async (
    request: TRequest,
    opts?: { ignoreIfInactive?: boolean },
  ): Promise<void> => {
    if (opts?.ignoreIfInactive && !shouldKeepRunning()) {
      return;
    }
    if (!adapter.shouldHandle(request)) {
      return;
    }

    if (pending.has(request.id)) {
      log.debug(`ignored duplicate request ${request.id}`);
      return;
    }

    log.debug(`received request ${request.id}`);
    const entry: PendingApprovalEntry<TPending, TRequest, TResolved> = {
      request,
      entries: [],
      timeoutId: null,
      delivering: true,
      pendingResolution: null,
    };
    pending.set(request.id, entry);
    let entries: TPending[];
    try {
      entries = await adapter.deliverRequested(request);
    } catch (err) {
      if (pending.get(request.id) === entry) {
        clearPendingEntry(request.id);
      }
      throw err;
    }
    const current = pending.get(request.id);
    if (current !== entry) {
      return;
    }
    if (!entries.length) {
      pending.delete(request.id);
      return;
    }
    entry.entries = entries;
    entry.delivering = false;
    if (entry.pendingResolution) {
      pending.delete(request.id);
      log.debug(`resolved ${entry.pendingResolution.id} with ${entry.pendingResolution.decision}`);
      await adapter.finalizeResolved({
        request: entry.request,
        resolved: entry.pendingResolution,
        entries: entry.entries,
      });
      return;
    }

    const timeoutMs = Math.max(0, request.expiresAtMs - nowMs());
    const timeoutId = setTimeout(() => {
      spawn("error handling approval expiration", handleExpired(request.id));
    }, timeoutMs);
    timeoutId.unref?.();
    entry.timeoutId = timeoutId;
  };

  const handleResolved = async (resolved: TResolved): Promise<void> => {
    const entry = pending.get(resolved.id);
    if (!entry) {
      return;
    }
    if (entry.delivering) {
      entry.pendingResolution = resolved;
      return;
    }
    const finalizedEntry = clearPendingEntry(resolved.id);
    if (!finalizedEntry) {
      return;
    }
    log.debug(`resolved ${resolved.id} with ${resolved.decision}`);
    await adapter.finalizeResolved({
      request: finalizedEntry.request,
      resolved,
      entries: finalizedEntry.entries,
    });
  };

  const handleGatewayEvent = (evt: EventFrame): void => {
    if (evt.event === "exec.approval.requested" && eventKinds.has("exec")) {
      spawn(
        "error handling approval request",
        handleRequested(evt.payload as TRequest, { ignoreIfInactive: true }),
      );
      return;
    }
    if (evt.event === "plugin.approval.requested" && eventKinds.has("plugin")) {
      spawn(
        "error handling approval request",
        handleRequested(evt.payload as TRequest, { ignoreIfInactive: true }),
      );
      return;
    }
    if (evt.event === "exec.approval.resolved" && eventKinds.has("exec")) {
      spawn("error handling approval resolved", handleResolved(evt.payload as TResolved));
      return;
    }
    if (evt.event === "plugin.approval.resolved" && eventKinds.has("plugin")) {
      spawn("error handling approval resolved", handleResolved(evt.payload as TResolved));
    }
  };

  const replayPendingApprovals = async (client: GatewayClient): Promise<void> => {
    try {
      for (const method of resolveApprovalReplayMethods(eventKinds)) {
        if (stopClientIfInactive(client)) {
          return;
        }
        const pendingRequests = await client.request<Array<TRequest>>(method, {});
        if (stopClientIfInactive(client)) {
          return;
        }
        for (const request of pendingRequests) {
          if (stopClientIfInactive(client)) {
            return;
          }
          await handleRequested(request, { ignoreIfInactive: true });
        }
      }
    } catch (error) {
      if (!shouldKeepRunning()) {
        return;
      }
      throw error;
    }
  };

  const startPendingApprovalReplay = (client: GatewayClient): void => {
    const promise = replayPendingApprovals(client)
      .catch((err: unknown) => {
        const message = formatErrorMessage(err);
        log.error(`error replaying pending approvals: ${message}`);
      })
      .finally(() => {
        if (replayPromise === promise) {
          replayPromise = null;
        }
      });
    replayPromise = promise;
  };

  const waitForPendingApprovalReplay = async (): Promise<void> => {
    const replay = replayPromise;
    if (!replay) {
      return;
    }
    await replay.catch(() => {});
  };

  return {
    async start(): Promise<void> {
      if (started) {
        return;
      }
      if (startPromise) {
        await startPromise;
        return;
      }

      shouldRun = true;
      startPromise = (async () => {
        if (!adapter.isConfigured()) {
          log.debug("disabled");
          return;
        }

        let readySettled = false;
        let resolveReady!: () => void;
        let rejectReady!: (error: unknown) => void;
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        let lastConnectError: unknown = null;
        const settleReady = (fn: () => void) => {
          if (readySettled) {
            return;
          }
          readySettled = true;
          fn();
        };

        const client = await createOperatorApprovalsGatewayClient({
          config: adapter.cfg,
          gatewayUrl: adapter.gatewayUrl,
          clientDisplayName: adapter.clientDisplayName,
          onEvent: handleGatewayEvent,
          onHelloOk: () => {
            log.debug("connected to gateway");
            settleReady(resolveReady);
          },
          onConnectError: (err) => {
            log.error(`connect error: ${err.message}`);
            lastConnectError = err;
            if (readGatewayConnectErrorDetailCode(err)) {
              return;
            }
            settleReady(() => rejectReady(err));
          },
          onReconnectPaused: (info) => {
            settleReady(() =>
              rejectReady(new ExecApprovalChannelRuntimeTerminalStartError(info, lastConnectError)),
            );
          },
          onClose: (code, reason) => {
            log.debug(`gateway closed: ${code} ${reason}`);
            settleReady(() =>
              rejectReady(lastConnectError ?? new Error(`gateway closed: ${code} ${reason}`)),
            );
          },
        });

        if (!shouldRun) {
          client.stop();
          return;
        }
        await adapter.beforeGatewayClientStart?.();
        gatewayClient = client;
        try {
          client.start();
          await ready;
          if (stopClientIfInactive(client)) {
            return;
          }
          started = true;
          startPendingApprovalReplay(client);
        } catch (error) {
          gatewayClient = null;
          started = false;
          client.stop();
          throw error;
        }
      })().finally(() => {
        startPromise = null;
      });

      await startPromise;
    },

    async stop(): Promise<void> {
      shouldRun = false;
      if (startPromise) {
        await startPromise.catch(() => {});
      }
      const wasActive = started || gatewayClient !== null || replayPromise !== null;
      started = false;
      gatewayClient?.stop();
      gatewayClient = null;
      await waitForPendingApprovalReplay();
      if (!wasActive) {
        await adapter.onStopped?.();
        return;
      }
      for (const entry of pending.values()) {
        if (entry.timeoutId) {
          clearTimeout(entry.timeoutId);
        }
      }
      pending.clear();
      await adapter.onStopped?.();
      log.debug("stopped");
    },

    handleRequested,
    handleResolved,
    handleExpired,

    async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
      if (!gatewayClient) {
        throw new Error(`${adapter.label}: gateway client not connected`);
      }
      return (await gatewayClient.request(method, params)) as T;
    },
  };
}
