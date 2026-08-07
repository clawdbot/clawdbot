type TrustedToolExecutionContext = {
  lifecycleGeneration: string;
  contextLifecycleToken?: object;
};

const executionContextByEvent = new WeakMap<object, TrustedToolExecutionContext>();

export function captureTrustedToolExecutionContext(
  event: object,
  lifecycleGeneration: string,
  contextLifecycleToken?: object,
): void {
  executionContextByEvent.set(event, {
    lifecycleGeneration,
    ...(contextLifecycleToken ? { contextLifecycleToken } : {}),
  });
}

export function getTrustedToolExecutionLifecycleGeneration(event: object): string | undefined {
  return executionContextByEvent.get(event)?.lifecycleGeneration;
}

export function getTrustedToolExecutionContextLifecycleToken(event: object): object | undefined {
  return executionContextByEvent.get(event)?.contextLifecycleToken;
}
