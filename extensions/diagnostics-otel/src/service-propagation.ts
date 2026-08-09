import {
  context,
  createContextKey,
  propagation,
  ROOT_CONTEXT,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  getStringListFromEnv,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { B3InjectEncoding, B3Propagator } from "@opentelemetry/propagator-b3";
import { JaegerPropagator } from "@opentelemetry/propagator-jaeger";

const DEFAULT_PROPAGATORS = ["tracecontext", "baggage"];
const CONTEXT_OWNER_KEY = createContextKey("openclaw.owned-sdk.context-owner");
const PROPAGATOR_OWNER_KEY = createContextKey("openclaw.owned-sdk.propagator-owner");

class OwnedContextManager extends AsyncLocalStorageContextManager {
  constructor(private readonly owner: object) {
    super();
  }

  override with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const probe = activeContext.getValue(CONTEXT_OWNER_KEY);
    if (probe && typeof probe === "object") {
      (probe as { owner?: object }).owner = this.owner;
    }
    return super.with(activeContext, fn, thisArg, ...args);
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

function ownsGlobalContextManager(owner: object): boolean {
  const probe: { owner?: object } = {};
  context.with(ROOT_CONTEXT.setValue(CONTEXT_OWNER_KEY, probe), () => {});
  return probe.owner === owner;
}

function createConfiguredPropagator(warn: (message: string) => void): TextMapPropagator | null {
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
        warn(
          'The Jaeger propagator is deprecated and will be removed in a future release. Use the W3C TraceContext propagator ("tracecontext") instead.',
        );
        return [new JaegerPropagator()];
      default:
        warn(`Propagator "${name}" requested through environment variable is unavailable.`);
        return [];
    }
  });
  if (propagators.length === 0) {
    return null;
  }
  return propagators.length === 1 ? propagators[0]! : new CompositePropagator({ propagators });
}

export function registerOwnedSdkRuntime(warn: (message: string) => void): (() => void) | null {
  const owner = {};
  const contextManager = new OwnedContextManager(owner).enable();
  const ownsContext = context.setGlobalContextManager(contextManager);
  if (!ownsContext) {
    contextManager.disable();
  }
  const propagator = createConfiguredPropagator(warn);
  const ownsPropagation = propagator
    ? propagation.setGlobalPropagator(new OwnedPropagator(propagator, owner))
    : false;
  if (!ownsContext && !ownsPropagation) {
    return null;
  }
  // Ownership can change after registration. Probe the current public API
  // delegate before removing a global so a later host SDK remains intact.
  return () => {
    if (ownsPropagation && ownsGlobalPropagator(owner)) {
      propagation.disable();
    }
    if (ownsContext && ownsGlobalContextManager(owner)) {
      context.disable();
    } else if (ownsContext) {
      contextManager.disable();
    }
  };
}
