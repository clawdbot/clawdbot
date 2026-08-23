// Bench Model script supports OpenClaw repository automation.
import { pathToFileURL } from "node:url";
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { parseStrictIntegerOption } from "./lib/dev-tooling-safety.ts";

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

type RunResult = {
  durationMs: number;
  usage?: Usage;
};

type CliOptions = {
  help: boolean;
  prompt: string;
  runs: number;
};

const DEFAULT_PROMPT = "Reply with a single word: ok. No punctuation or extra text.";
const DEFAULT_RUNS = 10;
const BOOLEAN_FLAGS = new Set(["--help", "-h"]);
const VALUE_FLAGS = new Set(["--prompt", "--runs"]);

class CliArgumentError extends Error {
  override name = "CliArgumentError";
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim() ?? "";
  if (!value || value.startsWith("-")) {
    throw new CliArgumentError(`${flag} requires a value`);
  }
  return value;
}

function validateCliArgs(argv: string[]): void {
  const seenValueFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      if (seenValueFlags.has(arg)) {
        throw new CliArgumentError(`${arg} was provided more than once`);
      }
      seenValueFlags.add(arg);
      readValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new CliArgumentError(`Unknown argument: ${arg}`);
  }
}

function parseArg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return readValue(argv, index, flag);
}

function parseRuns(raw: string | undefined): number {
  return parseStrictIntegerOption({
    fallback: DEFAULT_RUNS,
    label: "--runs",
    min: 1,
    raw,
  });
}

function parseArgs(argv = process.argv.slice(2)): CliOptions {
  validateCliArgs(argv);
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    prompt: parseArg(argv, "--prompt") ?? DEFAULT_PROMPT,
    runs: parseRuns(parseArg(argv, "--runs")),
  };
}

function printUsage(): void {
  console.log(`OpenClaw model latency benchmark

Usage:
  node --import tsx scripts/bench-model.ts [options]

Options:
  --runs <n>      Runs per model (default: ${DEFAULT_RUNS})
  --prompt <text> Prompt to send to each model
  --help, -h      Show this text

Environment:
  ANTHROPIC_API_KEY
  MINIMAX_API_KEY
  MINIMAX_BASE_URL
  MINIMAX_MODEL
`);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(
      (expectDefined(sorted[mid - 1], "lower middle model benchmark sample") +
        expectDefined(sorted[mid], "upper middle model benchmark sample")) /
        2,
    );
  }
  return expectDefined(sorted[mid], "middle model benchmark sample");
}

async function runModel(opts: {
  label: string;
  model: Model;
  apiKey: string;
  runs: number;
  prompt: string;
}): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 0; i < opts.runs; i += 1) {
    const started = Date.now();
    const res = await completeSimple(
      opts.model,
      {
        messages: [
          {
            role: "user",
            content: opts.prompt,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: opts.apiKey, maxTokens: 64 },
    );
    const durationMs = Date.now() - started;
    results.push({ durationMs, usage: res.usage });
    console.log(`${opts.label} run ${i + 1}/${opts.runs}: ${durationMs}ms`);
  }
  return results;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const minimaxKey = process.env.MINIMAX_API_KEY?.trim();
  if (!anthropicKey) {
    throw new Error("Missing ANTHROPIC_API_KEY in environment.");
  }
  if (!minimaxKey) {
    throw new Error("Missing MINIMAX_API_KEY in environment.");
  }

  const minimaxBaseUrl = process.env.MINIMAX_BASE_URL?.trim() || "https://api.minimax.io/v1";
  const minimaxModelId = process.env.MINIMAX_MODEL?.trim() || "MiniMax-M2.1";

  const minimaxModel: Model<"openai-completions"> = {
    id: minimaxModelId,
    name: `MiniMax ${minimaxModelId}`,
    api: "openai-completions",
    provider: "minimax",
    baseUrl: minimaxBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
  const opusModel: Model<"anthropic-messages"> = {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 32000,
  };

  console.log(`Prompt: ${options.prompt}`);
  console.log(`Runs: ${options.runs}`);
  console.log("");

  const minimaxResults = await runModel({
    label: "minimax",
    model: minimaxModel,
    apiKey: minimaxKey,
    runs: options.runs,
    prompt: options.prompt,
  });
  const opusResults = await runModel({
    label: "opus",
    model: opusModel,
    apiKey: anthropicKey,
    runs: options.runs,
    prompt: options.prompt,
  });

  const summarize = (label: string, results: RunResult[]) => {
    const durations = results.map((r) => r.durationMs);
    const med = median(durations);
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    return { label, med, min, max };
  };

  const summary = [summarize("minimax", minimaxResults), summarize("opus", opusResults)];
  console.log("");
  console.log("Summary (ms):");
  for (const row of summary) {
    console.log(`${row.label.padEnd(7)} median=${row.med} min=${row.min} max=${row.max}`);
  }
}

export const testing = {
  median,
  parseArgs,
  parseRuns,
  validateCliArgs,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    if (err instanceof CliArgumentError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
