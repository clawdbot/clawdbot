import crypto from "node:crypto";

export function buildQQBotStateKey(...parts: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
