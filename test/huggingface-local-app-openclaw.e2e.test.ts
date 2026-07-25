import fs from "node:fs/promises";
// Hugging Face local-app CLI contract tests cover OpenClaw's snippet-facing commands.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

type CapturedChatRequest = {
  path: string;
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  stream?: boolean;
};

type FakeOpenAiServer = {
  baseUrl: string;
  requests: CapturedChatRequest[];
  close: () => Promise<void>;
};

const HF_LOCAL_APP_CASES = [
  {
    name: "GGUF llama.cpp",
    providerId: "llama-cpp",
    modelId: "ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M",
  },
  {
    name: "MLX LM",
    providerId: "mlx-lm",
    modelId: "mlx-community/Qwen3-0.6B-4bit",
  },
] as const;

const instances: OpenClawTestInstance[] = [];
const fakeServers: FakeOpenAiServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(fakeServers.splice(0).map((server) => server.close()));
});

describe("Hugging Face OpenClaw local-app CLI contract", () => {
  it.each(HF_LOCAL_APP_CASES)(
    "runs onboard and local agent commands for $name",
    async ({ providerId, modelId }) => {
      const fakeServer = await startFakeOpenAiServer({ modelId });
      fakeServers.push(fakeServer);
      const instance = await createOpenClawTestInstance({
        name: `hf-local-app-${providerId}`,
        env: {
          CUSTOM_API_KEY: undefined,
          OPENCLAW_TEST_FAST: "1",
        },
      });
      instances.push(instance);

      const onboard = await instance.cli(
        [
          "onboard",
          "--non-interactive",
          "--mode",
          "local",
          "--auth-choice",
          "custom-api-key",
          "--custom-base-url",
          fakeServer.baseUrl,
          "--custom-model-id",
          modelId,
          "--custom-provider-id",
          providerId,
          "--custom-compatibility",
          "openai",
          "--custom-text-input",
          "--accept-risk",
          "--skip-health",
        ],
        { timeoutMs: 120_000 },
      );

      expect(onboard.code, onboard.stderr).toBe(0);
      expect(onboard.stdout).toContain("Updated config");
      await expectConfiguredLocalProvider(instance.configPath, {
        baseUrl: fakeServer.baseUrl,
        modelId,
        providerId,
      });

      const agent = await instance.cli(
        ["agent", "--local", "--agent", "main", "--message", "Hello from Hugging Face"],
        { timeoutMs: 120_000 },
      );

      expect(agent.code, agent.stderr).toBe(0);
      expect(agent.stdout).toContain(`hf local app ok: ${providerId}`);
      expect(fakeServer.requests).toHaveLength(1);
      expect(fakeServer.requests[0]).toMatchObject({
        path: "/v1/chat/completions",
        model: modelId,
        stream: true,
      });
      expect(fakeServer.requests[0]?.messages?.some(messageContainsHello)).toBe(true);
    },
    180_000,
  );
});

function messageContainsHello(message: { content?: unknown }): boolean {
  const content = message.content;
  if (typeof content === "string") {
    return content.includes("Hello from Hugging Face");
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((part) => {
    if (typeof part === "string") {
      return part.includes("Hello from Hugging Face");
    }
    if (part && typeof part === "object" && "text" in part) {
      return String(part.text).includes("Hello from Hugging Face");
    }
    return false;
  });
}

async function expectConfiguredLocalProvider(
  configPath: string,
  expected: { baseUrl: string; modelId: string; providerId: string },
): Promise<void> {
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    agents?: {
      defaults?: {
        model?: { primary?: string };
      };
    };
    models?: {
      providers?: Record<
        string,
        { api?: string; baseUrl?: string; models?: Array<{ id?: string }> }
      >;
    };
  };
  const provider = config.models?.providers?.[expected.providerId];
  expect(provider).toMatchObject({
    api: "openai-completions",
    baseUrl: expected.baseUrl,
  });
  expect(provider?.models?.some((model) => model.id === expected.modelId)).toBe(true);
  expect(config.agents?.defaults?.model?.primary).toBe(
    `${expected.providerId}/${expected.modelId}`,
  );
}

async function startFakeOpenAiServer(params: { modelId: string }): Promise<FakeOpenAiServer> {
  const requests: CapturedChatRequest[] = [];
  const server = createServer((req, res) => {
    void handleFakeOpenAiRequest(req, res, params.modelId, requests);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("fake OpenAI server did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handleFakeOpenAiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  modelId: string,
  requests: CapturedChatRequest[],
): Promise<void> {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
    return;
  }

  const rawBody = await readRequestBody(req);
  const payload = JSON.parse(rawBody) as {
    messages?: Array<{ role?: string; content?: unknown }>;
    model?: string;
    stream?: boolean;
  };
  requests.push({
    path: req.url,
    messages: payload.messages,
    model: payload.model,
    stream: payload.stream,
  });

  res.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  const providerId = modelId.startsWith("mlx-community/") ? "mlx-lm" : "llama-cpp";
  const created = Math.floor(Date.now() / 1000);
  writeSse(res, {
    id: "chatcmpl-hf-openclaw-contract",
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: `hf local app ok: ${providerId}` },
        finish_reason: null,
      },
    ],
  });
  writeSse(res, {
    id: "chatcmpl-hf-openclaw-contract",
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  res.end("data: [DONE]\n\n");
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeSse(res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
