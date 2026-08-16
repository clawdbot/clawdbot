import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";

const NOTE_REF_PATTERN = /^note:notes\/knowledge\/[a-z0-9]+(?:_[a-z0-9]+)*$/;
const ABSOLUTE_PATH_PATTERN =
  /(?:file:\/\/|~\/|(?:^|[\s'"`])\/(?:Users|private|tmp|var|home)(?:\/|$)|(?:^|[\s'"`])[A-Za-z]:[\\/])/i;
const DEFAULT_TIMEOUT_MS = 10_000;

export const planningKnowledgeConfigSchema = Type.Object(
  {
    scriptPath: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Explicit OneLibrary planning_knowledge_index.py path.",
      }),
    ),
    sourceRoot: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Explicit notes/knowledge source root.",
      }),
    ),
    indexPath: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Explicit derived planning_personal index path.",
      }),
    ),
    writerScriptPath: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Explicit Planning-owned knowledge_notes.py writer path.",
      }),
    ),
    maintenanceScriptPath: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Explicit read-only Planning knowledge_maintenance.py path.",
      }),
    ),
    pythonExecutable: Type.Optional(
      Type.String({ minLength: 1, description: "Python executable for the OneLibrary CLI." }),
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("text"), Type.Literal("semantic"), Type.Literal("hybrid")]),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 })),
  },
  { additionalProperties: false },
);

type PlanningKnowledgeConfig = Static<typeof planningKnowledgeConfigSchema>;

export const planningKnowledgeSearchParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description: "Question or terms to find in saved Knowledge.",
    }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
  },
  { additionalProperties: false },
);

type PlanningKnowledgeSearchParams = Static<typeof planningKnowledgeSearchParameters>;

export const planningKnowledgeCaptureParameters = Type.Object(
  {
    content: Type.String({
      minLength: 1,
      description: "Content the user explicitly asked to save as personal Knowledge.",
    }),
    title: Type.Optional(Type.String({ minLength: 1 })),
    knowledgeType: Type.Optional(
      Type.Union([
        Type.Literal("principle"),
        Type.Literal("learning"),
        Type.Literal("framework"),
        Type.Literal("concept"),
        Type.Literal("reference"),
        Type.Literal("reflection"),
      ]),
    ),
    sourceType: Type.Optional(
      Type.Union([
        Type.Literal("human"),
        Type.Literal("ai_chat"),
        Type.Literal("meeting"),
        Type.Literal("book"),
        Type.Literal("paper"),
        Type.Literal("article"),
        Type.Literal("web"),
        Type.Literal("document"),
        Type.Literal("other"),
      ]),
    ),
    verificationStatus: Type.Optional(
      Type.Union([
        Type.Literal("unverified"),
        Type.Literal("reviewed"),
        Type.Literal("confirmed"),
        Type.Literal("corrected"),
        Type.Literal("rejected"),
      ]),
    ),
    essence: Type.Optional(Type.String({ minLength: 1 })),
    knowledge: Type.Optional(Type.String({ minLength: 1 })),
    domains: Type.Optional(Type.Array(Type.String())),
    topics: Type.Optional(Type.Array(Type.String())),
    goalRefs: Type.Optional(Type.Array(Type.String())),
    projectRefs: Type.Optional(Type.Array(Type.String())),
    relatedNoteRefs: Type.Optional(Type.Array(Type.String())),
    sourceRefs: Type.Optional(Type.Array(Type.String())),
    supersedes: Type.Optional(Type.Array(Type.String())),
    operationalFollowUp: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Separate reminder/action text, if the request is mixed.",
      }),
    ),
  },
  { additionalProperties: false },
);

type PlanningKnowledgeCaptureParams = Static<typeof planningKnowledgeCaptureParameters>;

type ResolvedPlanningKnowledgeConfig = {
  scriptPath: string;
  sourceRoot: string;
  indexPath: string;
  writerScriptPath?: string;
  maintenanceScriptPath?: string;
  pythonExecutable: string;
  mode: "text" | "semantic" | "hybrid";
  timeoutMs: number;
};

type CommandResult = {
  stdout: string;
  exitCode: number | null;
};

type PlanningKnowledgeCommandRunner = (request: {
  executable: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<CommandResult>;

function isPathInside(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isKnowledgeRoot(value: string): boolean {
  const normalized = resolve(value);
  return basename(normalized) === "knowledge" && basename(dirname(normalized)) === "notes";
}

function requireConfiguredString(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Planning Knowledge ${name} is not configured`);
  }
  return normalized;
}

function resolveConfiguredPath(
  value: string | undefined,
  name: string,
  resolvePath: (input: string) => string | undefined,
): string {
  const configured = requireConfiguredString(value, name);
  if (isAbsolute(configured)) {
    return resolve(configured);
  }
  if (configured === "~" || configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(homedir(), configured.slice(2));
  }

  let resolvedByPlugin: string | undefined;
  try {
    resolvedByPlugin = resolvePath(configured);
  } catch {
    resolvedByPlugin = undefined;
  }
  if (!resolvedByPlugin) {
    throw new Error(`Planning Knowledge ${name} must be an absolute path or a plugin-local path`);
  }
  return resolve(resolvedByPlugin);
}

export function resolvePlanningKnowledgeConfig(
  config: PlanningKnowledgeConfig,
  resolvePath: (input: string) => string | undefined,
): ResolvedPlanningKnowledgeConfig | null {
  if (!config.scriptPath || !config.sourceRoot || !config.indexPath) {
    return null;
  }

  const normalizedSourceRoot = resolveConfiguredPath(config.sourceRoot, "sourceRoot", resolvePath);
  const normalizedScriptPath = resolveConfiguredPath(config.scriptPath, "scriptPath", resolvePath);
  const normalizedIndexPath = resolveConfiguredPath(config.indexPath, "indexPath", resolvePath);
  const normalizedWriterScriptPath = config.writerScriptPath
    ? resolveConfiguredPath(config.writerScriptPath, "writerScriptPath", resolvePath)
    : undefined;
  const normalizedMaintenanceScriptPath = config.maintenanceScriptPath
    ? resolveConfiguredPath(config.maintenanceScriptPath, "maintenanceScriptPath", resolvePath)
    : undefined;

  if (!isKnowledgeRoot(normalizedSourceRoot)) {
    throw new Error("Planning Knowledge sourceRoot must end in notes/knowledge");
  }
  if (basename(normalizedScriptPath) !== "planning_knowledge_index.py") {
    throw new Error("Planning Knowledge scriptPath must be OneLibrary planning_knowledge_index.py");
  }
  if (normalizedWriterScriptPath && basename(normalizedWriterScriptPath) !== "knowledge_notes.py") {
    throw new Error("Planning Knowledge writerScriptPath must be Planning knowledge_notes.py");
  }
  if (
    normalizedMaintenanceScriptPath &&
    basename(normalizedMaintenanceScriptPath) !== "knowledge_maintenance.py"
  ) {
    throw new Error(
      "Planning Knowledge maintenanceScriptPath must be Planning knowledge_maintenance.py",
    );
  }
  if (isPathInside(normalizedIndexPath, normalizedSourceRoot)) {
    throw new Error("Planning Knowledge indexPath must be outside the canonical source root");
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error("Planning Knowledge timeoutMs is outside the allowed range");
  }

  return {
    scriptPath: normalizedScriptPath,
    sourceRoot: normalizedSourceRoot,
    indexPath: normalizedIndexPath,
    ...(normalizedWriterScriptPath ? { writerScriptPath: normalizedWriterScriptPath } : {}),
    ...(normalizedMaintenanceScriptPath
      ? { maintenanceScriptPath: normalizedMaintenanceScriptPath }
      : {}),
    pythonExecutable: config.pythonExecutable?.trim() || "python3",
    mode: config.mode ?? "text",
    timeoutMs,
  };
}

function runCommand(request: {
  executable: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(request.executable, request.args, {
      shell: false,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Planning Knowledge retrieval timed out"));
    }, request.timeoutMs);

    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("Planning Knowledge retrieval was cancelled"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
    };

    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else if (result) {
        resolveResult(result);
      }
    };

    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.stdin !== undefined) {
      child.stdin?.end(request.stdin);
    }
    const stdoutStream = child.stdout;
    if (!stdoutStream) {
      finish(new Error("Planning Knowledge command returned no stdout"));
      return;
    }
    stdoutStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => finish(new Error("Planning Knowledge adapter is unavailable")));
    child.once("close", (exitCode) => finish(undefined, { stdout, exitCode }));
  });
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(isString)) {
    throw new Error("Planning Knowledge returned invalid metadata");
  }
  return value.slice();
}

function assertNoAbsolutePath(value: unknown): void {
  if (isString(value) && ABSOLUTE_PATH_PATTERN.test(value)) {
    throw new Error("Planning Knowledge result contained a local path");
  }
}

function safeSearchResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Planning Knowledge returned an invalid result");
  }
  const record = value as Record<string, unknown>;
  const canonicalRef = record.canonical_ref;
  const status = record.status;
  const verificationStatus = record.verification_status;
  if (!isString(canonicalRef) || !NOTE_REF_PATTERN.test(canonicalRef)) {
    throw new Error("Planning Knowledge result is missing a valid canonical note ref");
  }
  if (status !== "active" || verificationStatus === "rejected") {
    throw new Error("Planning Knowledge returned an ineligible result");
  }
  if (!isString(record.title) || !isString(record.snippet)) {
    throw new Error("Planning Knowledge returned incomplete result metadata");
  }
  const domains = safeStringArray(record.domains);
  const topics = safeStringArray(record.topics);
  const projectRefs = safeStringArray(record.project_refs);
  const goalRefs = safeStringArray(record.goal_refs);
  if (!isString(record.knowledge_type) || !isString(record.source_type)) {
    throw new Error("Planning Knowledge returned incomplete result metadata");
  }
  for (const candidate of [
    canonicalRef,
    record.title,
    record.snippet,
    ...domains,
    ...topics,
    ...projectRefs,
    ...goalRefs,
  ]) {
    assertNoAbsolutePath(candidate);
  }
  return {
    canonical_ref: canonicalRef,
    title: record.title,
    snippet: record.snippet,
    ...(typeof record.score === "number" && Number.isFinite(record.score)
      ? { score: record.score }
      : {}),
    knowledge_type: record.knowledge_type,
    status,
    verification_status: verificationStatus,
    domains,
    topics,
    project_refs: projectRefs,
    goal_refs: goalRefs,
    source_type: record.source_type,
    ...(isString(record.created_at) ? { created_at: record.created_at } : {}),
    ...(isString(record.updated_at) ? { updated_at: record.updated_at } : {}),
  };
}

function parseSearchOutput(stdout: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Planning Knowledge adapter returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Planning Knowledge adapter returned an invalid response");
  }
  const results = (parsed as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    throw new Error("Planning Knowledge adapter returned no result list");
  }
  return results.map(safeSearchResult);
}

function parseCommandObject(stdout: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Planning Knowledge ${label} returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Planning Knowledge ${label} returned an invalid response`);
  }
  return parsed as Record<string, unknown>;
}

function assertPortableCommandObject(value: unknown): void {
  if (isString(value)) {
    assertNoAbsolutePath(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertPortableCommandObject(item);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertPortableCommandObject(item);
    }
  }
}

function parseCaptureResult(stdout: string): {
  status: "created" | "already_exists";
  title: string;
  canonical_ref: string;
} {
  const result = parseCommandObject(stdout, "Planning writer");
  const status = result.status;
  const title = result.title;
  const canonicalRef = result.canonical_ref;
  if (status !== "created" && status !== "already_exists") {
    throw new Error("Planning writer returned an unexpected status");
  }
  if (!isString(title) || !title.trim()) {
    throw new Error("Planning writer returned no title");
  }
  if (!isString(canonicalRef) || !NOTE_REF_PATTERN.test(canonicalRef)) {
    throw new Error("Planning writer returned an invalid canonical note ref");
  }
  assertPortableCommandObject({ title, canonical_ref: canonicalRef });
  return { status, title, canonical_ref: canonicalRef };
}

function parseSyncResult(stdout: string): Record<string, unknown> {
  const result = parseCommandObject(stdout, "OneLibrary sync");
  assertPortableCommandObject(result);
  return result;
}

export function createPlanningKnowledgeSearchTool(
  config: ResolvedPlanningKnowledgeConfig,
  runner: PlanningKnowledgeCommandRunner = runCommand,
  options: { authorized?: boolean } = {},
) {
  return {
    name: "planning_knowledge_search",
    label: "Planning Knowledge Search",
    description:
      "Search private Planning-owned personal Knowledge Notes through OneLibrary. Results are derived and must be cited with canonical note:notes/knowledge/<slug> refs.",
    parameters: planningKnowledgeSearchParameters,
    optional: true,
    async execute(
      _toolCallId: string,
      params: PlanningKnowledgeSearchParams,
      signal?: AbortSignal,
    ) {
      if (options.authorized === false) {
        throw new Error("Planning Knowledge access denied");
      }
      const query = params.query.trim();
      if (!query) {
        throw new Error("query required");
      }
      const limit = params.limit ?? 5;
      const result = await runner({
        executable: config.pythonExecutable,
        args: [
          config.scriptPath,
          "search",
          "--root",
          config.sourceRoot,
          "--index",
          config.indexPath,
          "--query",
          query,
          "--limit",
          String(limit),
          "--mode",
          config.mode,
        ],
        timeoutMs: config.timeoutMs,
        signal,
      });
      if (result.exitCode !== 0) {
        throw new Error("Planning Knowledge retrieval is unavailable");
      }
      const results = parseSearchOutput(result.stdout);
      return jsonResult({
        source_system: "planning",
        record_type: "knowledge",
        corpus: "planning_personal",
        security_scope: "personal",
        query,
        results,
        count: results.length,
        ...(results.length === 0
          ? { message: "No stored Planning Knowledge Note found for this query." }
          : {}),
      });
    },
  };
}

export function createPlanningKnowledgeCaptureTool(
  config?: ResolvedPlanningKnowledgeConfig,
  runner: PlanningKnowledgeCommandRunner = runCommand,
) {
  return {
    name: "planning_knowledge_capture",
    label: config?.writerScriptPath
      ? "Planning Knowledge Capture"
      : "Planning Knowledge Capture (disabled)",
    description: config?.writerScriptPath
      ? "Create an explicitly requested Planning Knowledge Note through the Planning-owned writer, then refresh the derived OneLibrary index. Never create tasks or calendar events."
      : "Recognize explicit requests to save personal Knowledge without writing in PLN-500A.",
    parameters: planningKnowledgeCaptureParameters,
    optional: true,
    async execute(
      _toolCallId: string,
      params: PlanningKnowledgeCaptureParams,
      signal?: AbortSignal,
    ) {
      if (!config?.writerScriptPath) {
        return jsonResult({
          intent: "knowledge_capture",
          status: "capture_not_enabled_in_pln_500a",
          write_performed: false,
          canonical_owner: "planning",
          operational_follow_up: params.operationalFollowUp?.trim() ? "route_separately" : "none",
        });
      }

      const title = params.title?.trim();
      const knowledgeType = params.knowledgeType;
      const sourceType = params.sourceType;
      const verificationStatus = params.verificationStatus;
      if (!title || !knowledgeType || !sourceType || !verificationStatus) {
        throw new Error(
          "Planning Knowledge capture requires title, knowledgeType, sourceType, and verificationStatus",
        );
      }
      const content = params.content.trim();
      if (!content) {
        throw new Error("Planning Knowledge capture content required");
      }
      const writerPayload: Record<string, unknown> = {
        title,
        knowledge_type: knowledgeType,
        source_type: sourceType,
        verification_status: verificationStatus,
        content: {
          essence: params.essence?.trim() || content,
          knowledge: params.knowledge?.trim() || content,
        },
      };
      for (const [input, output] of [
        ["domains", "domains"],
        ["topics", "topics"],
        ["goalRefs", "goal_refs"],
        ["projectRefs", "project_refs"],
        ["relatedNoteRefs", "related_note_refs"],
        ["sourceRefs", "source_refs"],
        ["supersedes", "supersedes"],
      ] as const) {
        const value = params[input];
        if (value !== undefined) {
          writerPayload[output] = value;
        }
      }

      const writerResult = await runner({
        executable: config.pythonExecutable,
        args: [
          config.writerScriptPath,
          "create",
          "--root",
          dirname(dirname(config.sourceRoot)),
          "--input",
          "-",
        ],
        stdin: JSON.stringify(writerPayload),
        timeoutMs: config.timeoutMs,
        signal,
      });
      if (writerResult.exitCode !== 0) {
        const error = parseCommandObject(writerResult.stdout, "Planning writer");
        throw new Error(
          isString(error.message) ? error.message : "Planning Knowledge capture failed",
        );
      }
      const created = parseCaptureResult(writerResult.stdout);

      const syncResult = await runner({
        executable: config.pythonExecutable,
        args: [
          config.scriptPath,
          "sync",
          "--root",
          config.sourceRoot,
          "--index",
          config.indexPath,
          "--mode",
          config.mode,
        ],
        timeoutMs: config.timeoutMs,
        signal,
      });
      if (syncResult.exitCode !== 0) {
        throw new Error("Planning Knowledge derived index sync failed");
      }
      const synced = parseSyncResult(syncResult.stdout);
      return jsonResult({
        intent: "knowledge_capture",
        status: created.status,
        write_performed: created.status === "created",
        canonical_owner: "planning",
        canonical_ref: created.canonical_ref,
        title: created.title,
        corpus: "planning_personal",
        derived_sync: "completed",
        sync_summary: {
          inserted_records: synced.inserted_records,
          updated_records: synced.updated_records,
          unchanged_records: synced.unchanged_records,
        },
        operational_follow_up: params.operationalFollowUp?.trim() ? "route_separately" : "none",
      });
    },
  };
}

export const planningKnowledgeMaintenanceParameters = Type.Object(
  {
    trigger: Type.Optional(
      Type.Union([Type.Literal("manual"), Type.Literal("scheduled"), Type.Literal("openclaw")]),
    ),
  },
  { additionalProperties: false },
);

export function createPlanningKnowledgeMaintenanceTool(
  config: ResolvedPlanningKnowledgeConfig,
  runner: PlanningKnowledgeCommandRunner = runCommand,
  options: { authorized?: boolean } = {},
) {
  return {
    name: "planning_knowledge_maintenance",
    label: "Planning Knowledge Maintenance",
    description:
      "Run bounded Level-A Planning Knowledge validation, health, quality and read-only OneLibrary audit. It cannot write canonical Notes, repair derived state, accept Candidates, migrate schemas or restore backups.",
    parameters: planningKnowledgeMaintenanceParameters,
    optional: true,
    async execute(
      _toolCallId: string,
      params: Static<typeof planningKnowledgeMaintenanceParameters>,
      signal?: AbortSignal,
    ) {
      if (options.authorized === false) {
        throw new Error("Planning Knowledge maintenance access denied");
      }
      if (!config.maintenanceScriptPath) {
        throw new Error("Planning Knowledge maintenance is not configured");
      }
      const result = await runner({
        executable: config.pythonExecutable,
        args: [
          config.maintenanceScriptPath,
          "run",
          "--root",
          dirname(dirname(config.sourceRoot)),
          "--onelibrary-script",
          config.scriptPath,
          "--index",
          config.indexPath,
          "--python",
          config.pythonExecutable,
          "--trigger",
          params.trigger ?? "openclaw",
          "--runtime-tool-visible",
        ],
        timeoutMs: config.timeoutMs,
        signal,
      });
      if (result.exitCode !== 0) {
        throw new Error("Planning Knowledge maintenance failed closed");
      }
      const parsed = parseCommandObject(result.stdout, "maintenance");
      if (
        parsed.schema !== "planning_knowledge_maintenance" ||
        parsed.schema_version !== 1 ||
        parsed.read_only !== true
      ) {
        throw new Error("Planning Knowledge maintenance returned an invalid contract");
      }
      assertPortableCommandObject(parsed);
      return jsonResult(parsed);
    },
  };
}
