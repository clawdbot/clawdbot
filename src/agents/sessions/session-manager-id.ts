import { randomUUID } from "node:crypto";
import { uuidv7 } from "../runtime/index.js";

export function createSessionId(): string {
  return uuidv7();
}

/** Generates a short collision-checked id, with a full UUID fallback. */
export function generateSessionEntryId(existing: { has(id: string): boolean }): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) {
      return id;
    }
  }
  return randomUUID();
}
