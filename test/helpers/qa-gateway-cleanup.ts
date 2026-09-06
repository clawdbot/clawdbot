// Fixture cleanup must retain the synchronous owner even when startup rejects.
// Surface diagnostic errors without interpreting them as process liveness.
type StopOptions = { keepTemp?: boolean; preserveToDir?: string };

export async function runQaGatewayFixture<T>(
  body: () => Promise<T>,
  ...cleanups: Array<() => unknown>
): Promise<T> {
  const errors: unknown[] = [];
  const bodyResult = (async () => body())();
  // Keep cleanup phases ordered, but never let one failure skip later owners
  // or replace the startup/body error. Callers may settle a phase in parallel.
  for (const phase of [() => bodyResult, ...cleanups]) {
    try {
      await phase();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1 && errors[0] instanceof Error) {
    throw errors[0];
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "QA gateway fixture failed");
  }
  return bodyResult;
}

export async function stopQaGatewayFixture(
  owner: {
    stop(options?: StopOptions): Promise<{ errors: unknown[] }>;
  },
  options?: StopOptions,
): Promise<void> {
  const { errors } = await owner.stop(options);
  if (errors.length) {
    throw new AggregateError(errors, "QA gateway fixture cleanup failed");
  }
}
