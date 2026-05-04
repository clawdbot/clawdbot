import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { completeSimple, type Api, type Context, type Model } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "./live-test-helpers.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { sanitizeSessionHistory } from "./pi-embedded-runner/replay-history.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";
import { transformTransportMessages } from "./transport-message-transform.js";

const LIVE = isLiveTestEnabled();
const REQUIRE_PROFILE_KEYS = isLiveProfileKeyModeEnabled();
const LIVE_CREDENTIAL_PRECEDENCE = REQUIRE_PROFILE_KEYS ? "profile-first" : "env-first";
const DEFAULT_TARGET_MODEL_REFS = "openai-codex/gpt-5.5,google/gemini-3-flash-preview";
const TARGET_MODEL_REFS = parseTargetModelRefs(
  process.env.OPENCLAW_LIVE_TOOL_REPLAY_REPAIR_MODELS ?? DEFAULT_TARGET_MODEL_REFS,
);
const describeLive = LIVE ? describe : describe.skip;

type TargetModelRef = {
  ref: string;
  provider: string;
  modelId: string;
};

function parseTargetModelRefs(raw: string | undefined): TargetModelRef[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((ref) => {
      const [provider, ...rest] = ref.split("/");
      const modelId = rest.join("/").trim();
      if (!provider?.trim() || !modelId) {
        throw new Error(
          `Invalid OPENCLAW_LIVE_TOOL_REPLAY_REPAIR_MODELS entry: ${JSON.stringify(ref)}`,
        );
      }
      return { ref, provider: provider.trim(), modelId };
    });
}

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

function isOpenAIResponsesFamily(api: string): boolean {
  return (
    api === "openai-responses" ||
    api === "openai-codex-responses" ||
    api === "azure-openai-responses"
  );
}

function buildReplayMessages(model: Model<Api>): AgentMessage[] {
  const now = Date.now();
  // Gemini source metadata deliberately simulates a model switch from a
  // provider-owned transcript. That forces the same id sanitization and replay
  // repair path that failed in real session replays, not just the happy path for
  // a same-provider synthetic fixture.
  const source =
    model.provider === "google"
      ? {
          api: "google-gemini-cli",
          provider: "google-antigravity",
          model: "claude-sonnet-4-20250514",
        }
      : {
          api: model.api,
          provider: model.provider,
          model: model.id,
        };

  return [
    {
      role: "user",
      content: "Use noop.",
      timestamp: now,
    },
    {
      role: "assistant",
      provider: source.provider,
      api: source.api,
      model: source.model,
      stopReason: "toolUse",
      timestamp: now + 1,
      content: [
        { type: "toolCall", id: "call_keep", name: "noop", arguments: {} },
        { type: "toolCall", id: "call_missing_a", name: "noop", arguments: {} },
        { type: "toolCall", id: "call_missing_b", name: "noop", arguments: {} },
      ],
    },
    {
      role: "user",
      content: "Reply with exactly: replay repair ok.",
      timestamp: now + 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_keep",
      toolName: "noop",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: now + 3,
    },
  ] as unknown as AgentMessage[];
}

function buildAbortedTransportMessages(model: Model<Api>): Context["messages"] {
  const now = Date.now();
  return [
    {
      role: "assistant",
      provider: model.provider,
      api: model.api,
      model: model.id,
      stopReason: "aborted",
      timestamp: now,
      content: [{ type: "toolCall", id: "call_transport_aborted", name: "noop", arguments: {} }],
    },
    {
      role: "user",
      content: "Reply with exactly: transport replay ok.",
      timestamp: now + 1,
    },
  ] as Context["messages"];
}

function syntheticToolResultText(message: AgentMessage): string | undefined {
  if (message.role !== "toolResult") {
    return undefined;
  }
  const first = message.content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : undefined;
}

function assistantToolCallIds(message: AgentMessage): string[] {
  if (message.role !== "assistant") {
    return [];
  }
  return message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
}

function isKnownLiveBlocker(errorMessage: string): boolean {
  return (
    /not supported when using codex with a chatgpt account/i.test(errorMessage) ||
    /hit your chatgpt usage limit/i.test(errorMessage)
  );
}

describeLive("tool replay repair live", () => {
  for (const target of TARGET_MODEL_REFS) {
    it(
      `accepts repaired displaced and missing tool results with ${target.ref}`,
      async () => {
        const cfg = getRuntimeConfig();
        await ensureOpenClawModelsJson(cfg);

        const agentDir = resolveOpenClawAgentDir();
        const authStorage = discoverAuthStorage(agentDir);
        const modelRegistry = discoverModels(authStorage, agentDir);
        const model = modelRegistry.find(target.provider, target.modelId) as Model<Api> | null;

        if (!model) {
          logProgress(`[tool-replay-repair] model missing from registry: ${target.ref}`);
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
          logProgress(`[tool-replay-repair] skip ${target.ref} (${String(error)})`);
          return;
        }

        if (REQUIRE_PROFILE_KEYS && !apiKeyInfo.source.startsWith("profile:")) {
          logProgress(
            `[tool-replay-repair] skip ${target.ref} (non-profile credential source: ${apiKeyInfo.source})`,
          );
          return;
        }

        logProgress(`[tool-replay-repair] target=${target.ref} auth source=${apiKeyInfo.source}`);
        const sanitized = await sanitizeSessionHistory({
          messages: buildReplayMessages(model),
          modelApi: model.api,
          provider: model.provider,
          modelId: model.id,
          sessionManager: SessionManager.inMemory(),
          sessionId: `tool-replay-repair-live-${target.provider}-${target.modelId}`,
        });

        expect(sanitized.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "toolResult",
          "toolResult",
          "toolResult",
          "user",
        ]);
        const assistantMessage = sanitized[1];
        expect(assistantMessage?.role).toBe("assistant");
        expect(
          sanitized.slice(2, 5).map((message) => (message as { toolCallId?: string }).toolCallId),
        ).toEqual(assistantToolCallIds(assistantMessage));

        // These assertions are the model-visible contract: OpenAI Responses
        // gets Codex-compatible "aborted" outputs, while Gemini proves the
        // generic repair does not leak OpenAI wording into other providers.
        const insertedTexts = sanitized.slice(3, 5).map(syntheticToolResultText);
        if (isOpenAIResponsesFamily(model.api)) {
          expect(insertedTexts).toEqual(["aborted", "aborted"]);
        } else {
          expect(insertedTexts).not.toContain("aborted");
        }

        // Sending the repaired transcript to the real model is the live proof:
        // providers reject malformed tool-call adjacency before generation, so
        // any non-error response here validates the repair shape end to end.
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
            maxTokens: 96,
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
          logProgress(`[tool-replay-repair] skip ${target.ref} (${errorMessage})`);
          return;
        }

        expect(response.stopReason).not.toBe("error");
        if (text.length > 0) {
          expect(text).toMatch(/^replay repair(?: ok)?\.?$/i);
        }
      },
      3 * 60 * 1000,
    );

    it(
      `accepts transport replay after dropping aborted assistant tool calls with ${target.ref}`,
      async () => {
        const cfg = getRuntimeConfig();
        await ensureOpenClawModelsJson(cfg);

        const agentDir = resolveOpenClawAgentDir();
        const authStorage = discoverAuthStorage(agentDir);
        const modelRegistry = discoverModels(authStorage, agentDir);
        const model = modelRegistry.find(target.provider, target.modelId) as Model<Api> | null;

        if (!model) {
          logProgress(`[tool-replay-repair] model missing from registry: ${target.ref}`);
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
          logProgress(`[tool-replay-repair] skip ${target.ref} (${String(error)})`);
          return;
        }

        if (REQUIRE_PROFILE_KEYS && !apiKeyInfo.source.startsWith("profile:")) {
          logProgress(
            `[tool-replay-repair] skip ${target.ref} (non-profile credential source: ${apiKeyInfo.source})`,
          );
          return;
        }

        const transformed = transformTransportMessages(buildAbortedTransportMessages(model), model);
        expect(transformed.map((message) => message.role)).toEqual(["user"]);
        expect(JSON.stringify(transformed)).not.toContain("call_transport_aborted");

        // This is the transport replay regression proof: providers reject
        // assistant(tool_call)->user replays without a matching result, so the
        // dropped transcript must still be accepted by real model APIs.
        const response = await completeSimpleWithTimeout(
          model,
          {
            systemPrompt: "You are a concise assistant. Follow the user's instruction exactly.",
            messages: transformed as never,
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
            maxTokens: 96,
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
          logProgress(`[tool-replay-repair] skip ${target.ref} (${errorMessage})`);
          return;
        }

        expect(response.stopReason).not.toBe("error");
        if (text.length > 0) {
          expect(text).toMatch(/^transport(?: replay(?: ok\.?)?)?$/i);
        }
      },
      3 * 60 * 1000,
    );
  }
});
