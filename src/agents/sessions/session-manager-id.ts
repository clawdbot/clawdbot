import { randomUUID } from "node:crypto";
import { uuidv7 } from "../../../packages/agent-core/src/harness/session/uuid.js";

export function createManagedSessionId(): string {
  return uuidv7();
}

export function generateSessionEntryId(): string {
  return randomUUID();
}
