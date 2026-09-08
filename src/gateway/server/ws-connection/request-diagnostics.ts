import { performance } from "node:perf_hooks";
import { hasInternalDiagnosticEventInterest } from "../../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
} from "../../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { isCoreGatewayMethodClassified } from "../../methods/core-descriptors.js";
import type { GatewayMethodRegistry } from "../../methods/registry.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";

type RpcEvent = Extract<DiagnosticEventInput, { type: "gateway.rpc" }>;
type ResponseOutcome = Extract<RpcEvent, { phase: "response" }>["outcome"];
type DispatchOutcome = Extract<RpcEvent, { phase: "dispatch" }>["outcome"];

class GatewayRpcDiagnostics {
  private readonly startedAt = performance.now();
  private trace = getActiveDiagnosticTraceContext();
  private queueStartedAt?: number;
  private queueWaitMs?: number;
  private handlerStarted = false;
  private deliveryFailureRecorded = false;
  private dispatchFinished = false;
  private responseState: Extract<RpcEvent, { phase: "dispatch" }>["response"] = "none";

  constructor(private readonly method: string) {
    this.emit({ type: "gateway.rpc", method, phase: "received" });
  }

  private emit(event: RpcEvent): void {
    // A retained response can run under another request; preserve captured absence too.
    runWithDiagnosticTraceContext(this.trace, () => emitTrustedDiagnosticEvent(event));
  }

  bindTrace(trace = getActiveDiagnosticTraceContext()): void {
    this.trace = trace;
  }

  startQueue(): void {
    this.queueStartedAt = performance.now();
  }

  finishQueue(): void {
    if (this.queueStartedAt !== undefined) {
      this.queueWaitMs = performance.now() - this.queueStartedAt;
    }
  }

  response(outcome: ResponseOutcome): void {
    const sent = outcome === "ok" || outcome === "error";
    if (sent ? this.responseState === "sent" : this.deliveryFailureRecorded) {
      return;
    }
    if (sent) {
      this.responseState = "sent";
    } else {
      this.deliveryFailureRecorded = true;
      if (this.responseState !== "sent") {
        this.responseState = outcome;
      }
    }
    // Acceptance and final frames can share one request and outlive its handler.
    // Retain only the first successful send and first delivery failure separately.
    this.emit({
      type: "gateway.rpc",
      method: this.method,
      phase: "response",
      outcome,
      durationMs: performance.now() - this.startedAt,
    });
  }

  async runHandler(invoke: () => Promise<void> | void): Promise<void> {
    const startedAt = performance.now();
    this.handlerStarted = true;
    let outcome: "returned" | "threw" = "returned";
    try {
      await invoke();
    } catch (error) {
      outcome = "threw";
      throw error;
    } finally {
      this.emit({
        type: "gateway.rpc",
        method: this.method,
        phase: "handler",
        outcome,
        durationMs: performance.now() - startedAt,
        admissionMs: startedAt - this.startedAt,
      });
    }
  }

  finish(outcome: DispatchOutcome): void {
    if (this.dispatchFinished) {
      return;
    }
    this.dispatchFinished = true;
    this.emit({
      type: "gateway.rpc",
      method: this.method,
      phase: "dispatch",
      outcome: outcome === "returned" && !this.handlerStarted ? "rejected" : outcome,
      durationMs: performance.now() - this.startedAt,
      ...(this.queueWaitMs !== undefined ? { queueWaitMs: this.queueWaitMs } : {}),
      response: this.responseState,
    });
  }
}

export type { GatewayRpcDiagnostics };

export function createGatewayRpcDiagnostics(
  method: string,
  getMethodRegistry: (() => GatewayMethodRegistry) | undefined,
  extraHandlers: GatewayRequestHandlers,
): GatewayRpcDiagnostics | undefined {
  if (!areDiagnosticsEnabledForProcess() || !hasInternalDiagnosticEventInterest("gateway.rpc")) {
    return undefined;
  }
  // Only process-stable core names become dimensions. Plugin/unknown names may
  // contain arbitrary caller data and must not create new metric series.
  const label = isCoreGatewayMethodClassified(method)
    ? method
    : getMethodRegistry?.().getHandler(method) || Object.hasOwn(extraHandlers, method)
      ? "other"
      : "unknown";
  return new GatewayRpcDiagnostics(label);
}
