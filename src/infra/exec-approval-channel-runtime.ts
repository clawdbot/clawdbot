// Runs the gateway-backed runtime that delivers native approval events.
import { readConnectErrorDetailCode } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { EventFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import type { GatewayClient, GatewayReconnectPausedInfo } from "../gateway/client.js";
import { isApprovalMethod } from "../gateway/method-scopes.js";
import { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferred } from "../shared/deferred.js";
import { createPendingApprovalRegistry } from "../shared/pending-approval-registry.js";
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

type PendingApprovalValue<TPending, TRequest extends ApprovalRequestEvent> = {
  request: TRequest;
  entries: TPending[];
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
  const pending = createPendingApprovalRegistry<PendingApprovalValue<TPending, TRequest>>();
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

  const finalizeExpiredEntry = async (entry: ReturnType<typeof pending.begin>): Promise<void> => {
    log.debug(`expired ${entry.id}`);
    await adapter.finalizeExpired?.(entry.value);
  };

  const handleExpired = async (approvalId: string): Promise<void> => {
    const entry = pending.remove(approvalId);
    if (!entry) {
      return;
    }
    await finalizeExpiredEntry(entry);
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
    const entry = pending.begin(request.id, { request, entries: [] });
    let entries: TPending[];
    try {
      entries = await adapter.deliverRequested(request);
    } catch (err) {
      pending.remove(request.id, entry);
      throw err;
    }
    if (!pending.isCurrent(entry)) {
      return;
    }
    if (!entries.length) {
      pending.remove(request.id, entry);
      return;
    }
    await pending.completeDelivery(entry, { request, entries });
    if (!pending.isCurrent(entry)) {
      return;
    }

    const timeoutMs = Math.max(0, request.expiresAtMs - nowMs());
    pending.scheduleExpiry(entry, timeoutMs, (expired) => {
      spawn("error handling approval expiration", finalizeExpiredEntry(expired));
    });
  };

  const handleResolved = async (resolved: TResolved): Promise<void> => {
    const settled = pending.settle(resolved.id, async (entry) => {
      log.debug(`resolved ${resolved.id} with ${resolved.decision}`);
      await adapter.finalizeResolved({
        request: entry.value.request,
        resolved,
        entries: entry.value.entries,
      });
    });
    if (settled.status === "taken") {
      await settled.terminal(settled.entry);
    }
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

        const ready = createDeferred();
        let lastConnectError: unknown = null;

        const client = await createOperatorApprovalsGatewayClient({
          config: adapter.cfg,
          gatewayUrl: adapter.gatewayUrl,
          clientDisplayName: adapter.clientDisplayName,
          onEvent: handleGatewayEvent,
          onHelloOk: () => {
            log.debug("connected to gateway");
            ready.resolve();
          },
          onConnectError: (err) => {
            log.error(`connect error: ${err.message}`);
            lastConnectError = err;
            if (readGatewayConnectErrorDetailCode(err)) {
              return;
            }
            ready.reject(err);
          },
          onReconnectPaused: (info) => {
            ready.reject(new ExecApprovalChannelRuntimeTerminalStartError(info, lastConnectError));
          },
          onClose: (code, reason) => {
            log.debug(`gateway closed: ${code} ${reason}`);
            ready.reject(lastConnectError ?? new Error(`gateway closed: ${code} ${reason}`));
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
            clientOptions: {},
          });
          if (!readiness.ready) {
            throw new Error(
              readiness.aborted
                ? "gateway approval runtime start aborted before readiness"
                : "gateway readiness unavailable before exec approval runtime start",
            );
          }
          await ready.promise;
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
