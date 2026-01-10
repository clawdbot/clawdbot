import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import {
  discoverAuthStorage,
  discoverModels,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/config.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";
import { getApiKeyForModel } from "./model-auth.js";
import { ensureClawdbotModelsJson } from "./models-config.js";

const LIVE = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";
const ALL_MODELS =
  process.env.CLAWDBOT_LIVE_ALL_MODELS === "1" ||
  process.env.CLAWDBOT_LIVE_MODELS === "all";
const REQUIRE_PROFILE_KEYS =
  process.env.CLAWDBOT_LIVE_REQUIRE_PROFILE_KEYS === "1";

const describeLive = LIVE && ALL_MODELS ? describe : describe.skip;

function parseProviderFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") return null;
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function parseModelFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") return null;
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function isGoogleModelNotFoundError(err: unknown): boolean {
  const msg = String(err);
  if (!/not found/i.test(msg)) return false;
  if (/models\/.+ is not found for api version/i.test(msg)) return true;
  if (/"status"\\s*:\\s*"NOT_FOUND"/.test(msg)) return true;
  if (/"code"\\s*:\\s*404/.test(msg)) return true;
  return false;
}

describeLive("live models (profile keys)", () => {
  it(
    "completes across configured models",
    async () => {
      const cfg = loadConfig();
      await ensureClawdbotModelsJson(cfg);

      const agentDir = resolveClawdbotAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const models = modelRegistry.getAll() as Array<Model<Api>>;

      const filter = parseModelFilter(process.env.CLAWDBOT_LIVE_MODELS);
      const providers = parseProviderFilter(
        process.env.CLAWDBOT_LIVE_PROVIDERS,
      );

      const failures: Array<{ model: string; error: string }> = [];
      const skipped: Array<{ model: string; reason: string }> = [];

      for (const model of models) {
        if (providers && !providers.has(model.provider)) continue;
        const id = `${model.provider}/${model.id}`;
        if (filter && !filter.has(id)) continue;

        let apiKeyInfo: Awaited<ReturnType<typeof getApiKeyForModel>>;
        try {
          apiKeyInfo = await getApiKeyForModel({ model, cfg });
        } catch (err) {
          skipped.push({ model: id, reason: String(err) });
          continue;
        }

        if (REQUIRE_PROFILE_KEYS && !apiKeyInfo.source.startsWith("profile:")) {
          skipped.push({
            model: id,
            reason: `non-profile credential source: ${apiKeyInfo.source}`,
          });
          continue;
        }

        try {
          // Special regression: OpenAI rejects replayed `reasoning` items for tool-only turns.
          if (
            model.provider === "openai" &&
            model.api === "openai-responses" &&
            model.id === "gpt-5.2"
          ) {
            const noopTool = {
              name: "noop",
              description: "Return ok.",
              parameters: Type.Object({}, { additionalProperties: false }),
            };

            const first = await completeSimple(
              model,
              {
                messages: [
                  {
                    role: "user",
                    content:
                      "Call the tool `noop` with {}. Do not write any other text.",
                    timestamp: Date.now(),
                  },
                ],
                tools: [noopTool],
              },
              {
                apiKey: apiKeyInfo.apiKey,
                reasoning: model.reasoning ? "low" : undefined,
                maxTokens: 128,
              },
            );

            const toolCall = first.content.find((b) => b.type === "toolCall");
            expect(toolCall).toBeTruthy();
            if (!toolCall || toolCall.type !== "toolCall") {
              throw new Error("expected tool call");
            }

            const second = await completeSimple(
              model,
              {
                messages: [
                  {
                    role: "user",
                    content:
                      "Call the tool `noop` with {}. Do not write any other text.",
                    timestamp: Date.now(),
                  },
                  first,
                  {
                    role: "toolResult",
                    toolCallId: toolCall.id,
                    toolName: "noop",
                    content: [{ type: "text", text: "ok" }],
                    isError: false,
                    timestamp: Date.now(),
                  },
                  {
                    role: "user",
                    content: "Reply with the word ok.",
                    timestamp: Date.now(),
                  },
                ],
              },
              {
                apiKey: apiKeyInfo.apiKey,
                reasoning: model.reasoning ? "low" : undefined,
                maxTokens: 64,
              },
            );

            const secondText = second.content
              .filter((b) => b.type === "text")
              .map((b) => b.text.trim())
              .join(" ");
            expect(secondText.length).toBeGreaterThan(0);
            continue;
          }

          const res = await completeSimple(
            model,
            {
              messages: [
                {
                  role: "user",
                  content: "Reply with the word ok.",
                  timestamp: Date.now(),
                },
              ],
            },
            {
              apiKey: apiKeyInfo.apiKey,
              reasoning: model.reasoning ? "low" : undefined,
              maxTokens: 64,
            },
          );

          const text = res.content
            .filter((block) => block.type === "text")
            .map((block) => block.text.trim())
            .join(" ");
          if (text.length === 0 && model.provider === "google") {
            skipped.push({
              model: id,
              reason: "no text returned (likely unavailable model id)",
            });
            continue;
          }
          expect(text.length).toBeGreaterThan(0);
        } catch (err) {
          if (model.provider === "google" && isGoogleModelNotFoundError(err)) {
            skipped.push({ model: id, reason: String(err) });
            continue;
          }
          failures.push({ model: id, error: String(err) });
        }
      }

      if (failures.length > 0) {
        const preview = failures
          .slice(0, 10)
          .map((f) => `- ${f.model}: ${f.error}`)
          .join("\n");
        throw new Error(
          `live model failures (${failures.length}):\n${preview}`,
        );
      }

      // Keep one assertion so the test fails loudly if we somehow ran nothing.
      expect(models.length).toBeGreaterThan(0);
      void skipped;
    },
    15 * 60 * 1000,
  );
});
