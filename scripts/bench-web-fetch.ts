// Web fetch benchmark covers direct response loading, HTML extraction, and fallback cleanup.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { extractBasicHtmlContent } from "../src/agents/tools/web-fetch-utils.js";
import { createWebFetchTool } from "../src/agents/tools/web-fetch.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { LookupFn } from "../src/infra/net/ssrf.js";
import { extractReadableContent } from "../src/web-fetch/content-extractors.runtime.js";
import * as cliArgs from "./lib/arg-utils.mts";

type BenchmarkCaseId =
  | "tool-create"
  | "tool-text"
  | "tool-markdown"
  | "tool-html-article"
  | "tool-html-article-text"
  | "tool-html-shell"
  | "extract-readable-article"
  | "extract-readable-article-text"
  | "extract-basic-shell";

type BenchmarkCase = {
  id: BenchmarkCaseId;
  label: string;
  run: () => Promise<void> | void;
};

type Options = {
  cases: BenchmarkCaseId[];
  json: boolean;
  output?: string;
  runs: number;
  warmup: number;
};

type SummaryStats = {
  avg: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
};

type CaseReport = {
  id: BenchmarkCaseId;
  label: string;
  samplesMs: number[];
  summaryMs: SummaryStats;
};

type BenchmarkReport = {
  cases: CaseReport[];
  node: string;
  options: Omit<Options, "json">;
  rssMb: number;
};

const ALL_CASE_IDS = [
  "tool-create",
  "tool-text",
  "tool-markdown",
  "tool-html-article",
  "tool-html-article-text",
  "tool-html-shell",
  "extract-readable-article",
  "extract-readable-article-text",
  "extract-basic-shell",
] as const satisfies readonly BenchmarkCaseId[];

const SPLIT_VALUE_FLAG_OPTIONS = { allowInline: false, rejectShortOptions: true } as const;

class CliArgumentError extends Error {
  override name = "CliArgumentError";
}

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Web Fetch Benchmark Article</title>
  </head>
  <body>
    <nav>${Array.from({ length: 24 }, (_, index) => `<a href="/nav-${index}">Nav ${index}</a>`).join("")}</nav>
    <main>
      <article>
        <h1>Web Fetch Benchmark Article</h1>
        ${Array.from(
          { length: 180 },
          (_, index) =>
            `<p>Paragraph ${index} carries readable benchmark content with enough prose for Readability to score it as article body text.</p>`,
        ).join("\n")}
      </article>
    </main>
    <footer>Repeated footer chrome that should not dominate extracted content.</footer>
  </body>
</html>`;

const SHELL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Shell App</title>
  </head>
  <body>
    <div id="app"></div>
    <script>window.__APP__ = true;</script>
    <noscript>Enable JavaScript to load this page.</noscript>
  </body>
</html>`;

const TEXT_BODY = "OpenClaw web_fetch direct text benchmark body.".repeat(160);
const MARKDOWN_BODY = "# Web Fetch Benchmark\n\n" + "- markdown list item\n".repeat(220);
const OFFLINE_PROVIDER_ENV_VARS = ["FIRECRAWL_API_KEY"] as const;

const lookupFn = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
const toolConfig: OpenClawConfig = {
  tools: {
    web: {
      fetch: {
        cacheTtlMinutes: 0,
      },
    },
  },
};

function parseCases(requested: string[]): BenchmarkCaseId[] {
  if (requested.length === 0 || requested.includes("all")) {
    return [...ALL_CASE_IDS];
  }
  const valid = new Set<string>(ALL_CASE_IDS);
  for (const id of requested) {
    if (!valid.has(id)) {
      throw new CliArgumentError(
        `--case must be one of all, ${ALL_CASE_IDS.join(", ")}; got ${JSON.stringify(id)}`,
      );
    }
  }
  return requested as BenchmarkCaseId[];
}

function parseBenchmarkCount(raw: string, flag: string, minimum: 0 | 1): number {
  const parsed = cliArgs.classifyBoundedUnsignedDecimal(raw, minimum, Number.MAX_SAFE_INTEGER);
  if (parsed.kind === "value") {
    return parsed.value;
  }
  const kind = minimum === 0 ? "non-negative" : "positive";
  throw new CliArgumentError(`${flag} must be a ${kind} integer`);
}

function parseOptions(args = process.argv.slice(2)): Options {
  const normalizedArgs = cliArgs.stripLeadingPackageManagerSeparator(args);
  try {
    const parsed = cliArgs.parseFlagArgs(
      normalizedArgs,
      {
        cases: [] as string[],
        json: false,
        output: undefined as string | undefined,
        runs: "20",
        warmup: "3",
      },
      [
        cliArgs.stringListFlag("--case", "cases", SPLIT_VALUE_FLAG_OPTIONS),
        cliArgs.stringFlag("--output", "output", SPLIT_VALUE_FLAG_OPTIONS),
        cliArgs.stringFlag("--runs", "runs", SPLIT_VALUE_FLAG_OPTIONS),
        cliArgs.stringFlag("--warmup", "warmup", SPLIT_VALUE_FLAG_OPTIONS),
        cliArgs.booleanFlag("--json", "json", true, { repeatable: true }),
      ],
      {
        ignoreDoubleDash: false,
        onUnhandledArg(arg) {
          throw new CliArgumentError(`Unknown argument: ${arg}`);
        },
      },
    );
    return {
      cases: parseCases(parsed.cases),
      json: parsed.json,
      output: parsed.output,
      runs: parseBenchmarkCount(parsed.runs, "--runs", 1),
      warmup: parseBenchmarkCount(parsed.warmup, "--warmup", 0),
    };
  } catch (error) {
    throw new CliArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function printUsage(): void {
  process.stdout.write(`OpenClaw web_fetch benchmark

Usage:
  pnpm perf:web-fetch -- [options]
  node --import tsx scripts/bench-web-fetch.ts [options]

Options:
  --case <id>      Case to run; repeatable. Use "all" for every case.
  --runs <n>       Measured runs per case (default: 20)
  --warmup <n>     Warmup runs per case (default: 3)
  --output <path>  Write JSON report
  --json           Print JSON report
  --help, -h       Show this text

Cases:
  ${ALL_CASE_IDS.join("\n  ")}
`);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return round(sorted[index] ?? 0);
}

function stats(values: number[]): SummaryStats {
  if (values.length === 0) {
    return { avg: 0, max: 0, min: 0, p50: 0, p95: 0 };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    avg: round(total / values.length),
    max: round(Math.max(...values)),
    min: round(Math.min(...values)),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

function installMockFetch(params: { body: string; contentType: string }) {
  const fetchImpl = (async () =>
    new Response(params.body, {
      status: 200,
      headers: {
        "content-type": params.contentType,
      },
    })) as unknown as typeof globalThis.fetch & { mock: object };
  // fetchWithSsrFGuard preserves dispatcher support unless global fetch is a
  // test double. The marker keeps this benchmark offline and deterministic.
  fetchImpl.mock = {};
  globalThis.fetch = fetchImpl;
}

async function withOfflineProviderEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const name of OFFLINE_PROVIDER_ENV_VARS) {
    previous.set(name, process.env[name]);
    process.env[name] = "";
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function createTool() {
  const tool = createWebFetchTool({
    config: toolConfig,
    lookupFn,
    sandboxed: false,
  });
  if (!tool?.execute) {
    throw new Error("web_fetch tool was not created");
  }
  return tool;
}

function createCases(): Record<BenchmarkCaseId, BenchmarkCase> {
  const textTool = createTool();
  const markdownTool = createTool();
  const articleTool = createTool();
  const articleTextTool = createTool();
  const shellTool = createTool();
  return {
    "tool-create": {
      id: "tool-create",
      label: "create web_fetch tool",
      run: () => {
        createTool();
      },
    },
    "tool-text": {
      id: "tool-text",
      label: "execute text/plain fetch",
      run: async () => {
        installMockFetch({ body: TEXT_BODY, contentType: "text/plain; charset=utf-8" });
        await textTool.execute("bench", { url: "https://example.com/plain" });
      },
    },
    "tool-markdown": {
      id: "tool-markdown",
      label: "execute text/markdown fetch",
      run: async () => {
        installMockFetch({ body: MARKDOWN_BODY, contentType: "text/markdown; charset=utf-8" });
        await markdownTool.execute("bench", { url: "https://example.com/markdown" });
      },
    },
    "tool-html-article": {
      id: "tool-html-article",
      label: "execute article HTML fetch",
      run: async () => {
        installMockFetch({ body: ARTICLE_HTML, contentType: "text/html; charset=utf-8" });
        await articleTool.execute("bench", { url: "https://example.com/article" });
      },
    },
    "tool-html-article-text": {
      id: "tool-html-article-text",
      label: "execute article HTML fetch as text",
      run: async () => {
        installMockFetch({ body: ARTICLE_HTML, contentType: "text/html; charset=utf-8" });
        await articleTextTool.execute("bench", {
          url: "https://example.com/article-text",
          extractMode: "text",
        });
      },
    },
    "tool-html-shell": {
      id: "tool-html-shell",
      label: "execute shell HTML fallback fetch",
      run: async () => {
        installMockFetch({ body: SHELL_HTML, contentType: "text/html; charset=utf-8" });
        await shellTool.execute("bench", { url: "https://example.com/shell" });
      },
    },
    "extract-readable-article": {
      id: "extract-readable-article",
      label: "extract readable article HTML",
      run: async () => {
        await extractReadableContent({
          html: ARTICLE_HTML,
          url: "https://example.com/article",
          extractMode: "markdown",
          config: toolConfig,
        });
      },
    },
    "extract-readable-article-text": {
      id: "extract-readable-article-text",
      label: "extract readable article HTML as text",
      run: async () => {
        await extractReadableContent({
          html: ARTICLE_HTML,
          url: "https://example.com/article-text",
          extractMode: "text",
          config: toolConfig,
        });
      },
    },
    "extract-basic-shell": {
      id: "extract-basic-shell",
      label: "extract basic shell HTML",
      run: async () => {
        await extractBasicHtmlContent({
          html: SHELL_HTML,
          extractMode: "markdown",
        });
      },
    },
  };
}

async function measureCase(testCase: BenchmarkCase, options: Options): Promise<CaseReport> {
  for (let index = 0; index < options.warmup; index += 1) {
    await testCase.run();
  }
  const samplesMs: number[] = [];
  for (let index = 0; index < options.runs; index += 1) {
    const started = performance.now();
    await testCase.run();
    samplesMs.push(round(performance.now() - started));
  }
  return {
    id: testCase.id,
    label: testCase.label,
    samplesMs,
    summaryMs: stats(samplesMs),
  };
}

function printProofLines(report: BenchmarkReport): void {
  for (const testCase of report.cases) {
    const summary = testCase.summaryMs;
    console.log(
      `WEB_FETCH_BENCH_CASE=${testCase.id} avg_ms=${summary.avg.toFixed(3)} p50_ms=${summary.p50.toFixed(3)} p95_ms=${summary.p95.toFixed(3)} max_ms=${summary.max.toFixed(3)}`,
    );
  }
  console.log(`WEB_FETCH_BENCH_RSS_MB=${report.rssMb.toFixed(1)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  const options = parseOptions(args);
  const report = await withOfflineProviderEnv(async () => {
    const casesById = createCases();
    const cases: CaseReport[] = [];
    for (const caseId of options.cases) {
      cases.push(await measureCase(casesById[caseId], options));
    }
    return {
      cases,
      node: process.version,
      options: {
        cases: options.cases,
        output: options.output,
        runs: options.runs,
        warmup: options.warmup,
      },
      rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    };
  });
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printProofLines(report);
  }
}

main().catch((error: unknown) => {
  if (error instanceof CliArgumentError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  throw error;
});
