import "./session-lifecycle-admission.js";

type RunExclusiveSessionLifecycleParams<T> = {
  scope: string;
  identities: Iterable<string | undefined>;
  signal?: AbortSignal;
  run: () => Promise<T>;
};

type SessionLifecycleAdmissionTestApi = {
  runExclusiveSessionLifecycle<T>(params: RunExclusiveSessionLifecycleParams<T>): Promise<T>;
};

function getTestApi(): SessionLifecycleAdmissionTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionLifecycleAdmissionTestApi")
  ] as SessionLifecycleAdmissionTestApi;
}

export async function runExclusiveSessionLifecycle<T>(
  params: RunExclusiveSessionLifecycleParams<T>,
): Promise<T> {
  return await getTestApi().runExclusiveSessionLifecycle(params);
}
