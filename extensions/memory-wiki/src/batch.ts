import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyMemoryWikiMutation } from "./apply.js";
import { compileMemoryWikiVault, type CompileMemoryWikiResult } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  assertMemoryWikiSourceBuffer,
  ingestMemoryWikiSourceBatchOperation,
  type IngestMemoryWikiEvidence,
} from "./ingest.js";
import { slugifyWikiPageStem } from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import {
  boundedWikiBatchHit,
  searchMemoryWikiBatch,
  type WikiBatchSearchQuery,
} from "./query-batch.js";
import { WIKI_SEARCH_MODES, type WikiSearchMode } from "./query.js";
import { initializeMemoryWikiVault } from "./vault.js";

const BATCH_INPUT_MAX_BYTES = 256 * 1024;
const BATCH_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
const BATCH_SOURCES_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
const BATCH_SYNTHESIS_MAX_BYTES = 1024 * 1024;
const BATCH_MAX_OPERATIONS = 16;
const BATCH_MAX_QUERIES = 6;
const BATCH_MAX_RESULTS = 10;
const BATCH_REPORT_HITS = 5;
const BATCH_UPDATED_FILES_MAX = 50;
const BATCH_ERRORS_MAX = 20;
const BATCH_PAGE_TYPES = new Set(["source", "synthesis", "entity", "concept", "report"]);
const BATCH_PAGE_DIRS = new Set(["sources", "syntheses", "entities", "concepts", "reports"]);

type JsonRecord = Record<string, unknown>;

type IngestSourceOperation = {
  id: string;
  kind: "ingest-source";
  inputPath: string;
  sourceBuffer: Buffer;
  title: string;
  evidence?: IngestMemoryWikiEvidence;
};

type UpsertSynthesisOperation = {
  id: string;
  kind: "upsert-synthesis";
  title: string;
  body: string;
  sourceRefs: string[];
  sourceIds: string[];
  confidence?: number;
  status?: string;
};

type ApplyBatchOperation = IngestSourceOperation | UpsertSynthesisOperation;

type SearchBatchItem = WikiBatchSearchQuery & {
  expectedPaths: string[];
  expectedIds: string[];
  expectedPageTypes: string[];
  required: boolean;
};

function requiredString(record: JsonRecord, key: string): string {
  const value = typeof record[key] === "string" ? record[key].trim() : "";
  if (!value) {
    throw new Error(`wiki batch requires non-empty ${key}.`);
  }
  return value;
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = typeof record[key] === "string" ? record[key].trim() : "";
  return value || undefined;
}

function requiredNonNegativeFiniteNumber(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`wiki batch requires non-negative finite numeric ${key}.`);
  }
  return value;
}

function stringList(record: JsonRecord, key: string): string[] {
  const raw = record[key];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`wiki batch ${key} must be an array.`);
  }
  return [...new Set(raw.map((value) => String(value).trim()).filter(Boolean))];
}

function expectedWikiPathList(record: JsonRecord): string[] {
  return stringList(record, "expectedPaths").map((value) => {
    const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
    const pageDir = normalized.split("/", 1)[0];
    if (
      path.posix.isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      !normalized.endsWith(".md") ||
      !pageDir ||
      !BATCH_PAGE_DIRS.has(pageDir)
    ) {
      throw new Error(`wiki search-batch expectedPaths contains an invalid wiki path: ${value}`);
    }
    return normalized;
  });
}

function registerTarget(targets: Set<string>, directory: string, title: string): void {
  const target = `${directory}/${slugifyWikiPageStem(title)}.md`;
  if (targets.has(target)) {
    throw new Error(`wiki apply-batch operations target the same page: ${target}`);
  }
  targets.add(target);
}

function boundedInteger(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("wiki batch maxResults must be a positive integer.");
  }
  return Math.min(value, BATCH_MAX_RESULTS);
}

async function readBatchInput(inputPath: string): Promise<JsonRecord> {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error("wiki batch input must be a regular file.");
  }
  if (stat.size > BATCH_INPUT_MAX_BYTES) {
    throw new Error(`wiki batch input exceeds ${BATCH_INPUT_MAX_BYTES} bytes.`);
  }
  const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error("wiki batch input must be a version 1 JSON object.");
  }
  return parsed;
}

function normalizeEvidence(value: unknown): IngestMemoryWikiEvidence | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("wiki batch evidence must be an object.");
  }
  return {
    sourceType: requiredString(value, "sourceType"),
    type: requiredString(value, "type"),
    kind: requiredString(value, "kind"),
    origin: requiredString(value, "origin"),
    directness: requiredString(value, "directness"),
    weight: requiredNonNegativeFiniteNumber(value, "weight"),
  };
}

async function normalizeApplyOperations(input: JsonRecord): Promise<ApplyBatchOperation[]> {
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new Error("wiki apply-batch requires at least one operation.");
  }
  if (input.operations.length > BATCH_MAX_OPERATIONS) {
    throw new Error(`wiki apply-batch accepts at most ${BATCH_MAX_OPERATIONS} operations.`);
  }
  const ids = new Set<string>();
  const operations: ApplyBatchOperation[] = [];
  const targets = new Set<string>();
  let sourceBytes = 0;
  for (const raw of input.operations) {
    if (!isRecord(raw)) {
      throw new Error("wiki apply-batch operations must be objects.");
    }
    const id = requiredString(raw, "id");
    if (ids.has(id)) {
      throw new Error(`wiki apply-batch operation id is duplicated: ${id}`);
    }
    ids.add(id);
    const kind = requiredString(raw, "kind");
    if (kind === "ingest-source") {
      const title = requiredString(raw, "title");
      registerTarget(targets, "sources", title);
      const inputPath = path.resolve(requiredString(raw, "inputPath"));
      const sourceStat = await fs.stat(inputPath);
      if (!sourceStat.isFile()) {
        throw new Error("ingest-source inputPath must be a regular file.");
      }
      if (sourceStat.size > BATCH_SOURCE_MAX_BYTES) {
        throw new Error(`ingest-source input exceeds ${BATCH_SOURCE_MAX_BYTES} bytes.`);
      }
      const sourceBuffer = await fs.readFile(inputPath);
      if (sourceBuffer.byteLength > BATCH_SOURCE_MAX_BYTES) {
        throw new Error(`ingest-source input exceeds ${BATCH_SOURCE_MAX_BYTES} bytes.`);
      }
      assertMemoryWikiSourceBuffer(sourceBuffer, inputPath);
      sourceBytes += sourceBuffer.byteLength;
      if (sourceBytes > BATCH_SOURCES_TOTAL_MAX_BYTES) {
        throw new Error(
          `ingest-source inputs exceed ${BATCH_SOURCES_TOTAL_MAX_BYTES} total bytes.`,
        );
      }
      operations.push({
        id,
        kind,
        inputPath,
        sourceBuffer,
        title,
        ...(raw.evidence !== undefined ? { evidence: normalizeEvidence(raw.evidence) } : {}),
      });
      continue;
    }
    if (kind !== "upsert-synthesis") {
      throw new Error(`wiki apply-batch operation kind is unsupported: ${kind}`);
    }
    const title = requiredString(raw, "title");
    registerTarget(targets, "syntheses", title);
    const body = optionalString(raw, "body");
    const bodyFile = optionalString(raw, "bodyFile");
    if (Boolean(body) === Boolean(bodyFile)) {
      throw new Error("upsert-synthesis requires exactly one of body or bodyFile.");
    }
    let resolvedBody = body;
    if (bodyFile) {
      const bodyPath = path.resolve(bodyFile);
      const bodyStat = await fs.stat(bodyPath);
      if (!bodyStat.isFile()) {
        throw new Error("upsert-synthesis bodyFile must be a regular file.");
      }
      if (bodyStat.size > BATCH_SYNTHESIS_MAX_BYTES) {
        throw new Error(`upsert-synthesis body exceeds ${BATCH_SYNTHESIS_MAX_BYTES} bytes.`);
      }
      resolvedBody = await fs.readFile(bodyPath, "utf8");
    }
    if (Buffer.byteLength(resolvedBody as string) > BATCH_SYNTHESIS_MAX_BYTES) {
      throw new Error(`upsert-synthesis body exceeds ${BATCH_SYNTHESIS_MAX_BYTES} bytes.`);
    }
    const sourceRefs = stringList(raw, "sourceRefs");
    const sourceIds = stringList(raw, "sourceIds");
    if (sourceRefs.length === 0 && sourceIds.length === 0) {
      throw new Error("upsert-synthesis requires sourceRefs or sourceIds.");
    }
    const confidence = raw.confidence;
    if (
      confidence !== undefined &&
      (typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1)
    ) {
      throw new Error("upsert-synthesis confidence must be between 0 and 1.");
    }
    const status = optionalString(raw, "status");
    operations.push({
      id,
      kind,
      title,
      body: resolvedBody as string,
      sourceRefs,
      sourceIds,
      ...(typeof confidence === "number" ? { confidence } : {}),
      ...(status ? { status } : {}),
    });
  }
  const availableSourceRefs = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "ingest-source") {
      availableSourceRefs.add(operation.id);
      continue;
    }
    for (const sourceRef of operation.sourceRefs) {
      if (!availableSourceRefs.has(sourceRef)) {
        throw new Error(
          `upsert-synthesis sourceRef must name an earlier ingest-source: ${sourceRef}`,
        );
      }
    }
  }
  return operations;
}

function summarizeCompile(
  config: ResolvedMemoryWikiConfig,
  compile: CompileMemoryWikiResult | undefined,
) {
  if (!compile) {
    return null;
  }
  return {
    pageCounts: compile.pageCounts,
    pageCount: compile.pages.length,
    claimCount: compile.claimCount,
    updatedFileCount: compile.updatedFiles.length,
    updatedFiles: compile.updatedFiles
      .slice(0, BATCH_UPDATED_FILES_MAX)
      .map((filePath) => path.relative(config.vault.path, filePath).replace(/\\/g, "/")),
    frontmatterErrorCount: compile.frontmatterErrors.length,
    frontmatterErrors: compile.frontmatterErrors.slice(0, BATCH_ERRORS_MAX),
  };
}

export async function runMemoryWikiApplyBatch(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  dryRun?: boolean;
}) {
  const startedAt = performance.now();
  const input = await readBatchInput(params.inputPath);
  const operations = await normalizeApplyOperations(input);
  return await withMemoryWikiVaultMutation(params.config.vault.path, async () => {
    let changed = false;
    if (!params.dryRun) {
      const initialization = await initializeMemoryWikiVault(params.config);
      changed = initialization.created;
    }
    const sourceIdsByRef = new Map<string, string>();
    const results: Array<Record<string, unknown>> = [];
    for (const operation of operations) {
      if (operation.kind === "ingest-source") {
        const result = await ingestMemoryWikiSourceBatchOperation({
          config: params.config,
          inputPath: operation.inputPath,
          sourceBuffer: operation.sourceBuffer,
          title: operation.title,
          evidence: operation.evidence,
          dryRun: params.dryRun,
        });
        sourceIdsByRef.set(operation.id, result.pageId);
        changed ||= result.changed;
        results.push({
          id: operation.id,
          kind: operation.kind,
          changed: result.changed,
          created: result.created,
          pageId: result.pageId,
          pagePath: result.pagePath,
          bytes: result.bytes,
        });
        continue;
      }
      const resolvedSourceIds = [
        ...operation.sourceIds,
        ...operation.sourceRefs.map((ref) => {
          const sourceId = sourceIdsByRef.get(ref);
          if (!sourceId) {
            throw new Error(
              `upsert-synthesis sourceRef must name an earlier ingest-source: ${ref}`,
            );
          }
          return sourceId;
        }),
      ];
      const result = await applyMemoryWikiMutation({
        config: params.config,
        mutation: {
          op: "create_synthesis",
          title: operation.title,
          body: operation.body,
          sourceIds: [...new Set(resolvedSourceIds)],
          ...(typeof operation.confidence === "number" ? { confidence: operation.confidence } : {}),
          ...(operation.status ? { status: operation.status } : {}),
        },
        compile: false,
        dryRun: params.dryRun,
        initialize: false,
      });
      changed ||= result.changed;
      results.push({
        id: operation.id,
        kind: operation.kind,
        changed: result.changed,
        pageId: result.pageId,
        pagePath: result.pagePath,
      });
    }
    const compile =
      changed && !params.dryRun ? await compileMemoryWikiVault(params.config) : undefined;
    return {
      version: 1,
      dryRun: params.dryRun === true,
      changed,
      operationCount: operations.length,
      operations: results,
      compile: summarizeCompile(params.config, compile),
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}

function normalizeSearchQueries(input: JsonRecord): SearchBatchItem[] {
  if (!Array.isArray(input.queries) || input.queries.length === 0) {
    throw new Error("wiki search-batch requires at least one query.");
  }
  if (input.queries.length > BATCH_MAX_QUERIES) {
    throw new Error(`wiki search-batch accepts at most ${BATCH_MAX_QUERIES} queries.`);
  }
  const ids = new Set<string>();
  return input.queries.map((raw) => {
    if (!isRecord(raw)) {
      throw new Error("wiki search-batch queries must be objects.");
    }
    const id = requiredString(raw, "id");
    if (ids.has(id)) {
      throw new Error(`wiki search-batch query id is duplicated: ${id}`);
    }
    ids.add(id);
    const mode = (optionalString(raw, "mode") ?? "auto") as WikiSearchMode;
    if (!(WIKI_SEARCH_MODES as readonly string[]).includes(mode)) {
      throw new Error(`wiki search-batch mode is unsupported: ${mode}`);
    }
    const expectedPaths = expectedWikiPathList(raw);
    const expectedIds = stringList(raw, "expectedIds");
    if (expectedPaths.length === 0 && expectedIds.length === 0) {
      throw new Error(`wiki search-batch query requires an expected path or id: ${id}`);
    }
    const expectedPageTypes = stringList(raw, "expectedPageTypes");
    if (expectedPageTypes.some((pageType) => !BATCH_PAGE_TYPES.has(pageType))) {
      throw new Error(`wiki search-batch expectedPageTypes is invalid: ${id}`);
    }
    return {
      id,
      query: requiredString(raw, "query"),
      maxResults: boundedInteger(raw.maxResults, BATCH_MAX_RESULTS),
      mode,
      expectedPaths,
      expectedIds,
      expectedPageTypes,
      required: raw.required !== false,
    };
  });
}

export async function runMemoryWikiSearchBatch(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
}) {
  const startedAt = performance.now();
  const input = await readBatchInput(params.inputPath);
  const queries = normalizeSearchQueries(input);
  const searched = await searchMemoryWikiBatch({
    config: params.config,
    queries: queries.map(({ id, query, maxResults, mode, expectedPaths, expectedIds }) => ({
      id,
      query,
      maxResults,
      mode,
      expectedPaths,
      expectedIds,
    })),
  });
  const byId = new Map(searched.map((item) => [item.id, item] as const));
  const results = queries.map((query) => {
    const item = byId.get(query.id);
    const hits = item?.results ?? [];
    const expectedPaths = new Set(query.expectedPaths);
    const expectedIds = new Set(query.expectedIds.map((value) => value.toLowerCase()));
    const expectedPageTypes = new Set(query.expectedPageTypes.map((value) => value.toLowerCase()));
    const match = hits.find((hit) => {
      const targetMatches =
        expectedPaths.has(hit.path) || Boolean(hit.id && expectedIds.has(hit.id.toLowerCase()));
      const pageTypeMatches =
        expectedPageTypes.size === 0 || expectedPageTypes.has(hit.kind.toLowerCase());
      return targetMatches && pageTypeMatches;
    });
    return {
      id: query.id,
      query: query.query,
      required: query.required,
      ok: Boolean(match),
      matchedPath: match?.path ?? null,
      matchedId: match?.id ?? null,
      candidatePageCount: item?.candidatePageCount ?? 0,
      resultCount: hits.length,
      hits: hits.slice(0, BATCH_REPORT_HITS).map(boundedWikiBatchHit),
    };
  });
  const failed = results.filter((result) => result.required && !result.ok);
  if (failed.length > 0) {
    throw new Error(
      `wiki search-batch required verification failed: ${failed.map((item) => item.id).join(", ")}`,
    );
  }
  return {
    version: 1,
    queryCount: queries.length,
    ok: true,
    results,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
