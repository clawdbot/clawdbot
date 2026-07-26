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

const MessageItemSchema = z
  .object({
    type: z.literal("message"),
    role: MessageItemRoleSchema,
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    phase: AssistantPhaseSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.phase !== undefined && value.role !== "assistant") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phase"],
        message: "`phase` is only valid on assistant messages.",
      });
    }
  });

const FunctionCallItemSchema = z
  .object({
    type: z.literal("function_call"),
    id: z.string().optional(),
    call_id: z.string().optional(),
    name: z.string(),
    arguments: z.string(),
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

const ResponseStatusSchema = z.enum([
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
]);

const OutputItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      id: z.string(),
      role: z.literal("assistant"),
      content: z.array(OutputTextContentPartSchema),
      phase: AssistantPhaseSchema.optional(),
      status: z.enum(["in_progress", "completed"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call"),
      id: z.string(),
      call_id: z.string(),
      name: z.string(),
      arguments: z.string(),
      status: z.enum(["in_progress", "completed"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning"),
      id: z.string(),
      content: z.string().optional(),
      summary: z.string().optional(),
    })
    .strict(),
]);

export type OutputItem = z.infer<typeof OutputItemSchema>;

const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

export type Usage = z.infer<typeof UsageSchema>;

const ResponseResourceSchema = z.object({
  id: z.string(),
  object: z.literal("response"),
  created_at: z.number().int(),
  status: ResponseStatusSchema,
  model: z.string(),
  output: z.array(OutputItemSchema),
  usage: UsageSchema,
  // Optional fields for future phases
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export type ResponseResource = z.infer<typeof ResponseResourceSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Streaming Event Types
// ─────────────────────────────────────────────────────────────────────────────

const ResponseCreatedEventSchema = z.object({
  type: z.literal("response.created"),
  response: ResponseResourceSchema,
});

const ResponseInProgressEventSchema = z.object({
  type: z.literal("response.in_progress"),
  response: ResponseResourceSchema,
});

const ResponseCompletedEventSchema = z.object({
  type: z.literal("response.completed"),
  response: ResponseResourceSchema,
});

const ResponseFailedEventSchema = z.object({
  type: z.literal("response.failed"),
  response: ResponseResourceSchema,
});

const OutputItemAddedEventSchema = z.object({
  type: z.literal("response.output_item.added"),
  output_index: z.number().int().nonnegative(),
  item: OutputItemSchema,
});

const OutputItemDoneEventSchema = z.object({
  type: z.literal("response.output_item.done"),
  output_index: z.number().int().nonnegative(),
  item: OutputItemSchema,
});

const ContentPartAddedEventSchema = z.object({
  type: z.literal("response.content_part.added"),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  part: OutputTextContentPartSchema,
});

const ContentPartDoneEventSchema = z.object({
  type: z.literal("response.content_part.done"),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  part: OutputTextContentPartSchema,
});

const OutputTextDeltaEventSchema = z.object({
  type: z.literal("response.output_text.delta"),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  delta: z.string(),
});

const OutputTextDoneEventSchema = z.object({
  type: z.literal("response.output_text.done"),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  text: z.string(),
});

export type StreamingEvent =
  | z.infer<typeof ResponseCreatedEventSchema>
  | z.infer<typeof ResponseInProgressEventSchema>
  | z.infer<typeof ResponseCompletedEventSchema>
  | z.infer<typeof ResponseFailedEventSchema>
  | z.infer<typeof OutputItemAddedEventSchema>
  | z.infer<typeof OutputItemDoneEventSchema>
  | z.infer<typeof ContentPartAddedEventSchema>
  | z.infer<typeof ContentPartDoneEventSchema>
  | z.infer<typeof OutputTextDeltaEventSchema>
  | z.infer<typeof OutputTextDoneEventSchema>;
