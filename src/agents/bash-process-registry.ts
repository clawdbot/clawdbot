import type { ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_JOB_TTL_MS = 60 * 1000; // 1 minute
const MAX_JOB_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

function clampTtl(value: number | undefined) {
  if (!value || Number.isNaN(value)) return DEFAULT_JOB_TTL_MS;
  return Math.min(Math.max(value, MIN_JOB_TTL_MS), MAX_JOB_TTL_MS);
}

let jobTtlMs = clampTtl(
  Number.parseInt(process.env.PI_BASH_JOB_TTL_MS ?? "", 10),
);

export type ProcessStatus = "running" | "completed" | "failed" | "killed";

export interface ProcessSession {
  id: string;
  command: string;
  scopeKey?: string;
  child?: ChildProcessWithoutNullStreams;
  pid?: number;
  startedAt: number;
  cwd?: string;
  maxOutputChars: number;
  totalOutputChars: number;
  pendingStdout: string[];
  pendingStderr: string[];
  aggregated: string;
  tail: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  exited: boolean;
  truncated: boolean;
  backgrounded: boolean;
}

export interface FinishedSession {
  id: string;
  command: string;
  scopeKey?: string;
  startedAt: number;
  endedAt: number;
  cwd?: string;
  status: ProcessStatus;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  aggregated: string;
  tail: string;
  truncated: boolean;
  totalOutputChars: number;
}

const runningSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, FinishedSession>();

let sweeper: NodeJS.Timeout | null = null;

export function addSession(session: ProcessSession) {
  runningSessions.set(session.id, session);
  startSweeper();
}

export function getSession(id: string) {
  return runningSessions.get(id);
}

export function getFinishedSession(id: string) {
  return finishedSessions.get(id);
}

export function deleteSession(id: string) {
  runningSessions.delete(id);
  finishedSessions.delete(id);
}

export function appendOutput(
  session: ProcessSession,
  stream: "stdout" | "stderr",
  chunk: string,
) {
  session.pendingStdout ??= [];
  session.pendingStderr ??= [];
  const buffer =
    stream === "stdout" ? session.pendingStdout : session.pendingStderr;
  buffer.push(chunk);
  session.totalOutputChars += chunk.length;
  const aggregated = trimWithCap(
    session.aggregated + chunk,
    session.maxOutputChars,
  );
  session.truncated =
    session.truncated ||
    aggregated.length < session.aggregated.length + chunk.length;
  session.aggregated = aggregated;
  session.tail = tail(session.aggregated, 2000);
}

export function drainSession(session: ProcessSession) {
  const stdout = session.pendingStdout.join("");
  const stderr = session.pendingStderr.join("");
  session.pendingStdout = [];
  session.pendingStderr = [];
  return { stdout, stderr };
}

export function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | number | null,
  status: ProcessStatus,
) {
  session.exited = true;
  session.exitCode = exitCode;
  session.exitSignal = exitSignal;
  session.tail = tail(session.aggregated, 2000);
  moveToFinished(session, status);
}

export function markBackgrounded(session: ProcessSession) {
  session.backgrounded = true;
}

function moveToFinished(session: ProcessSession, status: ProcessStatus) {
  runningSessions.delete(session.id);
  if (!session.backgrounded) return;
  finishedSessions.set(session.id, {
    id: session.id,
    command: session.command,
    scopeKey: session.scopeKey,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    cwd: session.cwd,
    status,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    aggregated: session.aggregated,
    tail: session.tail,
    truncated: session.truncated,
    totalOutputChars: session.totalOutputChars,
  });
}

export function tail(text: string, max = 2000) {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

export function trimWithCap(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

export function listRunningSessions() {
  return Array.from(runningSessions.values()).filter((s) => s.backgrounded);
}

export function listFinishedSessions() {
  return Array.from(finishedSessions.values());
}

export function clearFinished() {
  finishedSessions.clear();
}

export function resetProcessRegistryForTests() {
  runningSessions.clear();
  finishedSessions.clear();
  stopSweeper();
}

export function setJobTtlMs(value?: number) {
  if (value === undefined || Number.isNaN(value)) return;
  jobTtlMs = clampTtl(value);
  stopSweeper();
  startSweeper();
}

function pruneFinishedSessions() {
  const cutoff = Date.now() - jobTtlMs;
  for (const [id, session] of finishedSessions.entries()) {
    if (session.endedAt < cutoff) {
      finishedSessions.delete(id);
    }
  }
}

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(pruneFinishedSessions, Math.max(30_000, jobTtlMs / 6));
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}
