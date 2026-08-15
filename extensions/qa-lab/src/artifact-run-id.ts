// Qa Lab plugin helper creates collision-resistant artifact run identifiers.
import { randomUUID } from "node:crypto";

export function createQaArtifactRunId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
