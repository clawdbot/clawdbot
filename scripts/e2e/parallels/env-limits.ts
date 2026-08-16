// Env Limits script supports OpenClaw repository automation.
import { die } from "./host-command.ts";

const positiveIntPattern = /^[1-9]\d*$/u;
const fullGitCommitPattern = /^[0-9a-f]{40}$/iu;

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

export function parseTcpPort(value: string, label: string): number {
  const parsed = parsePositiveInt(value, label);
  if (parsed > 65_535) {
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

export function readGitCommitEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  const value = raw.trim();
  if (!fullGitCommitPattern.test(value)) {
    die(`invalid ${name}: expected a full 40-character commit SHA`);
  }
  return value.toLowerCase();
}
