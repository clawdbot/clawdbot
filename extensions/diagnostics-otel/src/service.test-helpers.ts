import {
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticTraceContext,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { onTrustedInternalDiagnosticEvent } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import type { OpenClawPluginServiceContext } from "../api.js";
import { createDiagnosticsOtelService } from "./service.js";

const OTEL_TEST_STATE_DIR = "/tmp/openclaw-diagnostics-otel-test";
export const OTEL_TEST_ENDPOINT = "http://otel-collector:4318";
const OTEL_TEST_PROTOCOL = "http/protobuf";
export const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
export const SPAN_ID = "00f067aa0ba902b7";
export const CHILD_SPAN_ID = "1111111111111111";
export const GRANDCHILD_SPAN_ID = "2222222222222222";
export const TOOL_SPAN_ID = "3333333333333333";
export const MODEL_CALL_SPAN_ID = "4444444444444444";
export const MODEL_USAGE_SPAN_ID = "5555555555555555";
export const MODEL_FIXTURE = {
  provider: "openai",
  model: "gpt-5.4",
} as const;
export const RUN_FIXTURE = { runId: "run-1", ...MODEL_FIXTURE } as const;
export const MODEL_CALL_FIXTURE = { ...RUN_FIXTURE, callId: "call-1" } as const;
export const MODEL_CONTENT_CAPTURE = {
  enabled: true,
  inputMessages: true,
  outputMessages: true,
  systemPrompt: true,
  toolDefinitions: true,
} as const;
export const INPUT_ONLY_CAPTURE = {
  enabled: true,
  inputMessages: true,
  outputMessages: false,
} as const;

type OtelConfig = NonNullable<
  NonNullable<OpenClawPluginServiceContext["config"]["diagnostics"]>["otel"]
>;
export type OtelContextFlags = Pick<
  OtelConfig,
  "traces" | "metrics" | "logs" | "protocol" | "logsExporter" | "captureContent"
>;

type StartOtelServiceOptions = OtelContextFlags & {
  endpoint?: string;
  configure?: (ctx: OpenClawPluginServiceContext) => void;
};

type StartedService = {
  service: ReturnType<typeof createDiagnosticsOtelService>;
  ctx: OpenClawPluginServiceContext;
};

const startedServices = new Set<StartedService>();

export function createOtelContext(
  endpoint: string,
  {
    traces = false,
    metrics = false,
    logs = false,
    protocol = OTEL_TEST_PROTOCOL,
    logsExporter,
    captureContent,
  }: OtelContextFlags = {},
): OpenClawPluginServiceContext {
  return {
    config: {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          endpoint,
          protocol,
          traces,
          metrics,
          logs,
          ...(logsExporter !== undefined ? { logsExporter } : {}),
          ...(captureContent !== undefined ? { captureContent } : {}),
        },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    stateDir: OTEL_TEST_STATE_DIR,
    internalDiagnostics: {
      emit: emitTrustedDiagnosticEventWithPrivateData,
      onEvent: onTrustedInternalDiagnosticEvent,
    },
  };
}

export async function startOtelService({
  endpoint = OTEL_TEST_ENDPOINT,
  configure,
  ...flags
}: StartOtelServiceOptions = {}): Promise<StartedService> {
  const service = createDiagnosticsOtelService();
  const ctx = createOtelContext(endpoint, flags);
  configure?.(ctx);
  await service.start(ctx);
  const started = { service, ctx };
  startedServices.add(started);
  return started;
}

export async function stopStartedOtelServices() {
  const services = [...startedServices];
  startedServices.clear();
  await Promise.all(services.map(({ service, ctx }) => Promise.resolve(service.stop?.(ctx))));
}

export function createTestTrace(spanId: string, parentSpanId?: string): DiagnosticTraceContext {
  return {
    traceId: TRACE_ID,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    traceFlags: "01",
  };
}
