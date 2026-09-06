import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { DiagnosticTraceContext } from "openclaw/plugin-sdk/diagnostic-runtime";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../../../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";

export function runModelCallAndCaptureTraceparent(params: {
  trace: DiagnosticTraceContext;
  runId: string;
  callId: string;
  provider: string;
  model: string;
}): string | undefined {
  let outboundTraceparent: string | undefined;
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
    ((
      _model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => {
      outboundTraceparent = options?.headers?.traceparent;
      return undefined as never;
    }) as StreamFn,
    {
      runId: params.runId,
      provider: params.provider,
      model: params.model,
      trace: params.trace,
      nextCallId: () => params.callId,
      suppressPluginHooks: true,
    },
  );
  void wrapped({} as never, {} as never);
  return outboundTraceparent;
}
