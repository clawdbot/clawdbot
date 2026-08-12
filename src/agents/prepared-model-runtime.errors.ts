import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";

export class PreparedModelRuntimeOwnerNotPublishedError extends Error {}

export class PreparedModelRuntimePublicationSupersededError extends PreparedModelRuntimeOwnerNotPublishedError {}

export function toPreparedModelRuntimeError(error: unknown): Error {
  return toStringifiedError(error);
}
