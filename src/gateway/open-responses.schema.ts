/**
 * OpenResponses API Zod Schemas
 *
 * Zod schemas for the OpenResponses `/v1/responses` endpoint.
 * This module is isolated from gateway imports to enable future codegen and prevent drift.
 *
 * @see https://www.open-responses.com/
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Content Parts
// ─────────────────────────────────────────────────────────────────────────────

const InputTextContentPartSchema = z
  .object({
    type: z.literal("input_text"),
    text: z.string(),
  })
  .strict();

const OutputTextContentPartSchema = z
  .object({
    type: z.literal("output_text"),
    text: z.string(),
  })
  .strict();

// OpenResponses Image Content: Supports URL or base64 sources
const InputImageSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("url"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("base64"),
    media_type: z.enum([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/heic",
      "image/heif",
    ]),
    data: z.string().min(1), // base64-encoded
  }),
]);

const InputImageContentPartSchema = z
  .object({
    type: z.literal("input_image"),
    source: InputImageSourceSchema,
  })
  .strict();

// OpenResponses File Content: Supports URL or base64 sources
const InputFileSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("url"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("base64"),
    media_type: z.string().min(1), // MIME type
    data: z.string().min(1), // base64-encoded
    filename: z.string().optional(),
  }),
]);

const InputFileContentPartSchema = z
  .object({
    type: z.literal("input_file"),
    source: InputFileSourceSchema,
  })
  .strict();

const ContentPartSchema = z.discriminatedUnion("type", [
  InputTextContentPartSchema,
  OutputTextContentPartSchema,
  InputImageContentPartSchema,
  InputFileContentPartSchema,
]);

export type ContentPart = z.infer<typeof ContentPartSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Item Types (ItemParam)
// ─────────────────────────────────────────────────────────────────────────────

const MessageItemRoleSchema = z.enum(["system", "developer", "user", "assistant"]);

const AssistantPhaseSchema = z.enum(["commentary", "final_answer"]);
const ItemStatusSchema = z.enum(["in_progress", "completed", "incomplete"]);

const MessageItemSchema = z
  .object({
    type: z.literal("message"),
    id: z.string().optional(),
    role: MessageItemRoleSchema,
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    phase: AssistantPhaseSchema.optional(),
    status: ItemStatusSchema.optional(),
  })
  .strict()
  .refine((value) => value.phase === undefined || value.role === "assistant", {
    path: ["phase"],
    message: "`phase` is only valid on assistant messages.",
  });

const FunctionCallItemSchema = z
  .object({
    type: z.literal("function_call"),
    id: z.string().optional(),
    call_id: z.string().optional(),
    name: z.string(),
    arguments: z.string(),
    status: ItemStatusSchema.optional(),
  })
  .strict();

const FunctionCallOutputItemSchema = z
  .object({
    type: z.literal("function_call_output"),
    call_id: z.string(),
    output: z.string(),
  })
  .strict();

const ReasoningItemSchema = z
  .object({
    type: z.literal("reasoning"),
    content: z.string().optional(),
    encrypted_content: z.string().optional(),
    summary: z.string().optional(),
  })
  .strict();

const ItemReferenceItemSchema = z
  .object({
    type: z.literal("item_reference"),
    id: z.string(),
  })
  .strict();

const ItemParamSchema = z.discriminatedUnion("type", [
  MessageItemSchema,
  FunctionCallItemSchema,
  FunctionCallOutputItemSchema,
  ReasoningItemSchema,
  ItemReferenceItemSchema,
]);

export type ItemParam = z.infer<typeof ItemParamSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────────────────────

// Responses API tool definition uses a flat format (not the Chat Completions
// wrapped-function format). Fields are at the top level alongside `type`.
const FunctionToolDefinitionSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1, "Tool name cannot be empty"),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  })
  .strict();

const ToolDefinitionSchema = FunctionToolDefinitionSchema;

// ─────────────────────────────────────────────────────────────────────────────
// Request Body
// ─────────────────────────────────────────────────────────────────────────────

const ToolChoiceSchema = z.union([
  z.literal("auto"),
  z.literal("none"),
  z.literal("required"),
  z
    .object({
      type: z.literal("function"),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("function"),
      function: z.object({ name: z.string().min(1) }),
    })
    .strict(),
]);

export const CreateResponseBodySchema = z
  .object({
    model: z.string(),
    input: z.union([z.string(), z.array(ItemParamSchema)]),
    instructions: z.string().optional(),
    tools: z.array(ToolDefinitionSchema).optional(),
    tool_choice: ToolChoiceSchema.optional(),
    // The SDK sends its plain-text default explicitly; structured formats must
    // stay rejected until the runtime actually enforces their contracts.
    text: z
      .object({
        format: z.object({ type: z.literal("text") }).strict(),
      })
      .strict()
      .optional(),
    stream: z.boolean().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    max_tool_calls: z.number().int().positive().optional(),
    user: z.string().optional(),
    // Sampling overrides forwarded to provider (best-effort; some backends like
    // ChatGPT Codex Responses strip these — see openai-transport-stream.ts).
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    store: z.boolean().optional(),
    previous_response_id: z.string().optional(),
    reasoning: z
      .object({
        effort: z.enum(["low", "medium", "high"]).optional(),
        summary: z.enum(["auto", "concise", "detailed"]).optional(),
      })
      .optional(),
    truncation: z.enum(["auto", "disabled"]).optional(),
  })
  .strict();

export type CreateResponseBody = z.infer<typeof CreateResponseBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Response Resource
// ─────────────────────────────────────────────────────────────────────────────

type OutputTextContentPart = Extract<ContentPart, { type: "output_text" }>;
type OutputStatus = "in_progress" | "completed";

export type OutputItem =
  | (Omit<Extract<ItemParam, { type: "message" }>, "id" | "role" | "content" | "status"> & {
      id: string;
      role: "assistant";
      content: OutputTextContentPart[];
      status?: OutputStatus | undefined;
    })
  | (Omit<Extract<ItemParam, { type: "function_call" }>, "id" | "call_id" | "status"> & {
      id: string;
      call_id: string;
      status?: OutputStatus | undefined;
    })
  | { type: "reasoning"; id: string; content?: string | undefined; summary?: string | undefined };

export type Usage = {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
};

export type ResponseResource = {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
  model: string;
  output: OutputItem[];
  usage: Usage;
  error?: { code: string; message: string } | undefined;
};

// ─────────────────────────────────────────────────────────────────────────────
// Streaming Event Types
// ─────────────────────────────────────────────────────────────────────────────

type ContentEventPosition = {
  item_id: string;
  output_index: number;
  content_index: number;
};

export type StreamingEvent =
  | { type: "response.created"; response: ResponseResource }
  | { type: "response.in_progress"; response: ResponseResource }
  | { type: "response.completed"; response: ResponseResource }
  | { type: "response.failed"; response: ResponseResource }
  | { type: "response.output_item.added"; output_index: number; item: OutputItem }
  | { type: "response.output_item.done"; output_index: number; item: OutputItem }
  | (ContentEventPosition & { type: "response.content_part.added"; part: OutputTextContentPart })
  | (ContentEventPosition & { type: "response.content_part.done"; part: OutputTextContentPart })
  | (ContentEventPosition & { type: "response.output_text.delta"; delta: string })
  | (ContentEventPosition & { type: "response.output_text.done"; text: string });
