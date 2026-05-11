import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { completeSimple, type Api, type Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "./live-test-helpers.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { sanitizeSessionHistory } from "./pi-embedded-runner/replay-history.js";
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
      const cfg = getRuntimeConfig();
      await ensureOpenClawModelsJson(cfg);

      const agentDir = resolveDefaultAgentDir(cfg);
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

  it(
    "accepts repaired OpenAI Codex parallel tool replay with aborted missing results",
    async () => {
      const { provider, modelId } = resolveTargetModelRef();
      const cfg = getRuntimeConfig();
      await ensureOpenClawModelsJson(cfg);

      const agentDir = resolveDefaultAgentDir(cfg);
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

      const messages = [
        {
          role: "user",
          content: "Use noop.",
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          provider: model.provider,
          api: model.api,
          model: model.id,
          stopReason: "toolUse",
          timestamp: Date.now(),
          content: [
            { type: "toolCall", id: "call_keep", name: "noop", arguments: {} },
            { type: "toolCall", id: "call_missing_a", name: "noop", arguments: {} },
            { type: "toolCall", id: "call_missing_b", name: "noop", arguments: {} },
          ],
        },
        {
          role: "user",
          content: "Reply with exactly: replay ok.",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "call_keep",
          toolName: "noop",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
      ] as unknown as AgentMessage[];

      const sanitized = await sanitizeSessionHistory({
        messages,
        modelApi: model.api,
        provider: model.provider,
        modelId: model.id,
        sessionManager: SessionManager.inMemory(),
        sessionId: "openai-codex-tool-replay-live",
      });

      expect(sanitized.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "toolResult",
        "toolResult",
        "user",
      ]);
      const assistantToolIds = (
        ((sanitized[1] as { content?: unknown }).content ?? []) as unknown[]
      )
        .filter(
          (block): block is { type: "toolCall"; id: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "toolCall" &&
            typeof (block as { id?: unknown }).id === "string",
        )
        .map((block) => block.id);
      expect(assistantToolIds).toHaveLength(3);
      expect(
        sanitized.slice(2, 5).map((message) => (message as { toolCallId?: string }).toolCallId),
      ).toEqual(assistantToolIds);
      expect(
        sanitized
          .slice(3, 5)
          .map((message) => (message as Extract<AgentMessage, { role: "toolResult" }>).content),
      ).toEqual([[{ type: "text", text: "aborted" }], [{ type: "text", text: "aborted" }]]);
      expect(JSON.stringify(sanitized)).not.toContain("missing tool result");

      const response = await completeSimpleWithTimeout(
        model,
        {
          systemPrompt: "You are a concise assistant. Follow the user's instruction exactly.",
          messages: sanitized as never,
          tools: [
            {
              name: "noop",
              description: "Return ok.",
              parameters: Type.Object({}, { additionalProperties: false }),
            },
          ],
        },
        {
          apiKey: requireApiKey(apiKeyInfo, model.provider),
          reasoning: "low",
          maxTokens: 64,
        },
        120_000,
      );

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text.trim())
        .join(" ")
        .trim();
      const errorMessage =
        typeof (response as { errorMessage?: unknown }).errorMessage === "string"
          ? ((response as { errorMessage?: string }).errorMessage ?? "")
          : "";
      if (errorMessage && isKnownLiveBlocker(errorMessage)) {
        logProgress(`[openai-reasoning-compat] skip (${errorMessage})`);
        return;
      }

      expect(text).toMatch(/^replay ok\.?$/i);
    },
    3 * 60 * 1000,
  );
});
