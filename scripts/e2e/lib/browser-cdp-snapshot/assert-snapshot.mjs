// Assertions for browser CDP snapshot E2E fixtures.
import fs from "node:fs";

const DEFAULT_SNAPSHOT_MAX_BYTES = 512 * 1024;
const SNAPSHOT_DIAGNOSTIC_MAX_BYTES = 32 * 1024;
const snapshotPath = process.argv[2] ?? "/tmp/browser-cdp-snapshot.txt";

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  return parsed;
}

function readBoundedSnapshot(file, maxBytes) {
  const stats = fs.statSync(file);
  if (!stats.isFile()) {
    throw new Error(`${file} is not a file`);
  }
  if (stats.size > maxBytes) {
    throw new Error(`browser CDP snapshot exceeded ${maxBytes} bytes: ${stats.size} bytes`);
  }
  const snapshot = fs.readFileSync(file, "utf8");
  const bytes = Buffer.byteLength(snapshot, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`browser CDP snapshot exceeded ${maxBytes} bytes: ${bytes} bytes`);
  }
  return snapshot;
}

function snapshotDiagnostic(snapshot) {
  const buffer = Buffer.from(snapshot, "utf8");
  if (buffer.byteLength <= SNAPSHOT_DIAGNOSTIC_MAX_BYTES) {
    return snapshot;
  }
  return `[truncated snapshot diagnostic to ${SNAPSHOT_DIAGNOSTIC_MAX_BYTES} bytes]\n${buffer
    .subarray(buffer.byteLength - SNAPSHOT_DIAGNOSTIC_MAX_BYTES)
    .toString("utf8")}`;
}

const snapshotMaxBytes = readPositiveIntEnv(
  "OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES",
  DEFAULT_SNAPSHOT_MAX_BYTES,
);
const snapshot = readBoundedSnapshot(snapshotPath, snapshotMaxBytes);

for (const needle of [
  'button "Save"',
  'link "Docs"',
  "https://docs.openclaw.ai/browser-cdp-live",
  'generic "Clickable Card"',
  "cursor:pointer",
  'Iframe "Child"',
  'button "Inside"',
]) {
  if (!snapshot.includes(needle)) {
    console.error(snapshotDiagnostic(snapshot));
    throw new Error(`missing snapshot needle: ${needle}`);
  }
}

console.log("ok");
