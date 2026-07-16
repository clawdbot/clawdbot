import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveGlobalSingleton,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  parseQmdQueryJson,
  resolveCliSpawnInvocation,
  runCliCommand,
  type QmdQueryResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type {
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { asRecord } from "../dreaming-shared.js";
import { asQmdAbortError, parseFailedQmdSearchJson } from "./qmd-command-errors.js";
import type { MemorySearchDeadlineAction } from "./search-deadline.js";

const log = createSubsystemLogger("memory");
const MCPORTER_STATE_KEY = Symbol.for("openclaw.mcporterState");

type McporterState = {
  coldStartWarned: boolean;
  daemonStart: Promise<void> | null;
};

type BuiltinQmdMcpTool = "query" | "search" | "vector_search" | "deep_search";

export type QmdCommandPhaseReporter = (action: MemorySearchDeadlineAction) => void;

type QmdMcporterSearchParams =
  | {
      mcporter: ResolvedQmdMcporterConfig;
      tool: string;
      searchCommand?: string;
      explicitToolOverride: true;
      query: string;
      limit: number;
      minScore: number;
      collection?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      reportCommandPhase?: QmdCommandPhaseReporter;
    }
  | {
      mcporter: ResolvedQmdMcporterConfig;
      tool: BuiltinQmdMcpTool;
      searchCommand?: string;
      explicitToolOverride: false;
      query: string;
      limit: number;
      minScore: number;
      collection?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      reportCommandPhase?: QmdCommandPhaseReporter;
    };

type QmdMcporterAcrossCollectionsParams =
  | {
      tool: string;
      searchCommand?: string;
      explicitToolOverride: true;
      query: string;
      limit: number;
      minScore: number;
      collectionNames: string[];
      signal?: AbortSignal;
      reportCommandPhase?: QmdCommandPhaseReporter;
    }
  | {
      tool: BuiltinQmdMcpTool;
      searchCommand?: string;
      explicitToolOverride: false;
      query: string;
      limit: number;
      minScore: number;
      collectionNames: string[];
      signal?: AbortSignal;
      reportCommandPhase?: QmdCommandPhaseReporter;
    };

export function resolveQmdMcporterSearchProcessTimeoutMs(timeoutMs: number): number {
  return Math.max(addTimerTimeoutGraceMs(timeoutMs, 2_000) ?? 1, 5_000);
}

function getMcporterState(): McporterState {
  return resolveGlobalSingleton<McporterState>(MCPORTER_STATE_KEY, () => ({
    coldStartWarned: false,
    daemonStart: null,
  }));
}

async function runInQmdCommandPhase<T>(
  report: QmdCommandPhaseReporter | undefined,
  task: () => Promise<T>,
): Promise<T> {
  report?.("pause");
  try {
    return await task();
  } finally {
    report?.("resume");
  }
}

export class QmdCommandClient {
  private qmdMcpToolVersion: "v2" | "v1" | null = null;

  constructor(
    private readonly qmd: ResolvedQmdConfig,
    private readonly env: NodeJS.ProcessEnv,
    private readonly workspaceDir: string,
    private readonly maxOutputChars: number,
  ) {}

  async run(
    args: string[],
    opts?: { timeoutMs?: number; discardOutput?: boolean; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }> {
    return await runCliCommand({
      commandSummary: `qmd ${args.join(" ")}`,
      spawnInvocation: resolveCliSpawnInvocation({
        command: this.qmd.command,
        args,
        env: this.env,
        packageName: "qmd",
      }),
      env: this.env,
      cwd: this.workspaceDir,
      timeoutMs: opts?.timeoutMs,
      maxOutputChars: this.maxOutputChars,
      // Large `qmd update` runs can easily exceed the output cap; keep only stderr.
      discardStdout: opts?.discardOutput,
      signal: opts?.signal,
    });
  }

  async search(
    args: string[],
    command: "query" | "search" | "vsearch",
    signal?: AbortSignal,
    reportCommandPhase?: QmdCommandPhaseReporter,
  ): Promise<QmdQueryResult[]> {
    try {
      const result = await runInQmdCommandPhase(reportCommandPhase, async () =>
        this.run(args, { timeoutMs: this.qmd.limits.timeoutMs, signal }),
      );
      return parseQmdQueryJson(result.stdout, result.stderr);
    } catch (err) {
      const recovered = parseFailedQmdSearchJson(err, command);
      if (recovered) {
        return recovered;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  resolveMcpTool(searchCommand: string): BuiltinQmdMcpTool {
    if (this.qmdMcpToolVersion === "v2") {
      return "query";
    }
    if (this.qmdMcpToolVersion === "v1") {
      return searchCommand === "search"
        ? "search"
        : searchCommand === "vsearch"
          ? "vector_search"
          : "deep_search";
    }
    return "query";
  }

  async searchViaMcporter(params: QmdMcporterSearchParams): Promise<QmdQueryResult[]> {
    if (params.signal?.aborted) {
      throw asQmdAbortError(params.signal);
    }
    await this.ensureMcporterDaemonStarted(params.mcporter);

    const effectiveTool =
      params.tool === "query" && this.qmdMcpToolVersion === "v1"
        ? this.resolveMcpTool(params.searchCommand ?? "query")
        : params.tool;
    const selector = `${params.mcporter.serverName}.${effectiveTool}`;
    const useUnifiedQueryTool = effectiveTool === "query";
    const callArgs: Record<string, unknown> = useUnifiedQueryTool
      ? {
          searches: this.buildV2Searches(params.query, params.searchCommand),
          limit: params.limit,
          ...(params.searchCommand === "search" || params.searchCommand === "vsearch"
            ? { rerank: false }
            : {}),
        }
      : {
          query: params.query,
          limit: params.limit,
          minScore: params.minScore,
        };
    if (params.collection) {
      if (useUnifiedQueryTool) {
        callArgs.collections = [params.collection];
      } else {
        callArgs.collection = params.collection;
      }
    }
    if (
      useUnifiedQueryTool &&
      params.searchCommand === "query" &&
      this.qmd.searchMode === "query" &&
      this.qmd.rerank === false
    ) {
      callArgs.rerank = false;
    }

    let result: { stdout: string };
    try {
      result = await runInQmdCommandPhase(params.reportCommandPhase, async () =>
        this.runMcporter(
          [
            "call",
            selector,
            "--args",
            JSON.stringify(callArgs),
            "--output",
            "json",
            "--timeout",
            String(Math.max(0, params.timeoutMs)),
          ],
          {
            timeoutMs: resolveQmdMcporterSearchProcessTimeoutMs(params.timeoutMs),
            signal: params.signal,
          },
        ),
      );
      if (useUnifiedQueryTool && this.qmdMcpToolVersion === null) {
        this.qmdMcpToolVersion = "v2";
      }
    } catch (err) {
      if (useUnifiedQueryTool && this.isQueryToolNotFoundError(err)) {
        this.markQmdV1Fallback();
        const v1Tool = this.resolveMcpTool(params.searchCommand ?? "query");
        return this.searchViaMcporter({
          mcporter: params.mcporter,
          tool: v1Tool,
          searchCommand: params.searchCommand,
          explicitToolOverride: false,
          query: params.query,
          limit: params.limit,
          minScore: params.minScore,
          collection: params.collection,
          timeoutMs: params.timeoutMs,
          signal: params.signal,
          reportCommandPhase: params.reportCommandPhase,
        });
      }
      throw err;
    }

    return this.parseMcporterResults(result.stdout);
  }

  async searchAcrossCollections(
    params: QmdMcporterAcrossCollectionsParams,
  ): Promise<QmdQueryResult[]> {
    const bestByDocId = new Map<string, QmdQueryResult>();
    for (const collectionName of params.collectionNames) {
      const parsed = params.explicitToolOverride
        ? await this.searchViaMcporter({
            mcporter: this.qmd.mcporter,
            tool: params.tool,
            searchCommand: params.searchCommand,
            explicitToolOverride: true,
            query: params.query,
            limit: params.limit,
            minScore: params.minScore,
            collection: collectionName,
            timeoutMs: this.qmd.limits.timeoutMs,
            signal: params.signal,
            reportCommandPhase: params.reportCommandPhase,
          })
        : await this.searchViaMcporter({
            mcporter: this.qmd.mcporter,
            tool: params.tool,
            searchCommand: params.searchCommand,
            explicitToolOverride: false,
            query: params.query,
            limit: params.limit,
            minScore: params.minScore,
            collection: collectionName,
            timeoutMs: this.qmd.limits.timeoutMs,
            signal: params.signal,
            reportCommandPhase: params.reportCommandPhase,
          });
      for (const entry of parsed) {
        if (typeof entry.docid !== "string" || !entry.docid.trim()) {
          continue;
        }
        const prev = bestByDocId.get(entry.docid);
        const prevScore = typeof prev?.score === "number" ? prev.score : Number.NEGATIVE_INFINITY;
        const nextScore = typeof entry.score === "number" ? entry.score : Number.NEGATIVE_INFINITY;
        if (!prev || nextScore > prevScore) {
          bestByDocId.set(entry.docid, entry);
        }
      }
    }
    return [...bestByDocId.values()].toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private buildV2Searches(
    query: string,
    searchCommand?: string,
  ): Array<{ type: string; query: string }> {
    const semanticQuery = normalizeQmdSemanticQuery(query);
    switch (searchCommand) {
      case "search":
        return [{ type: "lex", query }];
      case "vsearch":
        return [{ type: "vec", query: semanticQuery }];
      default:
        return [
          { type: "lex", query },
          { type: "vec", query: semanticQuery },
          { type: "hyde", query: semanticQuery },
        ];
    }
  }

  private isQueryToolNotFoundError(err: unknown): boolean {
    const message = formatErrorMessage(err);
    const detail = message.match(/ failed \(code \d+\): ([\s\S]*)$/)?.[1];
    if (!detail) {
      return false;
    }
    return /(?:^|\n|:\s)(?:MCP error [^:\n]+:\s*)?Tool ['"]?query['"]? not found\b/i.test(detail);
  }

  private markQmdV1Fallback(): void {
    if (this.qmdMcpToolVersion !== "v1") {
      this.qmdMcpToolVersion = "v1";
      log.warn(
        "QMD MCP server does not expose the v2 'query' tool; falling back to v1 tool names (search/vector_search/deep_search).",
      );
    }
  }

  private async ensureMcporterDaemonStarted(mcporter: ResolvedQmdMcporterConfig): Promise<void> {
    if (!mcporter.enabled) {
      return;
    }
    const state = getMcporterState();
    if (!mcporter.startDaemon) {
      if (!state.coldStartWarned) {
        state.coldStartWarned = true;
        log.warn(
          "mcporter qmd bridge enabled but startDaemon=false; each query may cold-start QMD MCP. Consider setting memory.qmd.mcporter.startDaemon=true to keep it warm.",
        );
      }
      return;
    }
    if (!state.daemonStart) {
      state.daemonStart = (async () => {
        try {
          await this.runMcporter(["daemon", "start"], { timeoutMs: 10_000 });
        } catch (err) {
          log.warn(`mcporter daemon start failed: ${String(err)}`);
          state.daemonStart = null;
        }
      })();
    }
    await state.daemonStart;
  }

  private async runMcporter(
    args: string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }> {
    const spawnInvocation = resolveCliSpawnInvocation({
      command: "mcporter",
      args,
      env: this.env,
      packageName: "mcporter",
    });
    return await runCliCommand({
      commandSummary: `${spawnInvocation.command} ${spawnInvocation.argv.join(" ")}`,
      spawnInvocation,
      env: this.env,
      cwd: this.workspaceDir,
      timeoutMs: opts?.timeoutMs,
      maxOutputChars: this.maxOutputChars,
      signal: opts?.signal,
    });
  }

  private parseMcporterResults(stdout: string): QmdQueryResult[] {
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(stdout);
    } catch {
      throw new Error("qmd mcporter returned non-JSON stdout", {
        cause: new Error("mcporter stdout was not valid JSON"),
      });
    }
    const parsedRecord = asRecord(parsedUnknown);
    const structuredContent = parsedRecord ? asRecord(parsedRecord.structuredContent) : null;
    const structured: unknown = structuredContent ?? parsedUnknown;
    const structuredRecord = asRecord(structured);
    const results: unknown[] =
      structuredRecord && Array.isArray(structuredRecord.results)
        ? (structuredRecord.results as unknown[])
        : Array.isArray(structured)
          ? structured
          : [];

    const out: QmdQueryResult[] = [];
    for (const item of results) {
      const itemRecord = asRecord(item);
      if (!itemRecord) {
        continue;
      }
      const docidRaw = itemRecord.docid;
      const docid = typeof docidRaw === "string" ? docidRaw.replace(/^#/, "").trim() : "";
      if (!docid) {
        continue;
      }
      const scoreRaw = itemRecord.score;
      const score = typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw);
      out.push({
        docid,
        score: Number.isFinite(score) ? score : 0,
        snippet: typeof itemRecord.snippet === "string" ? itemRecord.snippet : "",
        collection: typeof itemRecord.collection === "string" ? itemRecord.collection : undefined,
        file: typeof itemRecord.file === "string" ? itemRecord.file : undefined,
        body: typeof itemRecord.body === "string" ? itemRecord.body : undefined,
        startLine: normalizeSnippetLine(itemRecord.start_line ?? itemRecord.startLine),
        endLine: normalizeSnippetLine(itemRecord.end_line ?? itemRecord.endLine),
      });
    }
    return out;
  }
}

function normalizeSnippetLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeQmdSemanticQuery(query: string): string {
  return query.replace(/(\w)-(?=\w)/g, "$1 ");
}
