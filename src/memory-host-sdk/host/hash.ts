import crypto from "node:crypto";

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
