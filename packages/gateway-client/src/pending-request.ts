import type { ErrorShape, ResponseFrame } from "@openclaw/gateway-protocol";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestOptions,
} from "./protocol-request.js";
import { resolveSafeTimeoutDelayMs } from "./timeouts.js";

export type GatewayProtocolRequestTiming = {
  id: string;
  method: string;
  ok: boolean;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  errorCode?: string;
};

type GatewayRequestSender = {
  send: (data: string) => void;
};

type GatewayPendingRequest = {
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

type GatewayPendingRequestsOptions = {
  createRequestId: () => string;
  createRequestError?: (error: Partial<ErrorShape>) => GatewayProtocolRequestError;
  createRequestTimeoutError?: (method: string, timeoutMs: number, requestSent: boolean) => Error;
  createRequestAbortError?: (method: string) => Error;
  requestTimeoutMs?: number;
  nowMs: () => number;
  onTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onCallbackError?: (label: string, error: unknown) => void;
};

/** Owns request deadlines, correlation, settlement, and generation-scoped IDs. */
export class GatewayPendingRequests {
  private readonly pending = new Map<string, GatewayPendingRequest>();
  private requestSequence = 0;

  constructor(private readonly opts: GatewayPendingRequestsOptions) {}

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  get hasUnboundedPending(): boolean {
    return [...this.pending.values()].some((pending) => pending.unbounded);
  }

  request<T>(
    sender: GatewayRequestSender,
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    let id: string;
    try {
      id = this.allocateRequestId();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const requestedTimeoutMs =
      options?.timeoutMs === null ? undefined : (options?.timeoutMs ?? this.opts.requestTimeoutMs);
    const timeoutMs =
      typeof requestedTimeoutMs === "number" && Number.isFinite(requestedTimeoutMs)
        ? resolveSafeTimeoutDelayMs(requestedTimeoutMs, { minMs: 0 })
        : undefined;
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let requestSent = false;
      const pending: GatewayPendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: options?.expectFinal === true,
        acceptedNotified: false,
        onAccepted: options?.onAccepted,
        unbounded: timeoutMs === undefined,
        method,
        startedAtMs: this.opts.nowMs(),
      };
      const cleanup = () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        options?.signal?.removeEventListener("abort", onAbort);
      };
      const retire = (errorCode: string): boolean => {
        if (this.pending.get(id) !== pending) {
          return false;
        }
        this.pending.delete(id);
        cleanup();
        this.finishTiming(id, pending, false, errorCode);
        return true;
      };
      const onAbort = () => {
        if (!retire("CLIENT_ABORTED")) {
          return;
        }
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
      };
      if (options?.signal?.aborted) {
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
        return;
      }
      pending.cleanup = cleanup;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (!retire("CLIENT_TIMEOUT")) {
            return;
          }
          reject(
            this.opts.createRequestTimeoutError?.(method, timeoutMs, requestSent) ??
              new GatewayProtocolRequestTimeoutError({ method, timeoutMs, requestSent }),
          );
        }, timeoutMs);
        timeout.unref?.();
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      try {
        sender.send(JSON.stringify({ type: "req", id, method, params }));
        if (this.pending.get(id) !== pending) {
          return;
        }
        requestSent = true;
        this.invoke("sent", () => options?.onSent?.());
      } catch (error) {
        if (retire("CLIENT_SEND_ERROR")) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  handleResponse(frame: ResponseFrame): void {
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
      this.finishTiming(frame.id, pending, true);
      pending.resolve(frame.payload);
      return;
    }
    this.finishTiming(frame.id, pending, false, frame.error?.code);
    pending.reject(
      this.opts.createRequestError?.(frame.error ?? {}) ??
        new GatewayProtocolRequestError(frame.error ?? {}),
    );
  }

  flush(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.finishTiming(id, pending, false, "CLIENT_CLOSED");
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
    // Request sequences belong to one socket generation. Retired socket frames
    // are fenced by GatewayProtocolClient before the sequence restarts.
    this.requestSequence = 0;
  }

  private allocateRequestId(): string {
    this.requestSequence += 1;
    return `${this.requestSequence}:${this.opts.createRequestId()}`;
  }

  private finishTiming(
    id: string,
    pending: GatewayPendingRequest,
    ok: boolean,
    errorCode?: string,
  ): void {
    const endedAtMs = this.opts.nowMs();
    try {
      const onTiming = this.opts.onTiming;
      if (onTiming === undefined || onTiming === null) {
        return;
      }
      Reflect.apply(onTiming, this.opts, [
        {
          id,
          method: pending.method,
          ok,
          durationMs: Math.max(0, endedAtMs - pending.startedAtMs),
          startedAtMs: pending.startedAtMs,
          endedAtMs,
          errorCode,
        },
      ]);
    } catch (error) {
      this.opts.onCallbackError?.("request timing", error);
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
