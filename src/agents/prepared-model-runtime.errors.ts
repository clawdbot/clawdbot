export class PreparedModelRuntimeOwnerNotPublishedError extends Error {}

export class PreparedModelRuntimePublicationSupersededError extends PreparedModelRuntimeOwnerNotPublishedError {}

export function toPreparedModelRuntimeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
