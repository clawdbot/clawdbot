/**
 * One-off live Bedrock provider-path proof for PR #120248.
 * Run: OPENCLAW_BEDROCK_PROVIDER_PROOF=1 pnpm exec tsx extensions/amazon-bedrock/scripts/provider-large-toolcall-proof.mts
 * Not imported by CI. Prints redacted toolcall_end evidence only.
 */
import { createHash } from "node:crypto";
import { streamSimpleBedrock } from "../stream.runtime.ts";

const TARGET_BODY_CHARS = Number(process.env.OPENCLAW_PROOF_BODY_CHARS || 8_000);
const MODEL_ID =
  process.env.OPENCLAW_LIVE_BEDROCK_MODEL_ID?.trim() || "us.anthropic.claude-sonnet-4-6";

if (!process.env.OPENCLAW_BEDROCK_PROVIDER_PROOF) {
  console.error("Set OPENCLAW_BEDROCK_PROVIDER_PROOF=1 to run this script.");
  process.exit(2);
}

const model = {
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  id: MODEL_ID,
  name: "Claude Sonnet 4.6",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
} as const;

const writeDocumentTool = {
  name: "write_document",
  description: "Write a single synthetic test document body. Call exactly once.",
  parameters: {
    type: "object",
    properties: {
      body: {
        type: "string",
        description: `Synthetic test payload. Must be at least ${TARGET_BODY_CHARS} characters. Format: one line per integer 'LINE_000001\\nLINE_000002\\n...' with no other text.`,
      },
    },
    required: ["body"],
    additionalProperties: false,
  },
} as const;

function redactBody(body: string) {
  return {
    length: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    head: JSON.stringify(body.slice(0, 48)),
    tail: JSON.stringify(body.slice(-48)),
  };
}

const stream = streamSimpleBedrock(
  model as never,
  {
    systemPrompt:
      "You are a mechanical test harness for an OpenClaw Bedrock streaming parser. " +
      "Call write_document exactly once. The body must be synthetic numbered lines only: " +
      "'LINE_000001\\nLINE_000002\\n...' continuing until the body is at least " +
      `${TARGET_BODY_CHARS} characters. No prose, no commentary, no other tools.`,
    messages: [
      {
        role: "user",
        content: `Emit write_document with body = consecutive LINE_NNNNNN lines totaling >= ${TARGET_BODY_CHARS} chars.`,
        timestamp: Date.now(),
      },
    ],
    tools: [writeDocumentTool as never],
  },
  {
    region: process.env.AWS_REGION || "us-east-1",
    toolChoice: { type: "tool", name: "write_document" },
    maxTokens: 32_000,
    reasoning: "off",
  } as never,
);

let toolcallDeltas = 0;
let lastPartialBodyLen: number | null = null;
let toolcallEndArgs: Record<string, unknown> | undefined;
const eventTypes: string[] = [];

for await (const event of stream) {
  eventTypes.push(event.type);
  if (event.type === "toolcall_delta") {
    toolcallDeltas += 1;
    const content = event.partial.content?.[event.contentIndex] as
      | { arguments?: Record<string, unknown> }
      | undefined;
    if (typeof content?.arguments?.body === "string") {
      lastPartialBodyLen = content.arguments.body.length;
    }
  }
  if (event.type === "toolcall_end") {
    const content = event.partial.content?.[event.contentIndex] as
      | { arguments?: Record<string, unknown> }
      | undefined;
    toolcallEndArgs = content?.arguments;
  }
}

const output = await stream.result();
const toolCall = output.content.find((block) => block.type === "toolCall") as
  | { type: "toolCall"; name: string; arguments: Record<string, unknown> }
  | undefined;

const body = String(toolcallEndArgs?.body ?? toolCall?.arguments?.body ?? "");
const proof = {
  proof: "streamSimpleBedrock live large toolcall_end",
  modelId: MODEL_ID,
  stopReason: output.stopReason,
  errorMessage: output.errorMessage ?? null,
  toolcallDeltas,
  eventTypesUnique: [...new Set(eventTypes)],
  toolName: toolCall?.name ?? null,
  toolCallArgKeys: toolCall ? Object.keys(toolCall.arguments ?? {}) : [],
  toolcallEndArgKeys: toolcallEndArgs ? Object.keys(toolcallEndArgs) : [],
  lastPartialBodyLength: lastPartialBodyLen,
  finalized: body ? redactBody(body) : null,
  matchesToolCallBlock: body === String(toolCall?.arguments?.body ?? ""),
  ok: Boolean(body.length >= TARGET_BODY_CHARS && toolCall?.name === "write_document"),
};

console.log(JSON.stringify(proof, null, 2));
process.exit(proof.ok ? 0 : 1);
