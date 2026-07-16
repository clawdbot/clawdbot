// Runs the gateway-backed runtime that delivers native approval events.
import { readConnectErrorDetailCode } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { EventFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import type { GatewayClient, GatewayReconnectPausedInfo } from "../gateway/client.js";
import { isApprovalMethod } from "../gateway/method-scopes.js";
import { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import {
  isGatewayNativeApprovalMethod,
  type GatewayNativeApprovalMethod,
} from "./approval-gateway-runtime-methods.js";
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
type ApprovalReplayMethod = Extract<
  GatewayNativeApprovalMethod,
  "exec.approval.list" | "plugin.approval.list"
>;

type ApprovalReplayClient = {
  request: <T = unknown>(
    method: ApprovalReplayMethod,
    params: Record<string, unknown>,
  ) => Promise<T>;
};

/** Error raised when the gateway pauses approval reconnects after a terminal startup failure. */
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

/** Narrows terminal approval runtime startup failures for bootstrap retry policy. */
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
): ApprovalReplayMethod[] {
  const methods: ApprovalReplayMethod[] = [];
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

/** Creates the gateway-backed approval runtime that tracks pending requests and finalization. */
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
  const configuredGatewayRuntime = getGatewayNativeApprovalRuntime();
  const pending = new Map<string, PendingApprovalEntry<TPending, TRequest, TResolved>>();
  let gatewayClient: GatewayClient | null = null;
  let gatewayRuntime: typeof configuredGatewayRuntime;
  let unsubscribeGatewayRuntime: (() => void) | null = null;
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
    opts?: { ignoreIfInactive?: boolean; alreadyAccepted?: boolean },
  ): Promise<void> => {
    if (opts?.ignoreIfInactive && !shouldKeepRunning()) {
      return;
    }
    if (pending.has(request.id)) {
      log.debug(`ignored duplicate request ${request.id}`);
      return;
    }
    if (opts?.alreadyAccepted !== true && !adapter.shouldHandle(request)) {
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
      // Resolution can arrive while native delivery is still creating entries; finalize after both.
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

  const replayPendingApprovals = async (
    client: ApprovalReplayClient,
    externalClient?: GatewayClient,
  ): Promise<void> => {
    try {
      for (const method of resolveApprovalReplayMethods(eventKinds)) {
        if (externalClient && stopClientIfInactive(externalClient)) {
          return;
        }
        const pendingRequests = await client.request<Array<TRequest>>(method, {});
        if (externalClient && stopClientIfInactive(externalClient)) {
          return;
        }
        for (const request of pendingRequests) {
          if (externalClient && stopClientIfInactive(externalClient)) {
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

  const startPendingApprovalReplay = (
    client: ApprovalReplayClient,
    externalClient?: GatewayClient,
  ): void => {
    const promise = replayPendingApprovals(client, externalClient)
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

        if (configuredGatewayRuntime) {
          await adapter.beforeGatewayClientStart?.();
          gatewayRuntime = configuredGatewayRuntime;
          // Subscribe before replay so a request created during the list calls is not lost.
          unsubscribeGatewayRuntime = gatewayRuntime.subscribe({
            eventKinds,
            shouldHandle: (request) =>
              shouldKeepRunning() && adapter.shouldHandle(request as TRequest),
            onRequested: (request) => {
              spawn(
                "error handling approval request",
                handleRequested(request as TRequest, {
                  ignoreIfInactive: true,
                  alreadyAccepted: true,
                }),
              );
            },
            onResolved: (resolved) => {
              spawn("error handling approval resolved", handleResolved(resolved as TResolved));
            },
          });
          if (!shouldRun) {
            unsubscribeGatewayRuntime();
            unsubscribeGatewayRuntime = null;
            gatewayRuntime = undefined;
            return;
          }
          started = true;
          startPendingApprovalReplay({ request: gatewayRuntime.request });
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
          // Hello, close, and reconnect-paused callbacks can race during startup.
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
          const readiness = await startGatewayClientWhenEventLoopReady(client, {
            clientOptions: {
              preauthHandshakeTimeoutMs: adapter.cfg.gateway?.handshakeTimeoutMs,
            },
          });
          if (!readiness.ready) {
            throw new Error(
              readiness.aborted
                ? "gateway approval runtime start aborted before readiness"
                : "gateway readiness unavailable before exec approval runtime start",
            );
          }
          await ready;
          if (stopClientIfInactive(client)) {
            return;
          }
          started = true;
          startPendingApprovalReplay(client, client);
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
      unsubscribeGatewayRuntime?.();
      unsubscribeGatewayRuntime = null;
      gatewayRuntime = undefined;
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
      if (!isApprovalMethod(method)) {
        throw new Error(
          `${adapter.label}: operator approvals runtime cannot dispatch ${method}; use a write-capable gateway client`,
        );
      }
      if (gatewayRuntime) {
        if (!isGatewayNativeApprovalMethod(method)) {
          throw new Error(
            `${adapter.label}: Gateway-owned approval runtime cannot dispatch ${method}`,
          );
        }
        return await gatewayRuntime.request<T>(method, params, {
          clientDisplayName: adapter.clientDisplayName,
        });
      }
      if (!gatewayClient) {
        throw new Error(`${adapter.label}: gateway client not connected`);
      }
      return (await gatewayClient.request(method, params)) as T;
    },
  };
}
