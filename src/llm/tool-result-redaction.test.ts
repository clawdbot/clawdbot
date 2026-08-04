import { Agent, type AgentTool } from "openclaw/plugin-sdk/agent-core";
import { type Model, streamSimple } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../agents/tools/common.js";

const openAiMockState = vi.hoisted(() => ({
  requests: 0,
}));
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: () => {
          const request = openAiMockState.requests++;
          const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
          const chunks =
            request === 0
              ? [
                  {
                    id: "chatcmpl-tool",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          role: "assistant",
                          tool_calls: [
                            {
                              index: 0,
                              id: "call_exec",
                              type: "function",
                              function: { name: "exec", arguments: "{}" },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id: "chatcmpl-tool",
                    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                    usage,
                  },
                ]
              : [
                  {
                    id: "chatcmpl-final",
                    choices: [
                      {
                        index: 0,
                        delta: { role: "assistant", content: "done" },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id: "chatcmpl-final",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage,
                  },
                ];
          return {
            withResponse: async () => ({
              data: (async function* () {
                for (const chunk of chunks) {
                  yield chunk;
                }
              })(),
              response: new Response(null, { status: 200 }),
            }),
          };
        },
      },
    };
  },
}));

const model = {
  id: "provider-replay-test",
  name: "Provider replay test",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1024,
} satisfies Model<"openai-completions">;

const fakeSecret = ["qa", "-provider-secret-", "a1b2c3d4e5f6"].join("");
const safePayload = {
  password: fakeSecret,
  nonce: "QA_SAFE_NONCE_A1B2C3D4",
  status: "completed",
  cwd: "/workspace",
  exitCode: 0,
};

beforeEach(() => {
  openAiMockState.requests = 0;
});

describe("tool result redaction via AI transport host", () => {
  it("redacts real Agent tool output before the provider continuation request", async () => {
    const providerPayloads: unknown[] = [];
    const execute = vi.fn(async () => ({
      content: jsonResult(safePayload).content,
      details: safePayload,
    }));
    const tool = {
      name: "exec",
      label: "exec",
      description: "Return deterministic command evidence.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute,
    } satisfies AgentTool;
    const agent = new Agent({
      initialState: {
        model,
        tools: [tool],
      },
      streamFn: streamSimple,
      getApiKey: () => "test-api-key",
      onPayload: (payload) => {
        providerPayloads.push(structuredClone(payload));
      },
    });

    await agent.prompt("Run the exec tool once, then answer done.");

    expect(execute).toHaveBeenCalledOnce();
    expect(providerPayloads).toHaveLength(2);
    expect(openAiMockState.requests).toBe(2);

    const initialRequest = JSON.stringify(providerPayloads[0]);
    const continuationRequest = JSON.stringify(providerPayloads[1]);
    const continuationMessages = (
      providerPayloads[1] as { messages?: Array<{ content?: unknown; role?: string }> }
    ).messages;
    const toolContent = continuationMessages?.find((message) => message.role === "tool")?.content;
    expect(typeof toolContent).toBe("string");
    expect(initialRequest).not.toContain(fakeSecret);
    expect(initialRequest).not.toContain(safePayload.nonce);
    expect(continuationRequest).not.toContain(fakeSecret);
    expect(toolContent).toContain('"password"');
    expect(toolContent).toMatch(/password[^]*?(?:\*\*\*|…|redacted)/i);
    expect(toolContent).toContain(safePayload.nonce);
    expect(toolContent).toContain(safePayload.status);
    expect(toolContent).toContain(safePayload.cwd);
    expect(toolContent).toContain(String(safePayload.exitCode));

    const toolResults = agent.state.messages.filter((message) => message.role === "toolResult");
    const finalMessages = agent.state.messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.stopReason === "stop" &&
        message.content.some((block) => block.type === "text" && block.text === "done"),
    );
    expect(toolResults).toHaveLength(1);
    expect(finalMessages).toHaveLength(1);
  });
});
