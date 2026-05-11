import { completeSimple, getModel, type Api, type Model } from "@earendil-works/pi-ai";

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

const DEFAULT_PROMPT = "Reply with a single word: ok. No punctuation or extra text.";
const DEFAULT_RUNS = 10;

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function parseRuns(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_RUNS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RUNS;
  }
  return Math.floor(parsed);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

async function runModel(opts: {
  label: string;
  model: Model<Api>;
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

async function main(): Promise<void> {
  const runs = parseRuns(parseArg("--runs"));
  const prompt = parseArg("--prompt") ?? DEFAULT_PROMPT;

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
  const opusModel = getModel("anthropic", "claude-opus-4-6");

  console.log(`Prompt: ${prompt}`);
  console.log(`Runs: ${runs}`);
  console.log("");

  const minimaxResults = await runModel({
    label: "minimax",
    model: minimaxModel,
    apiKey: minimaxKey,
    runs,
    prompt,
  });
  const opusResults = await runModel({
    label: "opus",
    model: opusModel,
    apiKey: anthropicKey,
    runs,
    prompt,
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

await main();
