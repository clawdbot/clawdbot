import { text as readText } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { runIsolatedCompletion } from "../agents/isolated-completion.js";
import { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { maybeGenerateDashboardSessionTitle } from "./dashboard-session-title.js";
import { deriveSessionTitle } from "./session-utils-core.js";

const provider = "title-proof";
const model = "title-model";
const modelRef = `${provider}/${model}`;
type TitleRequest = {
  authorization: string | undefined;
  url: string | undefined;
  body: { model?: string; stream?: boolean };
};

async function withTitleProvider(
  raw: string,
  run: (fixture: {
    cfg: OpenClawConfig;
    agentDir: string;
    storePath: string;
    requests: TitleRequest[];
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "title-transport" }, async (state) => {
    const requests: TitleRequest[] = [];
    await withServer(
      (request, response) => {
        void readText(request).then((body) => {
          requests.push({
            authorization: request.headers.authorization,
            url: request.url,
            body: JSON.parse(body),
          });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({
              id: "chatcmpl-title-proof",
              object: "chat.completion.chunk",
              created: 0,
              model,
              choices: [
                { index: 0, delta: { role: "assistant", content: raw }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}\n\ndata: [DONE]\n\n`,
          );
        });
      },
      async (baseUrl) => {
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: modelRef },
              utilityModel: modelRef,
            },
          },
          models: {
            mode: "replace",
            providers: {
              [provider]: {
                baseUrl: `${baseUrl}/v1`,
                apiKey: "test-key",
                api: "openai-completions",
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: model,
                    name: model,
                    api: "openai-completions",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 16_000,
                    maxTokens: 4_096,
                  },
                ],
              },
            },
          },
        };
        await run({
          cfg,
          agentDir: state.agentDir(),
          storePath: state.statePath("sessions.json"),
          requests,
        });
      },
    );
  });
}

describe("generated titles over the real OpenAI-compatible transport", () => {
  it.each([
    [
      "closed reasoning",
      "<think>private</think>Invoice follow-up",
      "Invoice follow-up",
      "Invoice follow-up",
    ],
    ["unclosed reasoning", "<think>private", "private", null],
    ["namespaced reasoning", "<mm:think>private", "private", null],
    [
      "trailing reasoning",
      "Invoice follow-up<think>private",
      "Invoice follow-up<think>private",
      "Invoice follow-up",
    ],
    [
      "literal code",
      "Debug `<think>` parsing",
      "Debug `<think>` parsing",
      "Debug `<think>` parsing",
    ],
  ] as const)(
    "separates %s from ordinary completion recovery",
    async (_name, raw, ordinary, title) => {
      await withTitleProvider(raw, async ({ cfg, agentDir, requests }) => {
        const task = { agentId: "main", agentDir, timeoutMs: 5_000 };
        await expect(
          runIsolatedCompletion({
            ...task,
            config: cfg,
            provider,
            model,
            systemPrompt: "Return a concise title.",
            prompt: "Help me follow up on the invoice.",
          }),
        ).resolves.toMatchObject({ text: ordinary });
        await expect(
          generateConversationLabel({
            ...task,
            cfg,
            modelRef,
            prompt: "Return a concise title.",
            userMessage: "Help me follow up on the invoice.",
          }),
        ).resolves.toBe(title);
        expect(requests).toEqual(
          Array.from({ length: 2 }, () => ({
            authorization: "Bearer test-key",
            url: "/v1/chat/completions",
            body: expect.objectContaining({ model, stream: true }),
          })),
        );
      });
    },
  );

  it("persists the generated title through the dashboard owner", async () => {
    await withTitleProvider(
      "Invoice follow-up<think>private",
      async ({ cfg, storePath, requests }) => {
        const sessionKey = "agent:main:dashboard:title-proof";
        const entry = { sessionId: "title-proof-session", updatedAt: 1 };
        const scope = { agentId: "main", sessionKey, storePath };
        await replaceSessionEntry(scope, entry);
        await expect(
          maybeGenerateDashboardSessionTitle({
            ...scope,
            cfg,
            entry,
            sessionId: entry.sessionId,
            userMessage: "Help me follow up on the invoice.",
          }),
        ).resolves.toBe(true);
        const persisted = loadSessionEntry(scope);
        expect(requests).toHaveLength(1);
        expect(persisted?.displayName).toBe("Invoice follow-up");
        expect(deriveSessionTitle(persisted)).toBe("Invoice follow-up");
      },
    );
  });
});
