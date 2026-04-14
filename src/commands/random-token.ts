import crypto from "node:crypto";

export function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}
