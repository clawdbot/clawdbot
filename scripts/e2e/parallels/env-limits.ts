// Env Limits script supports OpenClaw repository automation.
import { die } from "./host-command.ts";

const positiveIntPattern = /^[1-9]\d*$/u;

export function parsePositiveInt(value: string, label: string): number {
  const trimmed = value.trim();
  if (!positiveIntPattern.test(trimmed)) {
    die(`invalid ${label}: ${value}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    die(`invalid ${label}: ${value}`);
  }
  return parsed;
}

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  return parsePositiveInt(raw, name);
}
