import { randomUUID } from "node:crypto";
import { uuidv7 } from "../runtime/index.js";

export function createManagedSessionId(): string {
  return uuidv7();
}

export function generateSessionEntryId(): string {
  return randomUUID();
}
