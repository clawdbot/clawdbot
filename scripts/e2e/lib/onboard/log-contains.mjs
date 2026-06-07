// Log substring assertion helper for onboard E2E scenarios.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_LOG_BYTES = 120_000;

const normalizeScriptOutput = (value) => value.replace(/\r?\n/g, "").replace(/\r/g, "");
const oscPattern = new RegExp(String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`, "g");
const csiPattern = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (value) =>
  normalizeScriptOutput(value).replace(oscPattern, "").replace(csiPattern, "");

const compact = (value) =>
  stripAnsi(value)
    .toLowerCase()
    .replace(/[^a-z]+/g, "");

export function readLogTail(file, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive integer");
  }
  const stats = fs.statSync(file);
  if (!stats.isFile()) {
    throw new Error(`${file} is not a file`);
  }
  const length = Math.min(stats.size, maxBytes);
  const start = Math.max(0, stats.size - length);
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function logTailContains(file, needle, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  const compactNeedle = compact(needle);
  if (!compactNeedle) {
    return false;
  }
  return compact(readLogTail(file, maxBytes)).includes(compactNeedle);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, needle] = process.argv.slice(2);
  if (!file || !needle) {
    process.exit(1);
  }

  try {
    process.exit(logTailContains(file, needle) ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
