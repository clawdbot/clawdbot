import type { ErrorShape, EventFrame, HelloOk, ResponseFrame } from "@openclaw/gateway-protocol";
import {
  isGatewayEventFrame,
  isGatewayResponseFrame,
} from "@openclaw/gateway-protocol/frame-guards";
import { RetrySupervisor, sleepWithAbort } from "@openclaw/retry";

export type GatewayProtocolSocket = {
  isOpen: () => boolean;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};
export type GatewayProtocolSocketHandlers = {
  open: () => void;
  message: (data: string) => void;
  close: (code: number, reason: string) => void;
  error: (error: Error) => void;
};
export type GatewayProtocolRequestOptions = {
  timeoutMs?: number | null;
  expectFinal?: boolean;
  onSent?: () => void;
  onAccepted?: (payload: unknown) => void;
  signal?: AbortSignal;
};
type GatewayProtocolConnectContext<TPlan> = {
  generation: number;
  nonce: string | null;
  plan: TPlan;
};
export type GatewayProtocolCloseContext = {
  code: number;
  reason: string;
  generation: number;
  socketOpened: boolean;
  helloReceived: boolean;
  connectRequestSent: boolean;
  connectFailure?: { error: Error; reconnectDelayMs?: number };
};
type GatewayProtocolConnectDecision = {
  closeCode: number;
  closeReason: string;
  reconnectDelayMs?: number;
  stop?: boolean;
  error?: Error;
};
type GatewayProtocolCloseDecision = {
  retry: boolean;
  notify: boolean;
  reconnectDelayMs?: number;
  pendingError?: Error;
};
export type GatewayProtocolTiming<TPlan> = {
  phase:
    | "socket-open"
    | "challenge"
    | "fallback"
    | "device-identity-ready"
    | "connect-plan-ready"
    | "request-sent"
    | "hello"
    | "failed";
  generation: number;
  durationMs: number;
  phaseDurationMs: number;
  hasChallenge: boolean;
  usedFallback: boolean;
  plan?: TPlan;
  detail?: unknown;
};
export type GatewayProtocolRequestTiming = {
  id: string;
  method: string;
  ok: boolean;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  errorCode?: string;
};
type GatewayProtocolClientOptions<TPlan> = {
  createSocket: (handlers: GatewayProtocolSocketHandlers) => GatewayProtocolSocket;
  createRequestId: () => string;
  createRequestError?: (error: Partial<ErrorShape>) => GatewayProtocolRequestError;
  createRequestTimeoutError?: (method: string, timeoutMs: number) => Error;
  createRequestAbortError?: (method: string) => Error;
  buildConnectPlan: (params: {
    nonce: string | null;
    generation: number;
  }) => TPlan | Promise<TPlan>;
  buildConnectParams: (plan: TPlan) => unknown;
  onConnectPlanError?: (error: Error) => GatewayProtocolConnectDecision;
  onConnectHello?: (hello: HelloOk, context: GatewayProtocolConnectContext<TPlan>) => void;
  onHello?: (hello: HelloOk) => void;
  onConnectFailure?: (
    error: GatewayProtocolRequestError,
    context: GatewayProtocolConnectContext<TPlan>,
  ) => GatewayProtocolConnectDecision;
  resolveClose: (context: GatewayProtocolCloseContext) => GatewayProtocolCloseDecision;
  onClose?: (context: GatewayProtocolCloseContext, decision: GatewayProtocolCloseDecision) => void;
  notifyStoppedClose?: boolean;
  onConnectError?: (error: Error) => void;
  onSocketFactoryError?: (error: Error) => void;
  onParseError?: (error: unknown) => void;
  onEvent?: (event: EventFrame) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onActivity?: () => void;
  onTiming?: (timing: GatewayProtocolTiming<TPlan>) => void;
  onRequestTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onCallbackError?: (label: string, error: unknown) => void;
  handshake:
    | { mode: "fallback"; timeoutMs: number }
    | {
        mode: "require-challenge";
        timeoutMs: number;
        timeoutMessage?: (elapsedMs: number) => string;
      };
  reconnect: { initialMs: number; multiplier: number; maxMs: number };
  requestTimeoutMs?: number;
  nowMs?: () => number;
  rethrowSocketFactoryError?: (error: Error) => boolean;
};
export class GatewayProtocolRequestError extends Error {
  readonly code: string;
  readonly gatewayCode: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(error: Partial<ErrorShape>) {
    super(error.message ?? "request failed");
    this.name = "GatewayProtocolRequestError";
    this.code = error.code ?? "UNAVAILABLE";
    this.gatewayCode = this.code;
    this.details = error.details;
    this.retryable = error.retryable === true;
    this.retryAfterMs = error.retryAfterMs;
  }
}

type ConnectTimingState = {
  generation: number;
  startedAtMs: number;
  lastAtMs: number;
  hasChallenge: boolean;
  usedFallback: boolean;
};
type CloseSnapshot = Omit<GatewayProtocolCloseContext, "code" | "reason">;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
  acceptedNotified: boolean;
  onAccepted?: (payload: unknown) => void;
  cleanup?: () => void;
  unbounded: boolean;
  method: string;
  startedAtMs: number;
};

/**
 * Browser-safe gateway wire client. Environment adapters own transport and auth
 * policy; this class owns the single socket/handshake/reconnect/frame state machine.
 */
export class GatewayProtocolClient<TPlan> {
  private socket: GatewayProtocolSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private listeners = new Set<(event: EventFrame) => void>();
  private stopped = true;
  private generation = 0;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectRequestSent = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectSupervisor: RetrySupervisor;
  private socketOpened = false;
  private helloReceived = false;
  private connectFailure: GatewayProtocolCloseContext["connectFailure"];
  private connectTiming: ConnectTimingState | null = null;
  private stoppedSocket?: { socket: GatewayProtocolSocket; context: CloseSnapshot };

  constructor(private readonly opts: GatewayProtocolClientOptions<TPlan>) {
    this.reconnectSupervisor = new RetrySupervisor({
      initialMs: opts.reconnect.initialMs,
      maxMs: opts.reconnect.maxMs,
      factor: opts.reconnect.multiplier,
      jitter: 0,
    });
  }

  get connected(): boolean {
    return this.socket?.isOpen() ?? false;
  }

  get hasPendingRequests(): boolean {
    return this.pending.size > 0;
  }

  get connecting(): boolean {
    return this.connectSent && !this.helloReceived;
  }

  get hasUnboundedPendingRequests(): boolean {
    return [...this.pending.values()].some((pending) => pending.unbounded);
  }

  start(): void {
    this.stopped = false;
    this.reconnectSupervisor.cancel();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHandshakeTimer();
    this.reconnectSupervisor.reset();
    const socket = this.socket;
    if (socket && this.opts.notifyStoppedClose) {
      // Node callers observe the transport's final close during explicit stop;
      // browser callers intentionally suppress it.
      this.stoppedSocket = { socket, context: this.closeContext() };
    }
    this.socket = null;
    this.connectFailure = undefined;
    this.connectTiming = null;
    this.flushRequests(new Error("gateway client stopped"));
    socket?.close();
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket?.isOpen()) {
      return Promise.reject(new Error("gateway not connected"));
    }
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new Error("invalid request frame: method must be a non-empty string"));
    }
    const id = this.opts.createRequestId();
    const timeoutMs =
      options?.timeoutMs === null ? undefined : (options?.timeoutMs ?? this.opts.requestTimeoutMs);
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: options?.expectFinal === true,
        acceptedNotified: false,
        onAccepted: options?.onAccepted,
        unbounded: timeoutMs === undefined,
        method,
        startedAtMs: this.nowMs(),
      };
      const onAbort = () => {
        this.pending.delete(id);
        if (timeout) {
          clearTimeout(timeout);
        }
        this.finishRequestTiming(id, pending, false, "CLIENT_ABORTED");
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
      };
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        options?.signal?.removeEventListener("abort", onAbort);
      };
      if (options?.signal?.aborted) {
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
        return;
      }
      pending.cleanup = cleanup;
      if (timeoutMs !== undefined && timeoutMs >= 0) {
        timeout = setTimeout(() => {
          this.pending.delete(id);
          options?.signal?.removeEventListener("abort", onAbort);
          this.finishRequestTiming(id, pending, false, "CLIENT_TIMEOUT");
          reject(
            this.opts.createRequestTimeoutError?.(method, timeoutMs) ??
              new Error(`gateway request timed out after ${timeoutMs}ms: ${method}`),
          );
        }, timeoutMs);
        timeout.unref?.();
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      try {
        socket.send(JSON.stringify({ type: "req", id, method, params }));
        this.invoke("sent", () => options?.onSent?.());
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        this.finishRequestTiming(id, pending, false, "CLIENT_SEND_ERROR");
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  addEventListener(listener: (event: EventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  closeSocket(code?: number, reason?: string): void {
    this.socket?.close(code, reason);
  }

  resetReconnectBackoff(initialMs: number): void {
    this.reconnectSupervisor.reset(initialMs);
  }

  recordTiming(
    phase: GatewayProtocolTiming<TPlan>["phase"],
    generation: number,
    plan?: TPlan,
    detail?: unknown,
  ): void {
    const now = this.nowMs();
    const state = this.connectTiming;
    if (!state || state.generation !== generation) {
      return;
    }
    state.hasChallenge ||= phase === "challenge";
    state.usedFallback ||= phase === "fallback";
    this.invoke("connect timing", () =>
      this.opts.onTiming?.({
        phase,
        generation,
        durationMs: Math.max(0, now - state.startedAtMs),
        phaseDurationMs: Math.max(0, now - state.lastAtMs),
        hasChallenge: state.hasChallenge,
        usedFallback: state.usedFallback,
        plan,
        detail,
      }),
    );
    state.lastAtMs = now;
    if (phase === "hello" || phase === "failed") {
      this.connectTiming = null;
    }
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const generation = this.generation + 1;
    this.connectNonce = null;
    this.connectSent = false;
    this.connectRequestSent = false;
    this.socketOpened = false;
    this.helloReceived = false;
    this.connectFailure = undefined;
    let socket: GatewayProtocolSocket;
    try {
      socket = this.opts.createSocket({
        open: () => this.handleOpen(socket, generation),
        message: (data) => this.handleMessage(socket, generation, data),
        close: (code, reason) => this.handleClose(socket, generation, code, reason),
        error: (error) => this.handleSocketError(socket, generation, error),
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.opts.onSocketFactoryError?.(normalized);
      this.opts.onConnectError?.(normalized);
      if (this.opts.rethrowSocketFactoryError?.(normalized)) {
        throw normalized;
      }
      return;
    }
    this.generation = generation;
    this.socket = socket;
    const now = this.nowMs();
    this.connectTiming = {
      generation,
      startedAtMs: now,
      lastAtMs: now,
      hasChallenge: false,
      usedFallback: false,
    };
  }

  private handleOpen(socket: GatewayProtocolSocket, generation: number): void {
    if (!this.isActive(socket, generation)) {
      return;
    }
    this.socketOpened = true;
    this.recordTiming("socket-open", generation);
    if (this.connectNonce) {
      this.sendConnect(socket, generation);
      return;
    }
    this.armHandshakeTimer(socket, generation);
  }

  private armHandshakeTimer(socket: GatewayProtocolSocket, generation: number): void {
    this.clearHandshakeTimer();
    const armedAt = Date.now();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (!this.isActive(socket, generation) || this.connectSent || !socket.isOpen()) {
        return;
      }
      if (this.opts.handshake.mode === "fallback") {
        this.recordTiming("fallback", generation);
        this.sendConnect(socket, generation);
        return;
      }
      const elapsedMs = Date.now() - armedAt;
      const error = new Error(
        this.opts.handshake.timeoutMessage?.(elapsedMs) ??
          `gateway connect challenge timeout after ${elapsedMs}ms`,
      );
      this.opts.onConnectError?.(error);
      socket.close(1008, "connect challenge timeout");
    }, this.opts.handshake.timeoutMs);
    this.handshakeTimer.unref?.();
  }

  private sendConnect(socket: GatewayProtocolSocket, generation: number): void {
    if (!this.isActive(socket, generation) || !socket.isOpen() || this.connectSent) {
      return;
    }
    this.connectSent = true;
    this.clearHandshakeTimer();
    let planOrPromise: TPlan | Promise<TPlan>;
    try {
      planOrPromise = this.opts.buildConnectPlan({
        nonce: this.connectNonce,
        generation,
      });
    } catch (error) {
      this.handleConnectPlanError(socket, generation, error);
      return;
    }
    if (planOrPromise instanceof Promise) {
      void planOrPromise
        .then((plan) => this.sendConnectPlan(socket, generation, plan))
        .catch((error: unknown) => this.handleConnectPlanError(socket, generation, error));
      return;
    }
    this.sendConnectPlan(socket, generation, planOrPromise);
  }

  private handleConnectPlanError(
    socket: GatewayProtocolSocket,
    generation: number,
    error: unknown,
  ): void {
    if (!this.isActive(socket, generation)) {
      return;
    }
    const normalized = error instanceof Error ? error : new Error(String(error));
    const outcome = this.opts.onConnectPlanError?.(normalized) ?? {
      closeCode: 1008,
      closeReason: "connect failed",
    };
    this.opts.onConnectError?.(outcome.error ?? normalized);
    if (outcome.stop) {
      this.stopped = true;
    }
    socket.close(outcome.closeCode, outcome.closeReason);
  }

  private sendConnectPlan(socket: GatewayProtocolSocket, generation: number, plan: TPlan): void {
    if (!this.isActive(socket, generation) || !socket.isOpen()) {
      return;
    }
    const context = { generation, nonce: this.connectNonce, plan };
    this.recordTiming("connect-plan-ready", generation, plan);
    this.recordTiming("request-sent", generation, plan);
    this.connectRequestSent = true;
    void this.request<HelloOk>("connect", this.opts.buildConnectParams(plan))
      .then((hello) => {
        if (!this.isActive(socket, generation)) {
          return;
        }
        this.helloReceived = true;
        this.connectFailure = undefined;
        this.reconnectSupervisor.reset();
        this.recordTiming("hello", generation, plan);
        this.opts.onConnectHello?.(hello, context);
        this.invoke("hello", () => this.opts.onHello?.(hello));
      })
      .catch((error: unknown) => {
        if (!this.isActive(socket, generation)) {
          return;
        }
        const requestError =
          error instanceof GatewayProtocolRequestError
            ? error
            : new GatewayProtocolRequestError({ message: String(error) });
        const outcome = this.opts.onConnectFailure?.(requestError, context) ?? {
          closeCode: 1008,
          closeReason: "connect failed",
        };
        this.connectFailure = {
          error: requestError,
          reconnectDelayMs: outcome.reconnectDelayMs,
        };
        if (outcome.stop) {
          this.stopped = true;
        }
        socket.close(outcome.closeCode, outcome.closeReason);
      });
  }

  private handleMessage(socket: GatewayProtocolSocket, generation: number, raw: string): void {
    if (!this.isActive(socket, generation)) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.opts.onParseError?.(error);
      return;
    }
    if (isGatewayEventFrame(parsed)) {
      this.opts.onActivity?.();
      if (parsed.event === "connect.challenge") {
        const payload = parsed.payload as { nonce?: unknown } | undefined;
        const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : "";
        if (!nonce) {
          if (this.opts.handshake.mode === "require-challenge") {
            const error = new Error("gateway connect challenge missing nonce");
            this.opts.onConnectError?.(error);
            socket.close(1008, "connect challenge missing nonce");
          }
          return;
        }
        this.connectNonce = nonce;
        this.recordTiming("challenge", generation);
        this.sendConnect(socket, generation);
        return;
      }
      const seq = typeof parsed.seq === "number" ? parsed.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          const expected = this.lastSeq + 1;
          this.invoke("gap", () => this.opts.onGap?.({ expected, received: seq }));
        }
        this.lastSeq = seq;
      }
      this.invoke("event", () => this.opts.onEvent?.(parsed));
      for (const listener of this.listeners) {
        this.invoke("event listener", () => listener(parsed));
      }
      return;
    }
    if (!isGatewayResponseFrame(parsed)) {
      return;
    }
    this.opts.onActivity?.();
    this.handleResponse(parsed);
  }

  private handleResponse(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    const status = (frame.payload as { status?: unknown } | undefined)?.status;
    if (pending.expectFinal && status === "accepted") {
      if (!pending.acceptedNotified) {
        pending.acceptedNotified = true;
        this.invoke("accepted", () => pending.onAccepted?.(frame.payload));
      }
      return;
    }
    this.pending.delete(frame.id);
    pending.cleanup?.();
    if (frame.ok) {
      this.finishRequestTiming(frame.id, pending, true);
      pending.resolve(frame.payload);
      return;
    }
    this.finishRequestTiming(frame.id, pending, false, frame.error?.code);
    pending.reject(
      this.opts.createRequestError?.(frame.error ?? {}) ??
        new GatewayProtocolRequestError(frame.error ?? {}),
    );
  }

  private handleClose(
    socket: GatewayProtocolSocket,
    generation: number,
    code: number,
    reason: string,
  ): void {
    if (this.socket !== socket) {
      if (this.stoppedSocket?.socket === socket) {
        const context = { ...this.stoppedSocket.context, code, reason };
        this.stoppedSocket = undefined;
        this.invoke("close", () => this.opts.onClose?.(context, { retry: false, notify: true }));
      }
      return;
    }
    this.socket = null;
    this.clearHandshakeTimer();
    const context: GatewayProtocolCloseContext = {
      ...this.closeContext(),
      code,
      reason,
      generation,
    };
    this.connectFailure = undefined;
    const decision = this.opts.resolveClose(context);
    this.flushRequests(
      decision.pendingError ??
        context.connectFailure?.error ??
        new Error(`gateway closed (${code}): ${reason}`),
    );
    this.invoke("close", () => this.opts.onClose?.(context, decision));
    if (decision.retry && !this.stopped) {
      this.scheduleReconnect(decision.reconnectDelayMs ?? context.connectFailure?.reconnectDelayMs);
    }
  }

  private handleSocketError(socket: GatewayProtocolSocket, generation: number, error: Error): void {
    if (!this.isActive(socket, generation) || this.connectSent) {
      return;
    }
    this.opts.onConnectError?.(error);
  }

  private flushRequests(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.finishRequestTiming(id, pending, false, "CLIENT_CLOSED");
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private finishRequestTiming(
    id: string,
    pending: PendingRequest,
    ok: boolean,
    errorCode?: string,
  ): void {
    const endedAtMs = this.nowMs();
    this.invoke("request timing", () =>
      this.opts.onRequestTiming?.({
        id,
        method: pending.method,
        ok,
        durationMs: Math.max(0, endedAtMs - pending.startedAtMs),
        startedAtMs: pending.startedAtMs,
        endedAtMs,
        errorCode,
      }),
    );
  }

  private scheduleReconnect(overrideMs?: number): void {
    if (overrideMs !== undefined) {
      // Retry-After is a floor for this wait, not a failed attempt. Preserve
      // the exponential sequence for the next transport failure.
      this.reconnectSupervisor.nextDelayOverrideMs = overrideMs;
    }
    const retry = this.reconnectSupervisor.next();
    if (!retry) {
      return;
    }
    // Ignore cancelled sleeps only; reconnect start failures stay observable.
    void sleepWithAbort(retry.delayMs, retry.signal).then(
      () => this.connect(),
      () => {},
    );
  }

  private closeContext(): CloseSnapshot {
    return {
      generation: this.generation,
      socketOpened: this.socketOpened,
      helloReceived: this.helloReceived,
      connectRequestSent: this.connectRequestSent,
      connectFailure: this.connectFailure,
    };
  }

  private isActive(socket: GatewayProtocolSocket, generation: number): boolean {
    return !this.stopped && this.socket === socket && this.generation === generation;
  }

  private nowMs(): number {
    return this.opts.nowMs?.() ?? Date.now();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private invoke(label: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.opts.onCallbackError?.(label, error);
    }
  }
}
