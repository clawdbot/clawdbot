import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { formatCodexDisplayText } from "./command-formatters.js";

export const CODEX_CLI_SESSIONS_LIST_COMMAND = "codex.cli.sessions.list";
export const CODEX_CLI_SESSION_RESUME_COMMAND = "codex.cli.session.resume";

const DEFAULT_SESSION_LIMIT = 10;
const MAX_SESSION_LIMIT = 50;
const DEFAULT_RESUME_TIMEOUT_MS = 20 * 60_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const activeResumeSessions = new Set<string>();

export type CodexCliSessionSummary = {
  sessionId: string;
  updatedAt?: string;
  lastMessage?: string;
  cwd?: string;
  sessionFile?: string;
  messageCount: number;
};

export type CodexCliSessionsListResult = {
  sessions: CodexCliSessionSummary[];
  codexHome: string;
};

export type CodexCliSessionResumeResult = {
  ok: true;
  sessionId: string;
  text: string;
};

type CodexCliSessionNodeInfo = {
  nodeId?: string;
  displayName?: string;
  remoteIp?: string;
  connected?: boolean;
  commands?: string[];
};

type CodexCliResumeSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_RESUME_SPAWN_RUNTIME: CodexCliResumeSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

export function createCodexCliSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CODEX_CLI_SESSIONS_LIST_COMMAND,
      cap: "codex-cli-sessions",
      handle: listLocalCodexCliSessions,
    },
    {
      command: CODEX_CLI_SESSION_RESUME_COMMAND,
      cap: "codex-cli-sessions",
      dangerous: true,
      handle: resumeLocalCodexCliSession,
    },
  ];
}

export function createCodexCliSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [CODEX_CLI_SESSIONS_LIST_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (ctx) => ctx.invokeNode(),
    },
    {
      commands: [CODEX_CLI_SESSION_RESUME_COMMAND],
      dangerous: true,
      handle: (ctx) => ctx.invokeNode(),
    },
  ];
}

export async function listCodexCliSessionsOnNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
  filter?: string;
  limit?: number;
}): Promise<{ node: CodexCliSessionNodeInfo; result: CodexCliSessionsListResult }> {
  const node = await resolveCodexCliNode({
    runtime: params.runtime,
    requestedNode: params.requestedNode,
    command: CODEX_CLI_SESSIONS_LIST_COMMAND,
  });
  const raw = await params.runtime.nodes.invoke({
    nodeId: readNodeId(node),
    command: CODEX_CLI_SESSIONS_LIST_COMMAND,
    params: {
      limit: params.limit,
      filter: params.filter,
    },
    timeoutMs: 15_000,
  });
  return { node, result: parseCodexCliSessionsListResult(raw) };
}

export async function resolveCodexCliSessionForBindingOnNode(params: {
  runtime: PluginRuntime;
  requestedNode: string;
  sessionId: string;
}): Promise<{ node: CodexCliSessionNodeInfo; session?: CodexCliSessionSummary }> {
  const listing = await listCodexCliSessionsOnNode({
    runtime: params.runtime,
    requestedNode: params.requestedNode,
    filter: params.sessionId,
    limit: MAX_SESSION_LIMIT,
  });
  if (!listing.node.commands?.includes(CODEX_CLI_SESSION_RESUME_COMMAND)) {
    throw new Error(
      `Node ${formatNodeLabel(listing.node)} does not expose ${CODEX_CLI_SESSION_RESUME_COMMAND}.`,
    );
  }
  return {
    node: listing.node,
    session: listing.result.sessions.find((session) => session.sessionId === params.sessionId),
  };
}

export async function resumeCodexCliSessionOnNode(params: {
  runtime: PluginRuntime;
  nodeId: string;
  sessionId: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<CodexCliSessionResumeResult> {
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: CODEX_CLI_SESSION_RESUME_COMMAND,
    params: {
      sessionId: params.sessionId,
      prompt: params.prompt,
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
    },
    timeoutMs: (params.timeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS) + 5_000,
  });
  const payload = unwrapNodeInvokePayload(raw);
  if (!isRecord(payload) || payload.ok !== true || typeof payload.text !== "string") {
    throw new Error("Codex CLI resume returned an invalid payload.");
  }
  return {
    ok: true,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : params.sessionId,
    text: payload.text,
  };
}

export function formatCodexCliSessions(params: {
  node: CodexCliSessionNodeInfo;
  result: CodexCliSessionsListResult;
}): string {
  if (params.result.sessions.length === 0) {
    return `No Codex CLI sessions returned from ${formatCodexDisplayText(formatNodeLabel(params.node))}.`;
  }
  return [
    `Codex CLI sessions on ${formatCodexDisplayText(formatNodeLabel(params.node))}:`,
    ...params.result.sessions.map((session) => {
      const details = [session.cwd, session.updatedAt].filter((value): value is string =>
        Boolean(value),
      );
      return `- ${formatCodexDisplayText(session.sessionId)}${
        session.lastMessage ? ` - ${formatCodexDisplayText(session.lastMessage)}` : ""
      }${details.length > 0 ? ` (${details.map(formatCodexDisplayText).join(", ")})` : ""}\n  Bind: /codex resume ${formatCodexDisplayText(
        session.sessionId,
      )} --host ${formatCodexDisplayText(readNodeId(params.node))} --bind here`;
    }),
  ].join("\n");
}

async function listLocalCodexCliSessions(paramsJSON?: string | null): Promise<string> {
  const params = readRecordParam(paramsJSON);
  const limit = normalizeLimit(params.limit);
  const filter = typeof params.filter === "string" ? params.filter.trim().toLowerCase() : "";
  const codexHome = resolveCodexHome();
  const summaries = await readHistorySessions(codexHome);
  await hydrateSessionFiles(codexHome, summaries);
  await hydrateSessionsFromSessionFiles(codexHome, summaries);
  const sessions = [...summaries.values()]
    .filter((session) => {
      if (!filter) {
        return true;
      }
      return [session.sessionId, session.cwd, session.lastMessage].some((value) =>
        value?.toLowerCase().includes(filter),
      );
    })
    .toSorted((a, b) => compareOptionalStringsDesc(a.updatedAt, b.updatedAt))
    .slice(0, limit);
  return JSON.stringify({ sessions, codexHome } satisfies CodexCliSessionsListResult);
}

async function resumeLocalCodexCliSession(paramsJSON?: string | null): Promise<string> {
  const params = readRecordParam(paramsJSON);
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Missing or invalid Codex CLI session id.");
  }
  if (!prompt) {
    throw new Error("Missing Codex CLI prompt.");
  }
  if (activeResumeSessions.has(sessionId)) {
    throw new Error(`Codex CLI session ${sessionId} already has an active resume turn.`);
  }
  activeResumeSessions.add(sessionId);
  try {
    const text = await runCodexExecResume({
      sessionId,
      prompt,
      cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined,
      timeoutMs: normalizeTimeoutMs(params.timeoutMs),
    });
    return JSON.stringify({
      ok: true,
      sessionId,
      text: text.trim() || "Codex completed without a text reply.",
    } satisfies CodexCliSessionResumeResult);
  } finally {
    activeResumeSessions.delete(sessionId);
  }
}

async function runCodexExecResume(params: {
  sessionId: string;
  prompt: string;
  cwd?: string;
  timeoutMs: number;
}): Promise<string> {
  const outputPath = path.join(
    await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-cli-")),
    "last-message.txt",
  );
  try {
    const args = [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      params.sessionId,
      "-",
    ];
    const invocation = resolveCodexCliResumeSpawnInvocation(args, {
      platform: process.platform,
      env: process.env,
      execPath: process.execPath,
    });
    const child = spawn(invocation.command, invocation.args, {
      cwd: params.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: invocation.shell,
      windowsHide: invocation.windowsHide,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimeout.unref?.();
    }, params.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(params.prompt);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code));
    }).finally(() => {
      clearTimeout(timeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
    });
    if (timedOut) {
      throw new Error(`codex exec resume timed out after ${String(params.timeoutMs)}ms`);
    }
    if (exitCode !== 0) {
      const message =
        Buffer.concat(stderr).toString("utf8").trim() ||
        Buffer.concat(stdout).toString("utf8").trim() ||
        `codex exec resume exited with code ${String(exitCode)}`;
      throw new Error(message);
    }
    return await fs.readFile(outputPath, "utf8");
  } finally {
    await fs.rm(path.dirname(outputPath), { recursive: true, force: true });
  }
}

export function resolveCodexCliResumeSpawnInvocation(
  args: string[],
  runtime: CodexCliResumeSpawnRuntime = DEFAULT_RESUME_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  const program = resolveWindowsSpawnProgram({
    command: "codex",
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "@openai/codex",
  });
  const resolved = materializeWindowsSpawnProgram(program, args);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

async function readHistorySessions(
  codexHome: string,
): Promise<Map<string, CodexCliSessionSummary>> {
  const summaries = new Map<string, CodexCliSessionSummary>();
  const historyPath = path.join(codexHome, "history.jsonl");
  const content = await readFileIfExists(historyPath);
  if (!content) {
    return summaries;
  }
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.session_id !== "string") {
      continue;
    }
    const sessionId = parsed.session_id.trim();
    if (!sessionId) {
      continue;
    }
    const entry = summaries.get(sessionId) ?? {
      sessionId,
      messageCount: 0,
    };
    entry.messageCount += 1;
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      entry.lastMessage = truncateText(parsed.text.trim(), 140);
    }
    if (typeof parsed.ts === "number" && Number.isFinite(parsed.ts)) {
      entry.updatedAt = new Date(parsed.ts * 1000).toISOString();
    }
    summaries.set(sessionId, entry);
  }
  return summaries;
}

async function hydrateSessionFiles(
  codexHome: string,
  summaries: Map<string, CodexCliSessionSummary>,
): Promise<void> {
  if (summaries.size === 0) {
    return;
  }
  const sessionsDir = path.join(codexHome, "sessions");
  const files = await findSessionFiles(sessionsDir, 4);
  const pending = new Set(summaries.keys());
  for (const file of files) {
    const basename = path.basename(file);
    const sessionId = [...pending].find((id) => basename.includes(id));
    if (!sessionId) {
      continue;
    }
    const entry = summaries.get(sessionId);
    if (!entry) {
      continue;
    }
    entry.sessionFile = file;
    const firstLine = (await readFirstLine(file)) ?? "";
    const cwd = readSessionMetaCwd(firstLine);
    if (cwd) {
      entry.cwd = cwd;
    }
    pending.delete(sessionId);
    if (pending.size === 0) {
      return;
    }
  }
}

async function hydrateSessionsFromSessionFiles(
  codexHome: string,
  summaries: Map<string, CodexCliSessionSummary>,
): Promise<void> {
  const sessionsDir = path.join(codexHome, "sessions");
  const files = await findSessionFiles(sessionsDir, 4);
  for (const file of files) {
    const summary = await readSessionFileSummary(file);
    if (!summary) {
      continue;
    }
    const existing = summaries.get(summary.sessionId);
    summaries.set(summary.sessionId, {
      ...summary,
      ...existing,
      cwd: existing?.cwd ?? summary.cwd,
      sessionFile: existing?.sessionFile ?? summary.sessionFile,
      updatedAt: existing?.updatedAt ?? summary.updatedAt,
      lastMessage: existing?.lastMessage ?? summary.lastMessage,
      messageCount: existing?.messageCount ?? summary.messageCount,
    });
  }
}

async function readSessionFileSummary(file: string): Promise<CodexCliSessionSummary | null> {
  const content = await readFileIfExists(file);
  if (!content) {
    return null;
  }
  let sessionId = "";
  let cwd: string | undefined;
  let updatedAt: string | undefined;
  let lastMessage: string | undefined;
  let messageCount = 0;
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    if (typeof parsed.timestamp === "string" && parsed.timestamp.trim()) {
      updatedAt = parsed.timestamp.trim();
    }
    if (parsed.type === "session_meta" && isRecord(parsed.payload)) {
      if (typeof parsed.payload.id === "string" && parsed.payload.id.trim()) {
        sessionId = parsed.payload.id.trim();
      }
      if (typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim()) {
        cwd = parsed.payload.cwd.trim();
      }
      continue;
    }
    const messageText = readResponseItemMessageText(parsed);
    if (messageText) {
      messageCount += 1;
      lastMessage = truncateText(messageText, 140);
    }
  }
  if (!sessionId) {
    sessionId = readSessionIdFromFilename(file) ?? "";
  }
  if (!sessionId) {
    return null;
  }
  return {
    sessionId,
    updatedAt: updatedAt ?? (await readFileMtimeIso(file)),
    lastMessage,
    cwd,
    sessionFile: file,
    messageCount,
  };
}

async function findSessionFiles(dir: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) {
    return [];
  }
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSessionFiles(entryPath, maxDepth - 1)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

function readSessionMetaCwd(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
      return undefined;
    }
    return typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim()
      ? parsed.payload.cwd.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function readResponseItemMessageText(parsed: Record<string, unknown>): string | undefined {
  if (parsed.type !== "response_item" || !isRecord(parsed.payload)) {
    return undefined;
  }
  if (parsed.payload.type !== "message") {
    return undefined;
  }
  const role = typeof parsed.payload.role === "string" ? parsed.payload.role : "";
  if (role !== "user") {
    return undefined;
  }
  const content = Array.isArray(parsed.payload.content) ? parsed.payload.content : [];
  const parts = content.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const text =
      typeof entry.text === "string"
        ? entry.text
        : typeof entry.input_text === "string"
          ? entry.input_text
          : undefined;
    return text?.trim() ? [text.trim()] : [];
  });
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function readSessionIdFromFilename(file: string): string | undefined {
  const match = path.basename(file).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
  return match?.[0];
}

async function resolveCodexCliNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
  command: string;
}): Promise<CodexCliSessionNodeInfo> {
  const list = await params.runtime.nodes.list(
    params.requestedNode ? undefined : { connected: true },
  );
  const requested = params.requestedNode?.trim();
  const candidates = list.nodes.filter((node) => {
    if (requested) {
      return [node.nodeId, node.displayName, node.remoteIp].some((value) => value === requested);
    }
    return node.connected === true && node.commands?.includes(params.command);
  });
  if (candidates.length === 0) {
    throw new Error(
      requested
        ? `Codex CLI node ${requested} was not found.`
        : "No connected node exposes Codex CLI session commands.",
    );
  }
  const usable = candidates.filter((node) => node.commands?.includes(params.command));
  if (usable.length === 0) {
    throw new Error(`Node ${requested ?? "candidate"} does not expose ${params.command}.`);
  }
  if (usable.length > 1) {
    throw new Error("Multiple Codex CLI-capable nodes connected. Pass --host <node-id>.");
  }
  return usable[0];
}

function parseCodexCliSessionsListResult(raw: unknown): CodexCliSessionsListResult {
  const payload = unwrapNodeInvokePayload(raw);
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
    throw new Error("Codex CLI session list returned an invalid payload.");
  }
  return {
    codexHome: typeof payload.codexHome === "string" ? payload.codexHome : "",
    sessions: payload.sessions.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.sessionId !== "string") {
        return [];
      }
      return [
        {
          sessionId: entry.sessionId,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
          lastMessage: typeof entry.lastMessage === "string" ? entry.lastMessage : undefined,
          cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
          sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : undefined,
          messageCount:
            typeof entry.messageCount === "number" && Number.isFinite(entry.messageCount)
              ? entry.messageCount
              : 0,
        },
      ];
    }),
  };
}

function unwrapNodeInvokePayload(raw: unknown): unknown {
  const record = isRecord(raw) ? raw : {};
  if (typeof record.payloadJSON === "string" && record.payloadJSON.trim()) {
    try {
      return JSON.parse(record.payloadJSON) as unknown;
    } catch (error) {
      throw new Error("Codex CLI node command returned malformed payloadJSON.", {
        cause: error,
      });
    }
  }
  if ("payload" in record) {
    return record.payload;
  }
  return raw;
}

function readRecordParam(paramsJSON?: string | null): Record<string, unknown> {
  if (!paramsJSON?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(paramsJSON) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

async function readFileIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function readFirstLine(file: string): Promise<string | undefined> {
  const content = await readFileIfExists(file);
  return content?.split(/\r?\n/u)[0];
}

async function readFileMtimeIso(file: string): Promise<string | undefined> {
  try {
    return (await fs.stat(file)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function normalizeLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.floor(value)))
    : DEFAULT_SESSION_LIMIT;
}

function normalizeTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(60 * 60_000, Math.floor(value))
    : DEFAULT_RESUME_TIMEOUT_MS;
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function compareOptionalStringsDesc(a?: string, b?: string): number {
  return (b ?? "").localeCompare(a ?? "");
}

function readNodeId(node: CodexCliSessionNodeInfo): string {
  if (!node.nodeId) {
    throw new Error("Codex CLI node did not include a node id.");
  }
  return node.nodeId;
}

function formatNodeLabel(node: CodexCliSessionNodeInfo): string {
  return [node.displayName, node.nodeId, node.remoteIp].filter(Boolean).join(" / ") || "node";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
