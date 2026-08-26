import { NODE_INVOKE_PAIRING_CHANGED_ABORT } from "./node-registry-private-token.js";

export type PendingSystemRunEvent = {
  runId: string;
  sessionKey?: string;
  timeoutMs?: number | null;
};

export type PendingInvoke = {
  nodeId: string;
  connId: string;
  command: string;
  systemRunEvent?: PendingSystemRunEvent;
  resolve: (value: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  }) => void;
  reject: (err: Error) => void;
  deadlineAtMs?: number;
  hardTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleTimeoutMs?: number;
  onProgress?: (chunk: string) => void;
  nextProgressSeq: number;
  progressChunks: Map<number, string>;
  nextInputSeq: number;
  removeAbortListener?: () => void;
};

export type NodeInvokeProgressParams = {
  invokeId: string;
  nodeId: string;
  connId: string | undefined;
  seq: number;
  chunk: string;
};

export type NodeInvokeResultParams = {
  id: string;
  nodeId: string;
  connId: string | undefined;
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

const MAX_PENDING_PROGRESS_CHUNKS = 128;
const MAX_INVOKE_INPUT_BYTES = 16 * 1024;

export class NodeInvokeStreamController {
  constructor(
    private readonly options: {
      pendingInvokes: Map<string, PendingInvoke>;
      sendCancel: (requestId: string, pending: PendingInvoke) => void;
      isConnectionActive: (pending: PendingInvoke) => boolean;
      sendInput: (
        invokeId: string,
        pending: PendingInvoke,
        seq: number,
        payloadJSON: string,
      ) => boolean;
      onFailedResult: (pending: PendingInvoke) => void;
      // Settles a pending invoke on transport loss. The registry's callback
      // preserves MCP's structured-failure contract (resolve, not reject) so
      // MCP callers can degrade instead of seeing an opaque invoke error.
      disconnectPending: (pending: PendingInvoke) => void;
    },
  ) {}

  sendInput(invokeId: string, payload: unknown): void {
    const pending = this.options.pendingInvokes.get(invokeId);
    if (!pending) {
      throw new Error("node invoke is not pending");
    }
    const payloadJSON = JSON.stringify(payload);
    if (payloadJSON === undefined) {
      throw new Error("node invoke input is not serializable");
    }
    if (Buffer.byteLength(payloadJSON, "utf8") > MAX_INVOKE_INPUT_BYTES) {
      throw new Error("node invoke input exceeds 16 KiB");
    }
    if (this.settleIfExpired(invokeId, pending)) {
      throw new Error("node invoke is not pending");
    }
    if (!this.options.isConnectionActive(pending)) {
      throw new Error("node invoke connection or pairing generation is unavailable");
    }
    if (!this.options.sendInput(invokeId, pending, pending.nextInputSeq, payloadJSON)) {
      throw new Error("failed to send node invoke input");
    }
    pending.nextInputSeq += 1;
  }

  handleDisconnect(connId: string): void {
    for (const [id, pending] of this.options.pendingInvokes) {
      if (pending.connId !== connId) {
        continue;
      }
      if (this.settleIfExpired(id, pending)) {
        continue;
      }
      if (!this.takePending(id, pending)) {
        continue;
      }
      this.options.disconnectPending(pending);
    }
  }

  handleResult(params: NodeInvokeResultParams): boolean {
    const pending = this.options.pendingInvokes.get(params.id);
    if (
      !pending ||
      pending.nodeId !== params.nodeId ||
      pending.connId !== params.connId ||
      !this.options.isConnectionActive(pending)
    ) {
      return false;
    }
    if (this.settleIfExpired(params.id, pending)) {
      return false;
    }
    if (!this.takePending(params.id, pending)) {
      return false;
    }
    if (!params.ok) {
      this.options.onFailedResult(pending);
    }
    pending.resolve({
      ok: params.ok,
      payload: params.payload,
      payloadJSON: params.payloadJSON ?? null,
      error: params.error ?? null,
    });
    return true;
  }

  armPending(params: {
    requestId: string;
    pending: PendingInvoke;
    timeoutMs: number;
    idleTimeoutMs: number;
    signal?: AbortSignal;
  }): void {
    if (params.timeoutMs > 0) {
      params.pending.deadlineAtMs = Date.now() + params.timeoutMs;
    }
    this.options.pendingInvokes.set(params.requestId, params.pending);
    if (params.timeoutMs > 0) {
      params.pending.hardTimer = setTimeout(() => {
        this.settleTimeout(params.requestId, params.pending);
      }, params.timeoutMs);
    }
    if (params.pending.onProgress && params.idleTimeoutMs > 0) {
      params.pending.idleTimeoutMs = params.idleTimeoutMs;
    }
    if (params.signal) {
      const onAbort = () => {
        if (this.settleIfExpired(params.requestId, params.pending)) {
          return;
        }
        if (!this.takePending(params.requestId, params.pending)) {
          return;
        }
        this.sendInvokeCancel(params.requestId, params.pending);
        this.options.onFailedResult(params.pending);
        const pairingChanged = params.signal?.reason === NODE_INVOKE_PAIRING_CHANGED_ABORT;
        params.pending.resolve({
          ok: false,
          error: pairingChanged
            ? { code: "PAIRING_CHANGED", message: "node pairing changed after dispatch" }
            : { code: "ABORTED", message: "node invoke cancelled" },
        });
      };
      params.signal.addEventListener("abort", onAbort, { once: true });
      params.pending.removeAbortListener = () =>
        params.signal?.removeEventListener("abort", onAbort);
      if (params.signal.aborted) {
        onAbort();
      }
    }
  }

  handleProgress(params: NodeInvokeProgressParams): boolean {
    const pending = this.options.pendingInvokes.get(params.invokeId);
    if (
      !pending ||
      pending.nodeId !== params.nodeId ||
      pending.connId !== params.connId ||
      !this.options.isConnectionActive(pending) ||
      !pending.onProgress ||
      params.seq < pending.nextProgressSeq
    ) {
      return false;
    }
    if (this.settleIfExpired(params.invokeId, pending)) {
      return false;
    }
    if (params.seq > pending.nextProgressSeq) {
      // Duplicate buffered frames are not progress: resetting idle for them
      // would let a stalled sender extend the deadline forever without ever
      // delivering the missing chunk.
      if (pending.progressChunks.has(params.seq)) {
        return false;
      }
      if (pending.progressChunks.size >= MAX_PENDING_PROGRESS_CHUNKS) {
        return false;
      }
    }
    pending.progressChunks.set(params.seq, params.chunk);
    // The first authenticated frame proves execution, even when it is out of order.
    if (!pending.idleTimer) {
      this.resetIdleTimer(params.invokeId, pending);
    }
    while (true) {
      const chunk = pending.progressChunks.get(pending.nextProgressSeq);
      if (chunk === undefined) {
        break;
      }
      if (this.settleIfExpired(params.invokeId, pending)) {
        break;
      }
      pending.progressChunks.delete(pending.nextProgressSeq);
      pending.nextProgressSeq += 1;
      try {
        pending.onProgress(chunk);
      } catch (error) {
        this.sendInvokeCancel(params.invokeId, pending);
        this.clearTimers(pending);
        this.options.pendingInvokes.delete(params.invokeId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        break;
      }
      // onProgress can settle the invoke (e.g. abort); stop draining buffered
      // chunks once it is terminal so consumers see no output after cancel.
      if (this.options.pendingInvokes.get(params.invokeId) !== pending) {
        pending.progressChunks.clear();
        break;
      }
      if (this.settleIfExpired(params.invokeId, pending)) {
        break;
      }
      this.resetIdleTimer(params.invokeId, pending);
    }
    return true;
  }

  clearTimers(pending: PendingInvoke): void {
    if (pending.hardTimer) {
      clearTimeout(pending.hardTimer);
    }
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
    }
    pending.removeAbortListener?.();
    pending.removeAbortListener = undefined;
  }

  private createIdleTimer(requestId: string, pending: PendingInvoke) {
    return setTimeout(() => {
      if (!this.takePending(requestId, pending)) {
        return;
      }
      this.sendInvokeCancel(requestId, pending);
      pending.resolve({
        ok: false,
        error: { code: "IDLE_TIMEOUT", message: "node invoke produced no progress" },
      });
    }, pending.idleTimeoutMs);
  }

  private resetIdleTimer(requestId: string, pending: PendingInvoke): void {
    if (!pending.idleTimeoutMs) {
      return;
    }
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
    }
    pending.idleTimer = this.createIdleTimer(requestId, pending);
  }

  private sendInvokeCancel(requestId: string, pending: PendingInvoke): void {
    this.options.sendCancel(requestId, pending);
  }

  private settleIfExpired(requestId: string, pending: PendingInvoke): boolean {
    if (pending.deadlineAtMs === undefined || Date.now() < pending.deadlineAtMs) {
      return false;
    }
    this.settleTimeout(requestId, pending);
    return true;
  }

  private settleTimeout(requestId: string, pending: PendingInvoke): void {
    if (!this.takePending(requestId, pending)) {
      return;
    }
    this.sendInvokeCancel(requestId, pending);
    pending.resolve({
      ok: false,
      error: { code: "TIMEOUT", message: "node invoke timed out" },
    });
  }

  private takePending(requestId: string, pending: PendingInvoke): boolean {
    if (this.options.pendingInvokes.get(requestId) !== pending) {
      return false;
    }
    this.options.pendingInvokes.delete(requestId);
    this.clearTimers(pending);
    return true;
  }
}
