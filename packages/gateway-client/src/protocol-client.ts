import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import {
  isGatewayEventFrame,
  isGatewayResponseFrame,
} from "@openclaw/gateway-protocol/frame-guards";
import { RetrySupervisor, sleepWithAbort } from "@openclaw/retry";
import { GatewayEventListeners } from "./event-listeners.js";
import { GatewayPendingRequests, type GatewayProtocolRequestTiming } from "./pending-request.js";
import type {
  CloseSnapshot,
  ConnectTimingState,
  GatewayProtocolClientOptions,
  GatewayProtocolCloseContext,
  GatewayProtocolSocket,
  GatewayProtocolTiming,
} from "./protocol-client-contract.js";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestOptions,
} from "./protocol-request.js";
import { clearGatewayConnectTimeout, startGatewayConnectTimeout } from "./timeouts.js";

export {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolRequestTiming,
};

export type {
  GatewayProtocolCloseContext,
  GatewayProtocolSocket,
  GatewayProtocolSocketHandlers,
  GatewayProtocolTiming,
} from "./protocol-client-contract.js";

/**
 * Browser-safe gateway wire client. Environment adapters own transport and auth
 * policy; this class owns the single socket/handshake/reconnect/frame state machine.
 */
export class GatewayProtocolClient<TPlan> {
  private socket: GatewayProtocolSocket | null = null;
  private readonly requests: GatewayPendingRequests;
  private readonly listeners = new GatewayEventListeners<EventFrame>();
  private stopped = true;
  private generation = 0;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectChallengeTs: number | null | undefined;
  private connectSent = false;
  private connectRequestSent = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectSupervisor: RetrySupervisor;
  private reconnectSignal: AbortSignal | null = null;
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
    this.requests = new GatewayPendingRequests({
      createRequestId: opts.createRequestId,
      createRequestError: opts.createRequestError,
      createRequestTimeoutError: opts.createRequestTimeoutError,
      createRequestAbortError: opts.createRequestAbortError,
      requestTimeoutMs: opts.requestTimeoutMs,
      nowMs: () => this.nowMs(),
      onTiming: opts.onRequestTiming,
      onCallbackError: opts.onCallbackError,
    });
  }

  get connected(): boolean {
    return this.socket?.isOpen() ?? false;
  }

  get hasPendingRequests(): boolean {
    return this.requests.hasPending;
  }

  get connecting(): boolean {
    return this.connectSent && !this.helloReceived;
  }

  get hasUnboundedPendingRequests(): boolean {
    return this.requests.hasUnboundedPending;
  }

  start(): void {
    if (this.socket || this.reconnectSignal) {
      return;
    }
    this.stopped = false;
    this.reconnectSupervisor.cancel();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHandshakeTimer();
    this.reconnectSignal = null;
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
    this.requests.flush(new Error("gateway client stopped"));
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
    return this.requests.request<T>(socket, method, params, options);
  }

  addEventListener(listener: (event: EventFrame) => void): () => void {
    return this.listeners.add(listener);
  }

  closeSocket(code?: number, reason?: string): void {
    this.socket?.close(code, reason);
  }

  resetReconnectBackoff(initialMs: number): void {
    this.reconnectSignal = null;
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
    this.lastSeq = null; // Outer event sequences belong to one WebSocket generation.
    this.connectNonce = null;
    this.connectChallengeTs = undefined;
    this.connectSent = this.connectRequestSent = false;
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
        if (this.generation > 0 && !this.stopped && !this.socket && !this.reconnectSignal) {
          this.opts.onReconnectStopped?.(normalized);
        }
        throw normalized;
      }
      // Callbacks can stop or restart synchronously; never schedule over their replacement socket.
      if (
        this.opts.shouldRetrySocketFactoryError?.(normalized) &&
        !this.stopped &&
        !this.socket &&
        !this.reconnectSignal
      ) {
        this.scheduleReconnect();
      } else if (this.generation > 0 && !this.stopped && !this.socket && !this.reconnectSignal) {
        this.opts.onReconnectStopped?.(normalized);
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
    // The challenge timer ends before asynchronous device preparation. Keep
    // the same socket supervised until hello so a silent peer cannot strand it.
    this.handshakeTimer = startGatewayConnectTimeout(() => {
      if (this.isActive(socket, generation) && !this.helloReceived) {
        socket.close(4000, "connect timeout");
      }
    });
    let planOrPromise: TPlan | Promise<TPlan>;
    try {
      planOrPromise = this.opts.buildConnectPlan({
        nonce: this.connectNonce,
        challengeTs: this.connectChallengeTs,
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
    const context = {
      generation,
      nonce: this.connectNonce,
      challengeTs: this.connectChallengeTs,
      plan,
    };
    this.recordTiming("connect-plan-ready", generation, plan);
    this.recordTiming("request-sent", generation, plan);
    this.connectRequestSent = true;
    void this.request<HelloOk>("connect", this.opts.buildConnectParams(plan))
      .then((hello) => {
        if (!this.isActive(socket, generation)) {
          return;
        }
        this.helloReceived = true;
        this.clearHandshakeTimer();
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
        const payload = parsed.payload as { nonce?: unknown; ts?: unknown } | undefined;
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
        const challengeTs = payload?.ts;
        this.connectChallengeTs =
          typeof challengeTs === "number" && Number.isSafeInteger(challengeTs) && challengeTs >= 0
            ? challengeTs
            : null;
        this.recordTiming("challenge", generation);
        this.sendConnect(socket, generation);
        return;
      }
      const seq = typeof parsed.seq === "number" ? parsed.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          const expected = this.lastSeq + 1;
          this.invoke("gap", () => this.opts.onGap?.({ expected, received: seq }));
          // Gap recovery can retire this socket synchronously. Never advance a
          // replacement's sequence or dispatch a frame from the retired owner.
          if (!this.isActive(socket, generation)) {
            return;
          }
        }
        this.lastSeq = seq;
      }
      // An owner may replace the socket while handling this frame. Snapshot
      // first so replacement listeners cannot inherit a retired event.
      const listeners = this.listeners.snapshot();
      this.invoke("event", () => this.opts.onEvent?.(parsed));
      for (const [listener, subscription] of listeners) {
        if (!this.isActive(socket, generation)) {
          return;
        }
        if (this.listeners.isCurrent(listener, subscription)) {
          this.invoke("event listener", () => listener(parsed));
        }
      }
      return;
    }
    if (!isGatewayResponseFrame(parsed)) {
      return;
    }
    this.opts.onActivity?.();
    this.requests.handleResponse(parsed);
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
    this.requests.flush(
      decision.pendingError ??
        context.connectFailure?.error ??
        new Error(`gateway closed (${code}): ${reason}`),
    );
    this.invoke("close", () => this.opts.onClose?.(context, decision));
    // A close callback can reconnect synchronously and already own the next socket or retry.
    if (decision.retry && !this.stopped && !this.socket && !this.reconnectSignal) {
      this.scheduleReconnect(decision.reconnectDelayMs ?? context.connectFailure?.reconnectDelayMs);
    }
  }

  private handleSocketError(socket: GatewayProtocolSocket, generation: number, error: Error): void {
    if (!this.isActive(socket, generation) || this.connectSent) {
      return;
    }
    this.connectFailure = { error };
    this.opts.onConnectError?.(error);
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
    this.reconnectSignal = retry.signal;
    // Ignore cancelled sleeps only; reconnect start failures stay observable.
    void sleepWithAbort(retry.delayMs, retry.signal).then(
      () => {
        if (this.reconnectSignal !== retry.signal) {
          return;
        }
        this.reconnectSignal = null;
        // Explicit start retains synchronous policy errors; background retries cannot reject orphaned.
        this.invoke("reconnect", () => this.connect());
      },
      () => {
        if (this.reconnectSignal === retry.signal) {
          this.reconnectSignal = null;
        }
      },
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
    this.handshakeTimer = clearGatewayConnectTimeout(this.handshakeTimer);
  }

  private invoke(label: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.opts.onCallbackError?.(label, error);
    }
  }
}
