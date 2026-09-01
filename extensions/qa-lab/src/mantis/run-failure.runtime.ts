// Qa Lab plugin module carries Mantis failure artifact diagnostics across CLI boundaries.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const mantisFailureArtifactPath = Symbol("mantisFailureArtifactPath");

export function attachMantisFailureArtifact(error: unknown, errorPath: string): Error {
  const artifactLine = `Mantis error details: ${errorPath}`;
  const attachedError =
    error instanceof Error
      ? error
      : new Error(`${formatErrorMessage(error)}\n${artifactLine}`, { cause: error });
  if (error instanceof Error) {
    attachedError.message = `${attachedError.message}\n${artifactLine}`;
  }
  Object.defineProperty(attachedError, mantisFailureArtifactPath, { value: errorPath });
  return attachedError;
}

export function findMantisFailureArtifactPath(
  error: unknown,
  seen = new Set<unknown>(),
): string | undefined {
  if (!error || (typeof error !== "object" && typeof error !== "function") || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  const attachedPath = Object.getOwnPropertyDescriptor(error, mantisFailureArtifactPath)?.value;
  if (typeof attachedPath === "string") {
    return attachedPath;
  }
  if (error instanceof AggregateError) {
    for (const nestedError of error.errors) {
      const nestedPath = findMantisFailureArtifactPath(nestedError, seen);
      if (nestedPath) {
        return nestedPath;
      }
    }
  }
  if ("cause" in error) {
    return findMantisFailureArtifactPath(error.cause, seen);
  }
  return undefined;
}
