import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FileEntry, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import { resolveStateDir } from "../config/paths.js";
import {
  jsonSupportBundleFile,
  jsonlSupportBundleFile,
  supportBundleContents,
  textSupportBundleFile,
  writeSupportBundleDirectory,
  type DiagnosticSupportBundleContent,
  type DiagnosticSupportBundleFile,
} from "../logging/diagnostic-support-bundle.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import {
  TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  safeTrajectorySessionFileName,
} from "./paths.js";
import type {
  TrajectoryBundleManifest,
  TrajectoryBundleWarning,
  TrajectoryEvent,
  TrajectoryToolDefinition,
} from "./types.js";

type BuildTrajectoryBundleParams = {
  outputDir: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  runtimeFile?: string;
  systemPrompt?: string;
  tools?: TrajectoryToolDefinition[];
  maxTotalEvents?: number;
};

type RuntimeTrajectoryContext = {
  systemPrompt?: string;
  tools?: TrajectoryToolDefinition[];
};

type JsonRecord = Record<string, unknown>;
type TrajectoryExportRedaction = SupportRedactionContext & {
  workspaceDir: string;
};

type JsonlParseWarning = Omit<TrajectoryBundleWarning, "count" | "rows"> & {
  row: number;
};

const MAX_TRAJECTORY_RUNTIME_EVENTS = 200_000;
const MAX_TRAJECTORY_TOTAL_EVENTS = 250_000;
const MAX_TRAJECTORY_SESSION_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TRAJECTORY_WARNING_ROWS = 20;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSessionFileEntry(value: unknown): value is FileEntry {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type !== "message") {
    return true;
  }
  const message = value.message;
  return isRecord(message) && typeof message.role === "string";
}

function parseSessionEntries(content: string): {
  entries: FileEntry[];
  warnings: JsonlParseWarning[];
  rowByEntry: Map<FileEntry, number>;
} {
  const entries: FileEntry[] = [];
  const warnings: JsonlParseWarning[] = [];
  const rowByEntry = new Map<FileEntry, number>();
  const rows = content.split(/\r?\n/u);
  for (const [index, rawLine] of rows.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isSessionFileEntry(parsed)) {
        warnings.push({
          source: "session",
          code: "invalid-session-row",
          row: index + 1,
          message: "Skipped a session JSONL row that is not a session entry object.",
        });
        continue;
      }
      entries.push(parsed);
      rowByEntry.set(parsed, index + 1);
    } catch {
      warnings.push({
        source: "session",
        code: "invalid-session-json",
        row: index + 1,
        message: "Skipped a session JSONL row that is not valid JSON.",
      });
    }
  }
  return { entries, warnings, rowByEntry };
}

function migrateLegacySessionEntries(entries: FileEntry[]): void {
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  const version = header?.version ?? 1;
  if (version < 2) {
    let previousId: string | null = null;
    let index = 0;
    for (const entry of entries) {
      if (entry.type === "session") {
        entry.version = 2;
        continue;
      }
      const mutable = entry as unknown as Record<string, unknown>;
      if (typeof mutable.id !== "string") {
        mutable.id = `legacy-${index++}`;
      }
      mutable.parentId = previousId;
      const entryId = mutable.id;
      previousId = typeof entryId === "string" ? entryId : null;
      if (entry.type === "compaction" && typeof mutable.firstKeptEntryIndex === "number") {
        const target = entries[mutable.firstKeptEntryIndex];
        if (target && target.type !== "session") {
          mutable.firstKeptEntryId = (target as unknown as Record<string, unknown>).id;
        }
        delete mutable.firstKeptEntryIndex;
      }
    }
  }
  if (version < 3) {
    for (const entry of entries) {
      if (entry.type === "session") {
        entry.version = 3;
        continue;
      }
      if (entry.type === "message") {
        const message = (entry as { message?: { role?: string } }).message;
        if (message?.role === "hookMessage") {
          message.role = "custom";
        }
      }
    }
  }
}

async function readSessionBranch(filePath: string): Promise<{
  header: SessionHeader | null;
  leafId: string | null;
  branchEntries: SessionEntry[];
  warnings: JsonlParseWarning[];
}> {
  const {
    entries: fileEntries,
    warnings,
    rowByEntry,
  } = parseSessionEntries(await fsp.readFile(filePath, "utf8"));
  migrateLegacySessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter(
    (entry): entry is SessionEntry =>
      entry.type !== "session" &&
      typeof (entry as { id?: unknown }).id === "string" &&
      (typeof (entry as { timestamp?: unknown }).timestamp === "string" ||
        typeof (entry as { timestamp?: unknown }).timestamp === "number"),
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const leafId = entries.at(-1)?.id ?? null;
  const branchEntries: SessionEntry[] = [];
  const seen = new Set<string>();
  let currentId = leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      const cycleEntry = byId.get(currentId);
      warnings.push({
        source: "session",
        code: "cyclic-session-branch",
        row: cycleEntry ? (rowByEntry.get(cycleEntry) ?? 0) : 0,
        message: "Stopped trajectory session branch export at a cyclic parent link.",
      });
      break;
    }
    seen.add(currentId);
    const current = byId.get(currentId);
    if (!current) {
      warnings.push({
        source: "session",
        code: "incomplete-session-branch",
        row: 0,
        message: "Exported the reachable session branch suffix after a missing parent link.",
      });
      break;
    }
    branchEntries.unshift(current);
    const parentId = typeof current.parentId === "string" ? current.parentId : null;
    if (parentId && !byId.has(parentId)) {
      warnings.push({
        source: "session",
        code: "incomplete-session-branch",
        row: rowByEntry.get(current) ?? 0,
        message: "Exported the reachable session branch suffix after a missing parent link.",
      });
      break;
    }
    currentId = parentId;
  }
  return { header, leafId, branchEntries, warnings };
}

async function parseJsonlFile<T>(
  filePath: string,
  params: {
    maxBytes: number;
    maxEvents: number;
    include?: (value: T) => boolean;
    validate?: (value: unknown) => value is T;
  },
): Promise<{ events: T[]; warnings: JsonlParseWarning[] }> {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], warnings: [] };
    }
    throw error;
  }
  if (!stat.isFile()) {
    return { events: [], warnings: [] };
  }
  if (stat.size > params.maxBytes) {
    throw new Error(
      `Trajectory runtime file is too large to export (${stat.size} bytes; limit ${params.maxBytes})`,
    );
  }
  const rows = (await fsp.readFile(filePath, "utf8")).split(/\r?\n/u);
  const parsed: T[] = [];
  const warnings: JsonlParseWarning[] = [];
  for (const [index, rawLine] of rows.entries()) {
    const row = rawLine.trim();
    if (!row) {
      continue;
    }
    if (parsed.length >= params.maxEvents) {
      throw new Error(
        `Trajectory runtime file has too many events to export (limit ${params.maxEvents})`,
      );
    }
    try {
      const value = JSON.parse(row) as unknown;
      if (!params.validate || params.validate(value)) {
        const typedValue = value as T;
        if (!params.include || params.include(typedValue)) {
          parsed.push(typedValue);
        }
      } else {
        warnings.push({
          source: "runtime",
          code: "invalid-runtime-event",
          row: index + 1,
          message: "Skipped a runtime trajectory JSONL row that does not match the session schema.",
        });
      }
    } catch {
      warnings.push({
        source: "runtime",
        code: "invalid-runtime-json",
        row: index + 1,
        message: "Skipped a runtime trajectory JSONL row that is not valid JSON.",
      });
    }
  }
  return { events: parsed, warnings };
}

function isRuntimeTrajectoryEvent(value: unknown): value is TrajectoryEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.traceSchema === "openclaw-trajectory" &&
    value.schemaVersion === 1 &&
    value.source === "runtime" &&
    typeof value.type === "string" &&
    typeof value.ts === "string" &&
    !Number.isNaN(Date.parse(value.ts)) &&
    isFiniteNumber(value.seq) &&
    typeof value.sessionId === "string" &&
    (!("data" in value) || value.data === undefined || isRecord(value.data))
  );
}

function summarizeJsonlWarnings(warnings: JsonlParseWarning[]): TrajectoryBundleWarning[] {
  const byKey = new Map<string, TrajectoryBundleWarning>();
  for (const warning of warnings) {
    const key = `${warning.source}:${warning.code}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.rows.length < MAX_TRAJECTORY_WARNING_ROWS) {
        existing.rows.push(warning.row);
      }
      continue;
    }
    byKey.set(key, {
      source: warning.source,
      code: warning.code,
      count: 1,
      rows: [warning.row],
      message: warning.message,
    });
  }
  return [...byKey.values()];
}

async function isRegularNonSymlinkFile(filePath: string): Promise<boolean> {
  try {
    const linkStat = await fsp.lstat(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      return false;
    }
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.dev === linkStat.dev && stat.ino === linkStat.ino;
  } catch {
    return false;
  }
}

async function readRuntimePointerFile(
  sessionFile: string,
  sessionId: string,
): Promise<string | undefined> {
  const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
  if (!(await isRegularNonSymlinkFile(pointerPath))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(pointerPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    if (parsed.sessionId !== sessionId || typeof parsed.runtimeFile !== "string") {
      return undefined;
    }
    const runtimeFile = path.resolve(parsed.runtimeFile);
    const safeRuntimeFileName = `${safeTrajectorySessionFileName(sessionId)}.jsonl`;
    const defaultRuntimeFile = path.resolve(
      resolveTrajectoryFilePath({
        env: {},
        sessionFile,
        sessionId,
      }),
    );
    if (runtimeFile !== defaultRuntimeFile && path.basename(runtimeFile) !== safeRuntimeFileName) {
      return undefined;
    }
    return runtimeFile;
  } catch {
    return undefined;
  }
}

async function resolveTrajectoryRuntimeFile(params: {
  runtimeFile?: string;
  sessionFile: string;
  sessionId: string;
}): Promise<string | undefined> {
  if (params.runtimeFile) {
    return params.runtimeFile;
  }
  const candidates = [
    await readRuntimePointerFile(params.sessionFile, params.sessionId),
    resolveTrajectoryFilePath({
      env: {},
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
    }),
    resolveTrajectoryFilePath({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
    }),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await isRegularNonSymlinkFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date(0).toISOString();
}

function resolveMessageEventType(message: AgentMessage): string {
  if (message.role === "user") {
    return "user.message";
  }
  if (message.role === "assistant") {
    return "assistant.message";
  }
  if (message.role === "toolResult") {
    return "tool.result";
  }
  return `message.${message.role}`;
}

function extractAssistantToolCalls(
  message: AgentMessage,
): Array<{ id?: string; name?: string; arguments?: unknown; index: number }> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block, index) => {
    if (!block || typeof block !== "object") {
      return [];
    }
    const typedBlock = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
      input?: unknown;
      parameters?: unknown;
    };
    const blockType =
      typeof typedBlock.type === "string" ? typedBlock.type.trim().toLowerCase() : "";
    if (blockType !== "toolcall" && blockType !== "tooluse" && blockType !== "functioncall") {
      return [];
    }
    return [
      {
        id: typeof typedBlock.id === "string" ? typedBlock.id : undefined,
        name: typeof typedBlock.name === "string" ? typedBlock.name : undefined,
        arguments: typedBlock.arguments ?? typedBlock.input ?? typedBlock.parameters,
        index,
      },
    ];
  });
}

function buildTranscriptEvents(params: {
  entries: SessionEntry[];
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  traceId: string;
}): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  let seq = 0;
  for (const entry of params.entries) {
    const push = (type: string, data?: Record<string, unknown>) => {
      events.push({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: params.traceId,
        source: "transcript",
        type,
        ts: normalizeTimestamp(entry.timestamp),
        seq: 0,
        sourceSeq: (seq += 1),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        entryId: entry.id,
        parentEntryId: entry.parentId,
        data,
      });
    };

    switch (entry.type) {
      case "message": {
        push(resolveMessageEventType(entry.message), {
          message: sanitizeDiagnosticPayload(entry.message),
        });
        for (const toolCall of extractAssistantToolCalls(entry.message)) {
          push("tool.call", {
            toolCallId: toolCall.id,
            name: toolCall.name,
            arguments: sanitizeDiagnosticPayload(toolCall.arguments),
            assistantEntryId: entry.id,
            blockIndex: toolCall.index,
          });
        }
        break;
      }
      case "compaction":
        push("session.compaction", {
          summary: entry.summary,
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore,
          details: sanitizeDiagnosticPayload(entry.details),
          fromHook: entry.fromHook ?? false,
        });
        break;
      case "branch_summary":
        push("session.branch_summary", {
          fromId: entry.fromId,
          summary: entry.summary,
          details: sanitizeDiagnosticPayload(entry.details),
          fromHook: entry.fromHook ?? false,
        });
        break;
      case "custom":
        push("session.custom", {
          customType: entry.customType,
          data: sanitizeDiagnosticPayload(entry.data),
        });
        break;
      case "custom_message":
        push("session.custom_message", {
          customType: entry.customType,
          content: sanitizeDiagnosticPayload(entry.content),
          details: sanitizeDiagnosticPayload(entry.details),
          display: entry.display,
        });
        break;
      case "thinking_level_change":
        push("session.thinking_level_change", {
          thinkingLevel: entry.thinkingLevel,
        });
        break;
      case "model_change":
        push("session.model_change", {
          provider: entry.provider,
          modelId: entry.modelId,
        });
        break;
      case "label":
        push("session.label", {
          targetId: entry.targetId,
          label: entry.label,
        });
        break;
      case "session_info":
        push("session.info", {
          name: entry.name,
        });
        break;
    }
  }
  return events;
}

function sortTrajectoryEvents(events: TrajectoryEvent[]): TrajectoryEvent[] {
  const sourceOrder: Record<TrajectoryEvent["source"], number> = {
    runtime: 0,
    transcript: 1,
    export: 2,
  };
  const sorted = events.toSorted((left, right) => {
    const byTs = left.ts.localeCompare(right.ts);
    if (byTs !== 0) {
      return byTs;
    }
    const bySource = sourceOrder[left.source] - sourceOrder[right.source];
    if (bySource !== 0) {
      return bySource;
    }
    return (left.sourceSeq ?? left.seq) - (right.sourceSeq ?? right.seq);
  });
  for (const [index, event] of sorted.entries()) {
    event.seq = index + 1;
  }
  return sorted;
}

function trajectoryJsonlFile(
  pathName: string,
  events: TrajectoryEvent[],
): DiagnosticSupportBundleFile {
  const lines = events
    .map((event) => safeJsonStringify(event))
    .filter((line): line is string => Boolean(line));
  return jsonlSupportBundleFile(pathName, lines);
}

function buildTrajectoryExportRedaction(params: {
  workspaceDir: string;
}): TrajectoryExportRedaction {
  const env = process.env;
  return {
    env,
    stateDir: resolveStateDir(env),
    workspaceDir: path.resolve(params.workspaceDir),
  };
}

function redactWorkspacePathString(value: string, redaction: TrajectoryExportRedaction): string {
  const workspaceDir = redaction.workspaceDir;
  if (!workspaceDir) {
    return value;
  }
  const normalizedWorkspaceDir = workspaceDir.replaceAll("\\", "/");
  let next = value;
  for (const candidate of new Set([workspaceDir, normalizedWorkspaceDir])) {
    if (!candidate) {
      continue;
    }
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    next = next.replace(new RegExp(`${escaped}(?=$|[\\\\/])`, "gu"), "$WORKSPACE_DIR");
  }
  return next;
}

function maybeRedactPathString(value: string, redaction: TrajectoryExportRedaction): string {
  const workspaceRedacted = redactWorkspacePathString(value, redaction);
  if (
    workspaceRedacted !== value ||
    path.isAbsolute(workspaceRedacted) ||
    workspaceRedacted.includes(redaction.stateDir) ||
    (redaction.env.HOME ? workspaceRedacted.includes(redaction.env.HOME) : false) ||
    (redaction.env.USERPROFILE ? workspaceRedacted.includes(redaction.env.USERPROFILE) : false)
  ) {
    return redactSupportString(workspaceRedacted, redaction);
  }
  return workspaceRedacted;
}

function redactLocalPathValues(value: unknown, redaction: TrajectoryExportRedaction): unknown {
  if (typeof value === "string") {
    return maybeRedactPathString(value, redaction);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactLocalPathValues(entry, redaction));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    next[key] = redactLocalPathValues(entry, redaction);
  }
  return next;
}

function redactEventForExport(
  event: TrajectoryEvent,
  redaction: TrajectoryExportRedaction,
): TrajectoryEvent {
  return {
    ...event,
    workspaceDir: event.workspaceDir
      ? maybeRedactPathString(event.workspaceDir, redaction)
      : undefined,
    data: event.data
      ? (redactLocalPathValues(event.data, redaction) as Record<string, unknown>)
      : undefined,
  };
}

function resolveRuntimeContext(runtimeEvents: TrajectoryEvent[]): RuntimeTrajectoryContext {
  const latestContext = runtimeEvents
    .slice()
    .toReversed()
    .find((event) => event.type === "context.compiled");
  const runtimeData = latestContext?.data;
  const toolsValue = Array.isArray(runtimeData?.tools)
    ? (runtimeData.tools as TrajectoryToolDefinition[])
    : undefined;
  return {
    systemPrompt:
      typeof runtimeData?.systemPrompt === "string" ? runtimeData.systemPrompt : undefined,
    tools: toolsValue,
  };
}

function resolveLatestRuntimeEventData(
  runtimeEvents: TrajectoryEvent[],
  type: string,
): JsonRecord | undefined {
  const event = runtimeEvents
    .slice()
    .toReversed()
    .find((candidate) => candidate.type === type);
  return event?.data;
}

function normalizePathForMatch(value: string): string {
  return value.replaceAll("\\", "/").trim().toLowerCase();
}

function collectPotentialPathStrings(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (input: unknown) => {
    if (!input || typeof input !== "object") {
      return;
    }
    if (Array.isArray(input)) {
      for (const entry of input) {
        visit(entry);
      }
      return;
    }
    for (const [key, entry] of Object.entries(input)) {
      if (
        typeof entry === "string" &&
        (key.toLowerCase().includes("path") ||
          entry.endsWith("SKILL.md") ||
          entry.endsWith("skill.md"))
      ) {
        found.add(entry);
      } else {
        visit(entry);
      }
    }
  };
  visit(value);
  return [...found];
}

function markInvokedSkills(params: { skills: unknown; events: TrajectoryEvent[] }): unknown {
  if (!params.skills || typeof params.skills !== "object") {
    return params.skills;
  }
  const skillsRecord = params.skills as {
    entries?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(skillsRecord.entries) || skillsRecord.entries.length === 0) {
    return params.skills;
  }
  const invokedPaths = new Set(
    params.events.flatMap((event) => {
      if (event.type !== "tool.call") {
        return [];
      }
      return collectPotentialPathStrings(event.data?.arguments);
    }),
  );
  const normalizedInvokedPaths = new Set(
    [...invokedPaths].map((value) => normalizePathForMatch(value)),
  );
  const entries = skillsRecord.entries.map((entry) => {
    const rawPath = typeof entry.filePath === "string" ? entry.filePath : undefined;
    const normalizedPath = rawPath ? normalizePathForMatch(rawPath) : undefined;
    const skillDirName =
      rawPath?.replaceAll("\\", "/").split("/").slice(-2, -1)[0]?.toLowerCase() ?? undefined;
    const invoked = normalizedPath
      ? [...normalizedInvokedPaths].some(
          (candidate) =>
            candidate === normalizedPath ||
            candidate.endsWith(normalizedPath) ||
            (skillDirName ? candidate.endsWith(`/${skillDirName}/skill.md`) : false),
        )
      : false;
    return invoked
      ? {
          ...entry,
          invoked,
          invocationDetectedBy: "tool-call-file-path",
        }
      : {
          ...entry,
          invoked: false,
        };
  });
  return {
    ...skillsRecord,
    entries,
  };
}

function buildMetadataCapture(params: {
  manifest: TrajectoryBundleManifest;
  runtimeEvents: TrajectoryEvent[];
  events: TrajectoryEvent[];
}): JsonRecord | undefined {
  const runtimeMetadata = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.metadata");
  if (!runtimeMetadata) {
    return undefined;
  }
  const modelFallback = (() => {
    const latest = params.runtimeEvents
      .slice()
      .toReversed()
      .find((event) => event.provider || event.modelId || event.modelApi);
    if (!latest?.provider && !latest?.modelId && !latest?.modelApi) {
      return undefined;
    }
    return {
      provider: latest.provider,
      name: latest.modelId,
      api: latest.modelApi,
    };
  })();
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.manifest.traceId,
    sessionId: params.manifest.sessionId,
    sessionKey: params.manifest.sessionKey,
    harness: runtimeMetadata.harness,
    model: runtimeMetadata.model ?? modelFallback,
    config: runtimeMetadata.config,
    plugins: runtimeMetadata.plugins,
    skills: markInvokedSkills({
      skills: runtimeMetadata.skills,
      events: params.events,
    }),
    prompting: runtimeMetadata.prompting,
    redaction: runtimeMetadata.redaction,
    metadata: runtimeMetadata.metadata,
  };
}

function buildArtifactsCapture(params: {
  manifest: TrajectoryBundleManifest;
  runtimeEvents: TrajectoryEvent[];
}): JsonRecord | undefined {
  const runtimeArtifacts = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.artifacts");
  const runtimeCompletion = resolveLatestRuntimeEventData(params.runtimeEvents, "model.completed");
  const runtimeEnd = resolveLatestRuntimeEventData(params.runtimeEvents, "session.ended");
  if (!runtimeArtifacts && !runtimeCompletion && !runtimeEnd) {
    return undefined;
  }
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.manifest.traceId,
    sessionId: params.manifest.sessionId,
    sessionKey: params.manifest.sessionKey,
    finalStatus: runtimeArtifacts?.finalStatus ?? runtimeEnd?.status,
    aborted: runtimeArtifacts?.aborted ?? runtimeEnd?.aborted,
    externalAbort: runtimeArtifacts?.externalAbort ?? runtimeEnd?.externalAbort,
    timedOut: runtimeArtifacts?.timedOut ?? runtimeEnd?.timedOut,
    idleTimedOut: runtimeArtifacts?.idleTimedOut ?? runtimeEnd?.idleTimedOut,
    timedOutDuringCompaction:
      runtimeArtifacts?.timedOutDuringCompaction ?? runtimeEnd?.timedOutDuringCompaction,
    timedOutDuringToolExecution:
      runtimeArtifacts?.timedOutDuringToolExecution ?? runtimeEnd?.timedOutDuringToolExecution,
    promptError:
      runtimeArtifacts?.promptError ?? runtimeEnd?.promptError ?? runtimeCompletion?.promptError,
    promptErrorSource: runtimeArtifacts?.promptErrorSource ?? runtimeCompletion?.promptErrorSource,
    terminalError:
      runtimeArtifacts?.terminalError ??
      runtimeEnd?.terminalError ??
      runtimeCompletion?.terminalError,
    usage: runtimeArtifacts?.usage ?? runtimeCompletion?.usage,
    promptCache: runtimeArtifacts?.promptCache ?? runtimeCompletion?.promptCache,
    compactionCount: runtimeArtifacts?.compactionCount ?? runtimeCompletion?.compactionCount,
    assistantTexts: runtimeArtifacts?.assistantTexts ?? runtimeCompletion?.assistantTexts,
    finalPromptText: runtimeArtifacts?.finalPromptText ?? runtimeCompletion?.finalPromptText,
    itemLifecycle: runtimeArtifacts?.itemLifecycle,
    toolMetas: runtimeArtifacts?.toolMetas,
    didSendViaMessagingTool: runtimeArtifacts?.didSendViaMessagingTool,
    successfulCronAdds: runtimeArtifacts?.successfulCronAdds,
    messagingToolSentTexts: runtimeArtifacts?.messagingToolSentTexts,
    messagingToolSentMediaUrls: runtimeArtifacts?.messagingToolSentMediaUrls,
    messagingToolSentTargets: runtimeArtifacts?.messagingToolSentTargets,
    lastToolError: runtimeArtifacts?.lastToolError,
  };
}

function buildPromptsCapture(params: {
  manifest: TrajectoryBundleManifest;
  runtimeEvents: TrajectoryEvent[];
  runtimeContext: RuntimeTrajectoryContext;
}): JsonRecord | undefined {
  const runtimeMetadata = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.metadata");
  const latestCompiled = resolveLatestRuntimeEventData(params.runtimeEvents, "context.compiled");
  const submittedPrompts = params.runtimeEvents
    .filter((event) => event.type === "prompt.submitted")
    .map((event) => event.data?.prompt)
    .filter((prompt): prompt is string => typeof prompt === "string");
  const systemPrompt =
    (typeof latestCompiled?.systemPrompt === "string" ? latestCompiled.systemPrompt : undefined) ??
    params.runtimeContext.systemPrompt;
  const skillsPrompt =
    runtimeMetadata?.prompting &&
    typeof runtimeMetadata.prompting === "object" &&
    typeof (runtimeMetadata.prompting as JsonRecord).skillsPrompt === "string"
      ? ((runtimeMetadata.prompting as JsonRecord).skillsPrompt as string)
      : undefined;
  const userPromptPrefixText =
    runtimeMetadata?.prompting &&
    typeof runtimeMetadata.prompting === "object" &&
    typeof (runtimeMetadata.prompting as JsonRecord).userPromptPrefixText === "string"
      ? ((runtimeMetadata.prompting as JsonRecord).userPromptPrefixText as string)
      : undefined;
  const promptReport =
    runtimeMetadata?.prompting &&
    typeof runtimeMetadata.prompting === "object" &&
    typeof (runtimeMetadata.prompting as JsonRecord).systemPromptReport === "object"
      ? (runtimeMetadata.prompting as JsonRecord).systemPromptReport
      : undefined;
  if (!systemPrompt && submittedPrompts.length === 0 && !skillsPrompt && !userPromptPrefixText) {
    return undefined;
  }
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.manifest.traceId,
    sessionId: params.manifest.sessionId,
    sessionKey: params.manifest.sessionKey,
    system: systemPrompt,
    submittedPrompts,
    latestSubmittedPrompt: submittedPrompts.at(-1),
    skillsPrompt,
    userPromptPrefixText,
    systemPromptReport: promptReport,
  };
}

export function resolveDefaultTrajectoryExportDir(params: {
  workspaceDir: string;
  sessionId: string;
  now?: Date;
}): string {
  const timestamp = (params.now ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sessionFileName = safeTrajectorySessionFileName(params.sessionId);
  return path.join(
    params.workspaceDir,
    ".openclaw",
    "trajectory-exports",
    `openclaw-trajectory-${sessionFileName.slice(0, 8)}-${timestamp}`,
  );
}

export async function exportTrajectoryBundle(params: BuildTrajectoryBundleParams): Promise<{
  manifest: TrajectoryBundleManifest;
  outputDir: string;
  events: TrajectoryEvent[];
  header: SessionHeader | null;
  runtimeFile?: string;
  supplementalFiles: string[];
}> {
  const redaction = buildTrajectoryExportRedaction({
    workspaceDir: params.workspaceDir,
  });
  const sessionStat = await fsp.stat(params.sessionFile);
  if (sessionStat.size > MAX_TRAJECTORY_SESSION_FILE_BYTES) {
    throw new Error(
      `Trajectory session file is too large to export (${sessionStat.size} bytes; limit ${MAX_TRAJECTORY_SESSION_FILE_BYTES})`,
    );
  }
  const {
    header,
    leafId,
    branchEntries,
    warnings: sessionWarnings,
  } = await readSessionBranch(params.sessionFile);
  const runtimeFile = await resolveTrajectoryRuntimeFile({
    runtimeFile: params.runtimeFile,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
  });
  const runtimeParse = runtimeFile
    ? await parseJsonlFile<TrajectoryEvent>(runtimeFile, {
        maxBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
        maxEvents: MAX_TRAJECTORY_RUNTIME_EVENTS,
        include: (value) => value.sessionId === params.sessionId,
        validate: isRuntimeTrajectoryEvent,
      })
    : { events: [], warnings: [] };
  const runtimeEvents = runtimeParse.events;
  const transcriptEvents = buildTranscriptEvents({
    entries: branchEntries,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    traceId: params.sessionId,
  });
  const maxTotalEvents = params.maxTotalEvents ?? MAX_TRAJECTORY_TOTAL_EVENTS;
  const totalEventCount = runtimeEvents.length + transcriptEvents.length;
  if (totalEventCount > maxTotalEvents) {
    throw new Error(
      `Trajectory export has too many events (${totalEventCount}; limit ${maxTotalEvents})`,
    );
  }
  const rawEvents = sortTrajectoryEvents([...runtimeEvents, ...transcriptEvents]);
  const events = rawEvents.map((event) => redactEventForExport(event, redaction));
  const manifest: TrajectoryBundleManifest = {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.sessionId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: maybeRedactPathString(params.workspaceDir, redaction),
    leafId,
    eventCount: events.length,
    runtimeEventCount: runtimeEvents.length,
    transcriptEventCount: transcriptEvents.length,
    sourceFiles: {
      session: maybeRedactPathString(params.sessionFile, redaction),
      runtime:
        runtimeFile && (await isRegularNonSymlinkFile(runtimeFile))
          ? maybeRedactPathString(runtimeFile, redaction)
          : undefined,
    },
  };
  const warnings = summarizeJsonlWarnings([...sessionWarnings, ...runtimeParse.warnings]);
  if (warnings.length > 0) {
    manifest.warnings = warnings;
  }

  const bundleRuntimeContext = resolveRuntimeContext(runtimeEvents);
  const files: DiagnosticSupportBundleFile[] = [];
  const supplementalFiles: string[] = [];
  const metadataCapture = buildMetadataCapture({
    manifest,
    runtimeEvents,
    events: rawEvents,
  });
  const artifactsCapture = buildArtifactsCapture({
    manifest,
    runtimeEvents,
  });
  const promptsCapture = buildPromptsCapture({
    manifest,
    runtimeEvents,
    runtimeContext: bundleRuntimeContext,
  });
  if (metadataCapture) {
    files.push(
      jsonSupportBundleFile("metadata.json", redactLocalPathValues(metadataCapture, redaction)),
    );
    supplementalFiles.push("metadata.json");
  }
  if (artifactsCapture) {
    files.push(
      jsonSupportBundleFile("artifacts.json", redactLocalPathValues(artifactsCapture, redaction)),
    );
    supplementalFiles.push("artifacts.json");
  }
  if (promptsCapture) {
    files.push(
      jsonSupportBundleFile("prompts.json", redactLocalPathValues(promptsCapture, redaction)),
    );
    supplementalFiles.push("prompts.json");
  }
  if (supplementalFiles.length > 0) {
    manifest.supplementalFiles = supplementalFiles;
  }

  files.push(trajectoryJsonlFile("events.jsonl", events));
  files.push(
    jsonSupportBundleFile(
      "session-branch.json",
      redactLocalPathValues(
        sanitizeDiagnosticPayload({
          header,
          leafId,
          entries: branchEntries,
        }),
        redaction,
      ),
    ),
  );
  if (bundleRuntimeContext.systemPrompt) {
    files.push(
      textSupportBundleFile(
        "system-prompt.txt",
        redactLocalPathValues(bundleRuntimeContext.systemPrompt, redaction) as string,
      ),
    );
  }
  if (bundleRuntimeContext.tools) {
    files.push(
      jsonSupportBundleFile(
        "tools.json",
        redactLocalPathValues(bundleRuntimeContext.tools, redaction),
      ),
    );
  }

  const contents: DiagnosticSupportBundleContent[] = [...supportBundleContents(files)];
  manifest.contents = contents;

  await writeSupportBundleDirectory({
    outputDir: params.outputDir,
    files: [jsonSupportBundleFile("manifest.json", manifest), ...files],
  });

  return {
    manifest,
    outputDir: params.outputDir,
    events,
    header,
    runtimeFile:
      runtimeFile && (await isRegularNonSymlinkFile(runtimeFile)) ? runtimeFile : undefined,
    supplementalFiles,
  };
}
