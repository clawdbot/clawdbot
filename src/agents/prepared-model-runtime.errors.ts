import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

export class PreparedModelRuntimeOwnerNotPublishedError extends Error {}

export class PreparedModelRuntimePublicationSupersededError extends PreparedModelRuntimeOwnerNotPublishedError {}

export function assertPreparedModelRuntimeInputCurrent(
  input: PreparedModelRuntimeInput,
  isCurrent: (() => boolean) | undefined,
): void {
  if (isCurrent && !isCurrent()) {
    throw new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime publication was superseded for ${input.agentDir}`,
    );
  }
}

export function assertPreparedModelRuntimeCandidatesCurrent(
  candidates: readonly {
    input: PreparedModelRuntimeInput;
    isBuildCurrent?: () => boolean;
  }[],
): void {
  for (const candidate of candidates) {
    assertPreparedModelRuntimeInputCurrent(candidate.input, candidate.isBuildCurrent);
  }
}
