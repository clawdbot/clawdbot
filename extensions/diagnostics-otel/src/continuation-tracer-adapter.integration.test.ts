import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";
import { createContinuationOtelTracerAdapter } from "./continuation-tracer-adapter.js";

const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");

function registeredContextManager() {
  return (
    globalThis as unknown as Record<
      symbol,
      { context?: Parameters<typeof context.setGlobalContextManager>[0] } | undefined
    >
  )[OTEL_GLOBAL_API_KEY]?.context;
}

test("parents owned-provider spans from active and carried trace context", async () => {
  const originalContextManager = registeredContextManager();
  context.disable();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  expect(context.setGlobalContextManager(contextManager)).toBe(true);

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  try {
    const parent = provider.getTracer("test.parent").startSpan("parent");
    const parentContext = parent.spanContext();
    const continuationTracer = createContinuationOtelTracerAdapter({
      tracerProvider: provider,
    });

    context.with(trace.setSpan(context.active(), parent), () => {
      const activeChild = continuationTracer.startSpan("continuation.work");
      activeChild.end();
    });
    const carriedChild = continuationTracer.startSpan("continuation.work.fire", {
      traceparent: `00-${parentContext.traceId}-${parentContext.spanId}-01`,
    });
    carriedChild.end();
    parent.end();
    await provider.forceFlush();

    for (const name of ["continuation.work", "continuation.work.fire"]) {
      const child = exporter.getFinishedSpans().find((span) => span.name === name);
      expect(child?.spanContext().traceId).toBe(parentContext.traceId);
      expect(child?.parentSpanContext?.traceId).toBe(parentContext.traceId);
      expect(child?.parentSpanContext?.spanId).toBe(parentContext.spanId);
    }
  } finally {
    await provider.shutdown();
    if (registeredContextManager() !== originalContextManager) {
      context.disable();
      if (originalContextManager) {
        context.setGlobalContextManager(originalContextManager);
      }
    }
  }
});

// Simulates a full continue_delegate round trip against a real SDK: the
// originating tool span dispatches, the dispatch traceparent is serialized
// across the hop, and the far side re-enters from that string alone. The
// trusted-span registry is forced to resolve nothing because it is
// process-local and capacity-evicted, so it cannot be what keeps a delegate
// stitched. Regression guard for orphaned continuation spans.
test("keeps one trace across a continue_delegate out-and-back hop", async () => {
  const originalContextManager = registeredContextManager();
  context.disable();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  expect(context.setGlobalContextManager(contextManager)).toBe(true);

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  try {
    const continuationTracer = createContinuationOtelTracerAdapter({
      tracerProvider: provider,
      resolveSpanContext: () => undefined,
    });

    // Leaving: the continue_delegate tool call is the active span.
    const toolSpan = provider.getTracer("test.delegate").startSpan("continue_delegate.tool");
    const toolContext = toolSpan.spanContext();

    const carried = context.with(trace.setSpan(context.active(), toolSpan), () => {
      const dispatch = continuationTracer.startSpan("continuation.delegate.dispatch");
      const dispatchTraceparent = dispatch.traceparent?.();
      dispatch.end();
      return dispatchTraceparent;
    });
    toolSpan.end();

    expect(carried).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(carried).toContain(toolContext.traceId);

    // Coming back: only the serialized traceparent survived the hop, and the
    // originating span is already ended and out of the active context.
    expect(carried).toBeDefined();
    const fire = continuationTracer.startSpan("continuation.delegate.fire", {
      traceparent: carried,
    });
    fire.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const dispatchSpan = spans.find((span) => span.name === "continuation.delegate.dispatch");
    const fireSpan = spans.find((span) => span.name === "continuation.delegate.fire");

    // One trace end to end.
    expect(dispatchSpan?.spanContext().traceId).toBe(toolContext.traceId);
    expect(fireSpan?.spanContext().traceId).toBe(toolContext.traceId);
    // Dispatch hangs off the originating tool span, and the far side hangs off
    // dispatch rather than starting a new root.
    expect(dispatchSpan?.parentSpanContext?.spanId).toBe(toolContext.spanId);
    expect(fireSpan?.parentSpanContext?.spanId).toBe(dispatchSpan?.spanContext().spanId);
  } finally {
    await provider.shutdown();
    if (registeredContextManager() !== originalContextManager) {
      context.disable();
      if (originalContextManager) {
        context.setGlobalContextManager(originalContextManager);
      }
    }
  }
});
