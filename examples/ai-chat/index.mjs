// Minimal @openclaw/ai consumer: one isolated runtime, built-in providers,
// one streamed completion. Uses only the public package surface — no OpenClaw
// application code. See README.md for build prerequisites and run commands.
import { createLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";

const MODELS = {
  anthropic: {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 8192,
  },
  openai: {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  },
  // Local Ollama server; no API key required.
  ollama: {
    id: process.env.OLLAMA_MODEL || "llama3.2:latest",
    name: "Ollama",
    api: "openai-completions",
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4096,
  },
};

const args = process.argv.slice(2);
const providerFlag = args.indexOf("--provider");
const provider = providerFlag === -1 ? "anthropic" : args[providerFlag + 1];
const prompt =
  args.filter((_, i) => i !== providerFlag && i !== providerFlag + 1).join(" ") ||
  "Reply with one short sentence: what is @openclaw/ai?";

const model = MODELS[provider];
if (!model) {
  console.error(`Unknown provider "${provider}". Use one of: ${Object.keys(MODELS).join(", ")}`);
  process.exit(1);
}

const runtime = createLlmRuntime();
registerBuiltInApiProviders(runtime.registry);

const stream = runtime.streamSimple(
  model,
  { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
  // Ollama ignores credentials but the OpenAI-compatible transport requires one.
  provider === "ollama" ? { apiKey: "ollama" } : undefined,
);

for await (const event of stream) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  }
}
const result = await stream.result();
process.stdout.write("\n");

if (result.stopReason === "error" || result.stopReason === "aborted") {
  console.error(`error: ${result.errorMessage ?? result.stopReason}`);
  process.exit(1);
}
const { input, output } = result.usage;
console.error(`[${model.id}] stop=${result.stopReason} tokens in=${input} out=${output}`);
