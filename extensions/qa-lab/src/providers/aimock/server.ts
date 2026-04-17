import type { IncomingMessage, ServerResponse } from "node:http";
import {
  LLMock,
  type ChatCompletionRequest,
  type JournalEntry,
  type Mountable,
} from "@copilotkit/aimock";

type AimockRequestSnapshot = {
  raw: string;
  body: Record<string, unknown>;
  prompt: string;
  allInputText: string;
  toolOutput: string;
  model: string;
  providerVariant: "openai" | "anthropic" | "unknown";
  imageInputCount: number;
  plannedToolName?: string;
};

function writeJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => stringifyContent(part))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    if (typeof record.output === "string") {
      return record.output;
    }
  }
  return "";
}

function requestMessages(body: ChatCompletionRequest | null | undefined) {
  return Array.isArray(body?.messages) ? body.messages : [];
}

function extractLastUserText(body: ChatCompletionRequest | null | undefined) {
  const messages = requestMessages(body);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return stringifyContent(message.content);
    }
  }
  return "";
}

function extractAllInputText(body: ChatCompletionRequest | null | undefined) {
  return requestMessages(body)
    .map((message) => stringifyContent(message.content))
    .filter(Boolean)
    .join("\n");
}

function extractToolOutput(body: ChatCompletionRequest | null | undefined) {
  const messages = requestMessages(body);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "tool") {
      return stringifyContent(message.content);
    }
  }
  return "";
}

function countImageInputs(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + countImageInputs(entry), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const imageLikeType =
    type === "input_image" || type === "image" || type === "image_url" || type === "media";
  const nested =
    countImageInputs(record.content) +
    countImageInputs(record.image_url) +
    countImageInputs(record.source);
  return (imageLikeType ? 1 : 0) + nested;
}

function resolveProviderVariant(model: string): AimockRequestSnapshot["providerVariant"] {
  const normalized = model.trim().toLowerCase();
  const provider = /^([^/:]+)[/:]/.exec(normalized)?.[1] ?? normalized;
  if (provider === "openai" || provider === "aimock" || provider === "openai-codex") {
    return "openai";
  }
  if (provider === "anthropic" || provider === "claude-cli") {
    return "anthropic";
  }
  if (/^(?:gpt-|o1-|openai-)/.test(normalized)) {
    return "openai";
  }
  if (/^(?:claude-|anthropic-)/.test(normalized)) {
    return "anthropic";
  }
  return "unknown";
}

function extractPlannedToolName(entry: JournalEntry) {
  const response = entry.response.fixture?.response as
    | { toolCalls?: Array<{ name?: unknown }> }
    | undefined;
  const name = response?.toolCalls?.[0]?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function toRequestSnapshot(entry: JournalEntry): AimockRequestSnapshot {
  const body = entry.body ?? null;
  const model = typeof body?.model === "string" ? body.model : "";
  return {
    raw: JSON.stringify(body ?? {}),
    body: (body ?? {}) as Record<string, unknown>,
    prompt: extractLastUserText(body),
    allInputText: extractAllInputText(body),
    toolOutput: extractToolOutput(body),
    model,
    providerVariant: resolveProviderVariant(model),
    imageInputCount: countImageInputs(requestMessages(body)),
    plannedToolName: extractPlannedToolName(entry),
  };
}

function createDebugMount(mock: LLMock): Mountable {
  return {
    async handleRequest(_req: IncomingMessage, res: ServerResponse, pathname: string) {
      const entries = mock.getRequests();
      if (pathname === "/last-request") {
        const lastEntry = entries.at(-1);
        writeJson(
          res,
          200,
          lastEntry ? toRequestSnapshot(lastEntry) : { ok: false, error: "no request recorded" },
        );
        return true;
      }
      if (pathname === "/requests") {
        writeJson(
          res,
          200,
          entries.map((entry) => toRequestSnapshot(entry)),
        );
        return true;
      }
      if (pathname === "/image-generations") {
        writeJson(
          res,
          200,
          entries
            .filter((entry) => entry.path === "/v1/images/generations")
            .map((entry) => entry.body ?? {}),
        );
        return true;
      }
      return false;
    },
  };
}

export async function startQaAimockServer(params?: { host?: string; port?: number }) {
  const mock = new LLMock({
    host: params?.host ?? "127.0.0.1",
    port: params?.port ?? 0,
    strict: false,
    logLevel: "silent",
  });

  mock.mount("/debug", createDebugMount(mock));
  mock.onMessage(/.*/, { content: "AIMOCK_QA_OK" });

  await mock.start();
  return {
    baseUrl: mock.baseUrl,
    async stop() {
      await mock.stop();
    },
  };
}
