// OpenAI-compatible HTTP tests cover chat completions, streaming, tool calls,
// session context, auth scopes, and provider error mapping.
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createClientToolNameConflictError } from "../agents/agent-tool-definition-adapter.js";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "../agents/embedded-agent-subscribe.js";
import { FailoverError } from "../agents/failover-error.js";
import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  waitForActiveGatewayRootWork,
} from "../process/gateway-work-admission.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildAssistantDeltaResult } from "./test-helpers.agent-results.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let enabledServer: Awaited<ReturnType<typeof startServer>>;
let enabledPort: number;

beforeAll(async () => {
  ({ startGatewayServer } = await import("./server.js"));
  const started = await startGatewayServerWithRetries({
    port: await getGatewayTestPort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
    },
  });
  enabledPort = started.port;
  enabledServer = started.server;
});

afterAll(async () => {
  await enabledServer?.close({ reason: "openai http enabled suite done" });
});

async function startServer(port: number, opts?: { openAiChatCompletionsEnabled?: boolean }) {
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "none" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? true,
  });
}

async function startSharedSecretServer(
  port: number,
  mode: "token" | "password",
  opts?: { openAiChatCompletionsEnabled?: boolean },
) {
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth:
      mode === "token"
        ? { mode: "token", token: "secret" }
        : { mode: "password", password: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? true,
  });
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function postChatCompletions(port: number, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function postRawChatCompletions(port: number, body: string) {
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
    },
    body,
  });
}

function createOpenAiChatClient(port: number): OpenAI {
  return new OpenAI({
    apiKey: "test",
    baseURL: `http://127.0.0.1:${port}/v1`,
    defaultHeaders: { "x-openclaw-scopes": "operator.write" },
    maxRetries: 0,
  });
}

function parseSseDataLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

type FirstAgentCommandOptions = {
  clientTools?: Array<{
    function?: {
      description?: string;
      name?: string;
      parameters?: Record<string, unknown>;
      strict?: boolean;
    };
    type?: string;
  }>;
  extraSystemPrompt?: string;
  images?: Array<{ data: string; mimeType: string; type: string }>;
  message?: string;
  messageChannel?: string;
  model?: string;
  senderIsOwner?: boolean;
  sessionKey?: string;
  streamParams?: {
    frequencyPenalty?: number;
    maxTokens?: number;
    presencePenalty?: number;
    responseFormat?: Record<string, unknown>;
    seed?: number;
    stop?: string[];
    temperature?: number;
    topP?: number;
  };
};

function firstAgentCommandOptions() {
  return agentCommandMock.mock.calls.at(0)?.[0] as FirstAgentCommandOptions | undefined;
}

describe("OpenAI-compatible HTTP API (e2e)", () => {
  it("returns a typed selection error unless an ownerless fleet request selects an agent", async () => {
    try {
      testState.agentsConfig = {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "beta" }],
      };
      resetConfigRuntimeState();
      agentCommandMock.mockClear();

      const missing = await postChatCompletions(enabledPort, {
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(missing.status).toBe(400);
      const missingJson = (await missing.json()) as { error?: { message?: string; type?: string } };
      expect(missingJson.error?.type).toBe("invalid_request_error");
      expect(missingJson.error?.message).toContain("has no explicit owner");
      expect(agentCommandMock).not.toHaveBeenCalled();

      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
      const selected = await postChatCompletions(
        enabledPort,
        { model: "openclaw/default", messages: [{ role: "user", content: "hi" }] },
        { "x-openclaw-agent-id": "main" },
      );
      expect(selected.status).toBe(200);
      expect(firstAgentCommandOptions()?.sessionKey ?? "").toMatch(/^agent:main:/);
      await selected.text();
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it("handles request validation and routing", async () => {
    const port = enabledPort;
    const mockAgentOnce = (payloads: Array<{ text: string }>) => {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads } as never);
    };
    const expectAgentSessionKeyMatch = async (request: {
      body: unknown;
      headers?: Record<string, string>;
      matcher: RegExp;
    }) => {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, request.body, request.headers);
      expect(res.status).toBe(200);
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expect(firstAgentCommandOptions()?.sessionKey ?? "").toMatch(request.matcher);
      await res.text();
    };
    const expectMessageContext = (
      message: string,
      expected: { history: string[]; current: string[] },
    ) => {
      expect(message).toContain(HISTORY_CONTEXT_MARKER);
      for (const line of expected.history) {
        expect(message).toContain(line);
      }
      expect(message).toContain(CURRENT_MESSAGE_MARKER);
      for (const line of expected.current) {
        expect(message).toContain(line);
      }
    };
    const getFirstAgentCall = () => firstAgentCommandOptions();
    const getFirstAgentMessage = () => getFirstAgentCall()?.message ?? "";
    const expectInvalidRequestNoDispatch = async (messages: unknown[]) => {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        messages,
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.type).toBe("invalid_request_error");
      expect(error?.message).toBe("Invalid image_url content in `messages`.");
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    };
    const postSyncUserMessage = async (message: string) => {
      const res = await postChatCompletions(port, {
        stream: false,
        model: "openclaw",
        messages: [{ role: "user", content: message }],
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };

    try {
      testState.agentsConfig = { list: [{ id: "main" }] };
      resetConfigRuntimeState();

      {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "GET",
          headers: { authorization: "Bearer secret" },
        });
        expect(res.status).toBe(405);
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openclaw-agent-id": "main",
          },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
        expect(getFirstAgentCall()?.messageChannel).toBe("webchat");
        await res.text();
      }

      testState.agentsConfig = {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "beta" }],
      };
      resetConfigRuntimeState();
      await expectAgentSessionKeyMatch({
        body: { model: "openclaw", messages: [{ role: "user", content: "hi" }] },
        headers: { "x-openclaw-agent-id": "beta" },
        matcher: /^agent:beta:/,
      });

      await expectAgentSessionKeyMatch({
        body: {
          model: "openclaw/beta",
          messages: [{ role: "user", content: "hi" }],
        },
        matcher: /^agent:beta:/,
      });

      testState.agentsConfig = { list: [{ id: "main" }] };
      resetConfigRuntimeState();

      await expectAgentSessionKeyMatch({
        body: {
          model: "openclaw/default",
          messages: [{ role: "user", content: "hi" }],
        },
        headers: { "x-openclaw-agent-id": "main" },
        matcher: /^agent:main:/,
      });

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(
          port,
          { model: "openclaw", messages: [{ role: "user", content: "hi" }] },
          { "x-openclaw-agent-id": "missing-agent" },
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe("Unknown agent 'missing-agent'.");
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(port, {
          model: "openclaw/missing-agent",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe("Unknown agent 'missing-agent'.");
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(
          port,
          { model: "openclaw", messages: [{ role: "user", content: "hi" }] },
          {
            "x-openclaw-session-key": "agent:main:harness:codex:supervision:spoofed-native-thread",
          },
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe(
          "`x-openclaw-session-key` cannot use reserved internal session namespaces.",
        );
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        testState.agentsConfig = {
          ownership: "explicit",
          list: [{ id: "main" }, { id: "beta" }],
        };
        resetConfigRuntimeState();
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          { model: "openclaw", messages: [{ role: "user", content: "hi" }] },
          {
            "x-openclaw-agent-id": "beta",
            "x-openclaw-session-key": "agent:beta:openai:custom",
          },
        );
        expect(res.status).toBe(200);

        expect(firstAgentCommandOptions()?.sessionKey).toBe("agent:beta:openai:custom");
        await res.text();
        testState.agentsConfig = { list: [{ id: "main" }] };
        resetConfigRuntimeState();
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(
          port,
          { model: "openclaw", messages: [{ role: "user", content: "hi" }] },
          { "x-openclaw-session-key": "agent:main:subagent:spoofed" },
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe(
          "`x-openclaw-session-key` cannot use reserved internal session namespaces.",
        );
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          user: "alice",
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(200);

        expect(firstAgentCommandOptions()?.sessionKey ?? "").toContain("openai-user:alice");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          {
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          { "x-openclaw-message-channel": "custom-client-channel" },
        );
        expect(res.status).toBe(200);
        expect(getFirstAgentCall()?.messageChannel).toBe("custom-client-channel");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          {
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          {
            "x-openclaw-model": "openai/gpt-5.4",
            "x-openclaw-scopes": "operator.admin, operator.write",
          },
        );
        expect(res.status).toBe(200);
        expect(firstAgentCommandOptions()?.model).toBe("openai/gpt-5.4");
        await res.text();
      }

      {
        await writeGatewayConfig({
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.4" },
              models: {
                "openai/gpt-5.4": {},
              },
            },
          },
        });
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          {
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          {
            "x-openclaw-model": "gpt-5.4",
            "x-openclaw-scopes": "operator.admin, operator.write",
          },
        );
        expect(res.status).toBe(200);
        expect(firstAgentCommandOptions()?.model).toBe("gpt-5.4");
        await res.text();
        await writeGatewayConfig({});
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(port, {
          model: "openai/",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe(
          "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
        );
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(
          port,
          {
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          { "x-openclaw-model": "openai/gpt-5.4" },
        );
        expect(res.status).toBe(403);
        const json = (await res.json()) as { error?: { message?: string; type?: string } };
        expect(json.error?.type).toBe("forbidden");
        expect(json.error?.message).toBe("missing scope: operator.admin");
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(
          port,
          {
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          {
            "x-openclaw-model": "openai/",
            "x-openclaw-scopes": "operator.admin, operator.write",
          },
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe("Invalid `x-openclaw-model`.");
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hello" },
                { type: "input_text", text: "world" },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        expect(firstAgentCommandOptions()?.message).toBe("hello\nworld");
        await res.text();
      }

      {
        const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA";
        mockAgentOnce([{ text: "looks good" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe this" },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${imageData}` },
                },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.message).toBe("describe this");
        expect(firstCall?.images).toEqual([
          { type: "image", data: imageData, mimeType: "image/png" },
        ]);
        await res.text();
      }

      {
        const imageData = "QUJDRA==";
        mockAgentOnce([{ text: "supports data-uri params" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "with metadata params" },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;charset=utf-8;base64,${imageData}` },
                },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.images).toEqual([
          { type: "image", data: imageData, mimeType: "image/png" },
        ]);
        await res.text();
      }

      await expectInvalidRequestNoDispatch([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/image.png" },
            },
          ],
        },
      ]);

      const malformedImageParts = [
        { type: "image_url" },
        { type: "image_url", image_url: null },
        { type: "image_url", image_url: {} },
        { type: "image_url", image_url: { url: "   " } },
        { type: "image_url", image_url: { url: 123 } },
        { type: "image_url", image_url: { url: null } },
        { type: "image_url", image_url: "   " },
        { type: "image_url", image_url: 123 },
      ];
      const validImagePart = {
        type: "image_url",
        image_url: { url: "data:image/png;base64,QUJDRA==" },
      };
      for (const imagePart of malformedImageParts) {
        for (const content of [
          [imagePart],
          [{ type: "text", text: "describe this" }, imagePart],
          [validImagePart, imagePart],
        ]) {
          await expectInvalidRequestNoDispatch([{ role: "user", content }]);
        }
      }

      for (const malformedDataUri of [
        "data:image/png,QUJDRA==",
        "data:image/png;base64,",
        "data:image/png;base64,%%%",
        "data:image/svg+xml;base64,PHN2Zz4=",
        "data:image/png;base64,JVBERi0xLjQK",
      ]) {
        await expectInvalidRequestNoDispatch([
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image_url", image_url: { url: malformedDataUri } },
            ],
          },
        ]);
      }

      {
        mockAgentOnce([{ text: "I can see the image" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "data:image/jpeg;base64,QUJDRA==" },
                },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.message).toContain("User sent image(s) with no text.");
        expect(firstCall?.images).toEqual([
          { type: "image", data: "QUJDRA==", mimeType: "image/jpeg" },
        ]);
        await res.text();
      }

      {
        mockAgentOnce([{ text: "follow up answer" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } },
              ],
            },
            { role: "assistant", content: "I can see it." },
            { role: "user", content: "What color was it?" },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.images).toBeUndefined();
        expect(firstCall?.message ?? "").not.toContain("User sent image(s) with no text.");
        await res.text();
      }

      for (const historicalImageParts of [
        [{ type: "image_url", image_url: { url: "   " } }],
        [validImagePart, { type: "image_url", image_url: { url: "   " } }],
      ]) {
        for (const followup of [
          { role: "user", content: "What color was it?" },
          { role: "tool", content: "Vision tool says it is blue." },
        ]) {
          mockAgentOnce([{ text: "follow up answer" }]);
          const res = await postChatCompletions(port, {
            model: "openclaw",
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "look at this" }, ...historicalImageParts],
              },
              { role: "assistant", content: "Checking the image." },
              followup,
            ],
          });
          expect(res.status).toBe(200);
          expect(getFirstAgentCall()?.images).toBeUndefined();
          expect(getFirstAgentMessage()).toContain("User: look at this");
          await res.text();
        }
      }

      {
        mockAgentOnce([{ text: "latest image only" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "first" },
                { type: "image_url", image_url: { url: "data:image/png;base64,QUFBQQ==" } },
              ],
            },
            { role: "assistant", content: "noted" },
            {
              role: "user",
              content: [
                { type: "text", text: "second" },
                { type: "image_url", image_url: { url: "data:image/png;base64,QkJCQg==" } },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.images).toEqual([
          { type: "image", data: "QkJCQg==", mimeType: "image/png" },
        ]);
        await res.text();
      }

      {
        const largeMessage = "x".repeat(1_200_000);
        mockAgentOnce([{ text: "accepted" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [{ role: "user", content: largeMessage }],
        });
        expect(res.status).toBe(200);
        await res.text();
      }

      await expectInvalidRequestNoDispatch([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:application/pdf;base64,QUJDRA==" },
            },
          ],
        },
      ]);

      {
        const manyImageParts = Array.from({ length: 9 }).map(() => ({
          type: "image_url",
          image_url: { url: "data:image/png;base64,QUJDRA==" },
        }));
        await expectInvalidRequestNoDispatch([
          {
            role: "user",
            content: manyImageParts,
          },
        ]);
      }

      {
        mockAgentOnce([{ text: "I am Claude" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello, who are you?" },
            { role: "assistant", content: "I am Claude." },
            { role: "user", content: "What did I just ask you?" },
          ],
        });
        expect(res.status).toBe(200);

        const message = getFirstAgentMessage();
        expectMessageContext(message, {
          history: ["User: Hello, who are you?", "Assistant: I am Claude."],
          current: ["User: What did I just ask you?"],
        });
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello" },
          ],
        });
        expect(res.status).toBe(200);

        const message = getFirstAgentMessage();
        expect(message).not.toContain(HISTORY_CONTEXT_MARKER);
        expect(message).not.toContain(CURRENT_MESSAGE_MARKER);
        expect(message).toBe("Hello");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "developer", content: "You are a helpful assistant." },
            { role: "user", content: "Hello" },
          ],
        });
        expect(res.status).toBe(200);

        const extraSystemPrompt = getFirstAgentCall()?.extraSystemPrompt ?? "";
        expect(extraSystemPrompt).toBe("You are a helpful assistant.");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "ok" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "What's the weather?" },
            { role: "assistant", content: "Checking the weather." },
            { role: "tool", content: "Sunny, 70F." },
          ],
        });
        expect(res.status).toBe(200);

        const message = getFirstAgentMessage();
        expectMessageContext(message, {
          history: ["User: What's the weather?", "Assistant: Checking the weather."],
          current: ["Tool: Sunny, 70F."],
        });
        await res.text();
      }

      {
        mockAgentOnce([{ text: "tool follow-up ok" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look at this" },
                { type: "image_url", image_url: { url: "https://example.com/image.png" } },
              ],
            },
            { role: "assistant", content: "Checking the image." },
            { role: "tool", content: "Vision tool says it is blue." },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.images).toBeUndefined();
        const message = getFirstAgentMessage();
        expectMessageContext(message, {
          history: ["User: look at this", "Assistant: Checking the image."],
          current: ["Tool: Vision tool says it is blue."],
        });
        expect(message).not.toContain("User sent image(s) with no text.");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "tool choice none" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tool_choice: "none",
          tools: [
            {
              type: "function",
              function: {
                name: "get_time",
                description: "Get current time",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "time?" }],
        });
        expect(res.status).toBe(200);
        const firstCall = getFirstAgentCall();
        expect(firstCall?.clientTools).toBeUndefined();
        await res.text();
      }

      {
        mockAgentOnce([{ text: "tool choice auto" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tool_choice: "auto",
          tools: [
            {
              type: "function",
              function: {
                name: "get_time",
                description: "Get current time",
                parameters: { type: "object", properties: {} },
                strict: true,
              },
            },
          ],
          messages: [{ role: "user", content: "time?" }],
        });
        expect(res.status).toBe(200);
        const firstCall = getFirstAgentCall();
        const clientTools = firstCall?.clientTools ?? [];
        expect(clientTools).toHaveLength(1);
        expect(clientTools[0]?.type).toBe("function");
        expect(clientTools[0]?.function?.name).toBe("get_time");
        expect(clientTools[0]?.function?.strict).toBe(true);
        expect(firstCall).not.toHaveProperty("toolsAllow");
        await res.text();
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "tool choice function" }],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [
              {
                id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Taipei"}',
              },
            ],
          },
        } as never);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tool_choice: { type: "function", function: { name: "get_weather" } },
          tools: [
            {
              type: "function",
              function: {
                name: "get_time",
                description: "Get current time",
                parameters: { type: "object", properties: {} },
              },
            },
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get current weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            },
          ],
          messages: [{ role: "user", content: "weather?" }],
        });
        expect(res.status).toBe(200);
        const firstCall = getFirstAgentCall();
        const clientTools = firstCall?.clientTools ?? [];
        expect(clientTools).toHaveLength(1);
        expect(clientTools[0]?.function?.name).toBe("get_weather");
        expect(firstCall?.extraSystemPrompt ?? "").toContain("You must call the get_weather tool");
        const json = (await res.json()) as { choices?: Array<{ finish_reason?: string | null }> };
        expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "tool choice required" }],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [
              {
                id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Taipei"}',
              },
            ],
          },
        } as never);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tool_choice: "required",
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get current weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            },
          ],
          messages: [{ role: "user", content: "weather?" }],
        });
        expect(res.status).toBe(200);
        const firstCall = getFirstAgentCall();
        const clientTools = firstCall?.clientTools ?? [];
        expect(clientTools).toHaveLength(1);
        expect(clientTools[0]?.function?.name).toBe("get_weather");
        expect(firstCall?.extraSystemPrompt ?? "").toContain(
          "You must call one of the available tools",
        );
        const json = (await res.json()) as { choices?: Array<{ finish_reason?: string | null }> };
        expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");
      }

      {
        mockAgentOnce([{ text: "plain text despite required" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tool_choice: "required",
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get current weather",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "weather?" }],
        });
        expect(res.status).toBe(502);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("api_error");
        expect(json.error?.message ?? "").toContain("tool_choice=required was not satisfied");
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "Calling a different tool." }],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [{ id: "call_1", name: "get_time", arguments: "{}" }],
          },
        } as never);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tool_choice: { type: "function", function: { name: "get_weather" } },
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get current weather",
                parameters: { type: "object", properties: {} },
              },
            },
            {
              type: "function",
              function: {
                name: "get_time",
                description: "Get current time",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "weather?" }],
        });
        expect(res.status).toBe(502);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("api_error");
        expect(json.error?.message ?? "").toContain("tool_choice required a get_weather tool call");
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tool_choice: "required",
          messages: [{ role: "user", content: "weather?" }],
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message ?? "").toContain("no tools were provided");
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tool_choice: { type: "function", function: { name: "missing_tool" } },
          tools: [
            {
              type: "function",
              function: {
                name: "get_time",
                description: "Get current time",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "weather?" }],
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message ?? "").toContain("unknown tool");
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tool_choice: {
            type: "allowed_tools",
            tools: [{ type: "function", function: { name: "x" } }],
          },
          tools: [
            {
              type: "function",
              function: {
                name: "x",
                description: "x",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "x?" }],
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message ?? "").toContain("allowed_tools");
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(port, {
          model: "openclaw",
          tools: [
            {
              type: "function",
              name: "invalid_flat_shape",
              parameters: { type: "object", properties: {} },
            },
          ],
          messages: [{ role: "user", content: "x?" }],
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message ?? "").toContain("tool.function is required");
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        mockAgentOnce([{ text: "ok" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "user", content: "What's the weather?" },
            { role: "assistant", content: "Checking the weather." },
            {
              role: "tool",
              tool_call_id: "call_1",
              content: [{ type: "text", text: "Sunny, 70F." }],
            },
          ],
        });
        expect(res.status).toBe(200);
        const message = getFirstAgentMessage();
        expectMessageContext(message, {
          history: ["User: What's the weather?", "Assistant: Checking the weather."],
          current: ["Tool:call_1: Sunny, 70F."],
        });
        await res.text();
      }

      {
        mockAgentOnce([{ text: "ok" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "user", content: "What's the weather?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"Taipei"}',
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_1",
              content: [{ type: "text", text: "Sunny, 70F." }],
            },
          ],
        });
        expect(res.status).toBe(200);
        const message = getFirstAgentMessage();
        expectMessageContext(message, {
          history: [
            "User: What's the weather?",
            'Assistant: tool_call id=call_1 name=get_weather arguments={"city":"Taipei"}',
          ],
          current: ["Tool:call_1: Sunny, 70F."],
        });
        await res.text();
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockRejectedValueOnce(createClientToolNameConflictError(["exec"]));
        const res = await postChatCompletions(port, {
          stream: false,
          model: "openclaw",
          tools: [
            {
              type: "function",
              function: {
                name: "exec",
                description: "conflicts with a built-in tool",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "run command" }],
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe("invalid tool configuration");
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "Let me check that." }],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [
              {
                id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Taipei"}',
              },
              {
                id: "call_2",
                name: "get_time",
                arguments: "{}",
              },
            ],
            agentMeta: {
              usage: {
                input: 10,
                output: 5,
                total: 15,
              },
            },
          },
        } as never);
        const res = await postChatCompletions(port, {
          stream: false,
          model: "openclaw",
          tool_choice: "auto",
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            },
            {
              type: "function",
              function: {
                name: "get_time",
                description: "Get time",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "weather?" }],
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          choices?: Array<{
            finish_reason?: string | null;
            message?: {
              role?: string;
              content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        const choice = json.choices?.[0];
        expect(choice?.finish_reason).toBe("tool_calls");
        expect(choice?.message?.role).toBe("assistant");
        expect(choice?.message?.content).toBe("Let me check that.");
        expect(choice?.message?.tool_calls).toEqual([
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Taipei"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "get_time", arguments: "{}" },
          },
        ]);
        expect(choice?.message?.tool_calls?.some((call) => Object.hasOwn(call, "index"))).toBe(
          false,
        );
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [
              {
                id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Taipei"}',
              },
            ],
          },
        } as never);
        const res = await postChatCompletions(port, {
          stream: false,
          model: "openclaw",
          tool_choice: "auto",
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            },
          ],
          messages: [{ role: "user", content: "weather?" }],
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          choices?: Array<{
            finish_reason?: string | null;
            message?: { content?: string; tool_calls?: unknown[] };
          }>;
        };
        const choice = json.choices?.[0];
        expect(choice?.finish_reason).toBe("tool_calls");
        expect(choice?.message?.content).toBe("");
        expect(choice?.message?.tool_calls).toHaveLength(1);
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const json = await postSyncUserMessage("hi");
        expect(json.object).toBe("chat.completion");
        expect(Array.isArray(json.choices)).toBe(true);
        const choice0 = (json.choices as Array<Record<string, unknown>>)[0] ?? {};
        const msg = (choice0.message as Record<string, unknown> | undefined) ?? {};
        expect(msg.role).toBe("assistant");
        expect(msg.content).toBe("hello");
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          const { session, emit } = createStubSessionHarness();
          subscribeEmbeddedAgentSession({ session, runId });
          emit({ type: "message_start", message: { role: "assistant" } });
          for (const delta of ["<", "final>Title\n", "Line one\nLine two</", "final>"]) {
            emitAssistantTextDelta({ emit, delta });
          }
          return { payloads: [{ text: "Title\nLine one\nLine two" }] };
        }) as never);

        const splitFinalRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(splitFinalRes.status).toBe(200);
        const splitFinalText = await splitFinalRes.text();
        const splitFinalData = parseSseDataLines(splitFinalText);
        const splitFinalChunks = splitFinalData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const splitFinalContent = splitFinalChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
          .filter((v): v is string => typeof v === "string")
          .join("");
        expect(splitFinalContent).toBe("Title\nLine one\nLine two");
        expect(splitFinalContent).not.toContain("<");
        expect(splitFinalContent).not.toContain("final>");
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "usage basic" }],
          meta: {
            agentMeta: {
              usage: {
                input: 42,
                output: 17,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 42,
          completion_tokens: 17,
          total_tokens: 59,
        });
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "usage cache" }],
          meta: {
            agentMeta: {
              usage: {
                input: 10,
                output: 5,
                cacheRead: 20,
                cacheWrite: 3,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 30,
          completion_tokens: 5,
          total_tokens: 35,
          prompt_tokens_details: { cached_tokens: 20 },
        });
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "usage last call" }],
          meta: {
            agentMeta: {
              lastCallUsage: { input: 80, output: 20, total: 100 },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 80,
          completion_tokens: 20,
          total_tokens: 100,
        });
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "usage total" }],
          meta: {
            agentMeta: {
              usage: {
                input: 10,
                output: 5,
                total: 100,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 100,
        });
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "usage total only" }],
          meta: {
            agentMeta: {
              usage: {
                total: 123,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 123,
        });
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "usage non-finite" }],
          meta: {
            agentMeta: {
              usage: {
                input: Number.POSITIVE_INFINITY,
                output: Number.NaN,
                cacheRead: 2,
                cacheWrite: Number.POSITIVE_INFINITY,
                total: Number.NaN,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 2,
          completion_tokens: 0,
          total_tokens: 2,
          prompt_tokens_details: { cached_tokens: 2 },
        });
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "usage non-finite aggregate fallback" }],
          meta: {
            agentMeta: {
              usage: {
                input: Number.POSITIVE_INFINITY,
                output: Number.NaN,
                total: 123,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 123,
        });
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "usage cache-write only" }],
          meta: {
            agentMeta: {
              usage: {
                cacheWrite: 10,
                total: 10,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 10,
        });
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "" }] } as never);
        const json = await postSyncUserMessage("hi");
        const choice0 = (json.choices as Array<Record<string, unknown>>)[0] ?? {};
        const msg = (choice0.message as Record<string, unknown> | undefined) ?? {};
        expect(msg.content).toBe("No response from OpenClaw.");
      }

      {
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [{ role: "system", content: "yo" }],
        });
        expect(res.status).toBe(400);
        const missingUserJson = (await res.json()) as Record<string, unknown>;
        expect((missingUserJson.error as Record<string, unknown> | undefined)?.type).toBe(
          "invalid_request_error",
        );
      }
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it("validates and forwards max_completion_tokens and max_tokens into streamParams", async () => {
    const port = enabledPort;
    const mockAgentOnce = () => {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
    };
    const getRecordedAgentMaxTokens = () => firstAgentCommandOptions()?.streamParams?.maxTokens;

    const validCases: Array<{
      name: string;
      body: Record<string, unknown>;
      expected: number | undefined;
    }> = [
      { name: "current field", body: { max_completion_tokens: 256 }, expected: 256 },
      { name: "legacy field", body: { max_tokens: 128 }, expected: 128 },
      {
        name: "current field precedence",
        body: { max_completion_tokens: 64, max_tokens: 999 },
        expected: 64,
      },
      {
        name: "null current field leaves legacy active",
        body: { max_completion_tokens: null, max_tokens: 32 },
        expected: 32,
      },
      {
        name: "null legacy field leaves current active",
        body: { max_completion_tokens: 16, max_tokens: null },
        expected: 16,
      },
      {
        name: "largest safe integer",
        body: { max_completion_tokens: Number.MAX_SAFE_INTEGER },
        expected: Number.MAX_SAFE_INTEGER,
      },
      { name: "omitted fields", body: {}, expected: undefined },
    ];

    for (const testCase of validCases) {
      mockAgentOnce();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        ...testCase.body,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(agentCommandMock, testCase.name).toHaveBeenCalledTimes(1);
      expect(getRecordedAgentMaxTokens(), testCase.name).toBe(testCase.expected);
      await res.text();
    }

    mockAgentOnce();
    const client = createOpenAiChatClient(port);
    await client.chat.completions.create({
      model: "openclaw",
      max_completion_tokens: null,
      max_tokens: null,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(agentCommandMock, "SDK null fields").toHaveBeenCalledTimes(1);
    expect(getRecordedAgentMaxTokens(), "SDK null fields").toBeUndefined();
  });

  it("rejects malformed token caps before agent dispatch", async () => {
    const port = enabledPort;
    const invalidValues: Array<{ name: string; value: unknown }> = [
      { name: "string", value: "32" },
      { name: "object", value: {} },
      { name: "array", value: [32] },
      { name: "zero", value: 0 },
      { name: "negative", value: -1 },
      { name: "fractional", value: 1.5 },
      { name: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const field of ["max_completion_tokens", "max_tokens"] as const) {
      for (const testCase of invalidValues) {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(port, {
          model: "openclaw",
          [field]: testCase.value,
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status, `${field}: ${testCase.name}`).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toContain(field);
        expect(agentCommandMock, `${field}: ${testCase.name}`).toHaveBeenCalledTimes(0);
      }

      agentCommandMock.mockClear();
      const res = await postRawChatCompletions(
        port,
        `{"model":"openclaw","messages":[{"role":"user","content":"hi"}],"${field}":1e309}`,
      );
      expect(res.status, `${field}: non-finite raw number`).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toContain(field);
      expect(agentCommandMock, `${field}: non-finite raw number`).toHaveBeenCalledTimes(0);
    }

    const shadowedCases = [
      {
        name: "malformed current field with valid legacy field",
        body: { max_completion_tokens: "64", max_tokens: 32 },
        field: "max_completion_tokens",
      },
      {
        name: "malformed legacy field with valid current field",
        body: { max_completion_tokens: 64, max_tokens: "32" },
        field: "max_tokens",
      },
    ];
    for (const testCase of shadowedCases) {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        ...testCase.body,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status, testCase.name).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toContain(testCase.field);
      expect(agentCommandMock, testCase.name).toHaveBeenCalledTimes(0);
    }
  });

  it("forwards inbound temperature and top_p into streamParams", async () => {
    const port = enabledPort;
    const mockAgentOnce = (payloads: Array<{ text: string }>) => {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads } as never);
    };
    const getStreamParams = () => firstAgentCommandOptions()?.streamParams;

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        temperature: 0.3,
        top_p: 0.95,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toMatchObject({ temperature: 0.3, topP: 0.95 });
      await res.text();
    }

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        temperature: 0,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      const params = getStreamParams();
      expect(params?.temperature).toBe(0);
      expect(params?.topP).toBeUndefined();
      await res.text();
    }

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toBeUndefined();
      await res.text();
    }

    {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        temperature: 999,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toMatch(/temperature/);
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    }

    {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        top_p: 5,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toMatch(/top_p/);
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    }
  });

  it("forwards inbound penalty and seed params into streamParams", async () => {
    const port = enabledPort;
    const mockAgentOnce = (payloads: Array<{ text: string }>) => {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads } as never);
    };
    const getStreamParams = () => firstAgentCommandOptions()?.streamParams;

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        frequency_penalty: -0.5,
        presence_penalty: 1.25,
        seed: 12345,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toMatchObject({
        frequencyPenalty: -0.5,
        presencePenalty: 1.25,
        seed: 12345,
      });
      await res.text();
    }

    for (const body of [{ frequency_penalty: 3 }, { presence_penalty: -3 }, { seed: 1.5 }]) {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        ...body,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    }
  });

  it("forwards inbound stop into streamParams", async () => {
    const port = enabledPort;
    const mockAgentOnce = (payloads: Array<{ text: string }>) => {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads } as never);
    };
    const getStreamParams = () => firstAgentCommandOptions()?.streamParams;

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        stop: "\n\n",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toMatchObject({ stop: ["\n\n"] });
      await res.text();
    }

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        stop: ["User:", "Assistant:"],
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toMatchObject({ stop: ["User:", "Assistant:"] });
      await res.text();
    }

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toBeUndefined();
      await res.text();
    }

    for (const stop of [["a", "b", "c", "d", "e"], [""], [123], {}]) {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        stop,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toMatch(/stop/);
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    }
  });

  it("maps provider format failures to OpenAI-compatible 400 errors", async () => {
    const port = enabledPort;

    agentCommandMock.mockClear();
    agentCommandMock.mockRejectedValueOnce(
      new FailoverError(
        "LLM request failed: provider rejected the request schema or tool payload.",
        {
          reason: "format",
          status: 400,
          code: "decimal_above_max_value",
          rawError:
            "400 Invalid 'temperature': decimal above maximum value. Expected a value <= 2, but got 999 instead.",
        },
      ) as never,
    );

    const res = await postChatCompletions(port, {
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error?: { type?: string; code?: string; message?: string };
    };
    expect(json.error?.type).toBe("invalid_request_error");
    expect(json.error?.code).toBe("decimal_above_max_value");
    expect(json.error?.message).toContain("Invalid 'temperature'");
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
  });

  it("rejects resolved terminal agent failures without exposing provider details", async () => {
    const privateDetail = "raw provider detail should stay private";
    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce({
      payloads: [{ text: "Command may have changed state", isError: true }],
      meta: { error: { kind: "incomplete_turn", message: privateDetail } },
    } as never);

    const res = await postChatCompletions(enabledPort, {
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: { message: "internal error", type: "api_error" },
    });
    expect(body).not.toContain(privateDetail);
  });

  it("rejects resolved error stop reasons", async () => {
    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce({
      payloads: [{ text: "Command may have changed state", isError: true }],
      meta: { stopReason: "error" },
    } as never);

    const res = await postChatCompletions(enabledPort, {
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(500);
  });

  it("forwards response_format into streamParams", async () => {
    const port = enabledPort;
    const mockAgentOnce = (payloads: Array<{ text: string }>) => {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads } as never);
    };
    const getStreamParams = () => firstAgentCommandOptions()?.streamParams;

    {
      mockAgentOnce([{ text: "{}" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toMatchObject({ responseFormat: { type: "json_object" } });
      await res.text();
    }

    {
      mockAgentOnce([{ text: "{}" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        response_format: {
          type: "json_schema",
          json_schema: { name: "test", schema: { type: "object" } },
        },
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toMatchObject({
        responseFormat: { type: "json_schema" },
      });
      await res.text();
    }

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        response_format: { type: "text" },
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toMatchObject({ responseFormat: { type: "text" } });
      await res.text();
    }

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toBeUndefined();
      await res.text();
    }

    {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        response_format: { type: "xml" },
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toMatch(/response_format/);
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    }
  });

  it("returns 429 for repeated failed auth when gateway.auth.rateLimit is configured", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
    };
    await withGatewayServer(
      async ({ port }) => {
        const headers = {
          "content-type": "application/json",
          authorization: "Bearer wrong",
        };
        const body = {
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        };

        const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(first.status).toBe(401);

        const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(second.status).toBe(429);
        expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
      },
      {
        serverOptions: {
          host: "127.0.0.1",
          controlUiEnabled: false,
          openAiChatCompletionsEnabled: true,
        },
      },
    );
  });

  it.each([
    {
      name: "a split custom XML opener",
      deltas: ["<", "xiaohai-banli>milk tea</", "xiaohai-banli>"],
      expected: "<xiaohai-banli>milk tea</xiaohai-banli>",
    },
    {
      name: "literal script-like content",
      deltas: ["<", "script>alert('literal')</", "script>"],
      expected: "<script>alert('literal')</script>",
    },
  ])("preserves $name through the official OpenAI SDK SSE stream", async ({ deltas, expected }) => {
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      const { session, emit } = createStubSessionHarness();
      subscribeEmbeddedAgentSession({ session, runId });
      emit({ type: "message_start", message: { role: "assistant" } });
      for (const delta of deltas) {
        emitAssistantTextDelta({ emit, delta });
      }
      return { payloads: [{ text: expected }] };
    }) as never);

    const stream = await createOpenAiChatClient(enabledPort).chat.completions.create({
      model: "openclaw",
      messages: [{ role: "user", content: "Preserve the literal output." }],
      stream: true,
    });
    const content: string[] = [];
    const finishReasons: Array<string | null> = [];
    for await (const chunk of stream) {
      for (const choice of chunk.choices) {
        if (typeof choice.delta.content === "string") {
          content.push(choice.delta.content);
        }
        finishReasons.push(choice.finish_reason);
      }
    }

    expect(content.join("")).toBe(expected);
    expect(finishReasons.at(-1)).toBe("stop");
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
  });

  it("preserves buffered leading content in cumulative assistant snapshots", async () => {
    const expected = "<xiaohai-banli>milk tea</xiaohai-banli>";
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: {
          text: expected,
          delta: "xiaohai-banli>milk tea</xiaohai-banli>",
        },
      });
      return { payloads: [{ text: expected }] };
    }) as never);

    const stream = await createOpenAiChatClient(enabledPort).chat.completions.create({
      model: "openclaw",
      messages: [{ role: "user", content: "Preserve the full snapshot." }],
      stream: true,
    });
    const content: string[] = [];
    const finishReasons: Array<string | null> = [];
    for await (const chunk of stream) {
      for (const choice of chunk.choices) {
        if (typeof choice.delta.content === "string") {
          content.push(choice.delta.content);
        }
        finishReasons.push(choice.finish_reason);
      }
    }

    expect(content.join("")).toBe(expected);
    expect(finishReasons.at(-1)).toBe("stop");
  });

  it("flushes same-turn assistant microtasks before the SSE done frame", async () => {
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce(((opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "start " } });
      const result = Promise.resolve({ payloads: [{ text: "start finish" }] });
      void result.then(() => {
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        void Promise.resolve().then(() => {
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "finish" } });
        });
      });
      return result;
    }) as never);

    const res = await postChatCompletions(enabledPort, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "Finish the streamed response." }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const data = parseSseDataLines(await res.text());
    expect(data.at(-1)).toBe("[DONE]");
    const chunks = data
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const content = chunks
      .flatMap((chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])
      .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    expect(content).toBe("start finish");
    const finishChoice = chunks
      .flatMap((chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])
      .at(-1);
    expect(finishChoice?.finish_reason).toBe("stop");
  });

  it.each([
    { name: "resolved", reject: false },
    { name: "rejected", reject: true },
  ])(
    "fails an official SDK stream when an error lifecycle precedes a $name run",
    async ({ reject }) => {
      const idleRootCount = getActiveGatewayRootWorkCount();
      const wireResponse = createDeferred<string>();
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
        const runId = (opts as { runId?: string }).runId;
        if (!runId) {
          throw new Error("expected a streaming chat-completion run ID");
        }
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "partial answer" } });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "error", error: "All model fallback candidates failed" },
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "error", error: "A later lifecycle event must not replace the failure" },
        });
        if (reject) {
          throw new Error("private upstream failure");
        }
        return {
          payloads: [{ text: "partial answer" }],
          meta: { agentMeta: { usage: { input: 11, output: 7, total: 18 } } },
        };
      }) as never);

      const client = new OpenAI({
        apiKey: "test",
        baseURL: `http://127.0.0.1:${enabledPort}/v1`,
        defaultHeaders: { "x-openclaw-scopes": "operator.write" },
        maxRetries: 0,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          void response.clone().text().then(wireResponse.resolve, wireResponse.reject);
          return response;
        },
      });
      const stream = await client.chat.completions.create({
        model: "openclaw",
        messages: [{ role: "user", content: "Report the provider failure." }],
        stream: true,
      });
      const deliveredContent: string[] = [];
      const deliveredFinishReasons: Array<string | null> = [];

      await expect(async () => {
        for await (const chunk of stream) {
          for (const choice of chunk.choices) {
            if (typeof choice.delta.content === "string") {
              deliveredContent.push(choice.delta.content);
            }
            deliveredFinishReasons.push(choice.finish_reason);
          }
        }
      }).rejects.toMatchObject({
        message: "All model fallback candidates failed",
        type: "api_error",
      });

      const data = parseSseDataLines(await wireResponse.promise);
      const chunks = data
        .filter((line) => line !== "[DONE]")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(deliveredContent).toEqual(["partial answer"]);
      expect(deliveredFinishReasons.every((reason) => reason === null)).toBe(true);
      expect(chunks.filter((chunk) => "error" in chunk)).toEqual([
        { error: { message: "All model fallback candidates failed", type: "api_error" } },
      ]);
      expect(data.at(-1)).toBe("[DONE]");
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
    },
  );

  it.each([
    { name: "rewritten", replacementText: "final answer" },
    { name: "shortened", replacementText: "dra" },
    { name: "cleared", replacementText: "" },
  ])("fails an official SDK stream when streamed text is $name", async ({ replacementText }) => {
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string }).runId;
      if (!runId) {
        throw new Error("expected a streaming chat-completion run ID");
      }
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text: "draft answer", delta: "draft answer" },
      });
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text: replacementText, delta: "", replace: true, phase: "commentary" },
      });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
      return { payloads: [{ text: replacementText }] };
    }) as never);

    const stream = await createOpenAiChatClient(enabledPort).chat.completions.create({
      model: "openclaw",
      messages: [{ role: "user", content: "Reject an incompatible replacement snapshot." }],
      stream: true,
    });
    const deliveredContent: string[] = [];
    await expect(async () => {
      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          if (typeof choice.delta.content === "string") {
            deliveredContent.push(choice.delta.content);
          }
        }
      }
    }).rejects.toMatchObject({
      message: "Assistant output cannot be represented as an append-only response stream.",
      type: "api_error",
    });
    expect(deliveredContent).toEqual(["draft answer"]);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "a producer replacement snapshot without a delta",
      previousDelta: undefined,
      replacementDelta: undefined,
    },
    {
      name: "a producer replacement snapshot with its own delta",
      previousDelta: undefined,
      replacementDelta: "final answer",
    },
    {
      name: "an append-compatible replacement after streamed partial text",
      previousDelta: "final ",
      replacementDelta: "answer",
    },
  ])(
    "keeps official SDK text consistent for $name",
    async ({ previousDelta, replacementDelta }) => {
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
        const runId = (opts as { runId?: string }).runId;
        if (!runId) {
          throw new Error("expected a streaming chat-completion run ID");
        }
        if (previousDelta) {
          emitAgentEvent({
            runId,
            stream: "assistant",
            data: { text: previousDelta, delta: previousDelta },
          });
        }
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: {
            text: "final answer",
            replace: true,
            phase: "commentary",
            ...(replacementDelta === undefined ? {} : { delta: replacementDelta }),
          },
        });
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        return { payloads: [{ text: "final answer" }] };
      }) as never);

      const stream = await createOpenAiChatClient(enabledPort).chat.completions.create({
        model: "openclaw",
        messages: [{ role: "user", content: "Preserve an append-compatible replacement." }],
        stream: true,
      });
      const deliveredContent: string[] = [];
      const finishReasons: Array<string | null> = [];
      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          if (typeof choice.delta.content === "string") {
            deliveredContent.push(choice.delta.content);
          }
          finishReasons.push(choice.finish_reason);
        }
      }
      expect(deliveredContent.join("")).toBe("final answer");
      expect(finishReasons.at(-1)).toBe("stop");
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "successful completion without a provider terminal",
      fail: false,
      providerTerminal: false,
      expected: "hello",
      protocolError: false,
    },
    {
      name: "successful completion with a provider terminal",
      fail: false,
      providerTerminal: true,
      expected: "hello",
      protocolError: false,
    },
    {
      name: "internal agent error without a provider terminal",
      fail: true,
      providerTerminal: false,
      expected: "Error: internal error",
      protocolError: false,
    },
    {
      name: "internal agent error with a provider terminal",
      fail: true,
      providerTerminal: true,
      expected: "Agent run failed",
      protocolError: true,
    },
  ])(
    "separates streamed content from the terminal finish for an official SDK $name",
    async ({ fail, providerTerminal, expected, protocolError }) => {
      const idleRootCount = getActiveGatewayRootWorkCount();
      const terminalAdmission = createDeferred<{
        active: number;
        drained: { drained: boolean; active: number };
      }>();
      const wireResponse = createDeferred<string>();
      const continueAgent = createDeferred();
      const lifecycleTerminals: string[] = [];
      let activeRunId: string | undefined;
      const unsubscribe = onAgentEvent((event) => {
        const phase = event.data?.phase;
        if (event.runId !== activeRunId || event.stream !== "lifecycle") {
          return;
        }
        if (phase !== "end" && phase !== "error") {
          return;
        }
        lifecycleTerminals.push(phase);
        // Agent settlement schedules the terminal in a later microtask. The
        // request must remain admitted until Node finishes the actual stream.
        const active = getActiveGatewayRootWorkCount();
        void waitForActiveGatewayRootWork(0).then((drained) => {
          terminalAdmission.resolve({ active, drained });
        });
      });
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
        activeRunId = (opts as { runId?: string }).runId;
        if (!activeRunId) {
          throw new Error("expected a streaming chat-completion run ID");
        }
        await continueAgent.promise;
        if (fail) {
          if (providerTerminal) {
            emitAgentEvent({ runId: activeRunId, stream: "lifecycle", data: { phase: "error" } });
          }
          throw new Error("private upstream failure");
        }
        const result = buildAssistantDeltaResult({
          opts,
          emit: emitAgentEvent,
          deltas: ["he", "llo"],
          text: expected,
        });
        if (providerTerminal) {
          emitAgentEvent({ runId: activeRunId, stream: "lifecycle", data: { phase: "end" } });
        }
        return result;
      }) as never);

      try {
        const client = new OpenAI({
          apiKey: "test",
          baseURL: `http://127.0.0.1:${enabledPort}/v1`,
          defaultHeaders: { "x-openclaw-scopes": "operator.write" },
          maxRetries: 0,
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            void response.clone().text().then(wireResponse.resolve, wireResponse.reject);
            return response;
          },
        });
        const stream = await client.chat.completions.create({
          model: "openclaw",
          messages: [{ role: "user", content: "Return a complete streamed response." }],
          stream: true,
        });
        await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        continueAgent.resolve();

        const choices: Array<{
          delta: { content?: string | null };
          finish_reason: string | null;
        }> = [];
        const consumeStream = async () => {
          for await (const chunk of stream) {
            choices.push(...chunk.choices);
          }
        };
        if (protocolError) {
          await expect(consumeStream()).rejects.toMatchObject({
            message: expected,
            type: "api_error",
          });
        } else {
          await consumeStream();
        }

        const [admission, wire] = await Promise.all([
          terminalAdmission.promise,
          wireResponse.promise,
        ]);
        expect(admission.active).toBe(idleRootCount + 1);
        expect(admission.drained).toEqual({ drained: false, active: idleRootCount + 1 });
        expect(parseSseDataLines(wire).at(-1)).toBe("[DONE]");
        expect(lifecycleTerminals).toEqual([fail ? "error" : "end"]);

        const contentChoices = choices.filter((choice) => typeof choice.delta.content === "string");
        expect(contentChoices.map((choice) => choice.delta.content).join("")).toBe(
          protocolError ? "" : expected,
        );
        expect(contentChoices.every((choice) => choice.finish_reason === null)).toBe(true);

        const terminalChoices = choices.filter((choice) => choice.finish_reason === "stop");
        expect(terminalChoices).toHaveLength(protocolError ? 0 : 1);
        if (!protocolError) {
          expect(terminalChoices[0]?.delta).toEqual({});
          expect(choices.at(-1)).toEqual(terminalChoices[0]);
        }
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
      } finally {
        continueAgent.resolve();
        unsubscribe();
      }
    },
  );

  it("streams SSE chunks when stream=true", async () => {
    const port = enabledPort;
    try {
      {
        agentCommandMock.mockClear();
        agentCommandMock.mockImplementationOnce((async (opts: unknown) =>
          buildAssistantDeltaResult({
            opts,
            emit: emitAgentEvent,
            deltas: ["he", "llo"],
            text: "hello",
          })) as never);

        const res = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

        const text = await res.text();
        const data = parseSseDataLines(text);
        expect(data[data.length - 1]).toBe("[DONE]");

        const jsonChunks = data
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        expect(jsonChunks.map((chunk) => chunk.object)).toContain("chat.completion.chunk");
        const allContent = jsonChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
          .filter((v): v is string => typeof v === "string")
          .join("");
        expect(allContent).toBe("hello");
        const contentChoices = jsonChunks
          .flatMap((chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .filter(
            (choice) =>
              typeof (choice.delta as Record<string, unknown> | undefined)?.content === "string",
          );
        expect(contentChoices.every((choice) => choice.finish_reason === null)).toBe(true);
        const stopChoices = jsonChunks
          .flatMap((chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((choice) => choice.finish_reason === "stop");
        expect(stopChoices).toHaveLength(1);
        expect(stopChoices[0]?.delta).toEqual({});
        const usageChunks = jsonChunks.filter((c) => "usage" in c);
        expect(usageChunks).toHaveLength(0);
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockImplementationOnce((async (opts: unknown) =>
          buildAssistantDeltaResult({
            opts,
            emit: emitAgentEvent,
            deltas: ["hi", "hi"],
            text: "hihi",
          })) as never);

        const repeatedRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(repeatedRes.status).toBe(200);
        const repeatedText = await repeatedRes.text();
        const repeatedData = parseSseDataLines(repeatedText);
        const repeatedChunks = repeatedData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const repeatedContent = repeatedChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
          .filter((v): v is string => typeof v === "string")
          .join("");
        expect(repeatedContent).toBe("hihi");
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "hello" }],
        } as never);

        const fallbackRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(fallbackRes.status).toBe(200);
        const fallbackText = await fallbackRes.text();
        expect(fallbackText).toContain("[DONE]");
        expect(fallbackText).toContain("hello");
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockImplementationOnce((async (opts: unknown) =>
          buildAssistantDeltaResult({
            opts,
            emit: emitAgentEvent,
            deltas: ["plain text despite required"],
            text: "plain text despite required",
          })) as never);

        const requiredFailureRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          tool_choice: "required",
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get weather",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "weather?" }],
        });
        expect(requiredFailureRes.status).toBe(200);
        const requiredFailureText = await requiredFailureRes.text();
        expect(requiredFailureText).toContain("[DONE]");
        expect(requiredFailureText).toContain("tool_choice=required was not satisfied");
        expect(requiredFailureText).not.toContain("plain text despite required");
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "Let me check that." }],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [
              {
                id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Taipei"}',
              },
            ],
          },
        } as never);

        const toolCallRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(toolCallRes.status).toBe(200);
        const toolCallText = await toolCallRes.text();
        const toolCallData = parseSseDataLines(toolCallText);
        const toolCallChunks = toolCallData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const toolDeltaChunks = toolCallChunks.filter((chunk) => {
          const choice = ((chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])[0];
          const delta = (choice?.delta as Record<string, unknown> | undefined) ?? {};
          return Array.isArray(delta.tool_calls);
        });
        expect(toolDeltaChunks.length).toBeGreaterThan(0);
        const toolCallDeltaRecords = toolDeltaChunks.flatMap((chunk) => {
          const choice = ((chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])[0];
          const delta = (choice?.delta as Record<string, unknown> | undefined) ?? {};
          return (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
        });
        const withIdentity = toolCallDeltaRecords.find(
          (record) =>
            record.id === "call_1" &&
            record.type === "function" &&
            ((record.function as Record<string, unknown> | undefined)?.name as
              | string
              | undefined) === "get_weather",
        );
        if (!withIdentity) {
          throw new Error("expected tool call delta with identity");
        }
        const argsJoined = toolCallDeltaRecords
          .filter((record) => record.index === 0)
          .map(
            (record) =>
              ((record.function as Record<string, unknown> | undefined)?.arguments as
                | string
                | undefined) ?? "",
          )
          .join("");
        expect(argsJoined).toBe('{"city":"Taipei"}');
        const finishChunk = toolCallChunks
          .flatMap((chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .find((choice) => choice.finish_reason === "tool_calls");
        if (!finishChunk) {
          throw new Error("expected tool_calls finish chunk");
        }
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "Let me check that." }],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [
              {
                id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Taipei"}',
              },
            ],
            agentMeta: {
              usage: {
                input: 12,
                output: 3,
                total: 15,
              },
            },
          },
        } as never);

        const toolCallUsageRes = await postChatCompletions(port, {
          stream: true,
          stream_options: { include_usage: true },
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(toolCallUsageRes.status).toBe(200);
        const toolCallUsageText = await toolCallUsageRes.text();
        const toolCallUsageData = parseSseDataLines(toolCallUsageText);
        const jsonChunks = toolCallUsageData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const usageChunk = jsonChunks.find((chunk) => "usage" in chunk);
        if (!usageChunk) {
          throw new Error("expected streamed usage chunk");
        }
        expect(usageChunk.choices).toEqual([]);
        expect(usageChunk.usage).toEqual({
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
        });
        expect(toolCallUsageData[toolCallUsageData.length - 1]).toBe("[DONE]");
      }

      {
        agentCommandMock.mockClear();
        let resolveLateToolCall:
          | ((result: {
              payloads: Array<{ text: string }>;
              meta: {
                stopReason: string;
                pendingToolCalls: Array<{ id: string; name: string; arguments: string }>;
              };
            }) => void)
          | undefined;
        agentCommandMock.mockImplementationOnce(
          ((opts: unknown) =>
            new Promise((resolve) => {
              resolveLateToolCall = resolve;
              const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
              emitAgentEvent({ runId, stream: "assistant", data: { delta: "Let me check that." } });
              emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
            })) as never,
        );

        const lateToolCallRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(lateToolCallRes.status).toBe(200);
        if (!lateToolCallRes.body) {
          throw new Error("expected streaming response body");
        }
        const reader = lateToolCallRes.body.getReader();
        const decoder = new TextDecoder();
        let lateToolCallText = "";
        while (!lateToolCallText.includes("Let me check that.")) {
          const { done, value } = await reader.read();
          if (done) {
            throw new Error("stream ended before early assistant delta");
          }
          lateToolCallText += decoder.decode(value, { stream: true });
        }
        expect(lateToolCallText).not.toContain("[DONE]");

        resolveLateToolCall?.({
          payloads: [{ text: "Let me check that." }],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [
              {
                id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Taipei"}',
              },
            ],
          },
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            lateToolCallText += decoder.decode();
            break;
          }
          lateToolCallText += decoder.decode(value, { stream: true });
        }
        const lateToolCallData = parseSseDataLines(lateToolCallText);
        const lateToolCallChunks = lateToolCallData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const finishChunk = lateToolCallChunks
          .flatMap((chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .find((choice) => choice.finish_reason === "tool_calls");
        if (!finishChunk) {
          throw new Error("expected late tool_calls finish chunk");
        }
        const anyToolCalls = lateToolCallChunks.some((chunk) => {
          const choice = ((chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])[0];
          const delta = (choice?.delta as Record<string, unknown> | undefined) ?? {};
          return Array.isArray(delta.tool_calls);
        });
        expect(anyToolCalls).toBe(true);
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockRejectedValueOnce(createClientToolNameConflictError(["exec"]));

        const toolConflictRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          tools: [
            {
              type: "function",
              function: {
                name: "exec",
                description: "conflicts with a built-in tool",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "run command" }],
        });
        expect(toolConflictRes.status).toBe(200);
        const toolConflictText = await toolConflictRes.text();
        const toolConflictData = parseSseDataLines(toolConflictText);
        expect(toolConflictData[toolConflictData.length - 1]).toBe("[DONE]");

        const toolConflictChunks = toolConflictData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const protocolError = toolConflictChunks.find(
          (chunk) =>
            typeof chunk.error === "object" &&
            ((chunk.error as { type?: unknown }).type ?? "") === "invalid_request_error" &&
            ((chunk.error as { message?: unknown }).message ?? "") === "invalid tool configuration",
        );
        if (!protocolError) {
          throw new Error("expected invalid tool configuration protocol error");
        }
        const stopChoice = toolConflictChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .find((choice) => choice.finish_reason === "stop");
        expect(stopChoice).toBeUndefined();
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockRejectedValueOnce(new Error("boom"));

        const errorRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(errorRes.status).toBe(200);
        const errorText = await errorRes.text();
        const errorData = parseSseDataLines(errorText);
        expect(errorData[errorData.length - 1]).toBe("[DONE]");

        const errorChunks = errorData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const choices = errorChunks.flatMap(
          (chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [],
        );
        const errorContentChoice = choices.find(
          (choice) =>
            (choice.delta as Record<string, unknown> | undefined)?.content ===
            "Error: internal error",
        );
        expect(errorContentChoice?.finish_reason).toBeNull();
        const stopChoices = choices.filter((choice) => choice.finish_reason === "stop");
        expect(stopChoices).toHaveLength(1);
        expect(stopChoices[0]?.delta).toEqual({});
        expect(choices.at(-1)).toEqual(stopChoices[0]);
      }
    } finally {
      // shared server
    }
  });

  it.each([
    { astral: "😀", boundary: 255 },
    { astral: "𐐷", boundary: 511 },
  ])(
    "keeps streamed tool-call arguments well-formed ($astral at UTF-16 boundary $boundary)",
    async ({ astral, boundary }) => {
      const argumentPrefix = '{"value":"';
      const value = `${"a".repeat(boundary - argumentPrefix.length)}${astral}tail`;
      const expectedArguments = JSON.stringify({ value });
      expect(expectedArguments.indexOf(astral)).toBe(boundary);

      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "Calling the tool." }],
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [
            {
              id: "call_1",
              name: "read_value",
              arguments: expectedArguments,
            },
          ],
        },
      } as never);

      const res = await postChatCompletions(enabledPort, {
        stream: true,
        model: "openclaw",
        messages: [{ role: "user", content: "read the value" }],
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const data = parseSseDataLines(await res.text());
      expect(data.at(-1)).toBe("[DONE]");

      const chunks = data
        .filter((line) => line !== "[DONE]")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const choices = chunks.flatMap(
        (chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [],
      );
      const argumentDeltas = choices
        .flatMap((choice) => {
          const delta = choice.delta as Record<string, unknown> | undefined;
          return (delta?.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
        })
        .map((toolCall) => {
          const toolFunction = toolCall.function as Record<string, unknown> | undefined;
          return toolFunction?.arguments;
        })
        .filter((argumentsDelta): argumentsDelta is string => typeof argumentsDelta === "string");

      expect(argumentDeltas.length).toBeGreaterThan(1);
      for (const argumentsDelta of argumentDeltas) {
        expect(new TextDecoder().decode(new TextEncoder().encode(argumentsDelta))).toBe(
          argumentsDelta,
        );
      }
      expect(argumentDeltas.join("")).toBe(expectedArguments);
      expect(JSON.parse(argumentDeltas.join(""))).toEqual({ value });
      expect(choices.some((choice) => choice.finish_reason === "tool_calls")).toBe(true);
    },
  );

  it(
    "sends an initial SSE chunk before a streaming agent run settles",
    { timeout: 15_000 },
    async () => {
      const port = enabledPort;
      let serverAbortSignal: AbortSignal | undefined;

      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(
        (opts: unknown) =>
          new Promise<undefined>((resolve) => {
            const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            serverAbortSignal = signal;
            if (signal?.aborted) {
              resolve(undefined);
              return;
            }
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      );

      let settled = false;
      const firstChunk = new Promise<string>((resolve, reject) => {
        const clientReq = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer secret",
            },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"] ?? "").toContain("text/event-stream");
            res.setEncoding("utf8");
            res.once("data", (chunk) => {
              settled = true;
              resolve(String(chunk));
              clientReq.destroy();
            });
          },
        );
        clientReq.on("error", (err) => {
          if (!settled) {
            reject(err);
          }
        });
        clientReq.setTimeout(2_000, () => {
          if (!settled) {
            settled = true;
            clientReq.destroy(new Error("timed out waiting for first SSE chunk"));
          }
        });
        clientReq.end(
          JSON.stringify({
            stream: true,
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          }),
        );
      });

      await expect(firstChunk).resolves.toContain('"role":"assistant"');
      await vi.waitFor(() => {
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
      });

      await vi.waitFor(
        () => {
          expect(serverAbortSignal?.aborted).toBe(true);
        },
        { timeout: 5_000, interval: 50 },
      );
    },
  );

  it("keeps streamed agent work admitted after the HTTP handler returns", async () => {
    const idleRootCount = getActiveGatewayRootWorkCount();
    const continueAgent = createDeferred();
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async () => {
      await continueAgent.promise;
      const queued = await enqueueCommandInLane("openai-http-admission-probe", async () => true);
      return { payloads: [{ text: queued ? "answer queued" : "unreachable" }] };
    }) as never);

    const res = await postChatCompletions(enabledPort, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    continueAgent.resolve();

    const streamed = parseSseDataLines(await res.text()).join("\n");
    expect(streamed).toContain("answer queued");
    expect(streamed).not.toContain("Error: internal error");
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
  });

  it("buffers replaceable assistant events for streaming chat completions", async () => {
    const port = enabledPort;
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text: "coordination draft", delta: "coordination draft", replaceable: true },
      });
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text: "final answer", delta: "", replace: true, replaceable: true },
      });
      emitAgentEvent({ runId, stream: "assistant", data: { text: "final answer" } });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
      return { payloads: [{ text: "final answer" }] };
    }) as never);

    const res = await postChatCompletions(port, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    const data = parseSseDataLines(await res.text());
    const chunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    const allContent = chunks
      .flatMap((chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])
      .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
      .filter((content): content is string => typeof content === "string")
      .join("");

    expect(allContent).toBe("final answer");
    expect(allContent).not.toContain("coordination draft");
  });

  it("prefers final result text over buffered replaceable chat drafts", async () => {
    const port = enabledPort;
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text: "coordination draft", delta: "coordination draft", replaceable: true },
      });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
      return { payloads: [{ text: "final answer" }] };
    }) as never);

    const res = await postChatCompletions(port, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    const data = parseSseDataLines(await res.text());
    const chunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    const allContent = chunks
      .flatMap((chunk) => (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])
      .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
      .filter((content): content is string => typeof content === "string")
      .join("");

    expect(allContent).toBe("final answer");
  });

  it.each([
    {
      name: "includes aggregate usage in the final stream chunk",
      usage: { input: 12, output: 5, cacheRead: 3, cacheWrite: 0, total: 20 },
      lastCallUsage: undefined,
      expected: {
        prompt_tokens: 15,
        completion_tokens: 5,
        total_tokens: 20,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    },
    {
      name: "uses last-call usage when the aggregate is zero",
      usage: { input: 0, output: 0, total: 0 },
      lastCallUsage: { input: 55, output: 7, total: 62 },
      expected: {
        prompt_tokens: 55,
        completion_tokens: 7,
        total_tokens: 62,
      },
    },
  ])("$name", async ({ usage, lastCallUsage, expected }) => {
    const port = enabledPort;
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "he" } });
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "llo" } });
      return {
        payloads: [{ text: "hello" }],
        meta: {
          agentMeta: {
            usage,
            ...(lastCallUsage ? { lastCallUsage } : {}),
          },
        },
      };
    }) as never);

    const res = await postChatCompletions(port, {
      stream: true,
      stream_options: { include_usage: true },
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
    const jsonChunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);

    const usageChunk = jsonChunks.find((chunk) => "usage" in chunk);
    expect(usageChunk?.usage).toEqual(expected);
    expect(usageChunk?.choices).toStrictEqual([]);
  });

  it("keeps aggregate-only usage total in final stream usage chunk", async () => {
    const port = enabledPort;
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
      return {
        payloads: [{ text: "hello" }],
        meta: {
          agentMeta: {
            usage: {
              total: 123,
            },
          },
        },
      };
    }) as never);

    const res = await postChatCompletions(port, {
      stream: true,
      stream_options: { include_usage: true },
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
    const jsonChunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    const usageChunk = jsonChunks.find((chunk) => "usage" in chunk);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 123,
    });
  });

  it("finalizes stream when lifecycle end arrives before usage is available", async () => {
    const port = enabledPort;
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce(
      ((opts: unknown) =>
        new Promise((resolve) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          setTimeout(() => {
            resolve({
              payloads: [{ text: "hello" }],
              meta: {
                agentMeta: {
                  usage: { input: 7, output: 3, total: 10 },
                },
              },
            });
          }, 100);
        })) as never,
    );

    const res = await postChatCompletions(port, {
      stream: true,
      stream_options: { include_usage: true },
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
    const jsonChunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    const usageChunk = jsonChunks.find((chunk) => "usage" in chunk);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
  });

  it(
    "cleans up usage-enabled stream when client disconnects before usage arrives",
    { timeout: 15_000 },
    async () => {
      const port = enabledPort;
      let serverAbortSignal: AbortSignal | undefined;

      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(
        (opts: unknown) =>
          new Promise<undefined>((resolve) => {
            const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
            const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            serverAbortSignal = signal;
            emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
            emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
            if (signal?.aborted) {
              resolve(undefined);
              return;
            }
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      );

      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
      });
      clientReq.on("error", () => {});
      clientReq.end(
        JSON.stringify({
          stream: true,
          stream_options: { include_usage: true },
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      await vi.waitFor(() => {
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
      });

      clientReq.destroy();

      await vi.waitFor(
        () => {
          expect(serverAbortSignal?.aborted).toBe(true);
        },
        { timeout: 5_000, interval: 50 },
      );
    },
  );

  it("does not require usage to finalize when include_usage is not requested", async () => {
    const port = enabledPort;
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce(
      ((opts: unknown) =>
        new Promise((resolve) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          setTimeout(() => {
            resolve({ payloads: [{ text: "hello" }] });
          }, 100);
        })) as never,
    );

    const res = await postChatCompletions(port, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
    const jsonChunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    const usageChunks = jsonChunks.filter((chunk) => "usage" in chunk);
    expect(usageChunks).toHaveLength(0);
  });

  it("preserves declared owner identity for streaming and non-streaming private callers", async () => {
    for (const stream of [false, true]) {
      for (const { scopes, senderIsOwner } of [
        { scopes: "operator.write", senderIsOwner: false },
        { scopes: "operator.admin, operator.write", senderIsOwner: true },
      ]) {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);

        const res = await postChatCompletions(
          enabledPort,
          {
            stream,
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          {
            "x-openclaw-scopes": scopes,
            "x-openclaw-sender-is-owner": "true",
          },
        );

        expect(res.status).toBe(200);
        await res.text();
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
        expect(firstAgentCommandOptions()?.senderIsOwner).toBe(senderIsOwner);
      }
    }
  });

  it("preserves verified trusted-proxy owner identity for both response modes", async () => {
    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined },
      async () => {
        const port = await getGatewayTestPort();
        let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
        const previousGatewayAuth = testState.gatewayAuth;
        const trustedProxyAuth = {
          mode: "trusted-proxy" as const,
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
          },
        };
        testState.gatewayAuth = trustedProxyAuth;
        try {
          await writeGatewayConfig({
            gateway: {
              auth: trustedProxyAuth,
              trustedProxies: ["127.0.0.1"],
            },
          });
          resetConfigRuntimeState();
          server = await startGatewayServer(port, {
            host: "127.0.0.1",
            auth: trustedProxyAuth,
            controlUiEnabled: false,
            openAiChatCompletionsEnabled: true,
          });

          for (const stream of [false, true]) {
            for (const { scopes, senderIsOwner } of [
              { scopes: "operator.write", senderIsOwner: false },
              { scopes: "operator.admin, operator.write", senderIsOwner: true },
            ]) {
              agentCommandMock.mockClear();
              agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);

              const res = await postChatCompletions(
                port,
                {
                  stream,
                  model: "openclaw",
                  messages: [{ role: "user", content: "hi" }],
                },
                {
                  "x-forwarded-proto": "https",
                  "x-forwarded-user": "operator@example.com",
                  "x-openclaw-scopes": scopes,
                  "x-openclaw-sender-is-owner": "true",
                },
              );

              expect(res.status).toBe(200);
              await res.text();
              expect(agentCommandMock).toHaveBeenCalledTimes(1);
              expect(firstAgentCommandOptions()?.senderIsOwner).toBe(senderIsOwner);
            }
          }

          agentCommandMock.mockClear();
          const unauthorized = await postChatCompletions(
            port,
            { model: "openclaw", messages: [{ role: "user", content: "hi" }] },
            {
              "x-forwarded-proto": "https",
              "x-openclaw-scopes": "operator.admin, operator.write",
              "x-openclaw-sender-is-owner": "true",
            },
          );
          expect(unauthorized.status).toBe(401);
          await unauthorized.text();
          expect(agentCommandMock).not.toHaveBeenCalled();
        } finally {
          await server?.close({ reason: "openai trusted-proxy auth owner test done" });
          testState.gatewayAuth = previousGatewayAuth;
          await writeGatewayConfig({});
          resetConfigRuntimeState();
        }
      },
    );
  });

  it.each(["token", "password"] as const)(
    "preserves owner identity for streaming and non-streaming %s-authenticated callers",
    async (mode) => {
      const port = await getGatewayTestPort();
      const server = await startSharedSecretServer(port, mode);
      try {
        for (const stream of [false, true]) {
          agentCommandMock.mockClear();
          agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);

          const res = await postChatCompletions(
            port,
            {
              stream,
              model: "openclaw",
              messages: [{ role: "user", content: "hi" }],
            },
            {
              authorization: "Bearer secret",
              "x-openclaw-scopes": "operator.approvals",
              "x-openclaw-sender-is-owner": "false",
            },
          );

          expect(res.status).toBe(200);
          await res.text();
          expect(agentCommandMock).toHaveBeenCalledTimes(1);
          expect(firstAgentCommandOptions()?.senderIsOwner).toBe(true);
        }

        agentCommandMock.mockClear();
        const unauthorized = await postChatCompletions(
          port,
          { model: "openclaw", messages: [{ role: "user", content: "hi" }] },
          { authorization: "Bearer wrong", "x-openclaw-sender-is-owner": "true" },
        );
        expect(unauthorized.status).toBe(401);
        await unauthorized.text();
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        await server.close({ reason: `openai ${mode} auth owner test done` });
      }
    },
  );

  it("aborts agent command when streaming client disconnects", { timeout: 15_000 }, async () => {
    const port = enabledPort;
    const idleRootCount = getActiveGatewayRootWorkCount();
    const agentAborted = createDeferred();
    const finishAgentCleanup = createDeferred();
    const cleanupAdmissionClosed = createDeferred<boolean>();
    let serverAbortSignal: AbortSignal | undefined;

    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce(async (opts: unknown) => {
      const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      serverAbortSignal = signal;
      if (signal?.aborted) {
        agentAborted.resolve();
      } else {
        signal?.addEventListener("abort", () => agentAborted.resolve(), { once: true });
      }
      await agentAborted.promise;
      cleanupAdmissionClosed.resolve(isGatewaySubordinateWorkAdmissionClosed());
      await finishAgentCleanup.promise;
      return undefined;
    });

    const clientReq = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
    });
    clientReq.on("error", () => {});
    clientReq.end(
      JSON.stringify({
        stream: true,
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    await vi.waitFor(() => {
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    });

    try {
      clientReq.destroy();

      await vi.waitFor(() => expect(serverAbortSignal?.aborted).toBe(true), {
        timeout: 5_000,
        interval: 50,
      });
      expect(await cleanupAdmissionClosed.promise).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount + 1);
      expect(await waitForActiveGatewayRootWork(0)).toEqual({
        drained: false,
        active: idleRootCount + 1,
      });
    } finally {
      finishAgentCleanup.resolve();
    }

    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount), {
      timeout: 5_000,
      interval: 50,
    });
  });

  it(
    "aborts agent command when non-streaming client disconnects",
    { timeout: 15_000 },
    async () => {
      const port = enabledPort;
      let serverAbortSignal: AbortSignal | undefined;

      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(
        (opts: unknown) =>
          new Promise<undefined>((resolve) => {
            const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            serverAbortSignal = signal;
            if (signal?.aborted) {
              resolve(undefined);
              return;
            }
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      );

      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
      });
      clientReq.on("error", () => {});
      clientReq.end(
        JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      await vi.waitFor(() => {
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
      });

      clientReq.destroy();

      await vi.waitFor(
        () => {
          expect(serverAbortSignal?.aborted).toBe(true);
        },
        { timeout: 5_000, interval: 50 },
      );
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
