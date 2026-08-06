import { randomUUID } from "node:crypto";
import {
  context,
  createContextKey,
  diag,
  metrics,
  propagation,
  ROOT_CONTEXT,
  trace,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  type Tracer,
  type TracerOptions,
  type TracerProvider as ApiTracerProvider,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  getBooleanFromEnv,
  getStringListFromEnv,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { B3InjectEncoding, B3Propagator } from "@opentelemetry/propagator-b3";
import { JaegerPropagator } from "@opentelemetry/propagator-jaeger";
import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  serviceInstanceIdDetector,
  type Resource,
  type ResourceDetector,
} from "@opentelemetry/resources";
import { MeterProvider, type IMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  type Sampler,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const DEFAULT_PROPAGATORS = ["tracecontext", "baggage"];
const CONTEXT_OWNER_KEY = createContextKey("openclaw.diagnostics-otel.context-owner");
const PROPAGATOR_OWNER_KEY = createContextKey("openclaw.diagnostics-otel.propagator-owner");
const TRACE_OWNER_SCOPE = "openclaw.diagnostics-otel.lifecycle";
const RESOURCE_DETECTORS = new Map<string, ResourceDetector>([
  ["host", hostDetector],
  ["os", osDetector],
  ["serviceinstance", serviceInstanceIdDetector],
  ["process", processDetector],
  ["env", envDetector],
]);

class OwnedContextManager extends AsyncLocalStorageContextManager {
  constructor(private readonly owner: object) {
    super();
  }

  override active(): Context {
    return super.active().setValue(CONTEXT_OWNER_KEY, this.owner);
  }
}

class OwnedPropagator implements TextMapPropagator {
  constructor(
    private readonly delegate: TextMapPropagator,
    private readonly owner: object,
  ) {}

  inject(carrierContext: Context, carrier: unknown, setter: TextMapSetter): void {
    const probe = carrierContext.getValue(PROPAGATOR_OWNER_KEY);
    if (probe && typeof probe === "object") {
      (probe as { owner?: object }).owner = this.owner;
      return;
    }
    this.delegate.inject(carrierContext, carrier, setter);
  }

  extract(carrierContext: Context, carrier: unknown, getter: TextMapGetter): Context {
    return this.delegate.extract(carrierContext, carrier, getter);
  }

  fields(): string[] {
    return this.delegate.fields();
  }
}

function ownsGlobalPropagator(owner: object): boolean {
  const probe: { owner?: object } = {};
  propagation.inject(ROOT_CONTEXT.setValue(PROPAGATOR_OWNER_KEY, probe), {}, { set() {} });
  return probe.owner === owner;
}

class OwnedTracerProvider implements ApiTracerProvider {
  private readonly ownerId = randomUUID();
  private readonly ownerTracer: Tracer;

  constructor(readonly delegate: BasicTracerProvider) {
    this.ownerTracer = delegate.getTracer(TRACE_OWNER_SCOPE, this.ownerId);
  }

  getTracer(name: string, version?: string, options?: TracerOptions): Tracer {
    if (name === TRACE_OWNER_SCOPE && version === this.ownerId) {
      return this.ownerTracer;
    }
    return this.delegate.getTracer(name, version, options);
  }

  ownsGlobal(): boolean {
    return trace.getTracer(TRACE_OWNER_SCOPE, this.ownerId) === this.ownerTracer;
  }
}

function createConfiguredPropagator(): TextMapPropagator | null {
  const names = (getStringListFromEnv("OTEL_PROPAGATORS") ?? DEFAULT_PROPAGATORS).map((name) =>
    name.toLowerCase(),
  );
  if (names.includes("none")) {
    return null;
  }
  const propagators = [...new Set(names)].flatMap((name): TextMapPropagator[] => {
    switch (name) {
      case "tracecontext":
        return [new W3CTraceContextPropagator()];
      case "baggage":
        return [new W3CBaggagePropagator()];
      case "b3":
        return [new B3Propagator()];
      case "b3multi":
        return [new B3Propagator({ injectEncoding: B3InjectEncoding.MULTI_HEADER })];
      case "jaeger":
        diag.warn(
          'The Jaeger propagator is deprecated and will be removed in a future release. Use the W3C TraceContext propagator ("tracecontext") instead.',
        );
        return [new JaegerPropagator()];
      default:
        diag.warn(`Propagator "${name}" requested through environment variable is unavailable.`);
        return [];
    }
  });
  if (propagators.length === 0) {
    return null;
  }
  return propagators.length === 1 ? propagators[0]! : new CompositePropagator({ propagators });
}

function configuredResourceDetectors(): ResourceDetector[] {
  const names = getStringListFromEnv("OTEL_NODE_RESOURCE_DETECTORS");
  if (!names || names.includes("all")) {
    return [...RESOURCE_DETECTORS.values()];
  }
  if (names.includes("none")) {
    return [];
  }
  return names.flatMap((name) => {
    const detector = RESOURCE_DETECTORS.get(name);
    if (!detector) {
      diag.warn(
        `Invalid resource detector "${name}" specified in the environment variable OTEL_NODE_RESOURCE_DETECTORS`,
      );
    }
    return detector ? [detector] : [];
  });
}

export type OpenClawOtelSdkOptions = {
  metricReaders?: IMetricReader[];
  resource?: Resource;
  sampler?: Sampler;
  spanProcessors?: SpanProcessor[];
};

export class OpenClawOtelSdk {
  private readonly owner = {};
  private contextManager: OwnedContextManager | null = null;
  private meterProvider: MeterProvider | null = null;
  private ownsContext = false;
  private ownsMetrics = false;
  private ownsPropagation = false;
  private ownsTrace = false;
  private tracerProvider: OwnedTracerProvider | null = null;

  constructor(private readonly options: OpenClawOtelSdkOptions = {}) {}

  start(): void {
    const contextManager = new OwnedContextManager(this.owner).enable();
    this.contextManager = contextManager;
    this.ownsContext = context.setGlobalContextManager(contextManager);
    if (!this.ownsContext) {
      contextManager.disable();
    }

    const propagator = createConfiguredPropagator();
    this.ownsPropagation = propagator
      ? propagation.setGlobalPropagator(new OwnedPropagator(propagator, this.owner))
      : false;

    const metricReaders = this.options.metricReaders ?? [];
    const spanProcessors = this.options.spanProcessors ?? [];
    if (metricReaders.length === 0 && spanProcessors.length === 0) {
      return;
    }
    const resource = (this.options.resource ?? defaultResource()).merge(
      detectResources({ detectors: configuredResourceDetectors() }),
    );
    const sdkMetricsEnabled = getBooleanFromEnv("OTEL_NODE_EXPERIMENTAL_SDK_METRICS");
    if (metricReaders.length > 0) {
      const meterProvider = new MeterProvider({
        readers: metricReaders,
        resource,
        sdkMetricsEnabled,
      });
      this.meterProvider = meterProvider;
      this.ownsMetrics = metrics.setGlobalMeterProvider(meterProvider);
      if (!this.ownsMetrics) {
        throw new Error("diagnostics-otel could not register its global meter provider");
      }
    }
    if (spanProcessors.length > 0) {
      const tracerProvider = new OwnedTracerProvider(
        new BasicTracerProvider({
          resource,
          sampler: this.options.sampler,
          spanProcessors,
          ...(sdkMetricsEnabled && this.meterProvider ? { meterProvider: this.meterProvider } : {}),
        }),
      );
      this.tracerProvider = tracerProvider;
      this.ownsTrace = trace.setGlobalTracerProvider(tracerProvider);
      if (!this.ownsTrace) {
        throw new Error("diagnostics-otel could not register its global tracer provider");
      }
    }
  }

  unregisterSignalGlobals(): void {
    if (this.ownsTrace && this.tracerProvider?.ownsGlobal()) {
      trace.disable();
    }
    if (this.ownsMetrics && metrics.getMeterProvider() === this.meterProvider) {
      metrics.disable();
    }
    this.ownsTrace = false;
    this.ownsMetrics = false;
  }

  async shutdown(): Promise<void> {
    const results = await Promise.allSettled([
      this.tracerProvider?.delegate.shutdown(),
      this.meterProvider?.shutdown(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "diagnostics-otel providers failed to shut down");
    }
  }

  unregisterContextGlobals(): void {
    // Propagation and context stay active while providers flush suppressed telemetry.
    if (this.ownsPropagation && ownsGlobalPropagator(this.owner)) {
      propagation.disable();
    }
    if (this.ownsContext && context.active().getValue(CONTEXT_OWNER_KEY) === this.owner) {
      context.disable();
    } else if (this.ownsContext) {
      this.contextManager?.disable();
    }
    this.ownsPropagation = false;
    this.ownsContext = false;
  }
}
