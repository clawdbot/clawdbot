const INVALID_ARGUMENTS = new Error("invalid arguments");
const PLATFORMS = ["macos", "windows", "linux"];
const DEFAULT_MODELS = {
  anthropic: "anthropic/claude-sonnet-4-6",
  minimax: "minimax/MiniMax-M2.7",
  openai: "openai/gpt-5.6-luna",
};

export function parsePlatformList(value) {
  const entries = value.replaceAll(" ", "").replace(/^all$/u, PLATFORMS.join(",")).split(",");
  const result = new Set();
  for (const entry of entries) {
    if (!PLATFORMS.includes(entry)) {
      throw new Error(`invalid --platform entry: ${entry}`);
    }
    if (result.has(entry)) {
      throw new Error(`duplicate --platform entry: ${entry}`);
    }
    result.add(entry);
  }
  return result;
}

export function resolveParallelsProviderAuth(input, env) {
  const defaultModel = Object.hasOwn(DEFAULT_MODELS, input.provider)
    ? DEFAULT_MODELS[input.provider]
    : undefined;
  if (!defaultModel) {
    throw INVALID_ARGUMENTS;
  }
  const apiKeyEnv = input.apiKeyEnv || `${input.provider.toUpperCase()}_API_KEY`;
  const apiKeyValue = Object.hasOwn(env, apiKeyEnv) ? (env[apiKeyEnv] ?? "") : "";
  const genericModel = env[`OPENCLAW_PARALLELS_${input.provider.toUpperCase()}_MODEL`];
  const windowsOpenAi = input.platform === "windows" && input.provider === "openai";
  const auth = {
    apiKeyEnv,
    apiKeyValue,
    authChoice: input.provider === "minimax" ? "minimax-global-api" : "apiKey",
    authKeyFlag: `${input.provider}-api-key`,
    modelId:
      input.modelId ||
      (windowsOpenAi ? env.OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL?.trim() : undefined) ||
      (windowsOpenAi ? genericModel?.trim() && genericModel : genericModel) ||
      defaultModel,
    ...(input.provider === "minimax" ? {} : { tokenProvider: input.provider }),
  };
  return auth.apiKeyValue
    ? { auth, reason: null, status: "ready" }
    : { auth, reason: "credential_missing", status: "blocked" };
}

export function runParallelsPrerequisiteEval(argv, env, io) {
  let reason;
  try {
    const args = argv[0] === "--" ? argv.slice(1) : argv;
    if (args[0] !== "--prerequisite-check") {
      throw INVALID_ARGUMENTS;
    }
    const input = { provider: "openai" };
    let platforms = parsePlatformList("all");
    const seen = new Set();
    for (let index = 1; index < args.length; index++) {
      const key =
        args[index] === "--only"
          ? "--platform"
          : args[index].replace(/^--openai-api-key-env$/u, "--api-key-env");
      if (
        seen.has(key) ||
        !["--api-key-env", "--json", "--model", "--platform", "--provider"].includes(key)
      ) {
        throw INVALID_ARGUMENTS;
      }
      seen.add(key);
      if (key === "--json") {
        continue;
      }
      const value = args[++index];
      if (!value || value.startsWith("-")) {
        throw INVALID_ARGUMENTS;
      }
      if (key === "--api-key-env") {
        input.apiKeyEnv = value;
      } else if (key === "--model") {
        input.modelId = value;
      } else if (key === "--platform") {
        try {
          platforms = parsePlatformList(value);
        } catch {
          throw INVALID_ARGUMENTS;
        }
      } else {
        input.provider = value;
      }
    }
    if (!seen.has("--json")) {
      throw INVALID_ARGUMENTS;
    }
    reason =
      [...platforms]
        .map((platform) => resolveParallelsProviderAuth({ ...input, platform }, env))
        .find((result) => result.reason !== null)?.reason ?? null;
  } catch (error) {
    reason = error === INVALID_ARGUMENTS ? "invalid_arguments" : "internal_error";
  }
  const status = reason === null ? "ready" : "blocked";
  io.write(`${JSON.stringify({ schema: "openclaw.parallels-prerequisite.v1", status, reason })}\n`);
  return status === "ready" ? 0 : 1;
}
