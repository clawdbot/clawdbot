import {
  admitGuardAdapter,
  assertPinnedModel,
  INBOUND_INSTRUCTIONS,
  OUTBOUND_INSTRUCTIONS,
  type GuardAdapter,
  type GuardRequest,
  type RawGuardAdapter,
} from "./guard.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface AdapterOptions {
  apiKey: string;
  pinnedModel: string;
  fetch: FetchLike;
  timeoutMs?: number;
}

const verdictSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["allow", "deny", "review"] },
    category: { type: "string" },
    reason: { type: "string" },
    policyVersion: { type: "string" },
  },
  required: ["decision", "category", "reason", "policyVersion"],
} as const;

export function createOpenAiGuard(options: AdapterOptions): GuardAdapter {
  assertPinnedModel(options.pinnedModel);
  const raw: RawGuardAdapter = {
    providerId: "openai",
    pinnedModel: options.pinnedModel,
    async classifyRaw(request, signal) {
      const response = await options.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: options.pinnedModel,
          instructions: instructionFor(request),
          input: JSON.stringify(request),
          store: false,
          background: false,
          tools: [],
          text: {
            format: {
              type: "json_schema",
              name: "reef_guard_verdict",
              strict: true,
              schema: verdictSchema,
            },
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`guard HTTP ${response.status}`);
      }
      const envelope = await parseJsonResponse(response);
      if (
        !isRecord(envelope) ||
        typeof envelope.model !== "string" ||
        envelope.model !== options.pinnedModel ||
        envelope.status !== "completed" ||
        !Array.isArray(envelope.output)
      ) {
        throw new Error("invalid OpenAI guard response");
      }
      const outputTexts: string[] = [];
      for (const item of envelope.output) {
        if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
          continue;
        }
        for (const part of item.content) {
          if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
            outputTexts.push(part.text);
          }
        }
      }
      if (outputTexts.length !== 1) {
        throw new Error("guard must return one OpenAI output object");
      }
      return attachProviderModel(parseStrictJson(outputTexts[0]!, true), envelope.model);
    },
  };
  return admitGuardAdapter(raw, options.timeoutMs);
}

export function createAnthropicGuard(options: AdapterOptions): GuardAdapter {
  assertPinnedModel(options.pinnedModel);
  const raw: RawGuardAdapter = {
    providerId: "anthropic",
    pinnedModel: options.pinnedModel,
    async classifyRaw(request, signal) {
      const response = await options.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: options.pinnedModel,
          max_tokens: 512,
          system: `${instructionFor(request)} The object must exactly match this schema: ${JSON.stringify(verdictSchema)}`,
          output_config: { format: { type: "json_schema", schema: verdictSchema } },
          messages: [{ role: "user", content: JSON.stringify(request) }],
        }),
      });
      if (!response.ok) {
        throw new Error(`guard HTTP ${response.status}`);
      }
      const envelope = await parseJsonResponse(response);
      if (
        !isRecord(envelope) ||
        typeof envelope.model !== "string" ||
        envelope.model !== options.pinnedModel ||
        !Array.isArray(envelope.content) ||
        envelope.stop_reason !== "end_turn"
      ) {
        throw new Error("invalid Anthropic guard response");
      }
      if (envelope.content.length !== 1) {
        throw new Error("invalid Anthropic guard content");
      }
      const part = envelope.content[0];
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        throw new Error("missing Anthropic guard output");
      }
      return attachProviderModel(parseStrictJson(part.text, true), envelope.model);
    },
  };
  return admitGuardAdapter(raw, options.timeoutMs);
}

function instructionFor(request: GuardRequest): string {
  const directionInstructions =
    request.direction === "outbound" ? OUTBOUND_INSTRUCTIONS : INBOUND_INSTRUCTIONS;
  return `${directionInstructions} Set policyVersion to exactly ${JSON.stringify(request.policyVersion)}.`;
}

function attachProviderModel(value: unknown, model: string): unknown {
  if (!isRecord(value) || Object.hasOwn(value, "model")) {
    throw new Error("invalid model guard verdict");
  }
  return { ...value, model };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 256 * 1024) {
    throw new Error("guard response too large");
  }
  return parseStrictJson(text);
}

function parseStrictJson(text: string, rejectDuplicateKeys = false): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("guard returned non-object JSON");
  }
  if (rejectDuplicateKeys && hasDuplicateKeys(trimmed)) {
    throw new Error("guard returned duplicate JSON keys");
  }
  return JSON.parse(trimmed) as unknown;
}

function hasDuplicateKeys(text: string): boolean {
  const keys = new Set<string>();
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') {
      continue;
    }
    const start = index;
    for (index++; index < text.length; index++) {
      if (text[index] === "\\") {
        index++;
      } else if (text[index] === '"') {
        break;
      }
    }
    let next = index + 1;
    while (/\s/.test(text[next] ?? "")) {
      next++;
    }
    if (text[next] !== ":") {
      continue;
    }
    const key = JSON.parse(text.slice(start, index + 1)) as string;
    if (keys.has(key)) {
      return true;
    }
    keys.add(key);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
