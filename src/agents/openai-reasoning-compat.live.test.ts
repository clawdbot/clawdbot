import { completeSimple, type Api, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "./live-test-helpers.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";

const LIVE = isLiveTestEnabled();
const REQUIRE_PROFILE_KEYS = isLiveProfileKeyModeEnabled();
const LIVE_CREDENTIAL_PRECEDENCE = REQUIRE_PROFILE_KEYS ? "profile-first" : "env-first";
const DEFAULT_TARGET_MODEL_REF = "openai-codex/gpt-5.1-codex-mini";
const TARGET_MODEL_REF =
  process.env.OPENCLAW_LIVE_OPENAI_REASONING_COMPAT_MODEL?.trim() || DEFAULT_TARGET_MODEL_REF;
const describeLive = LIVE ? describe : describe.skip;

function logProgress(message: string): void {
  process.stderr.write(`[live] ${message}\n`);
}

async function completeSimpleWithTimeout<TApi extends Api>(
  model: Model<TApi>,
  context: Parameters<typeof completeSimple<TApi>>[1],
  options: Parameters<typeof completeSimple<TApi>>[2],
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof completeSimple<TApi>>>> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  abortTimer.unref?.();
  try {
    return await Promise.race([
      completeSimple(model, context, {
        ...options,
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        const hardTimer = setTimeout(() => {
          reject(new Error(`model call timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        hardTimer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(abortTimer);
  }
}

async function completeReplyWithRetry(params: {
  model: Model<Api>;
  apiKey: string;
  message: string;
}): Promise<{ text: string; errorMessage?: string }> {
  const runOnce = async (maxTokens: number) => {
    const response = await completeSimpleWithTimeout(
      params.model,
      {
        systemPrompt: "You are a concise assistant. Follow the user's instruction exactly.",
        messages: [
          {
            role: "user",
            content: params.message,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: params.apiKey,
        reasoning: "low",
        maxTokens,
      },
      120_000,
    );
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .join(" ")
      .trim();
    return {
      text,
      errorMessage:
        typeof (response as { errorMessage?: unknown }).errorMessage === "string"
          ? ((response as { errorMessage?: string }).errorMessage ?? undefined)
          : undefined,
    };
  };

  const first = await runOnce(64);
  if (first.text.length > 0 || first.errorMessage) {
    return first;
  }
  return await runOnce(256);
}

function isKnownLiveBlocker(errorMessage: string): boolean {
  return (
    /not supported when using codex with a chatgpt account/i.test(errorMessage) ||
    /hit your chatgpt usage limit/i.test(errorMessage)
  );
}

function resolveTargetModelRef(): { provider: string; modelId: string } {
  const [provider, ...rest] = TARGET_MODEL_REF.split("/");
  const modelId = rest.join("/").trim();
  if (!provider?.trim() || !modelId) {
    throw new Error(
      `Invalid OPENCLAW_LIVE_OPENAI_REASONING_COMPAT_MODEL: ${JSON.stringify(TARGET_MODEL_REF)}`,
    );
  }
  return {
    provider: provider.trim(),
    modelId,
  };
}

describeLive("openai reasoning compat live", () => {
  it(
    "remaps low reasoning for the configured OpenAI mini target",
    async () => {
      const { provider, modelId } = resolveTargetModelRef();
      const cfg = loadConfig();
      await ensureOpenClawModelsJson(cfg);

      const agentDir = resolveOpenClawAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const model = modelRegistry.find(provider, modelId) as Model<Api> | null;

      if (!model) {
        logProgress(`[openai-reasoning-compat] model missing from registry: ${TARGET_MODEL_REF}`);
        return;
      }

      let apiKeyInfo;
      try {
        apiKeyInfo = await getApiKeyForModel({
          model,
          cfg,
          credentialPrecedence: LIVE_CREDENTIAL_PRECEDENCE,
        });
      } catch (error) {
        logProgress(`[openai-reasoning-compat] skip (${String(error)})`);
        return;
      }

      if (REQUIRE_PROFILE_KEYS && !apiKeyInfo.source.startsWith("profile:")) {
        logProgress(
          `[openai-reasoning-compat] skip (non-profile credential source: ${apiKeyInfo.source})`,
        );
        return;
      }

      logProgress(
        `[openai-reasoning-compat] target=${TARGET_MODEL_REF} auth source=${apiKeyInfo.source}`,
      );
      const result = await completeReplyWithRetry({
        model,
        apiKey: requireApiKey(apiKeyInfo, model.provider),
        message: "Reply with exactly: low reasoning ok.",
      });
      if (result.errorMessage && isKnownLiveBlocker(result.errorMessage)) {
        logProgress(`[openai-reasoning-compat] skip (${result.errorMessage})`);
        return;
      }

      expect(result.text).toMatch(/^low reasoning ok\.?$/i);
    },
    3 * 60 * 1000,
  );
});
