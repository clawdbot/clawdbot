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

export type PlanningKnowledgeConfig = Static<typeof planningKnowledgeConfigSchema>;

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

export type PlanningKnowledgeSearchParams = Static<typeof planningKnowledgeSearchParameters>;

export const planningKnowledgeCaptureParameters = Type.Object(
  {
    content: Type.String({
      minLength: 1,
      description: "Content the user explicitly asked to save as personal Knowledge.",
    }),
    operationalFollowUp: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Separate reminder/action text, if the request is mixed.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type PlanningKnowledgeCaptureParams = Static<typeof planningKnowledgeCaptureParameters>;

type ResolvedPlanningKnowledgeConfig = {
  scriptPath: string;
  sourceRoot: string;
  indexPath: string;
  pythonExecutable: string;
  mode: "text" | "semantic" | "hybrid";
  timeoutMs: number;
};

type CommandResult = {
  stdout: string;
  exitCode: number | null;
};

export type PlanningKnowledgeCommandRunner = (request: {
  executable: string;
  args: string[];
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

  if (!isKnowledgeRoot(normalizedSourceRoot)) {
    throw new Error("Planning Knowledge sourceRoot must end in notes/knowledge");
  }
  if (basename(normalizedScriptPath) !== "planning_knowledge_index.py") {
    throw new Error("Planning Knowledge scriptPath must be OneLibrary planning_knowledge_index.py");
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
    pythonExecutable: config.pythonExecutable?.trim() || "python3",
    mode: config.mode ?? "text",
    timeoutMs,
  };
}

function runCommand(request: {
  executable: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(request.executable, request.args, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
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
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
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

export function createPlanningKnowledgeCaptureTool() {
  return {
    name: "planning_knowledge_capture",
    label: "Planning Knowledge Capture (disabled)",
    description:
      "Recognize explicit requests to save personal Knowledge without writing in PLN-500A.",
    parameters: planningKnowledgeCaptureParameters,
    optional: true,
    async execute(_toolCallId: string, params: PlanningKnowledgeCaptureParams) {
      return jsonResult({
        intent: "knowledge_capture",
        status: "capture_not_enabled_in_pln_500a",
        write_performed: false,
        canonical_owner: "planning",
        operational_follow_up: params.operationalFollowUp?.trim() ? "route_separately" : "none",
      });
    },
  };
}
