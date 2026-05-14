import fs from "node:fs";
import path from "node:path";

const command = process.argv[2];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH ??
    path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json")
  );
}

function writeConfig(cfg) {
  fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

function authProfilesPath() {
  return path.join(
    process.env.HOME ?? "",
    ".openclaw",
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
}

function readStateText() {
  const paths = [configPath(), authProfilesPath()].filter((file) => fs.existsSync(file));
  return paths.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

function configureMockOpenAi() {
  const mockPort = Number(process.argv[3]);
  const cfg = readJson(configPath());
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  cfg.models = {
    ...cfg.models,
    mode: "merge",
    providers: {
      ...cfg.models?.providers,
      openai: {
        ...cfg.models?.providers?.openai,
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        api: "openai-responses",
        request: { ...cfg.models?.providers?.openai?.request, allowPrivateNetwork: true },
        models: [
          {
            id: "gpt-5.5",
            name: "gpt-5.5",
            api: "openai-responses",
            reasoning: false,
            input: ["text", "image"],
            cost,
            contextWindow: 128000,
            contextTokens: 96000,
            maxTokens: 4096,
          },
        ],
      },
    },
  };
  cfg.agents = {
    ...cfg.agents,
    defaults: {
      ...cfg.agents?.defaults,
      model: { primary: "openai/gpt-5.5" },
      imageModel: { primary: "openai/gpt-5.5", timeoutMs: 30_000 },
      imageGenerationModel: { primary: "openai/gpt-image-1", timeoutMs: 30_000 },
      models: {
        ...cfg.agents?.defaults?.models,
        "openai/gpt-5.5": { params: { transport: "sse", openaiWsWarmup: false } },
      },
    },
  };
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
  };
  writeConfig(cfg);
}

function assertOpenAiEnvRef() {
  const rawKey = process.argv[3];
  const state = readStateText();
  assert(state.includes("OPENAI_API_KEY"), "OpenAI env ref was not persisted");
  assert(!state.includes(rawKey), "raw OpenAI key was persisted");
  assert(fs.existsSync(configPath()), "openclaw.json missing");
}

function assertAgentTurn() {
  const marker = process.argv[3];
  const outputPath = process.argv[4];
  const requestLogPath = process.argv[5];
  const output = fs.readFileSync(outputPath, "utf8");
  assert(output.includes(marker), `agent output did not contain ${marker}. Output: ${output}`);
  const requestLog = fs.existsSync(requestLogPath) ? fs.readFileSync(requestLogPath, "utf8") : "";
  assert(/\/v1\/(responses|chat\/completions)/u.test(requestLog), "mock OpenAI was not used");
}

function assertFileContains() {
  const file = process.argv[3];
  const needle = process.argv[4];
  const raw = fs.readFileSync(file, "utf8");
  assert(raw.includes(needle), `${file} did not contain ${needle}. Output: ${raw}`);
}

function assertImageDescribe() {
  const outputPath = process.argv[3];
  const requestLogPath = process.argv[4];
  const payload = readJson(outputPath);
  assert(payload.ok === true, `image describe failed: ${JSON.stringify(payload)}`);
  assert(payload.capability === "image.describe", "wrong image describe capability");
  const output = payload.outputs?.[0];
  assert(output?.text?.includes("OPENCLAW_E2E_OK"), "image description marker missing");
  assert(output.provider === "openai", `unexpected image provider: ${output?.provider}`);
  const requestLog = fs.existsSync(requestLogPath) ? fs.readFileSync(requestLogPath, "utf8") : "";
  assert(requestLog.includes("/v1/responses"), "image describe did not hit Responses API");
}

function assertImageGenerate() {
  const outputPath = process.argv[3];
  const requestLogPath = process.argv[4];
  const payload = readJson(outputPath);
  assert(payload.ok === true, `image generation failed: ${JSON.stringify(payload)}`);
  assert(payload.capability === "image.generate", "wrong image generation capability");
  const output = payload.outputs?.[0];
  assert(output?.path && fs.existsSync(output.path), `generated image missing: ${output?.path}`);
  assert(output.mimeType === "image/png", `unexpected generated mime type: ${output.mimeType}`);
  assert(payload.provider === "openai", `unexpected generation provider: ${payload.provider}`);
  const requestLog = fs.existsSync(requestLogPath) ? fs.readFileSync(requestLogPath, "utf8") : "";
  assert(requestLog.includes("/v1/images/generations"), "image generation endpoint was not used");
}

function assertMemorySearch() {
  const outputPath = process.argv[3];
  const needle = process.argv[4];
  const payload = readJson(outputPath);
  const haystack = JSON.stringify(payload);
  assert(haystack.includes(needle), `memory search missed ${needle}: ${haystack}`);
}

function assertPluginUninstalled() {
  const pluginId = process.argv[3];
  const cliRoot = process.argv[4];
  const cfg = readJson(configPath());
  const recordsPath = path.join(process.env.HOME ?? "", ".openclaw", "plugins", "installs.json");
  const records = fs.existsSync(recordsPath) ? readJson(recordsPath) : {};
  const installRecords = records.installRecords ?? records.records ?? {};
  assert(!installRecords[pluginId], `install record still present for ${pluginId}`);
  assert(!cfg.plugins?.entries?.[pluginId], `plugin config entry still present for ${pluginId}`);
  const managedRoot = path.join(
    process.env.HOME ?? "",
    ".openclaw",
    "plugins",
    "installed",
    pluginId,
  );
  assert(!fs.existsSync(managedRoot), `managed plugin directory still present: ${managedRoot}`);
  if (cliRoot) {
    const list = JSON.stringify(records);
    assert(!list.includes(cliRoot), `install records still mention CLI root ${cliRoot}`);
  }
}

const commands = {
  "configure-mock-openai": configureMockOpenAi,
  "assert-openai-env-ref": assertOpenAiEnvRef,
  "assert-agent-turn": assertAgentTurn,
  "assert-file-contains": assertFileContains,
  "assert-image-describe": assertImageDescribe,
  "assert-image-generate": assertImageGenerate,
  "assert-memory-search": assertMemorySearch,
  "assert-plugin-uninstalled": assertPluginUninstalled,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown release scenario assertion command: ${command ?? "<missing>"}`);
}
await fn();
